import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // 🌟 新しい項目を追加で受け取る
    const { id, title, tweet_1, tweet_2, tweet_3, purpose, why_now, recommended_action, affiliate_candidates, cautions } = body;

    // Supabaseの管理者権限で接続（RLSを突破して安全に上書きするため）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // データの更新（上書き）処理
    const { error } = await supabaseAdmin
      .from('posts')
      .update({ 
        title: title, 
        tweet_1: tweet_1, 
        tweet_2: tweet_2, 
        tweet_3: tweet_3,
        purpose: purpose,
        why_now: why_now,                           // 🌟 追加
        recommended_action: recommended_action,     // 🌟 追加
        affiliate_candidates: affiliate_candidates, // 🌟 追加
        cautions: cautions                          // 🌟 追加
      })
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}