'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage('更新中...');

    // 🌟 ユーザーのパスワードを上書きします
    const { error } = await supabase.auth.updateUser({
      password: password
    });

    if (error) {
      setMessage(`エラー: ${error.message}`);
    } else {
      setMessage('パスワードを更新しました！自動でトップページへ移動します...');
      setTimeout(() => {
        window.location.href = '/'; // 成功したらトップページへ
      }, 2000);
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-md">
        <h2 className="text-2xl font-bold text-center mb-6">新しいパスワードの設定</h2>
        
        <form className="space-y-4" onSubmit={handleUpdatePassword}>
          <div>
            <label className="block text-sm font-medium text-gray-700">新しいパスワード（6文字以上）</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full p-2 border border-gray-300 rounded-md"
              required 
            />
          </div>
          <div className="pt-2">
            <button 
              type="submit"
              disabled={isLoading || password.length < 6}
              className="w-full bg-blue-600 text-white p-2 rounded-md hover:bg-blue-700 transition font-bold disabled:bg-gray-400"
            >
              {isLoading ? '更新中...' : 'パスワードを更新する'}
            </button>
          </div>
        </form>

        {message && <p className="mt-4 text-center text-sm font-bold text-blue-600">{message}</p>}
      </div>
    </div>
  );
}