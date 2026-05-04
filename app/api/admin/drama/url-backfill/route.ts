import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const fetchHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

const normalize = (s: string) => s.replace(/[\s　・！!？?。、,.()\-―ー〜~]/g, '').toLowerCase();

// ドラマ詳細ページから「公式サイト」直後のリンクを抽出
function extractOfficialFromDetail(html: string): { title: string | null; officialUrl: string | null } {
  // 1. タイトル: h1 タグまたは <title> から取得
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title: string | null = null;
  if (h1Match) {
    title = h1Match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  } else {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      // "ドラマ名 | クランクイン!" のようなパターンから前半だけ取る
      title = titleMatch[1].split(/[|｜]/)[0].trim();
    }
  }

  // 2. 公式サイトURL: 「公式サイト」テキストの直後 ~500文字以内の <a href> を探す
  const officialPatterns = [
    /公式\s*(?:サイト|ホームページ|HP|hp)[\s\S]{0,800}?<a[^>]*?href=["']([^"']+)["']/i,
    /<a[^>]*?href=["']([^"']+)["'][^>]*?>\s*公式\s*(?:サイト|ホームページ)\s*</i,
  ];

  let officialUrl: string | null = null;
  for (const pat of officialPatterns) {
    const m = html.match(pat);
    if (m && m[1] && !m[1].includes('crank-in.net')) {
      officialUrl = m[1];
      break;
    }
  }

  return { title, officialUrl };
}

// 並列度制限付きの並列処理
async function parallelLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        results[idx] = null as any;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(req: Request) {
  try {
    const { season } = await req.json();
    if (!season || !/^(spring|summer|autumn|winter)\d{4}$/.test(season)) {
      return NextResponse.json({ success: false, error: 'season は "spring2026" 等の形式で指定してください' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. URL未登録ドラマ取得
    const { data: missingDramas, error: missingError } = await supabase
      .from('dramas')
      .select('id, title')
      .eq('season', season)
      .is('official_url', null);

    if (missingError) throw missingError;
    if (!missingDramas || missingDramas.length === 0) {
      return NextResponse.json({ success: true, season, missingTotal: 0, updated: 0, message: 'URL未登録のドラマはありません' });
    }

    // 2. 季節一覧ページを取得
    const indexUrl = `https://www.crank-in.net/drama/${season}`;
    const indexRes = await fetch(indexUrl, { headers: fetchHeaders });
    if (!indexRes.ok) throw new Error(`crank-in.net 季節ページ取得失敗: HTTP ${indexRes.status}`);
    const indexHtml = await indexRes.text();

    // 3. 詳細ページURL（/drama/{season}/{id}）を全部抽出
    const detailUrlPattern = new RegExp(`/drama/${season}/(\\d+)`, 'g');
    const detailIds = new Set<string>();
    let m;
    while ((m = detailUrlPattern.exec(indexHtml)) !== null) {
      detailIds.add(m[1]);
    }

    if (detailIds.size === 0) {
      return NextResponse.json({ success: false, error: '季節ページから詳細ページURLが1件も抽出できませんでした' }, { status: 500 });
    }

    const detailUrls = Array.from(detailIds).map((id) => `https://www.crank-in.net/drama/${season}/${id}`);

    // 4. 各詳細ページを並列取得（同時8接続まで）& title + officialUrl を抽出
    const detailResults = await parallelLimit(detailUrls, 8, async (url) => {
      const res = await fetch(url, { headers: fetchHeaders });
      if (!res.ok) return null;
      const html = await res.text();
      const { title, officialUrl } = extractOfficialFromDetail(html);
      if (!title || !officialUrl) return null;
      return { detailUrl: url, title, officialUrl };
    });

    const validResults = detailResults.filter(Boolean) as { detailUrl: string; title: string; officialUrl: string }[];

    // 5. title→officialUrlマップ（正規化込み）
    const titleToUrl = new Map<string, string>();
    const normMap = new Map<string, string>();
    for (const r of validResults) {
      titleToUrl.set(r.title, r.officialUrl);
      normMap.set(normalize(r.title), r.officialUrl);
    }

    // 6. DBの未登録ドラマとマッチング & UPDATE
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
      detailPagesFound: detailIds.size,
      detailPagesParsed: validResults.length,
      updated,
      matched,
      unmatched,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
