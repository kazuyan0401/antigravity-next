import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

    // ホームHTMLからエピソード/ストーリーサブページのURLを発見
    // 同一ドメイン内の /story/{n}/, /episode/{n}/, /next/, /preview/ 等を抽出
    const findEpisodeSubpages = (homeHtml: string, baseUrl: string): string[] => {
      const candidates: string[] = [];
      const baseObj = new URL(baseUrl);

      // (1) 番号付きエピソードページ: /story/01/, /episode/3/, /stories/2/
      const numberedPattern = /href=["']([^"']*?\/(?:story|stories|episode|episodes|onair|onair_story)\/(\d+)\/?[^"']*?)["']/gi;
      const byPath = new Map<string, { num: number; url: string }>();
      let m: RegExpExecArray | null;
      while ((m = numberedPattern.exec(homeHtml)) !== null) {
        const num = parseInt(m[2], 10);
        if (isNaN(num) || num < 1 || num > 50) continue;
        let fullUrl: string;
        try {
          fullUrl = new URL(m[1], baseUrl).toString();
        } catch { continue; }
        // 別ドメインは除外
        try {
          if (new URL(fullUrl).hostname !== baseObj.hostname) continue;
        } catch { continue; }
        // 番号より前のパス部分でグループ化し最大話数を選ぶ
        const pathPrefix = fullUrl.replace(/\d+\/?[^/]*$/, '');
        const existing = byPath.get(pathPrefix);
        if (!existing || num > existing.num) {
          byPath.set(pathPrefix, { num, url: fullUrl });
        }
      }
      for (const v of byPath.values()) candidates.push(v.url);

      // (2) 次回予告・ストーリー全般ページ: /next/, /preview/, /story/, /story.html
      const namedPattern = /href=["']([^"']*?\/(?:next|preview|onair|story|stories|nextstory)\/?(?:[^"']*?\.html?)?)["']/gi;
      while ((m = namedPattern.exec(homeHtml)) !== null) {
        let fullUrl: string;
        try {
          fullUrl = new URL(m[1], baseUrl).toString();
        } catch { continue; }
        try {
          if (new URL(fullUrl).hostname !== baseObj.hostname) continue;
        } catch { continue; }
        if (!candidates.includes(fullUrl)) candidates.push(fullUrl);
      }

      // 重複除外、ホームURL自身は除外、最大2件まで
      const uniq = Array.from(new Set(candidates)).filter((u) => u !== baseUrl && u !== baseUrl + '/');
      return uniq.slice(0, 2);
    };

    // 公式サイト取得（失敗してもメタデータだけで処理続行）
    let officialContent = '';
    let officialFetchError = '';
    let subpagesFetched: string[] = [];
    if (drama.official_url) {
      try {
        const r = await fetch(drama.official_url, { headers: fetchHeaders });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const html = await r.text();
        officialContent = `【ホームページ】\n${stripHtml(html, 4000)}`;

        // 最新話/次回予告サブページを並列取得（最大2件）
        const subUrls = findEpisodeSubpages(html, drama.official_url);
        const subResults = await Promise.all(
          subUrls.map(async (subUrl) => {
            try {
              const sr = await fetch(subUrl, { headers: fetchHeaders });
              if (!sr.ok) return null;
              const sh = await sr.text();
              return { url: subUrl, text: stripHtml(sh, 3000) };
            } catch {
              return null;
            }
          })
        );
        for (const sub of subResults) {
          if (!sub) continue;
          subpagesFetched.push(sub.url);
          officialContent += `\n\n【サブページ ${sub.url}】\n${sub.text}`;
        }
      } catch (e: any) {
        officialFetchError = e.message;
      }
    }

    const airLabel = drama.is_daily
      ? '帯ドラマ（月〜土または毎日放送）'
      : (drama.air_day_of_week !== null && drama.air_day_of_week !== undefined
          ? `${DOW_LABEL[drama.air_day_of_week]}曜${drama.air_time || ''}`
          : '放送時間未定');

    const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const prompt = `
あなたはX（旧Twitter）で月100万円以上を稼ぐプロのアフィリエイター、兼SNSアルゴリズム解析者です。
今日の放送予定ドラマについて、視聴者の興味を惹き、かつアフィリエイト収益化もできる投稿案を作成します。

【ドラマ情報】
- タイトル: ${drama.title}
- 放送局: ${drama.network || '不明'}
- 放送時間: ${airLabel}
- 公式サイト: ${drama.official_url || 'なし'}
- 季節: ${drama.season || '不明'}
- 取得日時: ${nowJst}

【公式サイトから取得した情報（複数ページの可能性あり）】
${officialContent || '（公式サイト取得不可：' + (officialFetchError || 'URL未登録') + '）'}

🚨【最重要：今日放送される最新話に焦点を合わせる】🚨
取得情報の中に「次回予告」「第N話」「ストーリー」「あらすじ」「ゲスト」「サブタイトル」等の**今日放送回特有の情報**があれば、それを最優先で投稿に反映してください。
- 例: 「今夜の第3話、〇〇がついに△△する展開ヤバい」「今夜のゲストは□□さん！」「次回予告で見せた◯◯のシーンが気になりすぎる」
- 第N話の話数・サブタイトル・ゲスト出演者・あらすじ等が判明しているなら必ず触れる
- 第1話（初回放送）の場合は「ついに今夜スタート」の文脈で
- 最終回付近なら「最終話/最終章」の特別感を強調
- 最新話情報が見つからない場合のみ、ドラマ全体の見どころで構成

🚨【絶対ルール】🚨
1. tweet_1 / tweet_2 / tweet_3 の役割を厳格に分けること（後述）
2. ドラマ名（${drama.title}）は必ず投稿文に明記すること
3. 放送時間（${airLabel}）も触れること（「今夜21時から」「毎朝8時から」等の自然な表現で）
4. 改行は「\\n」、空白行（1行空け）は「\\n\\n」で出力。空白行を必ず使うこと
5. tweet_2/tweet_3 のアフィリエイトリンク部分は必ず文字列「[アフィリリンク]」をそのまま埋め込む（実URLは絶対に書かない）
6. Amazon案件は末尾に「[ad]」、楽天案件は先頭に「PR」を付与

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
- title: 「【\${放送時間}放送】\${ドラマ名}（\${放送局}）」のように、ドラマ名と放送タイミングを目立たせる
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
