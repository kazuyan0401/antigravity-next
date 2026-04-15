import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';
import Parser from 'rss-parser';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; 

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
    const jstDate = new Date(new Date().toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"}));
    const currentHour = jstDate.getHours();
    const currentMinute = jstDate.getMinutes(); // 🌟追加：30分シフト用

    // 🌟 共通ボット対策ヘッダー（一般のMacのChromeのフリをしてアクセス）
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache"
    };

    const dailySources = [
      { name: "Gガイド番組表", url: "https://bangumi.org/epg/td?ggm_group_id=42", type: "scraping_tv" }
    ];

    const tvSources = [
      { name: "価格.com テレビ紹介", url: "https://kakaku.com/tv/", type: "scraping_kakaku" },
      { name: "TVでた蔵", url: "https://datazoo.jp/", type: "scraping_datazoo" },
      { name: "Yahoo!リアルタイム", url: "https://search.yahoo.co.jp/realtime", type: "scraping_yahoo_rt" }
    ];

    const hourlySources = [
      { name: "Googleトレンド", url: "https://trends.google.co.jp/trending/rss?geo=JP", type: "rss" },
      { name: "Yahoo!エンタメ", url: "https://news.yahoo.co.jp/rss/topics/entertainment.xml", type: "rss" },
      { name: "Yahoo!IT", url: "https://news.yahoo.co.jp/rss/topics/it.xml", type: "rss" },
      { name: "PR TIMES", url: "https://prtimes.jp/index.rdf", type: "rss" },
      { name: "Xトレンド", url: "https://twittrend.jp/", type: "scraping_x" }
    ];

    let targetSources: any[] = [];

    // 🌟 00分/30分の「完全交互シフト」ロジック
    if (currentMinute < 30) {
      // ⏱️ 00分〜29分：テレビ・特急レーン
      if (currentHour === 7) {
        targetSources.push(dailySources[0]); // 朝7時00分のみGガイド
      } else {
        targetSources.push(tvSources[currentHour % tvSources.length]);
      }
    } else {
      // ⏱️ 30分〜59分：通常レーン
      targetSources.push(hourlySources[currentHour % hourlySources.length]);
    }

    let addedCount = 0;
    const MAX_PROCESS = 1; 

    for (const source of targetSources) {
      if (addedCount >= MAX_PROCESS) break;
      console.log(`パトロール開始: ${source.name}`);

      let items = [];
      try {
        // 🌟 すべて「slice(0, 10)」に変更して10件深掘り！
        if (source.type === "rss") {
          const feed = await parser.parseURL(source.url);
          items = feed.items.slice(0, 10).map(i => ({ title: i.title, url: i.link }));
        } else if (source.type === "scraping_x") {
          const res = await fetch(source.url, { headers: fetchHeaders });
          const html = await res.text();
          const matches = html.match(/class="td_list">([\s\S]*?)<\/div>/g) || [];
          items = matches.slice(0, 10).map(m => ({
            title: `Xトレンド: ${m.replace(/<[^>]*>/g, '').trim()}`,
            url: `https://x.com/search?q=${encodeURIComponent(m.replace(/<[^>]*>/g, '').trim())}`
          }));
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
          // 🌟【新設】Yahoo!リアルタイム検索（トレンドワードのスクレイピング）
          const res = await fetch(source.url, { headers: fetchHeaders });
          const html = await res.text();
          // トレンドワードのリンクを抽出
          const rawMatches = html.match(/href="\/realtime\/search\?p=([^"&]+)/g) || [];
          // 重複を削除してURLエンコードを戻す
          const uniqueKeywords = Array.from(new Set(rawMatches.map(m => decodeURIComponent(m.replace('href="/realtime/search?p=', '')))));
          items = uniqueKeywords.slice(0, 10).map(kw => ({
            title: `🔍 Yahooリアルタイム: ${kw}`,
            url: `https://search.yahoo.co.jp/realtime/search?p=${encodeURIComponent(kw)}`
          }));
        }
      } catch (e) { console.error(`${source.name} 取得失敗`, e); continue; }

      // 🌟 【10件深掘りロジック】上から順に見て、保存済みのものはスキップ。「新しい1件」を見つけたら処理して即終了！
      for (const item of items) {
        if (addedCount >= MAX_PROCESS) break;
        const url = item.url || "";
        const title = item.title || "";

        const superCleanTitle = title.replace(/[^\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF0-9a-zA-Z]/g, '').substring(0, 10);
        const { data: existing } = await supabase.from('posts').select('id').eq('original_url', url).single();
        const { data: similar } = await supabase.from('posts').select('id').ilike('title', `%${superCleanTitle}%`).gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        
        // すでに保存済みなら次のアイテムへ進む（continue）
        if (existing || (similar && similar.length > 0)) {
          console.log(`重複スキップ: ${title}`);
          continue; 
        }

        // 新しいネタを見つけた場合のみ、ここから下のAI処理に進む
        let contentText = "";
        try {
          // 🌟 ここにもボット対策ヘッダーを付与
          const pageRes = await fetch(url, { headers: fetchHeaders });
          const html = await pageRes.text();
          contentText = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "").replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "").replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
        } catch (e) { contentText = "詳細取得失敗"; }

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

【🌟超実戦的！クリックが取れる投稿の型（収益化用のみ）】

🚨【絶対ルール：改行と空白行の完全再現】🚨
以下に提示している【型1〜型4】の「改行」と「空白行（1行空け）」のレイアウトは絶対に崩さずそのまま再現してください。文章を詰めて書くのは厳禁です。※改行は「\\n」、空白行は「\\n\\n」で出力。

🚨【広告タグの使い分け】🚨
・Amazon案件：末尾に「[ad]」
・楽天案件：先頭に「PR」
・その他(VOD等)：末尾に「[ad]」

型1【トレンド便乗型】（※楽天案件なら先頭にPR）
(話題のニュースの要約)🏭

そんなこと聞くと(食べたくなる/行きたくなる)よね😅

楽天(またはAmazon)覗いて見たら、(関連商品)なんてのあるんだね⬇️
[アフィリリンク]

これは知らなかったし、(ジャンル)好きとしては気になる😆

型2【スポーツ・イベント配信型】
ヤバい‼️もう(試合/配信)始まってる💦

(チーム名や番組名)
テレビ放送なし❌

ここでLIVE配信観れます👇
[アフィリリンク]
※(無料期間など)無料🆓

(注目の選手や見どころ)

型3【品薄・再販パトロール型】
(商品名)

売り切れ＆高騰だらけ💦

Amazonは在庫復活この前あったからチェック毎日してる⬇️
[アフィリリンク]

(付録や特典の魅力)欲しいなぁ🥕

(関連グッズ)も良いよね

型4【招待販売・予約開始型】
(商品名)

Amazonで招待販売（または予約）始まってます⬇️
[アフィリリンク]

Amazonの他の出品者をクリック➡️(定価など)円のやつがAmazonの販売
※本日時点の価格

現在時刻:${now}
【内容】\n${contentText}
【運用者からの補足】情報源: ${source?.name || '手動入力'} / タイトル: ${title || 'なし'}

必ず以下のJSON形式のみで出力してください。ツイート案の中の改行は必ず「\\n」を使って表現してください。
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
  "tweet_1": "投稿案1（収益化なら型を使用。シャドウバン対策ならリンク・タグなしの純粋なつぶやき）",
  "tweet_2": "投稿案2（収益化なら型を使用。シャドウバン対策ならリンク・タグなしの純粋なつぶやき）",
  "tweet_3": "投稿案3（完全な交流・問いかけ用。リンク・タグなし）",
  "cautions": "注意点"
}
`;

        const result = await model.generateContent(prompt);
        const responseText = await result.response.text();
        const jsonStart = responseText.indexOf('{');
        const jsonEnd = responseText.lastIndexOf('}') + 1;
        const data = JSON.parse(responseText.substring(jsonStart, jsonEnd));

        if (data.is_safe === false) { console.log(`🚨 スキップ: ${data.title}`); continue; }

        await supabase.from('posts').insert([{
          title: data.title, category: data.category, purpose: data.purpose, time_status: data.time_status, source_summary: data.source_summary, why_now: data.why_now, recommended_action: data.recommended_action, affiliate_candidates: data.affiliate_candidates, post_angles: data.post_angles, tweet_1: data.tweet_1, tweet_2: data.tweet_2, tweet_3: data.tweet_3, cautions: data.cautions, original_url: url
        }]);
        
        addedCount++;
      }
    }
    return NextResponse.json({ success: true, count: addedCount });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}