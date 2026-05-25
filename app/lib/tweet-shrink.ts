import { GoogleGenerativeAI } from '@google/generative-ai';
import { TWEET_MAX_LENGTH, findOverflowTweets, hardTruncateTweet } from './tweet-length';

type TweetKey = 'tweet_1' | 'tweet_2' | 'tweet_3';

async function shrinkSingle(
  genAI: GoogleGenerativeAI,
  text: string
): Promise<string> {
  const prompt = `次のXツイート文を、意味・絵文字・改行レイアウト・「[アフィリリンク]」「[ad]」「PR」「ハッシュタグ」を可能な限り保持したまま **${TWEET_MAX_LENGTH}文字以内** に短縮してください。

【絶対ルール】
- 出力は短縮後の本文のみ。前置き・後書き・引用符・コードブロック・説明文を一切付けない
- 「[アフィリリンク]」「[ad]」「PR」は必ず維持。実URLには変えない
- 絵文字は意味を持つもの1〜2個は残してOK。多すぎたら削る
- 改行「\\n」と空白行「\\n\\n」のレイアウトは可能な範囲で維持。字数のため空白行を通常改行に圧縮するのは可
- 文末の「。」「！」「？」は自然に残す
- ${TWEET_MAX_LENGTH}文字を1文字でも超えたら絶対NG。語尾の枕詞や補足、二重表現を削って字数優先で詰めること

【元のツイート】
${text}

【短縮版（${TWEET_MAX_LENGTH}文字以内、本文のみ）】`;

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  const result = await model.generateContent(prompt);
  let out = (await result.response.text()).trim();
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  out = out.replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();
  return out;
}

export async function enforceTweetLengths(
  genAI: GoogleGenerativeAI,
  data: { tweet_1?: string; tweet_2?: string; tweet_3?: string }
): Promise<{ tweet_1?: string; tweet_2?: string; tweet_3?: string; shrunk: TweetKey[] }> {
  const result = { ...data, shrunk: [] as TweetKey[] };
  const overflows = findOverflowTweets(data);
  for (const { key } of overflows) {
    const original = data[key] || '';
    try {
      let shrunk = await shrinkSingle(genAI, original);
      if (shrunk.length > TWEET_MAX_LENGTH) {
        shrunk = await shrinkSingle(genAI, shrunk);
      }
      if (shrunk.length > 0 && shrunk.length <= TWEET_MAX_LENGTH) {
        result[key] = shrunk;
        result.shrunk.push(key);
      } else {
        // AI短縮が上限を守れなかった/空を返した場合でも、確定的トランケートで
        // 必ず上限以内に収める。over_max を素通しさせない最終保険。
        const base = shrunk.length > 0 ? shrunk : original;
        result[key] = hardTruncateTweet(base, TWEET_MAX_LENGTH);
        result.shrunk.push(key);
        console.warn(`tweet短縮AI失敗→ハードトランケート適用（${original.length}→${result[key]!.length}文字）: ${key}`);
      }
    } catch (e: any) {
      // 例外時も素通しせず、元文をトランケートして上限厳守
      result[key] = hardTruncateTweet(original, TWEET_MAX_LENGTH);
      result.shrunk.push(key);
      console.warn(`tweet短縮エラー→ハードトランケート適用: ${key}: ${e?.message || e}`);
    }
  }
  return result;
}
