'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';

// ビルド時に鍵がなくてもエラーにならないように設定
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// URLとKeyがある時だけ接続を確立する
const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export default function Home() {
  const [allData, setAllData] = useState<any[]>([]);
  const [displayData, setDisplayData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAuthLoading, setIsAuthLoading] = useState(true); // 認証中かどうか
  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [inputUrl, setInputUrl] = useState('');
  const [inputMemo, setInputMemo] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  
  const [isAdminUser, setIsAdminUser] = useState(false);
  // 🌟 ここから追加：編集機能用のステートと関数
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);

  // 編集モードに入る関数
  const startEditing = () => {
    setEditData({ ...selectedItem }); // 現在のデータをコピーして編集用にする
    setIsEditing(true);
  };

  // 編集内容を保存する関数
  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/update-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editData)
      });
      const result = await res.json();
      
      if (result.success) {
        alert("編集内容を保存しました！");
        setIsEditing(false);
        setSelectedItem(editData); // 画面の表示も最新にする
        fetchData(); // 一覧データも再取得
      } else {
        alert("エラー: " + result.error);
      }
    } catch (err) {
      alert("通信エラーが発生しました");
    } finally {
      setIsSaving(false);
    }
  };
  // 🌟 ここまで追加
  
  // 🌟 管理者のメールアドレスをリストで指定します（カンマ区切りで追加可能）
  const ADMIN_EMAILS = [
    'prostzaitaku@gmail.com',
    'eijisanzou@gmail.com', // ←ご友人のアドレスに書き換えてください
    // '3人目@example.com' 
  ];

  const router = useRouter();

  // ログイン状態の完璧なチェックと監視
  useEffect(() => {
    if (!supabase) return;

    const setupAuth = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (!session) {
          router.push('/login');
        } else {
          // 🌟 リストの中にログインした人のメアドが含まれているかチェック
          setIsAdminUser(ADMIN_EMAILS.includes(session.user?.email || '')); 
          setIsAuthLoading(false);
        }
      } catch (err) {
        console.error("認証エラー:", err);
        router.push('/login');
      }
    };

    setupAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.push('/login');
      } else {
        // 🌟 リストの中にログインした人のメアドが含まれているかチェック
        setIsAdminUser(ADMIN_EMAILS.includes(session.user?.email || '')); 
        setIsAuthLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  const fetchData = async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    
    setLoading(true);
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error) {
      setAllData(data || []);
      setDisplayData(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    // 認証が終わってからデータを読み込む
    if (!isAuthLoading) {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoading]);

  const handleOpenAdmin = () => {
    // ⊕ボタンを押した時の合言葉チェックは不要になりました（ボタン自体を管理者しか見えないようにしたため）
    setIsAdmin(true);
  };

  const handleFilter = (filter: string) => {
    setActiveFilter(filter);
    if (filter === 'all') {
      setDisplayData(allData);
    } else if (filter === 'monetize') {
      // 🌟「収益特化」のものだけを抽出
      const filtered = allData.filter((item: any) => item.purpose === '収益特化');
      setDisplayData(filtered);
    } else if (filter === 'shadowban') {
      // 🌟「シャドウバン対策」のものだけを抽出
      const filtered = allData.filter((item: any) => item.purpose === 'シャドウバン対策');
      setDisplayData(filtered);
    }
  };

  const handlePost = async () => {
    if (!inputUrl) return;
    setIsGenerating(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: inputUrl, memo: inputMemo }) 
      });
      const result = await res.json();
      if (result.success) {
        alert("AI生成と保存が完了しました！");
        setInputUrl('');
        setInputMemo('');
        fetchData();
        setIsAdmin(false);
      } else {
        alert("エラーが発生しました: " + result.error);
      }
    } catch (err) {
      alert("通信エラーが発生しました");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRegenerate = async () => {
    if (!selectedItem) return;
    setIsGenerating(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url: selectedItem.original_url, 
          // 🌟 魔法の修正：AIへの強制命令の中に、現在のタイトルを直接「変数」として埋め込む！
          memo: `【再生成】より自然でプロらしい分析に直してください。
🚨【超重要・絶対厳守】🚨
このニュースの番組名や商品は「${selectedItem.title}」です。
AI側で「今日のテレビ番組」等の言葉に丸めることは絶対に禁止します。
必ず、出力する【タイトル】【今注目する理由】【すべてのツイート本文】に、「${selectedItem.title}」の文字をそのまま確実に含めてください。`, 
          id: selectedItem.id,
          title: selectedItem.title 
        }) 
      });
      const result = await res.json();
      if (result.success) {
        alert("最新AIで書き換えました！");
        fetchData();
        setSelectedItem(null);
      } else {
        alert("エラー: " + result.error);
      }
    } catch (err) {
      alert("通信エラー");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // 🌟 認証中は真っ白なローディング画面を表示（チラつき防止）
  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center font-bold text-slate-400">
        認証中...
      </div>
    );
  }

  // 🌟 詳細画面の表示（編集機能付き）
  if (selectedItem) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 pb-20 font-sans text-slate-800">
        <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-sm overflow-hidden min-h-screen">
          
          {/* 1. ヘッダー：戻るボタンと管理者ボタン */}
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <button 
              onClick={() => { setSelectedItem(null); setIsEditing(false); }} 
              className="text-slate-400 hover:text-slate-600 font-bold flex items-center gap-1"
            >
              <span>←</span> 戻る
            </button>
            
            {/* 管理者用のアクションボタン群 */}
            {isAdminUser && (
              <div className="flex gap-2">
                {isEditing ? (
                  <>
                    <button onClick={() => setIsEditing(false)} className="text-[11px] font-bold bg-slate-100 text-slate-600 px-3 py-2 rounded-lg hover:bg-slate-200">キャンセル</button>
                    <button onClick={handleSaveEdit} disabled={isSaving} className="text-[11px] font-bold bg-green-500 text-white px-3 py-2 rounded-lg hover:bg-green-600">
                      {isSaving ? '保存中...' : '保存する'}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={startEditing} className="text-[11px] font-bold bg-orange-50 text-orange-600 px-3 py-2 rounded-lg hover:bg-orange-100">手動で編集</button>
                    <button onClick={handleRegenerate} disabled={isGenerating} className="text-[11px] font-bold bg-blue-50 text-blue-600 px-3 py-2 rounded-lg hover:bg-blue-100">
                      {isGenerating ? '分析中...' : 'AIで再分析'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="p-6">
            {/* 2. タグ情報（目的の編集に対応） */}
            <div className="flex flex-wrap gap-2 mb-4">
              <span className="text-[11px] font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-full">{selectedItem.category}</span>
              
              {isEditing ? (
                <select 
                  value={editData.purpose} 
                  onChange={(e) => setEditData({...editData, purpose: e.target.value})}
                  className="text-[11px] font-bold border border-blue-300 text-blue-600 bg-blue-50 px-2 py-1 rounded-md outline-none"
                >
                  <option value="収益特化">収益特化</option>
                  <option value="シャドウバン対策">シャドウバン対策</option>
                </select>
              ) : (
                <span className="text-[11px] font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-full">{selectedItem.purpose}</span>
              )}
              
              <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full">{selectedItem.time_status}</span>
              <span className="text-[11px] text-slate-400 ml-auto">{new Date(selectedItem.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>

            {/* 3. タイトルの編集 */}
            {isEditing ? (
              <textarea 
                value={editData.title}
                onChange={(e) => setEditData({...editData, title: e.target.value})}
                className="w-full text-xl font-bold mb-8 leading-snug p-3 border border-blue-300 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                rows={2}
              />
            ) : (
              <h1 className="text-xl font-bold mb-8 leading-snug">{selectedItem.title}</h1>
            )}
            
            {/* 4. 分析内容（編集対応） */}
            <section className="mb-8">
              <h3 className="text-sm font-bold text-blue-600 mb-3 flex items-center gap-2">
                <span className="bg-blue-100 text-blue-600 w-5 h-5 rounded-full flex items-center justify-center text-xs">1</span>今注目する理由
              </h3>
              {isEditing ? (
                <textarea
                  value={editData.why_now || ''}
                  onChange={(e) => setEditData({...editData, why_now: e.target.value})}
                  className="w-full p-4 text-sm text-slate-700 leading-relaxed bg-blue-50/30 border border-blue-300 rounded-xl outline-none min-h-[100px]"
                />
              ) : (
                <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-xl">{selectedItem.why_now}</p>
              )}
            </section>

            <section className="mb-8">
              <h3 className="text-sm font-bold text-blue-600 mb-3 flex items-center gap-2">
                <span className="bg-blue-100 text-blue-600 w-5 h-5 rounded-full flex items-center justify-center text-xs">2</span>このネタの使い方
              </h3>
              {isEditing ? (
                <textarea
                  value={editData.recommended_action || ''}
                  onChange={(e) => setEditData({...editData, recommended_action: e.target.value})}
                  className="w-full p-4 text-sm text-slate-700 leading-relaxed bg-blue-50/30 border border-blue-300 rounded-xl outline-none min-h-[100px]"
                />
              ) : (
                <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-xl">{selectedItem.recommended_action}</p>
              )}
            </section>

            <section className="mb-8">
              <h3 className="text-sm font-bold text-blue-600 mb-3 flex items-center gap-2">
                <span className="bg-blue-100 text-blue-600 w-5 h-5 rounded-full flex items-center justify-center text-xs">3</span>おすすめ案件候補
              </h3>
              {isEditing ? (
                <textarea
                  value={editData.affiliate_candidates || ''}
                  onChange={(e) => setEditData({...editData, affiliate_candidates: e.target.value})}
                  className="w-full p-4 text-sm text-slate-700 leading-relaxed bg-blue-50/30 border border-blue-300 rounded-xl outline-none min-h-[100px]"
                />
              ) : (
                <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-xl">{selectedItem.affiliate_candidates}</p>
              )}
            </section>

            <section className="mb-8 border-b border-slate-100 pb-8">
              <h3 className="text-sm font-bold text-red-500 mb-3 flex items-center gap-2">
                <span className="bg-red-100 text-red-500 w-5 h-5 rounded-full flex items-center justify-center text-xs">!</span>注意点
              </h3>
              {isEditing ? (
                <textarea
                  value={editData.cautions || ''}
                  onChange={(e) => setEditData({...editData, cautions: e.target.value})}
                  className="w-full p-4 text-sm text-red-700 leading-relaxed bg-red-50/30 border border-red-300 rounded-xl outline-none min-h-[100px]"
                />
              ) : (
                <div className="text-sm text-slate-600 leading-relaxed bg-red-50 p-4 rounded-xl whitespace-pre-wrap">{selectedItem.cautions}</div>
              )}
            </section>

            {/* 5. 投稿例（ツイート）の編集 */}
            <section className="mt-8 mb-8">
              <h3 className="text-sm font-bold text-blue-600 mb-4 flex items-center gap-2">
                <span className="bg-blue-100 text-blue-600 w-5 h-5 rounded-full flex items-center justify-center text-xs">✉️</span>投稿例
              </h3>
              <div className="space-y-6">
                {[1, 2, 3].map((num) => {
                  const tweetKey = `tweet_${num}`;
                  const currentTweet = isEditing ? editData[tweetKey] : selectedItem[tweetKey];
                  
                  if (!currentTweet && !isEditing) return null;

                  return (
                    <div key={num} className={`bg-white border rounded-xl overflow-hidden shadow-sm ${isEditing ? 'border-blue-300' : 'border-slate-200'}`}>
                      {isEditing ? (
                        <textarea
                          value={editData[tweetKey] || ''}
                          onChange={(e) => setEditData({...editData, [tweetKey]: e.target.value})}
                          className="w-full p-4 text-sm text-slate-700 leading-relaxed bg-blue-50/30 outline-none resize-y min-h-[120px]"
                          placeholder={`ツイート案 ${num}`}
                        />
                      ) : (
                        <>
                          <div className="p-4 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap bg-slate-50/50">{currentTweet}</div>
                          <div className="bg-white border-t border-slate-100 p-3 flex justify-between items-center">
                            <span className="text-xs text-slate-400 font-medium">{currentTweet.length}文字</span>
                            <button 
                              onClick={() => handleCopy(currentTweet, num)}
                              className={`text-xs font-bold px-4 py-2 rounded-lg transition-colors ${copiedIndex === num ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                              {copiedIndex === num ? '✓ コピー完了' : 'コピーする'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  // 🌟 新ネタ手動追加画面の表示
  if (isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 p-6 flex items-center justify-center font-sans">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md">
          <h2 className="text-xl font-bold mb-6 text-center text-slate-800">新ネタを投入</h2>
          <div className="mb-4">
            <label className="block text-xs font-bold text-slate-500 mb-2 ml-1">元ネタのURL <span className="text-red-500">*</span></label>
            <input 
              type="text" 
              placeholder="ニュースや商品のURLをペースト"
              className="w-full p-4 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
            />
          </div>
          <div className="mb-8">
            <label className="block text-xs font-bold text-slate-500 mb-2 ml-1">補足・アフィリエイター視点（任意）</label>
            <textarea 
              placeholder="例：〇〇が卒業発表したから、過去の円盤が売れるはず！"
              className="w-full p-4 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm h-28 resize-none"
              value={inputMemo}
              onChange={(e) => setInputMemo(e.target.value)}
            />
          </div>
          <button 
            onClick={handlePost}
            disabled={isGenerating || !inputUrl}
            className={`w-full py-4 rounded-2xl font-bold text-white transition-all ${isGenerating ? 'bg-slate-300 animate-pulse' : 'bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-200'}`}
          >
            {isGenerating ? 'AIが考え中...' : '生成して投稿！'}
          </button>
          <button onClick={() => setIsAdmin(false)} className="w-full mt-4 text-slate-400 text-sm font-bold hover:text-slate-600">キャンセル</button>
        </div>
      </div>
    );
  }

  // 🌟 メイン画面（リスト）の表示
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      <div className="max-w-xl mx-auto min-h-screen bg-white shadow-sm border-x border-slate-100">
        <header className="p-6 flex justify-between items-center border-b border-slate-100">
          <h1 className="text-xl font-black text-slate-800">X-Affiliate<span className="text-blue-600">.next</span></h1>
          {/* 🌟 管理者だけに⊕ボタンを表示 */}
          {isAdminUser && (
            <button onClick={handleOpenAdmin} className="bg-white p-2 text-xl text-blue-600 hover:bg-blue-50 rounded-full transition-colors">⊕</button>
          )}
        </header>

        {/* 🌟 タブ切り替えボタン（件数表示付き） */}
        <div className="p-4 flex gap-2 border-b border-slate-100 overflow-x-auto no-scrollbar">
          <button 
            onClick={() => handleFilter('all')} 
            className={`px-5 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${activeFilter === 'all' ? 'bg-blue-600 text-white shadow-md shadow-blue-200' : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100'}`}
          >
            すべて ({allData.length})
          </button>
          <button 
            onClick={() => handleFilter('monetize')} 
            className={`px-5 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-colors flex items-center gap-1 ${activeFilter === 'monetize' ? 'bg-green-600 text-white shadow-md shadow-green-200' : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100'}`}
          >
            💰 収益化 ({allData.filter(i => i.purpose === '収益特化').length})
          </button>
          <button 
            onClick={() => handleFilter('shadowban')} 
            className={`px-5 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-colors flex items-center gap-1 ${activeFilter === 'shadowban' ? 'bg-orange-500 text-white shadow-md shadow-orange-200' : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100'}`}
          >
            🛡️ 運用・対策 ({allData.filter(i => i.purpose === 'シャドウバン対策').length})
          </button>
        </div>

        <main className="p-4 bg-slate-50/50 h-full">
          {loading ? (
            <div className="text-center py-20 animate-pulse text-slate-300">データベースを読み込み中...</div>
          ) : (
            <div className="grid gap-4">
              {displayData.map((item, index) => (
                <div key={index} onClick={() => setSelectedItem(item)} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 cursor-pointer hover:shadow-md transition-all">
                  <div className="flex gap-2 mb-3">
                    <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-md">{item.category}</span>
                    <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded-md">{item.purpose}</span>
                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-md">{item.time_status}</span>
                  </div>
                  <h3 className="text-[15px] font-bold text-slate-800 leading-snug mb-3">{item.title}</h3>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-slate-400">{new Date(item.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="text-xs font-bold text-blue-600 hover:underline">詳細を見る →</span>
                  </div>
                </div>
              ))}
              {displayData.length === 0 && (
                <div className="text-center py-20 text-slate-400 border-2 border-dashed border-slate-200 rounded-3xl">
                  データがまだありません。<br/>{isAdminUser && '右上の「⊕」から追加してください。'}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}