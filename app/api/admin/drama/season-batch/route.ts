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

const DAY_MAP: Record<string, number> = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

export async function POST(req: Request) {
  try {
    const { season } = await req.json();
    if (!season || !/^(spring|summer|autumn|winter)\d{4}$/.test(season)) {
      return NextResponse.json({ success: false, error: 'season は "spring2026" 等の形式で指定してください' }, { status: 400 });
    }

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

    const url = `https://www.crank-in.net/drama/${season}`;
    const res = await fetch(url, { headers: fetchHeaders });
    if (!res.ok) throw new Error(`crank-in.net 取得失敗: HTTP ${res.status}`);
    const html = await res.text();

    const cleanHtml = html
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, '')
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, '')
      .replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gmi, '')
      .replace(/<header\b[^>]*>([\s\S]*?)<\/header>/gmi, '')
      .replace(/<footer\b[^>]*>([\s\S]*?)<\/footer>/gmi, '')
      .replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gmi, '')
      .replace(/<img\b[^>]*>/gmi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 30000);

    const prompt = `
以下のHTMLは crank-in.net の季節ドラマ一覧ページです。
掲載されている全ドラマの情報を抽出し、JSON配列で出力してください。

【抽出ルール】
- 各ドラマについて、title, network, official_url, air_day, air_time, is_daily を抽出
- official_url は外部公式サイトURL（crank-in.net内ではなく、各ドラマのテレビ局/制作公式サイト）
- 公式サイトURLが見当たらない場合は null
- air_day は「日/月/火/水/木/金/土」の漢字1文字。帯ドラマや毎日放送なら null
- air_time は "21:00" のような24時間表記文字列。深夜枠の "25:29" 等もそのまま
- is_daily は「帯ドラマ」「連続テレビ小説」「朝ドラ」等、月-土または毎日放送なら true、通常週1なら false
- network は「フジテレビ系」「TBS系」「NHK」など放送局名
- 重複は除外
- 情報が不明確なドラマも含めて全部出力（不明項目は null）

【出力JSON形式】
{
  "dramas": [
    { "title": "...", "network": "...", "official_url": "...", "air_day": "月", "air_time": "21:00", "is_daily": false },
    ...
  ]
}

【HTML】
${cleanHtml}
`;

    const result = await model.generateContent(prompt);
    const responseText = await result.response.text();
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}') + 1;
    const parsed = JSON.parse(responseText.substring(jsonStart, jsonEnd));
    const dramas: any[] = parsed.dramas || [];

    if (dramas.length === 0) {
      return NextResponse.json({ success: false, error: 'ドラマが1件も抽出できませんでした' }, { status: 500 });
    }

    // 既存タイトル一括取得（1クエリ）
    const { data: existingRows } = await supabase
      .from('dramas')
      .select('title')
      .eq('season', season);
    const existingTitles = new Set((existingRows || []).map((r: any) => r.title));

    // 重複・無効を除外して挿入用配列を作る
    const toInsert: any[] = [];
    let skipped = 0;

    for (const d of dramas) {
      if (!d.title) { skipped++; continue; }
      if (existingTitles.has(d.title)) { skipped++; continue; }
      const air_day_of_week = d.air_day && DAY_MAP[d.air_day] !== undefined ? DAY_MAP[d.air_day] : null;
      toInsert.push({
        title: d.title,
        network: d.network || null,
        official_url: d.official_url || null,
        air_day_of_week,
        is_daily: !!d.is_daily,
        air_time: d.air_time || null,
        season,
        enabled: true,
      });
    }

    let inserted = 0;
    let insertError: string | null = null;
    if (toInsert.length > 0) {
      const { error } = await supabase.from('dramas').insert(toInsert);
      if (error) {
        insertError = error.message;
      } else {
        inserted = toInsert.length;
      }
    }

    return NextResponse.json({
      success: !insertError,
      season,
      total: dramas.length,
      inserted,
      skipped,
      error: insertError,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
