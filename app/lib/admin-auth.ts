import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// 管理者メアド。app/page.tsx の ADMIN_EMAILS と同期させる。
export const ADMIN_EMAILS = [
  'prostzaitaku@gmail.com',
  'eijisanzou@gmail.com',
];

type AdminAuthResult =
  | { ok: true; email: string }
  | { ok: false; response: NextResponse };

export async function requireAdmin(req: Request): Promise<AdminAuthResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'server misconfigured' },
        { status: 500 },
      ),
    };
  }

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'unauthorized' },
        { status: 401 },
      ),
    };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await supabase.auth.getUser(token);
  const email = data?.user?.email || '';
  if (error || !email || !ADMIN_EMAILS.includes(email)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'forbidden' },
        { status: 403 },
      ),
    };
  }

  return { ok: true, email };
}
