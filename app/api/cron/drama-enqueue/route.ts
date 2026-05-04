import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const dow = jstNow.getDay(); // 0=日,1=月,...6=土
    const todayStr = `${jstNow.getFullYear()}-${String(jstNow.getMonth() + 1).padStart(2, '0')}-${String(jstNow.getDate()).padStart(2, '0')}`;

    const { data: targets, error } = await supabase
      .from('dramas')
      .select('id, title, is_daily, air_day_of_week')
      .eq('enabled', true)
      .or(`is_daily.eq.true,air_day_of_week.eq.${dow}`);

    if (error) throw error;
    if (!targets || targets.length === 0) {
      return NextResponse.json({ success: true, dow, todayStr, enqueued: 0, message: '本日対象ドラマなし' });
    }

    let enqueued = 0;
    let skipped = 0;
    const skippedTitles: string[] = [];

    for (const d of targets) {
      const { error: insertError } = await supabase.from('drama_queue').insert([{
        drama_id: d.id,
        scheduled_for: todayStr,
        status: 'pending',
      }]);

      if (insertError) {
        // unique制約違反は重複なのでスキップ扱い
        if (insertError.code === '23505') {
          skipped++;
          skippedTitles.push(d.title);
        } else {
          throw insertError;
        }
      } else {
        enqueued++;
      }
    }

    return NextResponse.json({
      success: true,
      dow,
      todayStr,
      enqueued,
      skipped,
      skippedTitles,
      total: targets.length,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
