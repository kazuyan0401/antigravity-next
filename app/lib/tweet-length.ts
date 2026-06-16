export const TWEET_MAX_LENGTH = 120;
export const TWEET_MIN_LENGTH = 100;

export function isOverLimit(text: string | null | undefined): boolean {
  return (text?.length || 0) > TWEET_MAX_LENGTH;
}

export function isUnderLimit(text: string | null | undefined): boolean {
  const len = text?.length || 0;
  return len > 0 && len < TWEET_MIN_LENGTH;
}

export function findOverflowTweets(
  data: { tweet_1?: string; tweet_2?: string; tweet_3?: string }
): Array<{ key: 'tweet_1' | 'tweet_2' | 'tweet_3'; length: number }> {
  const result: Array<{ key: 'tweet_1' | 'tweet_2' | 'tweet_3'; length: number }> = [];
  (['tweet_1', 'tweet_2', 'tweet_3'] as const).forEach((key) => {
    const t = data[key] || '';
    if (t.length > TWEET_MAX_LENGTH) result.push({ key, length: t.length });
  });
  return result;
}

export function findUnderflowTweets(
  data: { tweet_1?: string; tweet_2?: string; tweet_3?: string }
): Array<{ key: 'tweet_1' | 'tweet_2' | 'tweet_3'; length: number }> {
  const result: Array<{ key: 'tweet_1' | 'tweet_2' | 'tweet_3'; length: number }> = [];
  (['tweet_1', 'tweet_2', 'tweet_3'] as const).forEach((key) => {
    const t = data[key] || '';
    if (t.length > 0 && t.length < TWEET_MIN_LENGTH) result.push({ key, length: t.length });
  });
  return result;
}

// AI短縮/拡張が上限を守れなかった場合の、確定的な最終トランケート。
// 末尾のリンク行（[アフィリリンク]/[ad]）とハッシュタグ行は可能な限り温存し、
// 本文側を文末（。！？!?）境界で削って max 以内に必ず収める。
// AIに頼らないため失敗しない＝over_max を物理的にゼロにするための保険。
// .length は UTF-16 単位のため、絵文字（サロゲートペア）の途中で切ると
// 末尾に孤立サロゲートが残り表示が壊れる。スライス結果から末尾の孤立分を落とす。
function trimLoneSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

export function hardTruncateTweet(
  text: string | null | undefined,
  max: number = TWEET_MAX_LENGTH
): string {
  if (!text) return text || '';
  if (text.length <= max) return text;

  const lines = text.split('\n');
  // 末尾の「リンク行・ハッシュタグ行・空行」は温存対象として退避
  const keepTail: string[] = [];
  while (
    lines.length > 0 &&
    /^\s*(?:\[アフィリリンク\]|\[ad\]|#|$)/i.test(lines[lines.length - 1])
  ) {
    keepTail.unshift(lines.pop() as string);
  }
  const tail = keepTail.join('\n').trim();
  // tail だけで超過する場合は、tail を捨ててでも本文を優先（リンク無しでも上限厳守）
  const tailCost = tail ? tail.length + 2 : 0; // +2 は本文との連結改行（\n\n）
  const budget = max - tailCost;

  let body = lines.join('\n').trim();
  if (budget <= 0) {
    // tail が大きすぎる → 本文を max で素直に切る（保険の保険）
    return trimLoneSurrogate(body.slice(0, max)).trim() || trimLoneSurrogate(text.slice(0, max)).trim();
  }
  if (body.length > budget) {
    let head = body.slice(0, budget);
    // 直近の文末記号で自然に切る（あまりに短く切れすぎる場合はそのまま）
    const m = head.match(/^[\s\S]*[。！？!?]/);
    if (m && m[0].length >= budget * 0.5) head = m[0];
    body = trimLoneSurrogate(head).trim();
  }
  const joined = (tail ? `${body}\n\n${tail}` : body).trim();
  return joined.length <= max ? joined : trimLoneSurrogate(joined.slice(0, max)).trim();
}
