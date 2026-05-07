import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';
import { processDrama, DramaRecord } from '@/app/lib/drama-processor';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

    await supabase.from('drama_queue').update({ status: 'processing' }).eq('id', queueRow.id);

    const drama = queueRow.dramas as unknown as DramaRecord | null;
    if (!drama) {
      await supabase.from('drama_queue')
        .update({ status: 'failed', error_message: 'dramas レコードが見つかりません', processed_at: new Date().toISOString() })
        .eq('id', queueRow.id);
      return NextResponse.json({ success: false, error: 'drama not found' });
    }

    try {
      const result = await processDrama(drama, genAI);

      const { error: insertError } = await supabase.from('posts').insert([{
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
      }]);
      if (insertError) throw insertError;

      await supabase.from('dramas').update({ last_processed_at: new Date().toISOString() }).eq('id', drama.id);
      await supabase.from('drama_queue').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', queueRow.id);

      return NextResponse.json({
        success: true,
        drama: drama.title,
        ...result.meta,
      });
    } catch (innerErr: any) {
      await supabase.from('drama_queue')
        .update({ status: 'failed', error_message: innerErr.message?.substring(0, 500) || 'unknown', processed_at: new Date().toISOString() })
        .eq('id', queueRow.id);
      return NextResponse.json({ success: false, drama: drama.title, error: innerErr.message }, { status: 500 });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
