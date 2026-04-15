'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// 環境変数からSupabaseの情報を読み込む
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export default function LoginPage() {
  const [isLoginMode, setIsLoginMode] = useState(true); // 🌟 ログイン/登録の切り替え用
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [secretWord, setSecretWord] = useState(''); // 🌟 合言葉用ステート
  const [message, setMessage] = useState('');

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('処理中...');

    if (isLoginMode) {
      // 🔵 ログイン処理（以前のまま）
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage(`エラー: ログイン情報が間違っています`);
      else {
        setMessage('ログイン成功！');
        window.location.href = '/';
      }
    } else {
      // 🔴 新規登録処理（作成したAPIの裏口へ送信）
      if (!secretWord) {
        setMessage('合言葉を入力してください。');
        return;
      }

      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, secretWord })
        });
        
        const data = await res.json();

        if (!res.ok) {
          setMessage(`エラー: ${data.error}`); // 合言葉間違いなどはここで表示
        } else {
          setMessage('登録成功！自動でログインします...');
          // API側でアカウントが強制発行されたので、その情報で即座にログインする
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) {
            setMessage('登録は完了しましたが、ログインに失敗しました。');
          } else {
            window.location.href = '/';
          }
        }
      } catch (err) {
        setMessage('通信エラーが発生しました。');
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-md">
        <h2 className="text-2xl font-bold text-center mb-6">
          {isLoginMode ? 'ログイン' : '購入者専用 新規登録'}
        </h2>
        <form className="space-y-4" onSubmit={handleAuth}>
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
          <div>
            <label className="block text-sm font-medium text-gray-700">パスワード（6文字以上）</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full p-2 border border-gray-300 rounded-md"
              required 
            />
          </div>

          {isLoginMode && (
              <div className="text-right mt-1">
                <a href="/forgot-password" className="text-xs text-blue-600 hover:underline">
                  パスワードを忘れた方はこちら
                </a>
              </div>
            )}
          
          {/* 🌟 新規登録モードの時だけ「合言葉」入力欄を表示 */}
          {!isLoginMode && (
            <div>
              <label className="block text-sm font-medium text-gray-700">購入者専用 合言葉</label>
              <input 
                type="text" 
                value={secretWord}
                onChange={(e) => setSecretWord(e.target.value)}
                placeholder="購入完了メールに記載の合言葉"
                className="mt-1 block w-full p-2 border border-gray-300 rounded-md bg-yellow-50"
                required={!isLoginMode} 
              />
            </div>
          )}

          <div className="pt-4">
            <button 
              type="submit"
              className="w-full bg-blue-600 text-white p-2 rounded-md hover:bg-blue-700 transition font-bold"
            >
              {isLoginMode ? 'ログインする' : '合言葉を使って登録する'}
            </button>
          </div>
        </form>

        {message && <p className="mt-4 text-center text-sm font-bold text-red-600">{message}</p>}

        {/* 🌟 モード切り替えボタン */}
        <div className="mt-6 text-center">
          <button 
            type="button"
            onClick={() => {
              setIsLoginMode(!isLoginMode);
              setMessage(''); // モードを切り替えたらエラーメッセージを消す
            }}
            className="text-sm text-blue-600 hover:underline"
          >
            {isLoginMode ? 'はじめての方（新規登録）はこちら' : 'すでにアカウントをお持ちの方（ログイン）はこちら'}
          </button>
        </div>
      </div>
    </div>
  );
}