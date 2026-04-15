import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { url, memo, id, title } = await req.json();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!supabaseUrl || !supabaseKey || !geminiKey) {
      throw new Error("環境変数が不足しています。");
    }

    let contentText = "";
    try {
      const pageRes = await fetch(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } 
      });
      const html = await pageRes.text();
      contentText = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
                        .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "")
                        .replace(/<[^>]*>?/gm, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .substring(0, 4000);
    } catch (e) {
      contentText = "";
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const supabase = createClient(supabaseUrl, supabaseKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const analysisInput = contentText.length > 100 
      ? `【ページ内容】\n${contentText}` 
      : `【⚠️警告】ページ内容の取得に失敗しました。URLからは詳細情報を読み取れません。`;

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

🚨【手動編集の引き継ぎ絶対ルール（超重要）】🚨
「現在のタイトル」や「運用者からの補足」に、ユーザーが手動で追加した具体的なテレビ番組名（例：DayDay.、めざましテレビ、ZIP!など）が含まれている場合、それをAIの判断で「今日のテレビ番組」と丸めたり、消去したりすることは【絶対厳禁】です。
必ずその番組名を最優先で拾い上げ、新しく出力するタイトル・理由・ツイート本文すべてに反映させてください。

現在時刻:${now}
【内容】\n${contentText}
【現在のタイトル（※ここに番組名があれば絶対に使用すること）】\n${title || 'なし'}
【運用者からの補足】\n${memo || 'なし'}

必ず以下のJSON形式のみで出力してください。ツイート案の中の改行は必ず「\n」を使って表現してください。
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

    if (data.is_safe === false) {
      return NextResponse.json({ 
        success: false, 
        error: "このニュースは炎上リスクまたはネガティブな内容と判定されたため、保存を中止しました。" 
      }, { status: 400 });
    }

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
      tweet_1: data.tweet_1,
      tweet_2: data.tweet_2,
      tweet_3: data.tweet_3,
      cautions: data.cautions,
      original_url: url
    };

    if (id) {
      await supabase.from('posts').update(insertData).eq('id', id);
    } else {
      await supabase.from('posts').insert([insertData]);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}