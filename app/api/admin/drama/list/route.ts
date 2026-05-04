import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { searchParams } = new URL(req.url);
    const season = searchParams.get('season');

    let query = supabase
      .from('dramas')
      .select('id, title, network, official_url, air_day_of_week, is_daily, air_time, season, enabled, last_processed_at, created_at')
      .order('is_daily', { ascending: false })
      .order('air_day_of_week', { ascending: true, nullsFirst: false })
      .order('air_time', { ascending: true });

    if (season) query = query.eq('season', season);

    const { data: dramas, error } = await query;
    if (error) throw error;

    // キュー状況の集計
    const todayJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const todayStr = `${todayJst.getFullYear()}-${String(todayJst.getMonth() + 1).padStart(2, '0')}-${String(todayJst.getDate()).padStart(2, '0')}`;

    const { data: queueToday } = await supabase
      .from('drama_queue')
      .select('status')
      .eq('scheduled_for', todayStr);

    const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
    (queueToday || []).forEach((q: any) => {
      if (counts[q.status as keyof typeof counts] !== undefined) {
        counts[q.status as keyof typeof counts]++;
      }
    });

    return NextResponse.json({
      success: true,
      dramas: dramas || [],
      queueToday: { todayStr, ...counts },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
