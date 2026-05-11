import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';
import { processDrama, DramaRecord } from '@/app/lib/drama-processor';
import { requireAdmin } from '@/app/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { post_id } = await req.json();
    if (!post_id) {
      return NextResponse.json({ success: false, error: 'post_id 必須' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!supabaseUrl || !supabaseKey || !geminiKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 対象 post を取得して original_url からドラマレコードを引く
    const { data: post, error: postErr } = await supabase
      .from('posts')
      .select('id, original_url, category')
      .eq('id', post_id)
      .maybeSingle();
    if (postErr) throw postErr;
    if (!post) return NextResponse.json({ success: false, error: 'post 見つからず' }, { status: 404 });
    if (post.category !== 'ドラマ') {
      return NextResponse.json({ success: false, error: 'ドラマ投稿ではない' }, { status: 400 });
    }
    if (!post.original_url) {
      return NextResponse.json({ success: false, error: 'original_url 未登録' }, { status: 400 });
    }

    const { data: drama, error: dramaErr } = await supabase
      .from('dramas')
      .select('id, title, network, official_url, air_day_of_week, is_daily, air_time, season')
      .eq('official_url', post.original_url)
      .maybeSingle();
    if (dramaErr) throw dramaErr;
    if (!drama) {
      return NextResponse.json({
        success: false,
        error: 'official_url に一致するドラマレコードが見つかりません',
        original_url: post.original_url,
      }, { status: 404 });
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const result = await processDrama(drama as DramaRecord, genAI);

    const { error: updateErr } = await supabase
      .from('posts')
      .update({
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
      })
      .eq('id', post_id);
    if (updateErr) throw updateErr;

    return NextResponse.json({
      success: true,
      drama: drama.title,
      ...result.meta,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
