import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { NextResponse } from 'next/server';
import { processDrama, DramaRecord } from '@/app/lib/drama-processor';
import { enforceTweetLengths } from '@/app/lib/tweet-shrink';
import { enforceTweetMinLengths } from '@/app/lib/tweet-expand';

export const maxDuration = 300;

const TRANSIENT_RE = /(503|UNAVAILABLE|Service Unavailable|overloaded|429|RESOURCE_EXHAUSTED|rate limit|deadline|ETIMEDOUT|ECONNRESET|fetch failed)/i;

const MODEL_CHAIN: { model: string; retries: number }[] = [
  { model: "gemini-2.5-flash", retries: 2 },
  { model: "gemini-2.5-flash-lite", retries: 1 },
  { model: "gemini-2.0-flash", retries: 1 },
];

async function generateOnce(model: any, prompt: string, maxAttempts: number): Promise<string> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || "");
      if (!TRANSIENT_RE.test(msg) || attempt === maxAttempts) throw err;
      const delay = 500 * Math.pow(3, attempt - 1);
      console.warn(`Gemini ${attempt}回目失敗、${delay}ms待機して再試行: ${msg.substring(0, 120)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function generateWithFallback(
  genAI: any,
  prompt: string,
  modelOptions: { generationConfig: any; safetySettings: any[] }
): Promise<{ text: string; modelUsed: string }> {
  let lastErr: any;
  for (const cfg of MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: cfg.model, ...modelOptions });
    try {
      const text = await generateOnce(model, prompt, cfg.retries + 1);
      return { text, modelUsed: cfg.model };
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || "");
      if (!TRANSIENT_RE.test(msg)) throw err;
      console.warn(`${cfg.model} 全リトライ失敗、次モデルへフォールバック: ${msg.substring(0, 120)}`);
    }
  }
  throw lastErr;
}

export async function POST(req: Request) {
  try {
    const { url: rawInput, memo, id, title } = await req.json();
    const trimmedInput = (rawInput || "").trim();
    if (!trimmedInput) {
      return NextResponse.json({ success: false, error: "URLまたはキーワードを入力してください。" }, { status: 400 });
    }
    const isUrl = /^https?:\/\//i.test(trimmedInput);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!supabaseUrl || !supabaseKey || !geminiKey) {
      throw new Error("環境変数が不足しています。");
    }

    // 🛡️ ドラマURL強制振り分け：URLが dramas.official_url に一致する場合は
    // 必ず drama-processor 経由で生成する（旧ブラウザJSが古いmemoでこのエンドポイントを
    // 叩いても、サーバ側で正しい経路に強制リダイレクトする保険）
    if (isUrl) {
      const supabaseEarly = createClient(supabaseUrl, supabaseKey);
      const { data: dramaMatch } = await supabaseEarly
        .from('dramas')
        .select('id, title, network, official_url, air_day_of_week, is_daily, air_time, season')
        .eq('official_url', trimmedInput)
        .maybeSingle();
      if (dramaMatch) {
        try {
          const genAIDrama = new GoogleGenerativeAI(geminiKey);
          const result = await processDrama(dramaMatch as DramaRecord, genAIDrama);
          const insertData = {
            title: result.title,
            category: result.category,
            purpose: result.purpose,
            time_status: result.time_status,
            source_summary: result.source_summary,
            why_now: result.why_now,
            recommended_action: result.recommended_action,
            affiliate_candidates: result.affiliate_candidates,
            post_angles: result.post_angles,
            tweet_1: result.tweet_1,
            tweet_2: result.tweet_2,
            tweet_3: result.tweet_3,
            cautions: result.cautions,
            original_url: result.original_url,
          };
          if (id) {
            await supabaseEarly.from('posts').update(insertData).eq('id', id);
          } else {
            await supabaseEarly.from('posts').insert([insertData]);
          }
          return NextResponse.json({
            success: true,
            modelUsed: 'gemini-2.5-flash (drama-processor)',
            data: insertData,
            routedTo: 'drama-processor',
          });
        } catch (e: any) {
          return NextResponse.json({ success: false, error: `drama-processor失敗: ${e.message}` }, { status: 500 });
        }
      }
    }

    let contentText = "";
    if (isUrl) {
      try {
        const pageRes = await fetch(trimmedInput, {
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
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const supabase = createClient(supabaseUrl, supabaseKey);
    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    ];
    // キーワードモードはGoogle検索Groundingで最新情報を取得（JSONモードと併用不可なので外す）
    const modelOptions = isUrl
      ? { generationConfig: { responseMimeType: "application/json" }, safetySettings }
      : { generationConfig: {}, safetySettings, tools: [{ google_search: {} } as any] };
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const analysisInput = isUrl
      ? (contentText.length > 100
          ? `【ページ内容】\n${contentText}`
          : `【⚠️警告】ページ内容の取得に失敗しました。URLは ${trimmedInput} ですが、内容を読み取れませんでした。タイトル・補足を頼りに分析してください。`)
      : `【運用者がフリー入力したネタ（URLではなくキーワード）】\n${trimmedInput}\n\n🚨【最重要・必ずGoogle検索を実行すること】🚨\nこのお題は運用者が手入力したキーワードです。あなた自身の知識だけで書くと事実誤認を起こします。必ずGoogle検索ツールでキーワードを検索し、最新の事実（発売日・放送日・開催日・現状の話題性）を確認してから書いてください。\n- 検索しても情報が見つからない場合は、無理に作らず "is_safe": false を返すこと。\n- 固有名詞・商品名・番組名・楽曲名は検索結果に従い、表記を勝手に変えないこと。`;

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

🚨【絶対ルール：文字数レンジ100〜120字（X規約厳守 & 中身担保）】🚨
tweet_1 / tweet_2 / tweet_3 はそれぞれ単独で **必ず100文字以上120文字以内** に収めること（収益化/シャドウバン対策どちらも同じ）。
- **下限：100文字**（100文字未満は中身がスカスカで絶対NG。事実＋感情＋誘導/問いかけの3要素を入れれば自然と100字に届く）
- **上限：120文字**（121文字以上は絶対NG。X規約と t.co 短縮を考慮した運用上限）
- このレンジ内でも、できるだけ上限120字に近づけて中身を詰めること

【❌ 実際にあったNG例（絶対に真似しないこと）】
- 「クラシックの行方は？」（10文字）← 中身ゼロで誰の何の話か分からない
- 「「HOME」の推し曲、もう予想した？」（18文字）← 唐突で文脈がない
- 「ZICOプロデュースの彼ら、どんな世界観見せるか楽しみすぎ！」（30文字）← 情報が薄すぎる

【⭕️ OKの目安】
- 「速報🐎コントレイル産駒コンジェスタスがG2京都新聞杯制覇！直線の伸びがコントレイル譲りで震えた…クラシックの主役候補、誰だと思う？POG民は今すぐチェック👇」のように、事実＋感情＋誘導/問いかけ で100〜120字に詰める

【カウント対象】実際に投稿される全文字（改行「\\n」も1文字、絵文字も1文字、「[アフィリリンク]」は9文字、「[ad]」は4文字、「PR」は2文字）。X側で実URLに置換されると t.co短縮で23文字相当になるため、120文字でもアフィリリンク込みで安全。
【自己点検】出力前に各tweetの文字数を数え、下限未満なら情報を足し、上限超なら語尾や枕詞を削って必ずレンジ内に収める。

🚨【絶対ルール：型は必ず4要素を全部入れる（字数より型優先）】🚨
以下の【型1〜型4】の構成要素（要約／感情／誘導／補足）はすべて省略禁止。「型のセクションを省略して字数を稼ぐ」のは禁止です。型を全部入れて120字を超えそうな場合は、各セクションの語尾・修飾語・絵文字を削って圧縮し、4要素は必ず維持すること。
改行「\\n」と空白行「\\n\\n」のレイアウトもそのまま再現する（文章を1行に詰めて書くのは厳禁）。

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

🚨【絶対厳守・日付混同ゼロルール】🚨
冒頭の「現在時刻」が "今日" です。記事や検索結果に出てくる発売日・放送日・開催日と、必ず比較してください。
❌ 絶対NG（過去日付を今日扱い）:
- 検索結果に「3月4日リリース」とあるのを、現在時刻が5月でも「本日3月4日にリリース」と書く
- 過去のイベントなのに「速報」「本日」「今日」「リリースされました」（完了形・直近形）を使う
- ハッシュタグに「#速報」「#本日」を付ける
⭕️ 正しい書き方の判定:
- 発売日・放送日が **現在時刻と同日 or 前後1〜2日** → 「本日」「今日」「速報」OK
- 発売日・放送日が **3日以上前** → 振り返り口調必須。「○月○日にリリースされた」「あれから○ヶ月、改めて聴いてる」「もう○回聴いたかな」のように過去視点で書く。time_status は「後追い向き」または「放送後向き」にする。
- 発売日・放送日が **未来** → 「先回り向き」。「○月○日リリース予定」「○月○日放送」と書く。
title・why_now・tweet本文すべて、この日付判定に矛盾しない表現にすること。

現在時刻:${now}
${analysisInput}
【現在のタイトル（※ここに番組名があれば絶対に使用すること）】\n${title || 'なし'}
【運用者からの補足】\n${memo || 'なし'}

必ず以下のJSON形式のみで出力してください。ツイート案の中の改行は必ず「\n」を使って表現してください。
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
  "tweet_1": "投稿案1（必ず100〜120文字。収益化なら型4要素必須。シャドウバン対策ならリンク・タグなしの純粋なつぶやき）",
  "tweet_2": "投稿案2（必ず100〜120文字。収益化なら型4要素必須。シャドウバン対策ならリンク・タグなしの純粋なつぶやき）",
  "tweet_3": "投稿案3（必ず100〜120文字。完全な交流・問いかけ用。リンク・タグなし。短すぎる単発質問は絶対NG）",
  "cautions": "注意点"
}
`;

    let responseText = "";
    let modelUsed = MODEL_CHAIN[0].model;
    try {
      const r = await generateWithFallback(genAI, prompt, modelOptions);
      responseText = r.text;
      modelUsed = r.modelUsed;
    } catch (aiError: any) {
      const msg = String(aiError?.message || "");
      console.error("Gemini生成エラー:", msg);
      const reasonLabel = /503|UNAVAILABLE|Service Unavailable|overloaded/i.test(msg)
        ? "Gemini AIサーバが一時的に混雑しています。1〜2分待ってから再試行してください"
        : /429|RESOURCE_EXHAUSTED|rate limit/i.test(msg)
          ? "AI APIの利用上限に達しました。少し待ってから再試行してください"
          : msg.includes("SAFETY")
            ? "安全性フィルターによりブロックされました"
            : msg.includes("RECITATION")
              ? "AIが記事を引用しすぎたためブロックされました（別の記事URLでお試しください）"
              : msg.includes("LANGUAGE")
                ? "言語判定でブロックされました"
                : `AI応答エラー（${msg.substring(0, 160)}）`;
      return NextResponse.json({ success: false, error: `AI生成に失敗しました: ${reasonLabel}` }, { status: 500 });
    }

    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}') + 1;
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      console.error("AI応答にJSONが含まれていません:", responseText.substring(0, 500));
      return NextResponse.json({ success: false, error: "AIの応答からJSONを取り出せませんでした。再試行してください。" }, { status: 500 });
    }

    let data: any;
    try {
      data = JSON.parse(responseText.substring(jsonStart, jsonEnd));
    } catch {
      console.error("JSONパース失敗:", responseText.substring(0, 500));
      return NextResponse.json({ success: false, error: "AIの応答が壊れていました（JSONパース失敗）。再試行してください。" }, { status: 500 });
    }

    if (data.is_safe === false) {
      return NextResponse.json({ 
        success: false, 
        error: "このニュースは炎上リスクまたはネガティブな内容と判定されたため、保存を中止しました。" 
      }, { status: 400 });
    }

    const shrunk = await enforceTweetLengths(genAI, {
      tweet_1: data.tweet_1,
      tweet_2: data.tweet_2,
      tweet_3: data.tweet_3,
    });
    const expandContext = [data.title, data.source_summary, data.why_now, data.affiliate_candidates]
      .filter(Boolean).join('\n');
    const enforced = await enforceTweetMinLengths(genAI, {
      tweet_1: shrunk.tweet_1,
      tweet_2: shrunk.tweet_2,
      tweet_3: shrunk.tweet_3,
    }, expandContext);

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
      original_url: isUrl ? trimmedInput : `keyword:${trimmedInput}`
    };

    if (id) {
      await supabase.from('posts').update(insertData).eq('id', id);
    } else {
      await supabase.from('posts').insert([insertData]);
    }

    return NextResponse.json({ success: true, modelUsed });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}