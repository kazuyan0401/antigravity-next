import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/admin-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id, enabled } = await req.json();
    if (!id || typeof enabled !== 'boolean') {
      return NextResponse.json({ success: false, error: 'id と enabled (boolean) が必要です' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { error } = await supabase.from('dramas').update({ enabled }).eq('id', id);
    if (error) throw error;

    return NextResponse.json({ success: true, id, enabled });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await req.json();
    if (!id) {
      return NextResponse.json({ success: false, error: 'id が必要です' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('環境変数不足');

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { error } = await supabase.from('dramas').delete().eq('id', id);
    if (error) throw error;

    return NextResponse.json({ success: true, id });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
