import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const fetchHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

const DOW_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!supabaseUrl || !supabaseKey || !geminiKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });

    // pending を 1 件取得（古い順）
    const { data: queueRow, error: queueError } = await supabase
      .from('drama_queue')
      .select('id, drama_id, scheduled_for, dramas(id, title, network, official_url, air_day_of_week, is_daily, air_time, season)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (queueError) throw queueError;
    if (!queueRow) {
      return NextResponse.json({ success: true, message: 'キューに pending なし' });
    }

    // 即 processing にしてロック
    await supabase.from('drama_queue').update({ status: 'processing' }).eq('id', queueRow.id);

    const drama: any = queueRow.dramas;
    if (!drama) {
      await supabase.from('drama_queue')
        .update({ status: 'failed', error_message: 'dramas レコードが見つかりません', processed_at: new Date().toISOString() })
        .eq('id', queueRow.id);
      return NextResponse.json({ success: false, error: 'drama not found' });
    }

    try {

    // HTMLからテキストへ整形するヘルパー
    const stripHtml = (html: string, maxLen: number) =>
      html
        .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, '')
        .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, '')
        .replace(/<[^>]*>?/gm, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, maxLen);

    // ホームHTMLからエピソード/ストーリー/ニュース/イントロサブページのURLを発見
    // フジテレビ式 /story/index.html, /news/news07.html や日テレ/TBS/NHK系の各種パスに対応
    const findEpisodeSubpages = (homeHtml: string, baseUrl: string): string[] => {
      const baseObj = new URL(baseUrl);
      const baseHomeNorm = (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toLowerCase();

      // 全 href を抽出
      const hrefs: string[] = [];
      const hrefRe = /href=["']([^"']+)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = hrefRe.exec(homeHtml)) !== null) {
        hrefs.push(m[1]);
      }

      // 同一ドメインへ正規化
      const sameDomain: string[] = [];
      for (const h of hrefs) {
        if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:')) continue;
        if (/\.(css|js|png|jpe?g|gif|svg|ico|webp|mp4|woff2?)(\?|$)/i.test(h)) continue;
        let full: string;
        try { full = new URL(h, baseUrl).toString(); } catch { continue; }
        try {
          if (new URL(full).hostname !== baseObj.hostname) continue;
        } catch { continue; }
        // 公式トップURL自身は除外
        const norm = (full.endsWith('/') ? full : full + '/').toLowerCase();
        if (norm === baseHomeNorm) continue;
        sameDomain.push(full);
      }

      // カテゴリ判定 + 優先度スコア + 番号付きは最大番号のみ採用
      type Item = { url: string; score: number; key: string; num: number };
      const items: Item[] = [];
      for (const url of sameDomain) {
        const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
        let score = 0;
        let key = '';
        let num = 0;

        // 番号付きエピソード: /story/01/, /episode/3/, /news/news07.html, /onair/05/
        const numbered = path.match(/\/(story|stories|episode|episodes|onair|onair_story|news\/news|story\/story|episode\/episode)[\/\-_]*(\d{1,2})(?:\/|\.html?|$)/);
        if (numbered) {
          num = parseInt(numbered[2], 10);
          if (num >= 1 && num <= 50) {
            score = 110; // 番号付きが最優先（最新話のあらすじ・ゲスト情報）
            key = `numbered:${numbered[1].split('/')[0]}`;
          }
        }

        // 名前付きカテゴリ
        if (score === 0) {
          if (/\/(story|stories)(\/index\.html?|\/?$)/.test(path)) { score = 100; key = 'story-index'; }
          else if (/\/news(\/index\.html?|\/?$)/.test(path)) { score = 95; key = 'news-index'; }
          else if (/\/(introduction|intro)(\/index\.html?|\/?$)/.test(path)) { score = 80; key = 'intro'; }
          else if (/\/(next|preview|nextstory)(\/index\.html?|\/?$)/.test(path)) { score = 90; key = 'next'; }
          else if (/\/(cast|cast-staff|staff)(\/index\.html?|\/?$)/.test(path)) { score = 60; key = 'cast'; }
          else if (/\/(topics|topic)(\/index\.html?|\/?$)/.test(path)) { score = 70; key = 'topics'; }
          else if (/\/onair(\/index\.html?|\/?$)/.test(path)) { score = 85; key = 'onair'; }
        }

        if (score > 0) items.push({ url, score, key, num });
      }

      // key 別に集約。番号付きは最大 num のみ。それ以外は先勝ち
      const byKey = new Map<string, Item>();
      for (const it of items) {
        const ex = byKey.get(it.key);
        if (!ex) { byKey.set(it.key, it); continue; }
        if (it.key.startsWith('numbered:')) {
          if (it.num > ex.num) byKey.set(it.key, it);
        }
      }

      // スコア降順 → 上位4件まで
      return Array.from(byKey.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map((it) => it.url);
    };

    // 同一オリジンのJSON/データエンドポイントを発見
    // SPA系サイト（YTV, NTV, 一部フジ/TBS）はホームHTMLが空シェルで、
    // /data/news.json /data/story.json /data/next.json 等にあらすじ・話数が入っている
    const findJsonEndpoints = async (homeHtml: string, baseUrl: string): Promise<string[]> => {
      const baseObj = new URL(baseUrl);
      // ドラマ公式URLのパス配下に限定（例: /kimishike/）。ルート直下の局共通JSONは除外
      const basePath = baseObj.pathname.endsWith('/') ? baseObj.pathname : baseObj.pathname + '/';
      const isInScope = (absUrl: string): boolean => {
        try {
          const u = new URL(absUrl);
          if (u.hostname !== baseObj.hostname) return false;
          return u.pathname.startsWith(basePath);
        } catch {
          return false;
        }
      };
      const candidates = new Set<string>();

      const scanForJson = (text: string) => {
        const re = /['"]([^'"\s<>]{2,200}\.json)(?:[?#][^'"]*)?['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const p = m[1];
          if (/^https?:\/\//i.test(p)) {
            if (isInScope(p)) candidates.add(p);
            continue;
          }
          if (p.startsWith('//')) continue; // 別オリジンの可能性が高いのでスキップ
          try {
            const abs = new URL(p, baseUrl).toString();
            if (isInScope(abs)) candidates.add(abs);
          } catch { /* noop */ }
        }
      };
      scanForJson(homeHtml);

      // 同一オリジンの.jsファイルを最大4本まで取得してスキャン
      const scriptSrcs: string[] = [];
      const srcRe = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi;
      let mm: RegExpExecArray | null;
      while ((mm = srcRe.exec(homeHtml)) !== null) {
        try {
          const abs = new URL(mm[1], baseUrl).toString();
          if (new URL(abs).hostname === baseObj.hostname) scriptSrcs.push(abs);
        } catch { /* noop */ }
      }
      const uniqJs = Array.from(new Set(scriptSrcs)).slice(0, 4);
      await Promise.all(uniqJs.map(async (src) => {
        try {
          const r = await fetch(src, { headers: fetchHeaders });
          if (!r.ok) return;
          const t = await r.text();
          scanForJson(t.substring(0, 200000));
        } catch { /* noop */ }
      }));

      // 既知の共通パス（YTV/NTV系で実績あり、他局でも空振り上等で試す）
      for (const p of ['data/news.json', 'data/story.json', 'data/next.json', 'data/cast.json', 'data/intro.json', 'data/topics.json']) {
        try { candidates.add(new URL(p, baseUrl).toString()); } catch { /* noop */ }
      }

      return Array.from(candidates).slice(0, 10);
    };

    // 公式サイト取得（失敗してもメタデータだけで処理続行）
    let officialContent = '';
    let officialFetchError = '';
    let subpagesFetched: string[] = [];
    let jsonEndpointsFetched: string[] = [];
    if (drama.official_url) {
      try {
        const r = await fetch(drama.official_url, { headers: fetchHeaders });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const html = await r.text();
        officialContent = `【ホームページ】\n${stripHtml(html, 7000)}`;

        // サブページ探索 と JSONエンドポイント発見を並列実行
        const subUrls = findEpisodeSubpages(html, drama.official_url);
        const [subResults, jsonUrls] = await Promise.all([
          Promise.all(
            subUrls.map(async (subUrl) => {
              try {
                const sr = await fetch(subUrl, { headers: fetchHeaders });
                if (!sr.ok) return null;
                const sh = await sr.text();
                return { url: subUrl, text: stripHtml(sh, 5000) };
              } catch {
                return null;
              }
            })
          ),
          findJsonEndpoints(html, drama.official_url),
        ]);
        for (const sub of subResults) {
          if (!sub) continue;
          subpagesFetched.push(sub.url);
          officialContent += `\n\n【サブページ ${sub.url}】\n${sub.text}`;
        }

        // 発見したJSONエンドポイントを並列取得（軽量・大半は404でも問題なし）
        const jsonResults = await Promise.all(
          jsonUrls.map(async (jurl) => {
            try {
              const jr = await fetch(jurl, { headers: fetchHeaders });
              if (!jr.ok) return null;
              const jt = await jr.text();
              const trimmed = jt.trim();
              if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
              // 最低限の体裁チェック後、生テキストを切り詰めて添付
              return { url: jurl, text: trimmed.substring(0, 5000) };
            } catch {
              return null;
            }
          })
        );
        for (const j of jsonResults) {
          if (!j) continue;
          jsonEndpointsFetched.push(j.url);
          officialContent += `\n\n【データ ${j.url}】\n${j.text}`;
        }

        // サブページから第N話HTML（例: story/6.html）が news.json 内のリンクに見えた場合、追加で取得
        const inlineEpisodeLinkRe = /["']([^"'\s]*\/(?:story|episode|news)[\/_-]?(\d{1,2})(?:\.html?)?)["']/gi;
        const linkMap = new Map<number, string>();
        let lm: RegExpExecArray | null;
        while ((lm = inlineEpisodeLinkRe.exec(officialContent)) !== null) {
          const n = parseInt(lm[2], 10);
          if (n >= 1 && n <= 50) {
            try {
              const abs = new URL(lm[1], drama.official_url).toString();
              if (new URL(abs).hostname === new URL(drama.official_url).hostname) {
                if (!linkMap.has(n)) linkMap.set(n, abs);
              }
            } catch { /* noop */ }
          }
        }
        // 最大話数のリンクのみ取得（既に subpagesFetched に含まれていなければ）
        if (linkMap.size > 0) {
          const maxN = Math.max(...Array.from(linkMap.keys()));
          const targetUrl = linkMap.get(maxN)!;
          if (!subpagesFetched.includes(targetUrl)) {
            try {
              const er = await fetch(targetUrl, { headers: fetchHeaders });
              if (er.ok) {
                const eh = await er.text();
                officialContent += `\n\n【最新話ページ ${targetUrl}】\n${stripHtml(eh, 5000)}`;
                subpagesFetched.push(targetUrl);
              }
            } catch { /* noop */ }
          }
        }
      } catch (e: any) {
        officialFetchError = e.message;
      }
    }

    // 取得済みコンテンツから最新話の番号を抽出
    const extractEpisodeNumber = (text: string): number | null => {
      const numbers: number[] = [];
      const patterns: RegExp[] = [
        /第\s*(\d{1,2})\s*話/g,
        /"episode"\s*:\s*"?(\d{1,2})"?/g,
        /episode[\s:_\-](\d{1,2})/gi,
        /\/(?:story|episode|news|onair)[\/\-_]?(\d{1,2})(?:[/.]|$)/gi,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= 50) numbers.push(n);
        }
      }
      if (numbers.length === 0) return null;
      return Math.max(...numbers);
    };
    const episodeNumber = extractEpisodeNumber(officialContent);

    // コンテンツ密度判定: JSON記号類を除いた純粋テキスト長
    const contentDensity = officialContent.replace(/[{}\[\],:"]/g, '').replace(/\s+/g, ' ').trim().length;

    // 情報が薄い時のSearch Groundingフォールバック
    // 公式サイトから十分な情報が取れなかった場合、Gemini + Google検索で補完
    let groundingNote = '';
    if (contentDensity < 1500) {
      try {
        const groundingModel = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          tools: [{ google_search: {} } as any],
        });
        const gJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const gToday = `${gJst.getFullYear()}年${gJst.getMonth() + 1}月${gJst.getDate()}日(${DOW_LABEL[gJst.getDay()]}曜日)`;
        const epLabel = episodeNumber !== null ? `第${episodeNumber}話` : '最新話';
        const networkLabel = drama.network ? `（${drama.network}）` : '';
        const gPrompt = `今日は **${gToday}**（日本時間）です。今夜（または既に）放送のドラマ「${drama.title}」${networkLabel}の${epLabel}について、必ずGoogle検索で公式サイトや最新ニュースを確認してから以下を箇条書きで300〜600字でまとめてください。
- 第何話か（公式表記そのまま）
- あらすじ（公式サイトの本文に近い形で）
- ゲスト出演者
- 主題歌・OST情報（アーティスト名・曲名）
- 放送時間
- その他話題のポイント

検索しても見つからない項目は推測せず「不明」と明記してください。捏造は厳禁。
今日（${gToday}）放送なので「明日」ではなく「今夜」「本日」基準で書くこと。`;
        const gRes = await groundingModel.generateContent(gPrompt);
        const gText = gRes.response.text();
        if (gText && gText.trim().length > 100) {
          groundingNote = gText.trim().substring(0, 3000);
          officialContent += `\n\n【Google検索による補完情報】\n${groundingNote}`;
        }
      } catch { /* グラウンディング失敗時はメインの生成にそのまま進む */ }
    }

    const airLabel = drama.is_daily
      ? '帯ドラマ（月〜土または毎日放送）'
      : (drama.air_day_of_week !== null && drama.air_day_of_week !== undefined
          ? `${DOW_LABEL[drama.air_day_of_week]}曜${drama.air_time || ''}`
          : '放送時間未定');

    // JSTの日付・曜日を取得（誤認防止のため明示的に展開）
    const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const jstYear = jstNow.getFullYear();
    const jstMonth = jstNow.getMonth() + 1;
    const jstDate = jstNow.getDate();
    const jstDow = jstNow.getDay();
    const jstHour = jstNow.getHours();
    const jstMinute = jstNow.getMinutes();
    const todayLabel = `${jstYear}年${jstMonth}月${jstDate}日(${DOW_LABEL[jstDow]}曜日)`;
    const nowJst = `${todayLabel} ${jstHour}時${String(jstMinute).padStart(2, '0')}分`;

    const episodeHint = episodeNumber !== null
      ? `今夜放送は **第${episodeNumber}話**（取得情報から確定）。tweet_1には必ず「第${episodeNumber}話」を入れること。`
      : '取得情報内に話数の手がかりが見つからない。1から内容を読み込み、明示的な「第N話」表記が無ければ無理に番号を入れない。';

    const prompt = `
あなたはX（旧Twitter）で月100万円以上を稼ぐプロのアフィリエイター、兼SNSアルゴリズム解析者です。
今日の放送予定ドラマについて、視聴者の興味を惹き、かつアフィリエイト収益化もできる投稿案を作成します。

🚨【最初に確実に把握すべき日付】🚨
**今日 = ${todayLabel}**（日本時間／システム時刻、絶対の事実）
**現在時刻 = ${nowJst}**
このcronは**放送日当日の早朝〜夜**に動いているので、放送日＝今日です。
- ❌「明日放送の」「明日5月7日に」などは絶対に書かない（あなたの内部知識上では未来日に見えても、このシステム上は今日です）
- ⭕️ 「今夜」「本日深夜」「今日の23:59から」「今夜の第N話」などの**今日基準の表現**を使う
- 取得した公式サイトのcalendar_date / oa_date等の日付が今日と一致している＝今夜の放送回 と理解すること

【ドラマ情報】
- タイトル: ${drama.title}
- 放送局: ${drama.network || '不明'}
- 放送時間: ${airLabel}
- 公式サイト: ${drama.official_url || 'なし'}
- 季節: ${drama.season || '不明'}
- 取得日時: ${nowJst}
- 話数ヒント: ${episodeHint}

【公式サイトから取得した情報（複数ページ／JSONエンドポイント／Google検索補完を含む）】
${officialContent || '（公式サイト取得不可：' + (officialFetchError || 'URL未登録') + '）'}

🚨【最重要：今日(${todayLabel})が放送日 / 最新話に焦点を合わせる】🚨
このcronは放送日当日に動いている。**ホームページに加えてサブページ（/story/, /news/, /intro/, /next/, /onair/ 等）、JSONデータ（data/news.json, data/story.json, data/next.json 等）、Google検索補完情報を必ず横断的に読み取り、第N話・サブタイトル・あらすじ・ゲスト出演者を抽出**してください。
- 「話数ヒント」に第N話が示されている場合、その番号を**必ず**投稿文に反映すること
- JSONデータ内の「text」「trailer_text」「subtitle」「title」「episode」「oa_date」などのフィールドに本文情報が入っている可能性が極めて高い
- 「次回予告」「あらすじ」「ゲスト」「サブタイトル」「story」「episode」「news」セクションの情報を最優先で投稿に反映
- 例: 「今夜の第${episodeNumber !== null ? episodeNumber : 'N'}話、〇〇がついに△△する展開ヤバい」「今夜のゲストは□□さん！」「次回予告で見せた◯◯のシーンが気になりすぎる」
- 第1話（初回放送）の場合は「ついに今夜スタート」の文脈で
- 最終回付近なら「最終話/最終章」の特別感を強調
- 取得情報を**3回以上熟読**した上で、第N話情報が**本当に1ミリも書かれていない場合のみ**ドラマ全体の見どころに切り替える（安易にフォールバックしない）
- キャスト・原作・主題歌情報がページ内にあるなら必ず拾う（捏造は厳禁、ただし"取れる情報を取り損なうのはもっと致命的"）

🚨【絶対ルール】🚨
1. tweet_1 / tweet_2 / tweet_3 の役割を厳格に分けること（後述）
2. **ドラマ名は正式タイトル「${drama.title}」のみ**を使うこと。tweet本文内でドラマ名を引用・参照する時、放送時間・放送局・キャッチコピー・出演者名・煽り文句等を**絶対に**含めない。
   - ⭕️ 良い例: 「${drama.title}」が今夜23:59に放送スタート！
   - ❌ 悪い例1: 「【木曜23:59放送】${drama.title}（〇〇テレビ）を深掘り！」が今夜放送
   - ❌ 悪い例2: 「【帯ドラマ放送中】${drama.title}（NHK総合）で〇〇が主演！」話題のNHK夜ドラ…
   - ❌ 悪い例3: 「【放送中】${drama.title}」（タイトル前後に【】や（）等の装飾を勝手に付与しない）
   - 後述する title フィールドは**運用者が一覧で見る管理用見出し**。tweet_1/tweet_2/tweet_3 の本文に **冒頭・中間・末尾どこにも** コピーしないこと。
3. 各tweetは**独立した本文**として書く。tweet先頭に「【...】〜」のような見出し風プレフィックスを付けるのは禁止（運用者が後から手作業で付ける）
4. 放送時間（${airLabel}）にも触れること（「今夜21時から」「毎朝8時から」等の自然な表現で）
5. 改行は「\\n」、空白行（1行空け）は「\\n\\n」で出力。空白行を必ず使うこと
6. tweet_2/tweet_3 のアフィリエイトリンク部分は必ず文字列「[アフィリリンク]」をそのまま埋め込む（実URLは絶対に書かない）
7. Amazon案件は末尾に「[ad]」、楽天案件は先頭に「PR」を付与
8. 出力前の自己点検: 各tweetの本文に「【」「】」が含まれていたら、それは管理用見出しの混入なので削除して書き直すこと（ドラマ正式名内に元々含まれる場合のみ例外）

🚨【tweet_1 = アカウント強化用】🚨
リンク・[ad]・PR・アフィ要素を一切含まない、純粋な期待感・感想・問いかけ投稿。
フォロワー獲得・エンゲージメント増加が目的。
例: 「今夜から始まる「${drama.title}」楽しみすぎる…\\n\\n主演◯◯さん、こういう役は初めてじゃない？\\n\\n見る人いる？感想シェアしたい🥰」

🚨【tweet_2 = 原作アフィ用】🚨
ドラマの原作（漫画・小説・コミック等）をAmazon/楽天で購入誘導するアフィ投稿。

- 原作がある場合（漫画・小説原作）:
  「\${ドラマ名}の原作、放送前に読んでおきたい」「\${原作名}気になってた」等の文脈で誘導
  「[アフィリリンク]」プレースホルダ必須、「[ad]」（Amazon）または先頭「PR」（楽天）を付与

- オリジナル脚本で原作がない場合:
  「脚本家◯◯の過去作」「主演◯◯の過去ドラマDVD/Blu-ray」「メイキング本」などへの誘導に切替
  それも厳しい場合は、tweet_2 もリンクなしの純粋な期待感投稿（"原作なしのオリジナル脚本らしい、毎週楽しみ"等）にフォールバック

🚨【tweet_3 = サウンドトラック/主題歌アフィ用】🚨
ドラマのOST・主題歌・劇伴音楽をAmazon/Apple Music/楽天で購入誘導するアフィ投稿。

- 主題歌アーティスト情報があれば「主題歌は◯◯の新曲、CD/配信は[アフィリリンク][ad]」等
- OST情報があれば「サントラ予約開始、[アフィリリンク][ad]」等
- 主題歌情報が皆無な場合は、tweet_3 もリンクなしで「主題歌誰なんだろう？気になる」等の交流型にフォールバック

【その他のフィールド】
- title: **管理画面の一覧で運用者が見る見出し**（※tweet本文ではない。tweet_1〜tweet_3 の本文中に絶対にコピーしないこと）
  - フォーマットは厳密に： **「【\${放送時間}放送】${drama.title}（\${放送局}）」** の3要素のみ
  - **以下は絶対に追加しない**: 出演者名（「〇〇主演」「〇〇が出演」等）、煽り文句（「見逃すな」「深掘り」「衝撃の」等）、ジャンル形容（「衝撃の人間ドラマ」「話題の」等）、感嘆符
  - ⭕️ OK例: 「【月-土 22:45放送】ミッドナイトタクシー（NHK総合）」
  - ❌ NG例1: 「【帯ドラマ放送中】ミッドナイトタクシー（NHK総合）で古川琴音が主演！」← 「で〜主演！」が余計
  - ❌ NG例2: 「【木曜23:59放送】君が死刑になる前に（読売テレビ・日本テレビ系）を深掘り！衝撃の人間ドラマを見逃すな！」← 「を深掘り！」以降が余計
- category: 必ず「ドラマ」固定
- purpose: 「収益特化」（tweet_2 か tweet_3 のいずれかでアフィしている場合）または「シャドウバン対策」（3つ全てリンクなしの場合）
- time_status: 「今すぐ投稿向き」（放送日当日のため基本これ）
- is_safe: 必ず true（ドラマは収益化NG条件に該当しない）
- source_summary: 公式サイトから抽出したあらすじ・見どころを2-3行
- why_now: 「本日\${放送時間}から\${放送局}で放送のため」
- recommended_action: アカウント運用上の戦略
- affiliate_candidates: tweet_2/3で誘導している具体的な案件名（原作漫画◯巻、サントラCD等）
- post_angles: 投稿の切り口を3つ簡潔に（強化用/原作/OST）
- cautions: 注意点（放送時間ズレ、原作未確認等）

必ず以下のJSON形式のみで出力してください：
{
  "is_safe": true,
  "title": "...",
  "category": "ドラマ",
  "purpose": "...",
  "time_status": "今すぐ投稿向き",
  "source_summary": "...",
  "why_now": "...",
  "recommended_action": "...",
  "affiliate_candidates": "...",
  "post_angles": "...",
  "tweet_1": "...",
  "tweet_2": "...",
  "tweet_3": "...",
  "cautions": "..."
}
`;

    const result = await model.generateContent(prompt);
    const responseText = await result.response.text();
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}') + 1;
    const data = JSON.parse(responseText.substring(jsonStart, jsonEnd));

    // 生成titleが本来のフォーマット外の余計な煽り句を含んでいた場合のサニタイズ
    // ドラマ名以降に「を深掘り」「で〇〇主演」「衝撃の」「見逃すな」等が付いていたら切り落とす
    const sanitizeTitle = (raw: string): string => {
      if (!raw) return raw;
      let t = raw.trim();
      // 「）」直後に続く煽り文をカット
      const idx = t.indexOf('）');
      if (idx > 0 && idx < t.length - 1) {
        t = t.substring(0, idx + 1);
      }
      // 末尾の感嘆符・絵文字を削除
      t = t.replace(/[！!♪🔥📺⚡️😭👇🆓😆🤔💦😱🚗💨🥰]+$/u, '').trim();
      return t;
    };
    data.title = sanitizeTitle(data.title || '');

    // tweet本文の冒頭に管理用見出し（titleフィールドや「【...】〜（...）」風プレフィックス）が
    // コピーされていた場合に剥がす
    const stripHeaderPrefix = (tweet: string, titleStr: string): string => {
      if (!tweet) return tweet;
      let t = tweet.trim();
      // 1) titleフィールド全文がそのまま冒頭にあれば除去
      if (titleStr && t.startsWith(titleStr)) {
        t = t.substring(titleStr.length).trim();
      }
      // 2) 「【...】〜...（〇〇テレビ）...」のような管理用ヘッダ形式を冒頭から1つ除去
      //    ドラマ名「${drama.title}」より長くて「【...】」を含むプレフィックスが先頭にある時のみ
      const headerRe = /^[「『]?【[^】]{1,50}】[^「『\n]{1,80}（[^）\n]{1,30}）[^\n「『]{0,80}[」』]?[\s、。！!]*/u;
      const m = t.match(headerRe);
      if (m && m[0].length > drama.title.length + 5 && m[0].length < t.length) {
        t = t.substring(m[0].length).trim();
      }
      return t;
    };
    data.tweet_1 = stripHeaderPrefix(data.tweet_1 || '', data.title);
    data.tweet_2 = stripHeaderPrefix(data.tweet_2 || '', data.title);
    data.tweet_3 = stripHeaderPrefix(data.tweet_3 || '', data.title);

    // postsテーブルに保存
    const postUrl = drama.official_url || `https://www.crank-in.net/drama/${drama.season || ''}`;
    const { error: insertError } = await supabase.from('posts').insert([{
      title: data.title,
      category: 'ドラマ',
      purpose: data.purpose,
      time_status: data.time_status,
      source_summary: data.source_summary,
      why_now: data.why_now,
      recommended_action: data.recommended_action,
      affiliate_candidates: data.affiliate_candidates,
      post_angles: data.post_angles,
      tweet_1: data.tweet_1,
      tweet_2: data.tweet_2,
      tweet_3: data.tweet_3,
      cautions: data.cautions,
      original_url: postUrl,
    }]);

    if (insertError) throw insertError;

    // dramas.last_processed_at 更新 + queue を done に
    await supabase.from('dramas').update({ last_processed_at: new Date().toISOString() }).eq('id', drama.id);
    await supabase.from('drama_queue').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', queueRow.id);

    return NextResponse.json({
      success: true,
      drama: drama.title,
      official_fetch: officialContent ? 'ok' : `failed: ${officialFetchError || 'no url'}`,
      subpages_fetched: subpagesFetched,
      json_endpoints_fetched: jsonEndpointsFetched,
      episode_number: episodeNumber,
      content_density: contentDensity,
      grounding_used: groundingNote.length > 0,
    });
    } catch (innerErr: any) {
      // 処理途中で失敗したらキューを failed にマーク
      await supabase.from('drama_queue')
        .update({ status: 'failed', error_message: innerErr.message?.substring(0, 500) || 'unknown', processed_at: new Date().toISOString() })
        .eq('id', queueRow.id);
      return NextResponse.json({ success: false, drama: drama.title, error: innerErr.message }, { status: 500 });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
