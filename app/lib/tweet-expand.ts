import { GoogleGenerativeAI } from '@google/generative-ai';
import { TWEET_MIN_LENGTH, TWEET_MAX_LENGTH, findUnderflowTweets } from './tweet-length';

type TweetKey = 'tweet_1' | 'tweet_2' | 'tweet_3';

async function expandSingle(
  genAI: GoogleGenerativeAI,
  text: string,
  context?: string
): Promise<string> {
  const ctxBlock = context
    ? `\n【参考情報（事実改変・捏造禁止のため必ず参照）】\n${context}\n`
    : '';
  const prompt = `次のXツイート文を、意味・絵文字・改行レイアウト・「[アフィリリンク]」「[ad]」「PR」「ハッシュタグ」を維持したまま、**${TWEET_MIN_LENGTH}文字以上${TWEET_MAX_LENGTH}文字以内** に拡張してください。

【絶対ルール】
- 出力は拡張後の本文のみ。前置き・後書き・引用符・コードブロック・説明文を一切付けない
- 「[アフィリリンク]」「[ad]」「PR」は必ず維持。実URLには絶対に変えない
- ハッシュタグ「#xxx」は維持し、必要に応じて追加可
- 元のツイートが持つ事実・感情・誘導・問いかけはそのまま、参考情報の範囲内で要素（具体情報/共感/問いかけ）を追加して${TWEET_MIN_LENGTH}字以上に
- **事実情報を改変・捏造することは絶対禁止**（参考情報や元ツイートに無い数字・人名・日付・固有名詞を勝手に足さない）
- 改行「\\n」と空白行「\\n\\n」のレイアウトは可能な範囲で維持。1段落にギュッと詰めず、段落間に空白行を入れる
- 「[アフィリリンク]」がある場合、そのリンク行は単独行に配置すること（前後を改行で分ける）
- ${TWEET_MIN_LENGTH}文字未満は絶対NG、${TWEET_MAX_LENGTH}文字を超えるのも絶対NG。出力前に自分で文字数を数えてレンジ内に収めること
${ctxBlock}
【元のツイート】
${text}

【拡張版（${TWEET_MIN_LENGTH}〜${TWEET_MAX_LENGTH}字、本文のみ）】`;

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  const result = await model.generateContent(prompt);
  let out = (await result.response.text()).trim();
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  out = out.replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();
  return out;
}

export async function enforceTweetMinLengths(
  genAI: GoogleGenerativeAI,
  data: { tweet_1?: string; tweet_2?: string; tweet_3?: string },
  context?: string
): Promise<{ tweet_1?: string; tweet_2?: string; tweet_3?: string; expanded: TweetKey[] }> {
  const result = { ...data, expanded: [] as TweetKey[] };
  const unders = findUnderflowTweets(data);
  for (const { key } of unders) {
    const original = data[key] || '';
    try {
      let expanded = await expandSingle(genAI, original, context);
      // レンジ外なら一度だけ再試行
      if (expanded.length < TWEET_MIN_LENGTH || expanded.length > TWEET_MAX_LENGTH) {
        expanded = await expandSingle(genAI, expanded.length === 0 ? original : expanded, context);
      }
      if (expanded.length >= TWEET_MIN_LENGTH && expanded.length <= TWEET_MAX_LENGTH) {
        result[key] = expanded;
        result.expanded.push(key);
      } else {
        console.warn(`tweet拡張失敗（${original.length}→${expanded.length}文字、レンジ外）: ${key}`);
      }
    } catch (e: any) {
      console.warn(`tweet拡張エラー: ${key}: ${e?.message || e}`);
    }
  }
  return result;
}
