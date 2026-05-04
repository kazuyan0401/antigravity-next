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

const normalize = (s: string) => s.replace(/[\s　・！!？?。、,.()\-―ー]/g, '').toLowerCase();

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

    // 1. URL未登録ドラマを取得
    const { data: missingDramas, error: missingError } = await supabase
      .from('dramas')
      .select('id, title')
      .eq('season', season)
      .is('official_url', null);

    if (missingError) throw missingError;
    if (!missingDramas || missingDramas.length === 0) {
      return NextResponse.json({ success: true, season, missingTotal: 0, updated: 0, message: 'URL未登録のドラマはありません' });
    }

    // 2. crank-in.netから取得
    const url = `https://www.crank-in.net/drama/${season}`;
    const res = await fetch(url, { headers: fetchHeaders });
    if (!res.ok) throw new Error(`crank-in.net 取得失敗: HTTP ${res.status}`);
    const html = await res.text();

    // 3. <a>タグを保持したまま軽くクリーンアップ
    const cleanHtml = html
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, '')
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, '')
      .replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gmi, '')
      .replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gmi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 80000);

    // 4. 6チャンク並列でtitle→URLペア抽出
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
これは crank-in.net 季節ドラマ一覧ページHTMLの一部 (${idx + 1}/${CHUNK_COUNT}) です。
このチャンクに含まれる「ドラマタイトル」と「ドラマ公式サイトURL」のペアを抽出してください。

【抽出ルール】
- 各テレビ局/制作会社の公式サイトURL（例: fujitv.co.jp, tbs.co.jp, nhk.or.jp, tv-asahi.co.jp, ntv.co.jp, tv-tokyo.co.jp, mbs.jp, abc.co.jp, ytv.co.jp, ktv.jp, tokai-tv.com, ctv.co.jp 等）
- crank-in.net内部URL (crank-in.net/...) は絶対に含めない
- ニュース記事リンク、SNS、広告、関連バナーは除外
- HTMLのリンク構造から、タイトルと公式URLが対応していることが明らかなペアのみ
- ドラマタイトルは公式サイトのリンクテキストや近接テキストから読み取る
- 確信が持てないペアは出力しない（質優先）

【出力JSON形式】
{
  "pairs": [
    { "title": "ドラマタイトル", "official_url": "https://公式URL" }
  ]
}

【HTML断片】
${chunk}
`;

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
          return Array.isArray(parsed.pairs) ? parsed.pairs : [];
        } catch {
          return [];
        }
      })
    );

    // 5. Title→URLマップ作成（先勝ち）。crank-in.net自身のURLは弾く
    const titleToUrl = new Map<string, string>();
    const normMap = new Map<string, string>(); // normalized title → URL
    for (const arr of chunkResults) {
      for (const p of arr) {
        if (!p?.title || !p?.official_url) continue;
        if (p.official_url.includes('crank-in.net')) continue;
        if (!titleToUrl.has(p.title)) {
          titleToUrl.set(p.title, p.official_url);
          normMap.set(normalize(p.title), p.official_url);
        }
      }
    }

    // 6. 並列UPDATE（マッチしたものだけ）
    const matched: { title: string; url: string }[] = [];
    const unmatched: string[] = [];

    const updateResults = await Promise.all(
      missingDramas.map(async (drama: any) => {
        const found = titleToUrl.get(drama.title) || normMap.get(normalize(drama.title));
        if (!found) {
          unmatched.push(drama.title);
          return false;
        }
        const { error } = await supabase
          .from('dramas')
          .update({ official_url: found })
          .eq('id', drama.id);
        if (error) return false;
        matched.push({ title: drama.title, url: found });
        return true;
      })
    );

    const updated = updateResults.filter(Boolean).length;

    return NextResponse.json({
      success: true,
      season,
      missingTotal: missingDramas.length,
      updated,
      pairsExtracted: titleToUrl.size,
      matched,
      unmatched,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
