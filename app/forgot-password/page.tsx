'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage('処理中...');

    // 🌟 ここで「パスワード再設定メール」を送信します
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // メール内のリンクをクリックした後に飛ばす画面のURLを指定
      redirectTo: `${window.location.origin}/update-password`,
    });

    if (error) {
      setMessage(`エラー: ${error.message}`);
    } else {
      setMessage('パスワード再設定用のメールを送信しました。メールボックスをご確認ください。');
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-md">
        <h2 className="text-2xl font-bold text-center mb-6">パスワードの再設定</h2>
        <p className="text-sm text-gray-600 mb-6 text-center">
          登録したメールアドレスを入力してください。パスワード再設定用のリンクをお送りします。
        </p>
        
        <form className="space-y-4" onSubmit={handleResetPassword}>
          <div>
            <label className="block text-sm font-medium text-gray-700">メールアドレス</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full p-2 border border-gray-300 rounded-md"
              required 
            />
          </div>
          <div className="pt-2">
            <button 
              type="submit"
              disabled={isLoading}
              className="w-full bg-blue-600 text-white p-2 rounded-md hover:bg-blue-700 transition font-bold disabled:bg-gray-400"
            >
              {isLoading ? '送信中...' : '再設定メールを送信する'}
            </button>
          </div>
        </form>

        {message && <p className="mt-4 text-center text-sm font-bold text-green-600">{message}</p>}

        <div className="mt-6 text-center">
          <a href="/login" className="text-sm text-blue-600 hover:underline">
            ← ログイン画面に戻る
          </a>
        </div>
      </div>
    </div>
  );
}