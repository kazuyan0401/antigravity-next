#!/usr/bin/env node
// 既存posts の100字未満 tweet を Gemini で 100〜120字に拡張するバッチ。
// app/lib/tweet-expand.ts の Node 等価実装。
// 入力: ~/Downloads/posts_rows.json （Supabase export）
// 出力: ./posts_rows_expanded.json と ./posts_expand_update.sql
//
// 実行: node scripts/expand-existing-posts.mjs [--limit=N] [--concurrency=K]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env.local 読み込み
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TWEET_MIN = 100;
const TWEET_MAX = 120;
const INPUT_PATH = process.env.INPUT_PATH || `${process.env.HOME}/Downloads/posts_rows.json`;
const OUT_JSON = path.join(__dirname, '..', 'posts_rows_expanded.json');
const OUT_SQL = path.join(__dirname, '..', 'posts_expand_update.sql');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const CONCURRENCY = args.concurrency ? parseInt(args.concurrency, 10) : 4;

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY 未設定 (.env.local を確認)');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

function expandPrompt(text, context) {
  const ctxBlock = context ? `\n【参考情報（事実改変・捏造禁止のため必ず参照）】\n${context}\n` : '';
  return `次のXツイート文を、意味・絵文字・改行レイアウト・「[アフィリリンク]」「[ad]」「PR」「ハッシュタグ」を維持したまま、**${TWEET_MIN}文字以上${TWEET_MAX}文字以内** に拡張してください。

【絶対ルール】
- 出力は拡張後の本文のみ。前置き・後書き・引用符・コードブロック・説明文を一切付けない
- 「[アフィリリンク]」「[ad]」「PR」は必ず維持。実URLには絶対に変えない
- ハッシュタグ「#xxx」は維持し、必要に応じて追加可
- 元のツイートが持つ事実・感情・誘導・問いかけはそのまま、参考情報の範囲内で要素（具体情報/共感/問いかけ）を追加して${TWEET_MIN}字以上に
- **事実情報を改変・捏造することは絶対禁止**（参考情報や元ツイートに無い数字・人名・日付・固有名詞を勝手に足さない）
- 改行「\\n」と空白行「\\n\\n」のレイアウトは可能な範囲で維持。1段落にギュッと詰めず、段落間に空白行を入れる
- 「[アフィリリンク]」がある場合、そのリンク行は単独行に配置すること（前後を改行で分ける）
- ${TWEET_MIN}文字未満は絶対NG、${TWEET_MAX}文字を超えるのも絶対NG。出力前に自分で文字数を数えてレンジ内に収めること
${ctxBlock}
【元のツイート】
${text}

【拡張版（${TWEET_MIN}〜${TWEET_MAX}字、本文のみ）】`;
}

function clean(text) {
  let out = text.trim();
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  out = out.replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();
  return out;
}

async function expandOnce(text, context, useFallback = false) {
  const m = useFallback ? fallbackModel : model;
  const r = await m.generateContent(expandPrompt(text, context));
  return clean(await r.response.text());
}

async function expand(text, context) {
  let out = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      out = await expandOnce(text, context, attempt >= 2);
      if (out.length >= TWEET_MIN && out.length <= TWEET_MAX) return out;
      // レンジ外ならその出力をさらに拡張/短縮
      const seed = out.length === 0 ? text : out;
      const out2 = await expandOnce(seed, context, attempt >= 1);
      if (out2.length >= TWEET_MIN && out2.length <= TWEET_MAX) return out2;
      out = out2 || out;
    } catch (e) {
      console.warn(`  attempt${attempt + 1} エラー: ${(e.message || '').slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

function escapeSql(text) {
  return text == null ? 'NULL' : `'${String(text).replace(/'/g, "''")}'`;
}

function buildContext(p) {
  return [p.title, p.source_summary, p.why_now, p.affiliate_candidates].filter(Boolean).join('\n');
}

async function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`入力ファイルなし: ${INPUT_PATH}`);
    process.exit(1);
  }
  const posts = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  console.log(`読み込み: ${posts.length}件 from ${INPUT_PATH}`);

  // 対象抽出: 100字未満（空は除外）
  const targets = [];
  for (const p of posts) {
    const unders = [];
    for (const k of ['tweet_1', 'tweet_2', 'tweet_3']) {
      const L = (p[k] || '').length;
      if (L > 0 && L < TWEET_MIN) unders.push(k);
    }
    if (unders.length > 0) targets.push({ id: p.id, unders, post: p });
  }
  console.log(`対象投稿: ${targets.length}件 / 個別tweet: ${targets.reduce((a, t) => a + t.unders.length, 0)}件`);

  if (targets.length === 0) {
    console.log('拡張対象なし。終了。');
    return;
  }

  const limited = targets.slice(0, LIMIT);
  console.log(`今回処理: ${limited.length}件 (concurrency=${CONCURRENCY})`);

  const updates = [];
  let done = 0;
  let failed = 0;

  const queue = limited.slice();
  async function worker(workerId) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const ctx = buildContext(item.post);
      const fields = {};
      for (const k of item.unders) {
        const original = item.post[k];
        const expanded = await expand(original, ctx);
        if (expanded && expanded.length >= TWEET_MIN && expanded.length <= TWEET_MAX) {
          fields[k] = expanded;
        } else {
          failed++;
          console.warn(`  [w${workerId}] id=${item.id} ${k} 拡張失敗 (元${original.length}文字)`);
        }
      }
      if (Object.keys(fields).length > 0) {
        updates.push({ id: item.id, fields });
      }
      done++;
      if (done % 10 === 0 || done === limited.length) {
        console.log(`進捗: ${done}/${limited.length} (失敗tweet累計: ${failed})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  console.log(`\n完了: ${done}投稿処理 / ${updates.length}投稿に変更あり / ${failed}tweet失敗`);

  // 出力1: 修正済み完全JSON
  const idMap = new Map(updates.map((u) => [u.id, u.fields]));
  const fixed = posts.map((p) => (idMap.has(p.id) ? { ...p, ...idMap.get(p.id) } : p));
  fs.writeFileSync(OUT_JSON, JSON.stringify(fixed, null, 2), 'utf-8');
  console.log(`書き出し: ${OUT_JSON}`);

  // 出力2: SQL UPDATE
  const sqlLines = ['-- 自動生成: tweet 100字未満を AI 拡張した UPDATE'];
  for (const { id, fields } of updates) {
    const sets = Object.entries(fields).map(([k, v]) => `${k} = ${escapeSql(v)}`).join(', ');
    sqlLines.push(`UPDATE posts SET ${sets} WHERE id = ${id};`);
  }
  fs.writeFileSync(OUT_SQL, sqlLines.join('\n') + '\n', 'utf-8');
  console.log(`書き出し: ${OUT_SQL}`);

  console.log('\n適用方法:');
  console.log('  Supabase SQL Editor で posts_expand_update.sql を貼り付けて実行');
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
