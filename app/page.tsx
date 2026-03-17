'use client';

import { useEffect, useState } from 'react';

export default function Home() {
  const [allData, setAllData] = useState([]);
  const [displayData, setDisplayData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null); // コピー状態を管理

  const GAS_URL = "https://script.google.com/macros/s/AKfycbwHStCW0TscLkauxjxFaH7SRSBA2HLJdBW8v-bH8MaW1qh4Hf1URC5jANP5_NBLKo3y/exec";

  useEffect(() => {
    fetch(GAS_URL)
      .then(res => res.json())
      .then(json => {
        setAllData(json);
        setDisplayData(json);
        setLoading(false);
      })
      .catch(err => console.error("Error:", err));
  }, []);

  const handleFilter = (filter: string) => {
    setActiveFilter(filter);
    if (filter === 'all') {
      setDisplayData(allData);
    } else {
      const filtered = allData.filter((item: any) => item.purpose === filter);
      setDisplayData(filtered);
    }
  };

  // 【新機能】コピーボタンの処理
  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000); // 2秒後に元に戻す
    });
  };

  const getCategoryColor = (category: string) => {
    const colors: { [key: string]: string } = {
      'セール': 'bg-orange-50 text-orange-600',
      '番組': 'bg-pink-50 text-pink-600',
      'スポーツ': 'bg-blue-50 text-blue-600',
      '音楽': 'bg-purple-50 text-purple-600',
    };
    return colors[category] || 'bg-slate-50 text-slate-600';
  };

  // --- 詳細表示 ---
  if (selectedItem) {
    return (
      <div className="min-h-screen bg-white p-6 pb-20">
        <button onClick={() => setSelectedItem(null)} className="mb-6 flex items-center text-slate-500 font-bold hover:text-blue-600 transition-colors">
          <span className="mr-2">←</span> 一覧に戻る
        </button>

        <div className="max-w-2xl mx-auto">
          <div className="flex gap-2 mb-4">
            <span className={`px-2 py-1 rounded-lg text-[10px] font-bold ${getCategoryColor(selectedItem.category)}`}>
              {selectedItem.category}
            </span>
            <span className="px-2 py-1 bg-slate-100 text-slate-500 rounded-lg text-[10px] font-bold">
              {selectedItem.purpose}
            </span>
          </div>

          <h1 className="text-2xl font-bold mb-8 leading-tight text-slate-800">{selectedItem.title}</h1>
          
          <div className="space-y-10">
            <section className="bg-slate-50 p-6 rounded-3xl border border-slate-100 shadow-sm">
              <h3 className="text-blue-600 font-bold text-sm mb-3 flex items-center gap-2">
                🚀 今注目する理由
              </h3>
              <p className="text-slate-600 text-[15px] leading-relaxed italic">
                {selectedItem.why_now}
              </p>
            </section>

            <section>
              <h3 className="text-slate-800 font-bold text-lg mb-4 flex items-center gap-2">
                📱 投稿例（クリックでコピー）
              </h3>
              <div className="grid gap-4">
                {[selectedItem.tweet_1, selectedItem.tweet_2, selectedItem.tweet_3].filter(Boolean).map((t, i) => (
                  <div key={i} className="group relative">
                    <div className="bg-white p-5 rounded-2xl border-2 border-slate-50 shadow-sm group-hover:border-blue-200 transition-all">
                      <p className="text-slate-700 text-[14px] leading-relaxed whitespace-pre-wrap mb-4">{t}</p>
                      <button 
                        onClick={() => handleCopy(t, i)}
                        className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${
                          copiedIndex === i 
                          ? 'bg-emerald-500 text-white' 
                          : 'bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white'
                        }`}
                      >
                        {copiedIndex === i ? '✓ コピー完了！' : '本文をコピーする'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  // --- 一覧表示（前回のまま） ---
  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <header className="max-w-2xl mx-auto mb-8 py-8 text-center">
        <h1 className="text-3xl font-black text-slate-800 tracking-tighter">Antigravity<span className="text-blue-600">.next</span></h1>
        <div className="mt-4 inline-block bg-white px-4 py-2 rounded-2xl shadow-sm border border-slate-100">
           <span className="text-blue-600 font-bold text-xs">💡 TIPS:</span> <span className="text-slate-500 text-xs">スプレッドシートを更新すると自動反映されます</span>
        </div>
      </header>

      <div className="max-w-2xl mx-auto mb-10 flex justify-center gap-2">
        {['all', '運用', '収益化'].map((f) => (
          <button
            key={f}
            onClick={() => handleFilter(f)}
            className={`px-6 py-2 rounded-full text-xs font-bold transition-all ${
              activeFilter === f ? 'bg-blue-600 text-white shadow-xl shadow-blue-200' : 'bg-white text-slate-400 border border-slate-100'
            }`}
          >
            {f === 'all' ? 'すべて' : f}
          </button>
        ))}
      </div>

      <main className="max-w-2xl mx-auto">
        {loading ? (
          <div className="text-center py-20 text-slate-300 font-bold animate-pulse text-sm tracking-widest uppercase">Fetching Database...</div>
        ) : (
          <div className="grid gap-6">
            {displayData.map((item: any, index: number) => (
              <div key={index} onClick={() => setSelectedItem(item)} className="bg-white rounded-3xl p-6 shadow-sm border border-slate-50 hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer group">
                <div className="flex justify-between items-start mb-4">
                   <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider ${getCategoryColor(item.category)}`}>
                    {item.category}
                  </span>
                  <span className="text-[10px] font-bold text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-md">{item.time_status}</span>
                </div>
                <h3 className="text-xl font-bold text-slate-800 mb-3 group-hover:text-blue-600 transition-colors leading-tight">{item.title}</h3>
                <p className="text-slate-400 text-sm line-clamp-2 leading-relaxed">{item.why_now}</p>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}