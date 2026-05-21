#!/usr/bin/env node
// 既存posts に対し tweet-sanitize 相当の後処理をオフラインで適用するバッチ。
// AI 呼び出しは使わず、正規表現ベースで以下を矯正する：
//   - JSON二重エスケープ \n / \\n を実改行へ
//   - 訃報・事件等のデリケート話題は purpose を強制シャドウバン対策へ
//   - シャドウバン対策の場合は [アフィリリンク]/[ad]/単独語PR を機械除去
//   - 禁止フレーズ（楽しみすぎる/胸熱 等）を代替表現へ置換
//   - テンプレ問いかけ（コメントで教えて/教えてね 等）を削除
//   - リンク要素を単独行へ切り出し前後に空白行を入れる（収益化のみ）
//
// 入力: ~/Downloads/posts_rows.json （Supabase export）
// 出力: ./posts_rows_sanitized.json と ./posts_sanitize_update.sql
//
// 実行: node scripts/sanitize-existing-posts.mjs [--limit=N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_PATH = process.env.INPUT_PATH || `${process.env.HOME}/Downloads/posts_rows.json`;
const OUT_JSON = path.join(__dirname, '..', 'posts_rows_sanitized.json');
const OUT_SQL = path.join(__dirname, '..', 'posts_sanitize_update.sql');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;

// ============ app/lib/tweet-sanitize.ts と同じロジックを再実装 ============

const DELICATE_KEYWORDS = [
  '訃報', '死去', '逝去', '永眠', 'ご冥福', '謹んで', '哀悼', '葬儀', '葬式',
  '事件', '事故', '逮捕', '謝罪', '不祥事', '炎上', 'スキャンダル',
  '離婚', '訴訟', '提訴', '送検', '書類送検', '懲役', '罰金',
  '飛び降り', '自殺', '自死', '急逝', 'お悔やみ',
];

function isDelicateTopic(...sources) {
  const text = sources.filter(Boolean).join(' ');
  return DELICATE_KEYWORDS.some((kw) => text.includes(kw));
}

function normalizeNewlines(text) {
  if (!text) return text || '';
  return text.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
}

function stripAffiliateMarkers(text) {
  if (!text) return text || '';
  let out = text;
  out = out.replace(/\[アフィリリンク\]/g, '');
  out = out.replace(/\[ad\]/gi, '');
  out = out.replace(/(^|\n)\s*PR(?=\s|$|\n|[、。！？#])/g, '$1');
  out = out.replace(/([\s、。！？])PR(?=\s|$|\n|[、。！？#])/g, '$1');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

const BANNED_PHRASE_REPLACEMENTS = [
  [/楽しみすぎる/g, 'リアタイ待機'],
  [/ワクワクが止まらない/g, '期待が膨らむ'],
  [/胸熱/g, 'グッとくる'],
  [/激アツ/g, 'アツい展開'],
  [/話題沸騰/g, '話題に'],
  [/見逃せない/g, 'リアタイしたい'],
  [/要チェック/g, '気になる'],
  [/心に響く/g, '響く'],
  [/心から願う/g, '願う'],
  [/心を打たれる/g, '刺さる'],
  [/感無量/g, 'グッときた'],
];

function replaceBannedPhrases(text) {
  if (!text) return text || '';
  let out = text;
  for (const [re, rep] of BANNED_PHRASE_REPLACEMENTS) out = out.replace(re, rep);
  return out;
}

const TEMPLATE_QUESTION_PATTERNS = [
  /みんなはどう思う[？?][ー〜]*[！!。.✨😊🥺💬]*/g,
  /みんなはどう[？?][ー〜]*[！!。.✨😊🥺💬]*/g,
  /コメントで教えて[ねよな]?[ー〜]*[！!。.]*/g,
  /教えて(?:ほしい|欲しい)な?[ー〜]*[！!。.✨😊🥺💬]*/g,
  /教えてね[ー〜]*[！!。.✨😊🥺💬]*/g,
  /率直な感想[がを]?(?:聞きたい|聞かせて|教えて)/g,
  /感想(?:を)?(?:聞かせて|教えて)[ねよな]?[ー〜]*[！!。.]*/g,
];

function replaceTemplateQuestions(text) {
  if (!text) return text || '';
  let out = text;
  for (const re of TEMPLATE_QUESTION_PATTERNS) out = out.replace(re, '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function normalizeLinkLayout(text) {
  if (!text) return text || '';
  if (!/\[アフィリリンク\]|\[ad\]/i.test(text)) return text;
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    if (!/\[アフィリリンク\]|\[ad\]/i.test(line)) { out.push(line); continue; }
    const merged = line
      .replace(/(\[アフィリリンク\])\s*(\[ad\])/gi, '$1$2')
      .replace(/(\[ad\])\s*(\[アフィリリンク\])/gi, '$1$2');
    const parts = merged.split(/(\[アフィリリンク\]\[ad\]|\[ad\]\[アフィリリンク\]|\[アフィリリンク\]|\[ad\])/gi)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) out.push(p);
  }
  let joined = out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  joined = joined.replace(
    /(^|\n)(\[アフィリリンク\](?:\[ad\])?|\[ad\](?:\[アフィリリンク\])?)(\n|$)/g,
    (_, pre, token, post) => {
      const before = pre === '\n' ? '\n\n' : pre;
      const after = post === '\n' ? '\n\n' : post;
      return `${before}${token}${after}`;
    }
  );
  joined = joined.replace(/\n{3,}/g, '\n\n').trim();
  return joined;
}

function sanitizePost(input) {
  const delicate = isDelicateTopic(input.title, input.source_summary);
  const originalPurpose = (input.purpose || '').trim();
  const purpose = delicate ? 'シャドウバン対策' : originalPurpose;
  const isShadowban = purpose === 'シャドウバン対策';

  const clean = (t) => {
    let out = normalizeNewlines(t);
    if (isShadowban) out = stripAffiliateMarkers(out);
    out = replaceBannedPhrases(out);
    out = replaceTemplateQuestions(out);
    if (!isShadowban) out = normalizeLinkLayout(out);
    return out;
  };

  return {
    purpose,
    tweet_1: clean(input.tweet_1),
    tweet_2: clean(input.tweet_2),
    tweet_3: clean(input.tweet_3),
    delicate,
    forcedShadowban: delicate && originalPurpose !== 'シャドウバン対策',
  };
}

// ============ ここからバッチ処理 ============

function escapeSql(text) {
  return text == null ? 'NULL' : `'${String(text).replace(/'/g, "''")}'`;
}

function diffFields(before, after) {
  const fields = {};
  for (const k of ['purpose', 'tweet_1', 'tweet_2', 'tweet_3']) {
    if ((before[k] || '') !== (after[k] || '')) fields[k] = after[k];
  }
  return fields;
}

function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`入力ファイルなし: ${INPUT_PATH}`);
    process.exit(1);
  }
  const posts = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  console.log(`読み込み: ${posts.length}件 from ${INPUT_PATH}`);

  const updates = [];
  let forcedShadow = 0;
  let touched = 0;

  for (const p of posts.slice(0, LIMIT)) {
    const result = sanitizePost({
      title: p.title,
      source_summary: p.source_summary,
      purpose: p.purpose,
      tweet_1: p.tweet_1,
      tweet_2: p.tweet_2,
      tweet_3: p.tweet_3,
    });
    if (result.forcedShadowban) forcedShadow++;
    const after = { purpose: result.purpose, tweet_1: result.tweet_1, tweet_2: result.tweet_2, tweet_3: result.tweet_3 };
    const fields = diffFields(p, after);
    if (Object.keys(fields).length > 0) {
      updates.push({ id: p.id, fields });
      touched++;
    }
  }

  console.log(`変更ありレコード: ${touched} / ${Math.min(posts.length, LIMIT)}`);
  console.log(`内 デリケート→シャドウバン強制: ${forcedShadow}`);

  // 出力1: 修正済み完全JSON
  const idMap = new Map(updates.map((u) => [u.id, u.fields]));
  const fixed = posts.map((p) => (idMap.has(p.id) ? { ...p, ...idMap.get(p.id) } : p));
  fs.writeFileSync(OUT_JSON, JSON.stringify(fixed, null, 2), 'utf-8');
  console.log(`書き出し: ${OUT_JSON}`);

  // 出力2: SQL UPDATE
  const sqlLines = ['-- 自動生成: tweet-sanitize 相当の遡及補修UPDATE'];
  for (const { id, fields } of updates) {
    const sets = Object.entries(fields).map(([k, v]) => `${k} = ${escapeSql(v)}`).join(', ');
    sqlLines.push(`UPDATE posts SET ${sets} WHERE id = ${id};`);
  }
  fs.writeFileSync(OUT_SQL, sqlLines.join('\n') + '\n', 'utf-8');
  console.log(`書き出し: ${OUT_SQL}`);

  console.log('\n適用方法:');
  console.log('  Supabase SQL Editor で posts_sanitize_update.sql を貼り付けて実行');
  console.log('  ※ 文字数レンジ違反（100字未満 / 120字超）は本スクリプトでは直らない。');
  console.log('     既存 scripts/fix-tweet-lengths.mjs (AI短縮) と組み合わせて使うこと。');
}

main();
