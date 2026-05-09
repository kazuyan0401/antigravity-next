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
