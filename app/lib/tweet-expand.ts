import { GoogleGenerativeAI } from '@google/generative-ai';
import { TWEET_MIN_LENGTH, TWEET_MAX_LENGTH, findUnderflowTweets, hardTruncateTweet } from './tweet-length';

type TweetKey = 'tweet_1' | 'tweet_2' | 'tweet_3';

// 拡張に使うモデルチェーン。lite が外し続けても flash で粘る。
// generate route と同様、失敗時に上位モデルへフォールバックして成功率を上げる。
const EXPAND_MODEL_CHAIN = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

async function expandSingle(
  genAI: GoogleGenerativeAI,
  text: string,
  context?: string,
  modelName: string = 'gemini-2.5-flash-lite'
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

  const model = genAI.getGenerativeModel({ model: modelName });
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
  const inRange = (s: string) => s.length >= TWEET_MIN_LENGTH && s.length <= TWEET_MAX_LENGTH;

  for (const { key } of unders) {
    const original = data[key] || '';
    // これまで得られた候補のうち「最も下限に近い／レンジ内」を保持しておき、
    // 全試行がレンジ外でも元の短文に戻さず、一番マシな候補を採用する。
    let best = original;
    const better = (cand: string) => {
      if (!cand) return false;
      if (inRange(cand)) return true;                 // レンジ内は即採用優先
      if (cand.length > TWEET_MAX_LENGTH) {           // 超過はトランケートで救えるので候補資格あり
        return best.length < TWEET_MIN_LENGTH;        // bestがまだ下限未満なら超過候補の方がマシ
      }
      return cand.length > best.length && best.length < TWEET_MIN_LENGTH; // より長い不足候補
    };

    try {
      // モデルチェーン × 各2回、最大4試行。レンジ内が出たら即終了。
      outer: for (const modelName of EXPAND_MODEL_CHAIN) {
        for (let attempt = 0; attempt < 2; attempt++) {
          let cand = '';
          try {
            const seed = best.length >= TWEET_MIN_LENGTH ? best : (best || original);
            cand = await expandSingle(genAI, seed, context, modelName);
          } catch (e: any) {
            console.warn(`tweet拡張エラー(${modelName} #${attempt + 1}): ${key}: ${e?.message || e}`);
            continue;
          }
          if (better(cand)) best = cand;
          if (inRange(best)) break outer;
        }
      }
    } catch (e: any) {
      console.warn(`tweet拡張致命的エラー: ${key}: ${e?.message || e}`);
    }

    // 超過していたら確定トランケートで上限以内へ（over_max を素通しさせない）。
    if (best.length > TWEET_MAX_LENGTH) best = hardTruncateTweet(best, TWEET_MAX_LENGTH);

    if (best !== original) {
      result[key] = best;
      result.expanded.push(key);
    }
    if (best.length < TWEET_MIN_LENGTH) {
      // ここに来たら拡張は最善を尽くしたが下限未達。素通しはするが必ず警告を残す
      // （下限は事実を捏造せず機械保証できないため。監視/手動補修で拾う対象）。
      console.warn(`tweet拡張: 下限未達のまま採用（${original.length}→${best.length}文字）: ${key}`);
    }
  }
  return result;
}
