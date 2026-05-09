import { GoogleGenerativeAI } from '@google/generative-ai';
import { enforceTweetLengths } from './tweet-shrink';
import { enforceTweetMinLengths } from './tweet-expand';

export type DramaRecord = {
  id: number | string;
  title: string;
  network: string | null;
  official_url: string | null;
  air_day_of_week: number | null;
  is_daily: boolean | null;
  air_time: string | null;
  season: string | null;
};

export type DramaProcessResult = {
  title: string;
  category: string;
  purpose: string;
  time_status: string;
  source_summary: string;
  why_now: string;
  recommended_action: string;
  affiliate_candidates: string;
  post_angles: string;
  tweet_1: string;
  tweet_2: string;
  tweet_3: string;
  cautions: string;
  original_url: string;
  meta: {
    subpages_fetched: string[];
    json_endpoints_fetched: string[];
    episode_number: number | null;
    content_density: number;
    grounding_used: boolean;
    official_fetch: string;
  };
};

const fetchHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

const DOW_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

const stripHtml = (html: string, maxLen: number) =>
  html
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, '')
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, '')
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);

const findEpisodeSubpages = (homeHtml: string, baseUrl: string): string[] => {
  const baseObj = new URL(baseUrl);
  const baseHomeNorm = (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toLowerCase();
  const hrefs: string[] = [];
  const hrefRe = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(homeHtml)) !== null) hrefs.push(m[1]);
  const sameDomain: string[] = [];
  for (const h of hrefs) {
    if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:')) continue;
    if (/\.(css|js|png|jpe?g|gif|svg|ico|webp|mp4|woff2?)(\?|$)/i.test(h)) continue;
    let full: string;
    try { full = new URL(h, baseUrl).toString(); } catch { continue; }
    try { if (new URL(full).hostname !== baseObj.hostname) continue; } catch { continue; }
    const norm = (full.endsWith('/') ? full : full + '/').toLowerCase();
    if (norm === baseHomeNorm) continue;
    sameDomain.push(full);
  }
  type Item = { url: string; score: number; key: string; num: number };
  const items: Item[] = [];
  for (const url of sameDomain) {
    const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
    let score = 0;
    let key = '';
    let num = 0;
    const numbered = path.match(/\/(story|stories|episode|episodes|onair|onair_story|news\/news|story\/story|episode\/episode)[\/\-_]*(\d{1,2})(?:\/|\.html?|$)/);
    if (numbered) {
      num = parseInt(numbered[2], 10);
      if (num >= 1 && num <= 50) {
        score = 110;
        key = `numbered:${numbered[1].split('/')[0]}`;
      }
    }
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
  const byKey = new Map<string, Item>();
  for (const it of items) {
    const ex = byKey.get(it.key);
    if (!ex) { byKey.set(it.key, it); continue; }
    if (it.key.startsWith('numbered:')) {
      if (it.num > ex.num) byKey.set(it.key, it);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score).slice(0, 4).map((it) => it.url);
};

const findJsonEndpoints = async (homeHtml: string, baseUrl: string): Promise<string[]> => {
  const baseObj = new URL(baseUrl);
  const basePath = baseObj.pathname.endsWith('/') ? baseObj.pathname : baseObj.pathname + '/';
  const isInScope = (absUrl: string): boolean => {
    try {
      const u = new URL(absUrl);
      if (u.hostname !== baseObj.hostname) return false;
      return u.pathname.startsWith(basePath);
    } catch { return false; }
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
      if (p.startsWith('//')) continue;
      try {
        const abs = new URL(p, baseUrl).toString();
        if (isInScope(abs)) candidates.add(abs);
      } catch { /* noop */ }
    }
  };
  scanForJson(homeHtml);
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
  for (const p of ['data/news.json', 'data/story.json', 'data/next.json', 'data/cast.json', 'data/intro.json', 'data/topics.json']) {
    try { candidates.add(new URL(p, baseUrl).toString()); } catch { /* noop */ }
  }
  return Array.from(candidates).slice(0, 10);
};

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

// 過去の生成で膨れた title を正式名のみに圧縮するための強力サニタイザ
// ・タイトル全文 → 「【放送時間】正式名（放送局）」のみに切り戻す
// ・既に正式名前後に「で〇〇主演」「を深掘り」「衝撃の〜」等が付いている場合も剥がす
const collapseToCleanTitle = (raw: string, formalName: string, network: string | null, airLabel: string): string => {
  // どんな入力が来ても、強制的に運用フォーマットに作り変える
  const cleanNetwork = (network || '').replace(/[（）()]/g, '').trim();
  if (!formalName) return raw || '';
  if (cleanNetwork) return `【${airLabel}放送】${formalName}（${cleanNetwork}）`;
  return `【${airLabel}放送】${formalName}`;
};

// tweet本文に管理用見出しがコピーされていたら剥がす（formalNameより長い管理用プレフィックスのみ除去）
const stripHeaderPrefix = (tweet: string, titleStr: string, formalName: string): string => {
  if (!tweet) return tweet;
  let t = tweet.trim();
  if (titleStr && t.startsWith(titleStr)) {
    t = t.substring(titleStr.length).trim();
  }
  // 二重 【【...】〜】 でも剥がせるよう、繰り返しチェック
  for (let i = 0; i < 3; i++) {
    const headerRe = /^[「『]?【[^】]{1,80}】[^「『\n]{0,120}[」』]?[\s、。！!]*/u;
    const m = t.match(headerRe);
    if (m && m[0].length > formalName.length + 3 && m[0].length < t.length) {
      t = t.substring(m[0].length).trim();
      continue;
    }
    break;
  }
  return t;
};

export async function processDrama(
  drama: DramaRecord,
  genAI: GoogleGenerativeAI,
): Promise<DramaProcessResult> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  // 公式サイト取得 + サブページ + JSONデータ
  let officialContent = '';
  let officialFetchError = '';
  const subpagesFetched: string[] = [];
  const jsonEndpointsFetched: string[] = [];
  if (drama.official_url) {
    try {
      const r = await fetch(drama.official_url, { headers: fetchHeaders });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      officialContent = `【ホームページ】\n${stripHtml(html, 7000)}`;
      const subUrls = findEpisodeSubpages(html, drama.official_url);
      const [subResults, jsonUrls] = await Promise.all([
        Promise.all(subUrls.map(async (subUrl) => {
          try {
            const sr = await fetch(subUrl, { headers: fetchHeaders });
            if (!sr.ok) return null;
            const sh = await sr.text();
            return { url: subUrl, text: stripHtml(sh, 5000) };
          } catch { return null; }
        })),
        findJsonEndpoints(html, drama.official_url),
      ]);
      for (const sub of subResults) {
        if (!sub) continue;
        subpagesFetched.push(sub.url);
        officialContent += `\n\n【サブページ ${sub.url}】\n${sub.text}`;
      }
      const jsonResults = await Promise.all(jsonUrls.map(async (jurl) => {
        try {
          const jr = await fetch(jurl, { headers: fetchHeaders });
          if (!jr.ok) return null;
          const jt = await jr.text();
          const trimmed = jt.trim();
          if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
          return { url: jurl, text: trimmed.substring(0, 5000) };
        } catch { return null; }
      }));
      for (const j of jsonResults) {
        if (!j) continue;
        jsonEndpointsFetched.push(j.url);
        officialContent += `\n\n【データ ${j.url}】\n${j.text}`;
      }
      // 最新話ページを追加取得
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

  const episodeNumber = extractEpisodeNumber(officialContent);
  const contentDensity = officialContent.replace(/[{}\[\],:"]/g, '').replace(/\s+/g, ' ').trim().length;

  // Search Groundingフォールバック
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
    } catch { /* noop */ }
  }

  const airLabel = drama.is_daily
    ? '帯ドラマ（月〜土または毎日放送）'
    : (drama.air_day_of_week !== null && drama.air_day_of_week !== undefined
        ? `${DOW_LABEL[drama.air_day_of_week]}曜${drama.air_time || ''}`
        : '放送時間未定');

  const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayLabel = `${jstNow.getFullYear()}年${jstNow.getMonth() + 1}月${jstNow.getDate()}日(${DOW_LABEL[jstNow.getDay()]}曜日)`;
  const nowJst = `${todayLabel} ${jstNow.getHours()}時${String(jstNow.getMinutes()).padStart(2, '0')}分`;

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
- ❌「明日放送の」「明日5月7日に」などは絶対に書かない
- ⭕️ 「今夜」「本日深夜」「今日の23:59から」「今夜の第N話」などの**今日基準の表現**を使う

【ドラマ情報】
- ドラマ正式タイトル: ${drama.title}（**この文字列のみがドラマ名。他の語句を一括りにしてはいけない**）
- 放送局: ${drama.network || '不明'}
- 放送時間: ${airLabel}
- 公式サイト: ${drama.official_url || 'なし'}
- 季節: ${drama.season || '不明'}
- 取得日時: ${nowJst}
- 話数ヒント: ${episodeHint}

【公式サイトから取得した情報（複数ページ／JSONエンドポイント／Google検索補完を含む）】
${officialContent || '（公式サイト取得不可：' + (officialFetchError || 'URL未登録') + '）'}

🚨【ドラマ名の引用に関する絶対ルール】🚨
ドラマの名前として書いてよいのは **「${drama.title}」のみ** です。これ以外の文字列を「ドラマ名」として扱ってはいけません。
- 入力に「【〇〇放送中】${drama.title}（局）で〇〇主演」のような長い文字列が含まれていても、それは過去の管理用見出しであって**ドラマ名ではありません**
- tweet本文でドラマ名を引用する時は、必ず「${drama.title}」だけを「」（または『』）で括る
- 「【」で始まる管理用ヘッダ風文字列を tweet 本文の冒頭・中間・末尾どこにもコピーしないこと

🚨【絶対ルール】🚨
1. tweet_1 / tweet_2 / tweet_3 の役割を厳格に分けること（後述）
2. **tweet本文中のドラマ名は正式タイトル「${drama.title}」のみ**を使うこと。装飾語句（放送時間・放送局・出演者名・煽り句等）を一括りにしない。
3. 各tweetは**独立した本文**として書く。tweet先頭に「【...】〜」のような見出し風プレフィックスを付けるのは禁止
4. 放送時間（${airLabel}）にも触れること（「今夜21時から」「毎朝22:45から」等の自然な表現で）
5. 改行は「\\n」、空白行（1行空け）は「\\n\\n」で出力。空白行を必ず使うこと
6. tweet_2/tweet_3 のアフィリエイトリンク部分は必ず文字列「[アフィリリンク]」をそのまま埋め込む（実URLは絶対に書かない）
7. Amazon案件は末尾に「[ad]」、楽天案件は先頭に「PR」を付与
8. **出力前の自己点検**: 各tweetに「【」が含まれていたら、それは管理用見出しの混入なので削除して書き直すこと
9. 🚨**文字数レンジ100〜120字（X規約厳守 & 中身担保）**🚨：tweet_1 / tweet_2 / tweet_3 はそれぞれ単独で **必ず100文字以上120文字以内** に収めること。
   - **下限100文字、上限120文字**（リンクありなしに関わらず全て同じ基準）
   - 改行「\\n」も1文字、絵文字も1文字、「[アフィリリンク]」は9文字、「[ad]」は4文字、「PR」は2文字としてカウント
   - 121文字以上は絶対NG、99文字以下も絶対NG（中身がスカスカで誰の何の話か伝わらない）
   - 出力前に必ず自分で文字数を数え、100字未満なら情報を足し（あらすじ/見どころ/共感ポイント/具体的シーン/放送回見どころ）、120字超なら語尾・修飾語・空白行を削って詰める
   - ❌ 実例NG: 「主題歌誰なんだろう？気になる」(15字) ／ 「クラシックの行方は？」(10字) ← どちらも中身ゼロで絶対NG

🚨【tweet_1 = アカウント強化用】🚨
リンク・[ad]・PR・アフィ要素を一切含まない、純粋な期待感・感想・問いかけ投稿。
例: 「今夜放送の「${drama.title}」楽しみすぎる…\\n\\n第N話、〇〇がついに△△する展開ヤバい\\n\\n見る人いる？感想シェアしたい🥰」

🚨【tweet_2 = 原作アフィ用】🚨
ドラマの原作（漫画・小説・コミック等）をAmazon/楽天で購入誘導するアフィ投稿。
- 原作がある場合: 「${drama.title}の原作、放送前に読んでおきたい」「\${原作名}気になってた」等の文脈で誘導。「[アフィリリンク]」「[ad]」（Amazon）または先頭「PR」（楽天）を付与
- オリジナル脚本で原作がない場合: 「脚本家◯◯の過去作」「主演◯◯の過去ドラマDVD」「メイキング本」へ切替、それも厳しい場合はリンクなしの期待感投稿にフォールバック

🚨【tweet_3 = サウンドトラック/主題歌アフィ用】🚨
ドラマのOST・主題歌をAmazon/Apple Music/楽天で購入誘導するアフィ投稿。
- 主題歌アーティスト情報があれば「主題歌は◯◯の新曲、CD/配信は[アフィリリンク][ad]」等
- 情報が皆無な場合は、リンクなしで「主題歌誰なんだろう？気になる」等の交流型にフォールバック

【title フィールドのフォーマット】
**厳密に「【${airLabel}放送】${drama.title}（${drama.network || '局名'}）」の3要素のみ**。出演者名・煽り句・感嘆符・絵文字を**絶対に追加しない**。
（このtitle値は管理画面の見出し用で、tweet本文には絶対にコピーしないこと）

【その他のフィールド】
- category: 必ず「ドラマ」固定
- purpose: 「収益特化」（tweet_2/3にアフィ含む場合）または「シャドウバン対策」（3つ全てリンクなしの場合）
- time_status: 「今すぐ投稿向き」
- is_safe: 必ず true
- source_summary: 公式サイトから抽出したあらすじ・見どころを2-3行
- why_now: 「本日${airLabel}から${drama.network || ''}で放送のため」
- recommended_action: アカウント運用上の戦略
- affiliate_candidates: tweet_2/3で誘導している具体的な案件名（原作漫画◯巻、サントラCD等）
- post_angles: 投稿の切り口を3つ簡潔に（強化用/原作/OST）
- cautions: 注意点

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
  "tweet_1": "...（必ず100〜120字）",
  "tweet_2": "...（必ず100〜120字）",
  "tweet_3": "...（必ず100〜120字）",
  "cautions": "..."
}
`;

  const result = await model.generateContent(prompt);
  const responseText = await result.response.text();
  const jsonStart = responseText.indexOf('{');
  const jsonEnd = responseText.lastIndexOf('}') + 1;
  const data = JSON.parse(responseText.substring(jsonStart, jsonEnd));

  // 強制サニタイズ：titleはフォーマットを問わず正式名フォーマットに作り直す
  const cleanTitle = collapseToCleanTitle(data.title || '', drama.title, drama.network, airLabel);
  data.title = cleanTitle;

  // 各tweet先頭の管理用見出しを剥がす
  data.tweet_1 = stripHeaderPrefix(data.tweet_1 || '', cleanTitle, drama.title);
  data.tweet_2 = stripHeaderPrefix(data.tweet_2 || '', cleanTitle, drama.title);
  data.tweet_3 = stripHeaderPrefix(data.tweet_3 || '', cleanTitle, drama.title);

  // 120文字超過分はAIで再短縮、100文字未満はAIで拡張（最終的に100〜120字を保証）
  const shrunk = await enforceTweetLengths(genAI, {
    tweet_1: data.tweet_1,
    tweet_2: data.tweet_2,
    tweet_3: data.tweet_3,
  });
  const expandContext = [
    `ドラマ: ${drama.title}`,
    drama.network ? `放送局: ${drama.network}` : '',
    airLabel ? `放送時間: ${airLabel}` : '',
    data.source_summary,
    data.why_now,
    data.affiliate_candidates,
  ].filter(Boolean).join('\n');
  const enforced = await enforceTweetMinLengths(genAI, {
    tweet_1: shrunk.tweet_1,
    tweet_2: shrunk.tweet_2,
    tweet_3: shrunk.tweet_3,
  }, expandContext);
  data.tweet_1 = enforced.tweet_1;
  data.tweet_2 = enforced.tweet_2;
  data.tweet_3 = enforced.tweet_3;

  const postUrl = drama.official_url || `https://www.crank-in.net/drama/${drama.season || ''}`;

  return {
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
    meta: {
      subpages_fetched: subpagesFetched,
      json_endpoints_fetched: jsonEndpointsFetched,
      episode_number: episodeNumber,
      content_density: contentDensity,
      grounding_used: groundingNote.length > 0,
      official_fetch: officialContent ? 'ok' : `failed: ${officialFetchError || 'no url'}`,
    },
  };
}
