import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/admin-auth';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ユーザー一覧取得
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Supabase Admin API の listUsers はデフォルト50件/ページ。
    // 全件取れるようページングしてすべて回収する。
    const perPage = 1000;
    let page = 1;
    const allUsers: { id: string; email: string | undefined; created_at: string }[] = [];
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      for (const u of data.users) {
        allUsers.push({ id: u.id, email: u.email, created_at: u.created_at });
      }
      if (data.users.length < perPage) break;
      page++;
    }

    return NextResponse.json({ success: true, users: allUsers });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// ユーザー新規作成（単体 or 一括）
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
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
