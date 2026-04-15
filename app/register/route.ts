import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { email, password, secretWord } = await req.json();

    // 1. 合言葉のチェック
    const correctSecret = process.env.REGISTRATION_SECRET;
    if (secretWord !== correctSecret) {
      return NextResponse.json({ success: false, error: "合言葉が間違っています。" }, { status: 403 });
    }

    // 2. Supabaseの管理者権限で接続（これで表玄関が閉まっていても登録可能）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; // 管理者キー
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 3. ユーザーの強制作成（メール認証なしで即座にログイン可能にする設定）
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true // 自動でメール確認済みにする
    });

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true, user: data.user });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}