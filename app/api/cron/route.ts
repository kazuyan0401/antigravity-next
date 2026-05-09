import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { enforceTweetLengths } from '@/app/lib/tweet-shrink';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type SourceDef = {
  name: string;
  url: string;
  type: string;
  // true なら URL を fetch せず Gemini Grounding でキーワードをリサーチして
  // その結果を contentText として本投稿生成に渡す
  isResearch?: boolean;
};

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!supabaseUrl || !supabaseKey || !geminiKey) throw new Error("環境変数不足");

    const supabase = createClient(supabaseUrl, supabaseKey);
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
    const parser = new Parser();

    // 🌟 日本時間の「時」と「分」を取得
    const jstDate = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
    const currentHour = jstDate.getHours();
    const currentMinute = jstDate.getMinutes();
    const todayLabel = `${jstDate.getFullYear()}年${jstDate.getMonth() + 1}月${jstDate.getDate()}日`;

    // 🌟 共通ボット対策ヘッダー
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache"
    };

    // 🌟 15分tickごとにカテゴリを固定して順送り巡回
    // tick 0 (00-14分): TV系
    // tick 1 (15-29分): トレンド系（リサーチワークフロー）
    // tick 2 (30-44分): エンタメニュース1
    // tick 3 (45-59分): エンタメニュース2
    // 昨日の日付（JST）を YYYY-MM-DD で生成（trend-calendar.com の日別アーカイブURL用）
    // 当日URLは集計が完了するまで404を返すことが多いため、安定して取れる前日を使う
    const yJst = new Date(jstDate.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = `${yJst.getFullYear()}-${String(yJst.getMonth() + 1).padStart(2, '0')}-${String(yJst.getDate()).padStart(2, '0')}`;
    const trendCalendarUrl = `https://jp.trend-calendar.com/trend/${yesterdayStr}.html`;

    const SCHEDULE: SourceDef[][] = [
      [
        { name: "価格.com テレビ紹介", url: "https://kakaku.com/tv/", type: "scraping_kakaku" },
        { name: "TVでた蔵", url: "https://datazoo.jp/", type: "scraping_datazoo" },
      ],
      // 🌟 トレンド系：Xを倍にして強化（live + アーカイブ）。各サイクル4源中2源がX
      [
        { name: "Xトレンド (live)", url: "https://twittrend.jp/", type: "scraping_x", isResearch: true },
        { name: "Xトレンド (アーカイブ)", url: trendCalendarUrl, type: "scraping_tc_x", isResearch: true },
        { name: "トレンドカレンダー Yahoo", url: trendCalendarUrl, type: "scraping_tc_yahoo", isResearch: true },
        { name: "トレンドカレンダー Google", url: trendCalendarUrl, type: "scraping_tc_google", isResearch: true },
        { name: "Yahoo!リアルタイム", url: "https://search.yahoo.co.jp/realtime", type: "scraping_yahoo_rt", isResearch: true },
        { name: "Googleトレンド", url: "https://trends.google.co.jp/trending/rss?geo=JP", type: "rss", isResearch: true },
      ],
      [
        { name: "コミックナタリー", url: "https://natalie.mu/comic/feed/news", type: "rss" },
        { name: "音楽ナタリー", url: "https://natalie.mu/music/feed/news", type: "rss" },
        { name: "シネマトゥデイ", url: "https://www.cinematoday.jp/index.xml", type: "rss" },
        { name: "モデルプレス", url: "https://feed.mdpr.jp/rss/export/mdpr-entertainment.xml", type: "rss" },
      ],
      [
        { name: "Yahoo!エンタメ", url: "https://news.yahoo.co.jp/rss/topics/entertainment.xml", type: "rss" },
        { name: "Yahoo!IT", url: "https://news.yahoo.co.jp/rss/topics/it.xml", type: "rss" },
        { name: "PR TIMES", url: "https://prtimes.jp/index.rdf", type: "rss" },
        { name: "ねとらぼ", url: "https://rss.itmedia.co.jp/rss/2.0/nlab.xml", type: "rss" },
      ],
    ];

    const tick = Math.floor(currentMinute / 15); // 0..3
    let source: SourceDef;
    if (currentHour === 7 && tick === 0) {
      // 朝7時00分台のみ Gガイド を特例で巡回
      source = { name: "Gガイド番組表", url: "https://bangumi.org/epg/td?ggm_group_id=42", type: "scraping_tv" };
    } else {
      const lane = SCHEDULE[tick];
      source = lane[currentHour % lane.length];
    }

    let addedCount = 0;
    const MAX_PROCESS = 1;

    console.log(`パトロール開始: ${source.name} (tick=${tick}, hour=${currentHour})`);

    let items: { title: string; url: string; keyword?: string }[] = [];
    try {
      if (source.type === "rss") {
        const feed = await parser.parseURL(source.url);
        items = feed.items.slice(0, 10).map((i: any) => ({
          title: source.isResearch ? `${source.name}: ${i.title}` : (i.title || ''),
          url: i.link || '',
          keyword: source.isResearch ? (i.title || '') : undefined,
        }));
      } else if (source.type === "scraping_x") {
        const res = await fetch(source.url, { headers: fetchHeaders });
        const html = await res.text();
        const matches = html.match(/class="td_list">([\s\S]*?)<\/div>/g) || [];
        items = matches.slice(0, 10).map(m => {
          const kw = m.replace(/<[^>]*>/g, '').trim();
          return {
            title: `Xトレンド: ${kw}`,
            url: `https://x.com/search?q=${encodeURIComponent(kw)}`,
            keyword: kw,
          };
        });
      } else if (source.type === "scraping_tv") {
        const res = await fetch(source.url, { headers: fetchHeaders });
        const html = await res.text();
        const programMatches = html.match(/\/epg\/show\/(\w+)/g) || [];
        const uniqueLinks = Array.from(new Set(programMatches)).slice(0, 10);
        items = uniqueLinks.map(link => ({ title: "テレビ番組特集", url: `https://bangumi.org${link}` }));
      } else if (source.type === "scraping_kakaku") {
        const res = await fetch(source.url, { headers: fetchHeaders });
        const arrayBuffer = await res.arrayBuffer();
        const decoder = new TextDecoder('shift-jis');
        const html = decoder.decode(arrayBuffer);
        const matches = html.match(/<a href="\/tv\/[^>]+>([^<]+)<\/a>/g) || [];
        const validMatches = matches.filter(m => !m.includes('詳細') && !m.includes('画像')).slice(0, 10);
        items = validMatches.map(m => {
          const titleMatch = m.match(/>([^<]+)</);
          return { title: `📺 TV紹介: ${titleMatch ? titleMatch[1].trim() : '注目商品'}`, url: source.url };
        });
      } else if (source.type === "scraping_datazoo") {
        const res = await fetch(source.url, { headers: fetchHeaders });
        const html = await res.text();
        const rawMatches = html.match(/<a[^>]*>([\s\S]*?)<\/a>/g) || [];
        const validMatches = rawMatches
          .map(m => m.replace(/<[^>]+>/g, '').replace(/&[a-zA-Z0-9#]+;/g, ' ').replace(/\s+/g, ' ').trim())
          .filter(text => text.length >= 12 && text.length <= 60 && !text.includes('ログイン') && !text.includes('番組表') && !text.includes('でた蔵') && !text.includes('プライバシー') && !text.includes('ページトップ') && !text.includes('企業様') && !text.includes('トライアル') && !text.includes('利用規約') && !text.includes('お問い合わせ') && !text.includes('ご利用') && !text.includes('■'))
          .slice(0, 10);
        items = validMatches.map(text => ({ title: `📺 でた蔵: ${text}`, url: source.url }));
      } else if (source.type === "scraping_yahoo_rt") {
        const res = await fetch(source.url, { headers: fetchHeaders });
        const html = await res.text();
        const rawMatches = html.match(/href="\/realtime\/search\?p=([^"&]+)/g) || [];
        const uniqueKeywords = Array.from(new Set(rawMatches.map(m => decodeURIComponent(m.replace('href="/realtime/search?p=', '')))));
        items = uniqueKeywords.slice(0, 10).map(kw => ({
          title: `🔍 Yahooリアルタイム: ${kw}`,
          url: `https://search.yahoo.co.jp/realtime/search?p=${encodeURIComponent(kw)}`,
          keyword: kw,
        }));
      } else if (source.type === "scraping_tc_x" || source.type === "scraping_tc_yahoo" || source.type === "scraping_tc_google") {
        // trend-calendar.com の日別アーカイブから X / Yahoo / Google それぞれのセクションを抽出
        const res = await fetch(source.url, { headers: fetchHeaders });
        if (!res.ok) {
          // 当日分が未公開の場合は何も拾えない（404 等）
          items = [];
        } else {
          const html = await res.text();
          const sectionId = source.type === "scraping_tc_x"
            ? 'twitter'
            : source.type === "scraping_tc_yahoo"
              ? 'yahoo'
              : 'google';
          // 後続セクション（他のid=...）か、次のh2/h3、または記事終端まで
          const sectionRe = new RegExp(`<div id="${sectionId}">[\\s\\S]*?(?=<div id="(?:twitter|yahoo|google)"|<h2|<h3|<aside|</article>)`);
          const sm = html.match(sectionRe);
          const labelMap: Record<string, string> = {
            scraping_tc_x: 'Xトレンド(アーカイブ)',
            scraping_tc_yahoo: 'Yahooトレンド(アーカイブ)',
            scraping_tc_google: 'Googleトレンド(アーカイブ)',
          };
          const searchHostMap: Record<string, (kw: string) => string> = {
            scraping_tc_x: kw => `https://x.com/search?q=${encodeURIComponent(kw)}`,
            scraping_tc_yahoo: kw => `https://search.yahoo.co.jp/realtime/search?p=${encodeURIComponent(kw)}`,
            scraping_tc_google: kw => `https://www.google.com/search?q=${encodeURIComponent(kw)}`,
          };
          if (sm) {
            const section = sm[0];
            // <a href="https://twitter.com/search?q=...">キーワード</a> 形式のリンクテキストを抽出
            const linkRe = /<a[^>]+href="(?:https?:[^"]+)"[^>]*>([^<]{1,80})<\/a>/g;
            const decodeEntities = (s: string) => s
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&nbsp;/g, ' ');
            const keywords: string[] = [];
            let lm: RegExpExecArray | null;
            while ((lm = linkRe.exec(section)) !== null) {
              const kw = decodeEntities(lm[1]).trim();
              if (kw && !keywords.includes(kw)) keywords.push(kw);
              if (keywords.length >= 15) break;
            }
            const buildUrl = searchHostMap[source.type];
            const labelPrefix = labelMap[source.type];
            items = keywords.slice(0, 10).map(kw => ({
              title: `${labelPrefix}: ${kw}`,
              url: buildUrl(kw),
              keyword: kw,
            }));
          } else {
            items = [];
          }
        }
      }
    } catch (e) {
      console.error(`${source.name} 取得失敗`, e);
      return NextResponse.json({ success: false, error: `${source.name} 取得失敗: ${(e as any)?.message}` });
    }

    // 🌟 重複判定: original_url完全一致 OR タイトル前方類似 AND 6時間以内 でスキップ
    // （以前は24h窓だったが「同じカード3連戦」「連日のトレンド」を取りこぼしていた）
    const dedupWindow = 6 * 60 * 60 * 1000; // 6時間
    let processedItem: any = null;
    for (const item of items) {
      if (addedCount >= MAX_PROCESS) break;
      const url = item.url || "";
      const title = item.title || "";

      const superCleanTitle = title.replace(/[^぀-ゟ゠-ヿ一-鿿0-9a-zA-Z]/g, '').substring(0, 10);
      const { data: existing } = await supabase.from('posts').select('id').eq('original_url', url).single();
      const { data: similar } = await supabase
        .from('posts')
        .select('id')
        .ilike('title', `%${superCleanTitle}%`)
        .gte('created_at', new Date(Date.now() - dedupWindow).toISOString());

      if (existing || (similar && similar.length > 0)) {
        console.log(`重複スキップ: ${title}`);
        continue;
      }

      processedItem = item;
      break;
    }

    if (!processedItem) {
      return NextResponse.json({ success: true, message: '新規ネタなし（全件重複）', source: source.name });
    }

    const url = processedItem.url || "";
    const title = processedItem.title || "";
    const keyword = processedItem.keyword;

    // 🌟 contentText の取得：リサーチ系は Gemini Grounding でキーワードを調査、
    // それ以外は URL を fetch して HTML→テキスト整形
    let contentText = "";
    if (source.isResearch && keyword) {
      try {
        const groundingModel = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          tools: [{ google_search: {} } as any],
        });
        const researchPrompt = `今日 ${todayLabel} に日本のSNS／検索トレンドで「${keyword}」が話題になっています。Google検索でこのキーワードがなぜ今話題なのか、関連する人物・商品・コンテキスト・最新ニュースを調べて、500〜1000字で日本語要約してください。
- いつから話題か（昨日／今日／今週など）
- 何が起こっているか（事件、発売、出演、発表、放送、ライブ、新作リリース等を具体的に）
- 関連する人名／商品名／番組名／作品名／固有名詞
- アフィリエイト的に注目すべき要素（テレビ出演、新作、ライブ、イベント、書籍、サントラ、ドラマ／映画化、配信開始等）

検索しても明確な話題が見つからない場合は冒頭に「【話題の特定不可】」と書いてください。捏造禁止、検索結果のみ参照。`;
        const gRes = await groundingModel.generateContent(researchPrompt);
        contentText = gRes.response.text().trim().substring(0, 4000);
        console.log(`リサーチ完了: ${keyword} (${contentText.length}字)`);
      } catch (e: any) {
        console.error('Groundingリサーチ失敗', e);
        contentText = `【リサーチ失敗】キーワード「${keyword}」のリサーチに失敗しました。理由: ${e?.message || 'unknown'}`;
      }
    } else {
      try {
        const pageRes = await fetch(url, { headers: fetchHeaders });
        const html = await pageRes.text();
        contentText = html
          .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
          .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "")
          .replace(/<[^>]*>?/gm, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 3000);
      } catch (e) {
        contentText = "詳細取得失敗";
      }
    }

    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const prompt = `
あなたはX（旧Twitter）で月100万円以上を稼ぐプロのアフィリエイター、兼SNSアルゴリズム解析者です。
以下の情報を分析し、JSONで出力してください。

🚨【STEP0：アカウントの世界観チェック（保存可否の判定）】🚨
以下の条件に当てはまるニュースは、エンタメ・トレンド系のアフィリエイトアカウントの投稿として不自然（ノイズ）になるため、必ず "is_safe": false を出力し、以降の処理を中止してください。
❌ 保存してはいけないニュース（is_safeをfalseにする）
1. 企業向けのプレスリリース（BtoB商材、販売代理店募集、業務提携、決算発表など）
2. マーケティング調査・アンケートレポート（「〇〇市場が拡大」「中国SNSで人気」などの業界向けニュース）
3. NPO法人の活動、政治・経済の硬すぎるニュース、事件・事故・災害のネガティブなニュース
4. リサーチ結果が「【話題の特定不可】」または「【リサーチ失敗】」で始まる場合（情報不足のため）

🚨【STEP1：収益化判定（最重要の絶対ルール）】🚨
まず、このニュースでアフィリエイトを行うかどうかの「判定」を厳格に行ってください。
以下の【収益化NG条件】に1つでも当てはまる場合は、必ず目的を「シャドウバン対策」にしてください。

❌【収益化NG条件（これらはアフィリエイト絶対禁止！）】
1. ニュースの事件・事故、またはドラマのストーリーに対する無理な関連商品のこじつけ（※有働アナのニュースだから過去の出演作を売る等はNG）
2. 芸能人や有名人のプライベートな話題（結婚、出産、育児、日常のつぶやき等）
3. 具体的な関連商品が自然に紹介できないもの

⭕️【収益化OK条件（これらには積極的にアフィリエイトを実施！）】
・【超重要】旅行番組や街ブラ番組のロケ地（放送前であっても、楽天トラベルのガイド記事や周辺ホテルへ積極的に誘導すること！）
・今日〜数日以内に配信・放送されるスポーツや特番（VODへ誘導）
・実際に話題になっている、またはテレビで紹介予定の具体的な商品・アイテム
・アーティストの楽曲解禁やライブ情報（過去のDVD等へ誘導）

🚨【案件選定とリンク出力の絶対ルール】🚨
1. 【紹介先プラットフォームの固定】：提案する案件は必ず「楽天（楽天市場、楽天トラベル等）」「Amazon」「主要VOD」のいずれかにしてください。企業独自の公式ECサイト（ベルメゾン公式、ナイキ公式など）への誘導は、運用者がアフィリエイトリンクを作れないため絶対に避けてください。公式のニュースであっても「楽天内の公式ショップ」などを想定してツイートを作成してください。
2. 【プレースホルダーの維持】：ツイート文中にURLを入れる箇所は、記事内の実際のURLを勝手に入れないでください。後で運用者が自身のアフィリエイトリンクに差し替えるため、必ず「[アフィリリンク]」という文字列そのものを出力してください。

🚨【TV・メディア露出時の絶対ルール（超重要）】🚨
情報源が「TVでた蔵」「価格.com」などのテレビ関連ネタである場合、以下のすべての項目において「具体的なテレビ番組名」と「放送時期（今日など）」を必ず明記してください。
1. タイトル (title): 「【〇〇(番組名)で紹介】話題の〇〇...」のように、番組名を目立たせる形式にすること。
2. 今注目する理由 (why_now): 「本日放送の〇〇（番組名）で紹介され、検索需要が急増しているため」など、テレビの影響であることを明記すること。
3. ツイート本文 (tweet_1, tweet_2): 型の(話題のニュースの要約)部分等で、必ず「今日の『〇〇（番組名）』で紹介されてた」等と番組名を出し、テレビの権威性を借りて読者の興味を惹く構成にすること。
※万が一、情報の中に具体的な番組名が含まれていない場合は「今日のテレビ番組で紹介され〜」と自然に補って作成すること。
※ツイートが複数ある場合、それぞれ異なる切り口・言い回し・絵文字を使用して、人間味のある多様な表現にすること（テンプレの使い回し厳禁）。

◆判定が「シャドウバン対策」の場合：
後述の【型】は完全に無視してください。アフィリリンク、[ad]、PRなどの広告要素は【絶対に使用禁止】です。tweet_1 〜 tweet_3 のすべてを、リンクを含まない「純粋な感想」や「フォロワーへの問いかけ」にしてください。

🚨【絶対ルール：文字数上限120文字（X規約厳守）】🚨
tweet_1 / tweet_2 / tweet_3 の本文は **必ず合計120文字以内** に収めること。
- カウント対象は実際に投稿される全文字（改行「\\n」も1文字、絵文字も1文字、「[アフィリリンク]」は9文字、「[ad]」は4文字、「PR」は2文字）
- 121文字以上の出力は禁止。型に全部入れて超える場合は、枕詞や語尾、補足を削って字数優先で再構成すること
- 出力前に必ず自分で文字数を数え、超えていたらより短い表現に作り直してから出力

【🌟超実戦的！クリックが取れる投稿の型（収益化用のみ）】
[フック - 改行 - 商品紹介 - リンク - 補足 - 感想]
※120文字制限が最優先なので、超える場合は型のセクションを省略してでも字数を守ること。

【現在の元タイトル】${title}
${keyword ? `【元キーワード（トレンド）】${keyword}\n` : ''}
【取得情報（${source.isResearch ? 'Google検索リサーチ結果' : 'ページ抽出テキスト'}）】
${contentText}

現在時刻: ${now}（日本時間）

必ず以下のJSON形式のみで出力してください。ツイート案の中の改行は必ず「\\n」を使って表現してください。
🚨【出力ルール】出力は純粋なJSONオブジェクト1個だけ。前置き、後書き、\`\`\`json などのマークダウン装飾、引用元の脚注、説明文は一切含めないこと。
{
  "is_safe": boolean,
  "title": "タイトル",
  "category": "番組/スポーツ/音楽/セール/ニュース/芸能/配信作品/その他",
  "purpose": "収益特化 または シャドウバン対策",
  "time_status": "先回り向き/今すぐ投稿向き/放送後向き/後追い向き",
  "source_summary": "要約",
  "why_now": "理由",
  "recommended_action": "戦略（シャドウバン対策の場合はその旨を記載）",
  "affiliate_candidates": "具体的な案件名（シャドウバン対策の場合は「なし」）",
  "post_angles": "切り口",
  "tweet_1": "投稿案1（必ず120文字以内。収益化なら型を使用。シャドウバン対策ならリンク・タグなしの純粋なつぶやき）",
  "tweet_2": "投稿案2（必ず120文字以内。収益化なら型を使用。シャドウバン対策ならリンク・タグなしの純粋なつぶやき）",
  "tweet_3": "投稿案3（必ず120文字以内。完全な交流・問いかけ用。リンク・タグなし）",
  "cautions": "注意点"
}
`;

    const result = await model.generateContent(prompt);
    const responseText = await result.response.text();
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}') + 1;
    const data = JSON.parse(responseText.substring(jsonStart, jsonEnd));

    if (!data.is_safe) {
      console.log(`is_safe=false でスキップ: ${title}`);
      return NextResponse.json({ success: true, message: 'is_safe=falseでスキップ', source: source.name, title });
    }

    const enforced = await enforceTweetLengths(genAI, {
      tweet_1: data.tweet_1,
      tweet_2: data.tweet_2,
      tweet_3: data.tweet_3,
    });

    const insertData = {
      title: data.title,
      category: data.category,
      purpose: data.purpose,
      time_status: data.time_status,
      source_summary: data.source_summary,
      why_now: data.why_now,
      recommended_action: data.recommended_action,
      affiliate_candidates: data.affiliate_candidates,
      post_angles: data.post_angles,
      tweet_1: enforced.tweet_1,
      tweet_2: enforced.tweet_2,
      tweet_3: enforced.tweet_3,
      cautions: data.cautions,
      original_url: url,
    };

    const { error: insertError } = await supabase.from('posts').insert([insertData]);
    if (insertError) throw insertError;

    addedCount++;
    return NextResponse.json({
      success: true,
      source: source.name,
      tick,
      added: addedCount,
      title: data.title,
      research_used: source.isResearch === true,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
