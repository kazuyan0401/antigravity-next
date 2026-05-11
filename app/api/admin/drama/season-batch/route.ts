import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const fetchHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

const DAY_MAP: Record<string, number> = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
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
      .substring(0, 60000);

    // HTMLを6チャンクに分割（重複2500文字込み）して並列処理
    // → Geminiの出力生成時間(ボトルネック)を1/6に短縮
    const CHUNK_COUNT = 6;
    const CHUNK_OVERLAP = 2500;
    const totalLen = cleanHtml.length;
    const chunkSize = Math.ceil(totalLen / CHUNK_COUNT);
    const chunks: string[] = [];
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const start = Math.max(0, i * chunkSize - CHUNK_OVERLAP);
      const end = Math.min(totalLen, (i + 1) * chunkSize + CHUNK_OVERLAP);
      chunks.push(cleanHtml.substring(start, end));
    }

    const buildPrompt = (chunk: string, idx: number) => `
これは crank-in.net 季節ドラマ一覧ページHTMLの一部（${idx + 1}/${CHUNK_COUNT} チャンク）です。
このチャンクに含まれるドラマ情報のみを抽出し、JSON配列で出力してください。

【抽出ルール】
- 各ドラマについて、title, network, official_url, air_day, air_time, is_daily を抽出
- official_url は外部公式サイトURL（crank-in.net内ではなく、各ドラマのテレビ局/制作公式サイト）。見つからなければ null
- air_day は「日/月/火/水/木/金/土」の漢字1文字。HTML中に明記されていない or 帯ドラマなら null
- air_time は "21:00" 等。深夜枠 "25:29" 等もそのまま
- is_daily は「帯ドラマ」「連続テレビ小説」「朝ドラ」等、月-土または毎日放送なら true
- network は「フジテレビ系」「TBS系」「NHK」など
- 【重要】タイトルさえ取れたら必ず出力する。不明項目は null でOK（網羅性最優先、取りこぼし禁止）
- ドラマ本編・大河ドラマ・連続テレビ小説・帯ドラマ・深夜ドラマ・配信ドラマ全てを対象に含める
- 「2026年春ドラマ」「ニュース記事」「コラム」「広告」等のメタ要素は無視
- 同じドラマが複数回登場する場合は1回だけ（タイトルで判定）

【出力JSON形式】
{
  "dramas": [
    { "title": "...", "network": "...", "official_url": "...", "air_day": "月", "air_time": "21:00", "is_daily": false }
  ]
}

【HTML断片】
${chunk}
`;

    // 全チャンクを並列でGemini呼び出し（各60秒で打ち切り）
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race<T | null>([
        p,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);

    const chunkResults = await Promise.all(
      chunks.map(async (chunk, idx) => {
        try {
          const result = await withTimeout(model.generateContent(buildPrompt(chunk, idx)), 60000);
          if (!result) return [];
          const text = await result.response.text();
          const s = text.indexOf('{');
          const e = text.lastIndexOf('}') + 1;
          if (s < 0 || e <= s) return [];
          const parsed = JSON.parse(text.substring(s, e));
          return Array.isArray(parsed.dramas) ? parsed.dramas : [];
        } catch (err) {
          return [];
        }
      })
    );

    // タイトルでマージ（先勝ち）
    const seenByTitle = new Map<string, any>();
    for (const arr of chunkResults) {
      for (const d of arr) {
        if (d?.title && !seenByTitle.has(d.title)) {
          seenByTitle.set(d.title, d);
        }
      }
    }
    const dramas: any[] = Array.from(seenByTitle.values());

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
