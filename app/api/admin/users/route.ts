import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ユーザー一覧取得
export async function GET() {
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;

    const users = data.users.map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
    }));

    return NextResponse.json({ success: true, users });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// ユーザー新規作成（単体 or 一括）
export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 一括登録
    if (body.bulk && Array.isArray(body.users)) {
      const supabase = createClient(supabaseUrl, supabaseServiceKey);
      const results: { email: string; success: boolean; error?: string }[] = [];

      for (const u of body.users) {
        if (!u.email || !u.password) {
          results.push({ email: u.email || '(空)', success: false, error: 'メールアドレスまたはパスワードが空です' });
          continue;
        }
        try {
          const { error } = await supabase.auth.admin.createUser({
            email: u.email,
            password: u.password,
            email_confirm: true,
          });
          if (error) {
            results.push({ email: u.email, success: false, error: error.message });
          } else {
            results.push({ email: u.email, success: true });
          }
        } catch (e: any) {
          results.push({ email: u.email, success: false, error: e.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      return NextResponse.json({ success: true, bulk: true, results, successCount, totalCount: results.length });
    }

    // 単体登録
    const { email, password } = body;
    if (!email || !password) {
      return NextResponse.json({ success: false, error: 'メールアドレスとパスワードは必須です' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) throw error;

    return NextResponse.json({ success: true, user: { id: data.user.id, email: data.user.email } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
