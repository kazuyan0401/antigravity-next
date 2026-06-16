// 生成済みの投稿に対し、プロンプトが守らなかったルールを機械的に矯正するための後処理。
// - シャドウバン対策の投稿に紛れ込んだ [アフィリリンク]/[ad]/PR を除去
// - 訃報・事件・事故などのデリケート話題で purpose を強制シャドウバン対策へ
// - JSON二重エスケープによる改行リテラル \n / \\n を実改行へ正規化
// - 既知の禁止フレーズを安全な代替表現へ置換
// - テンプレ問いかけ（みんなはどう／教えてほしい等）を除去

// 訃報・事件・事故・スキャンダル系のキーワード。
// タイトル or source_summary に該当があれば自動で「シャドウバン対策」へ。
import { hardTruncateTweet } from './tweet-length';

type TweetKey = 'tweet_1' | 'tweet_2' | 'tweet_3';

const DELICATE_KEYWORDS = [
  '訃報', '死去', '逝去', '永眠', 'ご冥福', '謹んで', '哀悼', '葬儀', '葬式',
  '事件', '事故', '逮捕', '謝罪', '不祥事', '炎上', 'スキャンダル',
  '離婚', '訴訟', '提訴', '送検', '書類送検', '懲役', '罰金',
  '飛び降り', '自殺', '自死', '急逝', 'お悔やみ',
];

export function isDelicateTopic(...sources: Array<string | null | undefined>): boolean {
  const text = sources.filter(Boolean).join(' ');
  return DELICATE_KEYWORDS.some((kw) => text.includes(kw));
}

// JSON出力時に \\n や \n がエスケープされず本文に文字列として残るケースを修復。
export function normalizeNewlines(text: string | null | undefined): string {
  if (!text) return text || '';
  return text
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

// シャドウバン対策の投稿に紛れ込んだアフィ要素を機械的に除去。
// - "[アフィリリンク]" / "[ad]" は無条件で除去
// - 単独語の "PR" は前後が空白/改行/句読点の場合のみ除去（"JR" や "PRECIOUS" 等は守る）
export function stripAffiliateMarkers(text: string | null | undefined): string {
  if (!text) return text || '';
  let out = text;
  out = out.replace(/\[アフィリリンク\]/g, '');
  out = out.replace(/\[ad\]/gi, '');
  // 行頭の PR
  out = out.replace(/(^|\n)\s*PR(?=\s|$|\n|[、。！？#])/g, '$1');
  // 中間・末尾の PR（前が空白/句読点、後ろが空白/改行/句読点/ハッシュ）
  out = out.replace(/([\s、。！？])PR(?=\s|$|\n|[、。！？#])/g, '$1');
  // 連続改行・行末空白を整理
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

// 本文中に紛れた「裸URL」「ダミー/捏造ドメイン」を除去する。
// プロンプトは実URLを禁止し [アフィリリンク] プレースホルダのみ許可しているが、
// AI が稀に "racexyz.com/xxxxx" のような偽ドメインや実URLを直書きする
// （誤クリック・誤誘導・規約違反の温床）。誤爆を避けるため、対象は
//  (1) http(s):// で始まる裸URL
//  (2) パスを伴うドメイン（"example.com/xxxx"）— 単体の "MLB.TV" 等の正当な
//      サービス名は除外
//  (3) xxx を3連以上含む明らかなダミードメイン
// のみに限定する。
const BARE_URL_PATTERNS: RegExp[] = [
  /https?:\/\/\S+/gi,
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|jp|tv|co|io|me|org|info|xyz|link|to|cc)\/\S*/gi,
  /\b[a-z0-9-]*x{3,}[a-z0-9-]*\.(?:com|net|jp|tv|co|io|me|org|info|xyz|link|to|cc)\b/gi,
];

export function stripBareUrls(text: string | null | undefined): string {
  if (!text) return text || '';
  let out = text;
  for (const re of BARE_URL_PATTERNS) out = out.replace(re, '');
  // URL を削った跡の余分な空白・記号を整える
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+([、。！？])/g, '$1')
    .trim();
  return out;
}

// 飽きられた煽り語・陳腐な感情表現の機械置換。
// 完全な自然さは諦めるが、テンプレ感の除去を優先。
const BANNED_PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
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

export function replaceBannedPhrases(text: string | null | undefined): string {
  if (!text) return text || '';
  let out = text;
  for (const [re, rep] of BANNED_PHRASE_REPLACEMENTS) {
    out = out.replace(re, rep);
  }
  return out;
}

// テンプレ問いかけは除去（置換だと不自然になりがちなので削るのみ）。
// 文末に余った句読点や絵文字の連続は後段で整える。
const TEMPLATE_QUESTION_PATTERNS: RegExp[] = [
  /みんなはどう思う[？?][ー〜]*[！!。.✨😊🥺💬]*/g,
  /みんなはどう[？?][ー〜]*[！!。.✨😊🥺💬]*/g,
  /コメントで教えて[ねよな]?[ー〜]*[！!。.]*/g,
  /教えて(?:ほしい|欲しい)な?[ー〜]*[！!。.✨😊🥺💬]*/g,
  /教えてね[ー〜]*[！!。.✨😊🥺💬]*/g,
  /率直な感想[がを]?(?:聞きたい|聞かせて|教えて)/g,
  /感想(?:を)?(?:聞かせて|教えて)[ねよな]?[ー〜]*[！!。.]*/g,
];

export function replaceTemplateQuestions(text: string | null | undefined): string {
  if (!text) return text || '';
  let out = text;
  for (const re of TEMPLATE_QUESTION_PATTERNS) {
    out = out.replace(re, '');
  }
  // 末尾に残った空文・空白行を整える
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

// 「[アフィリリンク]」「[ad]」が本文中に横並びで紛れたものを、
// その行から切り出して単独行に分離し、前後を空白行で区切る。
// プロンプトの型レイアウト指示が守られていない投稿（横並び・段落詰め込み）を
// 機械的に矯正する。purpose に依存せず、リンク要素を含む文にのみ作用する。
const AFFILIATE_TOKEN_RE = /\[アフィリリンク\]|\[ad\]/gi;

export function normalizeLinkLayout(text: string | null | undefined): string {
  if (!text) return text || '';
  // リンク要素が無ければ何もしない
  if (!AFFILIATE_TOKEN_RE.test(text)) return text;
  AFFILIATE_TOKEN_RE.lastIndex = 0;

  // 行単位で処理：リンクトークンを含む行は、トークンの前後を強制改行で切る
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!/\[アフィリリンク\]|\[ad\]/i.test(line)) {
      out.push(line);
      continue;
    }
    // 連続するトークン「[アフィリリンク][ad]」は1つの単独行にまとめる
    const merged = line
      .replace(/(\[アフィリリンク\])\s*(\[ad\])/gi, '$1$2')
      .replace(/(\[ad\])\s*(\[アフィリリンク\])/gi, '$1$2');

    // トークン位置で分割：前 / トークン / 後 …
    const parts = merged.split(/(\[アフィリリンク\]\[ad\]|\[ad\]\[アフィリリンク\]|\[アフィリリンク\]|\[ad\])/gi)
      .map(s => s.trim())
      .filter(Boolean);
    for (const p of parts) out.push(p);
  }

  // 連続改行を一旦整理
  let joined = out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  // リンク単独行の前後に空白行を強制（行頭・行末も考慮）
  joined = joined.replace(
    /(^|\n)(\[アフィリリンク\](?:\[ad\])?|\[ad\](?:\[アフィリリンク\])?)(\n|$)/g,
    (_, pre, token, post) => {
      const before = pre === '\n' ? '\n\n' : pre;
      const after = post === '\n' ? '\n\n' : post;
      return `${before}${token}${after}`;
    }
  );

  // 重複空白行を再整理
  joined = joined.replace(/\n{3,}/g, '\n\n').trim();
  return joined;
}

export type SanitizeInput = {
  title?: string | null;
  source_summary?: string | null;
  purpose?: string | null;
  tweet_1?: string | null;
  tweet_2?: string | null;
  tweet_3?: string | null;
};

export type SanitizeOutput = {
  purpose: string;
  tweet_1: string;
  tweet_2: string;
  tweet_3: string;
  delicate: boolean;
  forcedShadowban: boolean;
};

export function sanitizePost(input: SanitizeInput): SanitizeOutput {
  const delicate = isDelicateTopic(input.title, input.source_summary);
  const originalPurpose = (input.purpose || '').trim();
  // デリケート話題なら purpose を強制的にシャドウバン対策へ
  const purpose = delicate ? 'シャドウバン対策' : originalPurpose;
  const forcedShadowban = delicate && originalPurpose !== 'シャドウバン対策';
  const isShadowban = purpose === 'シャドウバン対策';

  // key も渡して tweet_3 の扱いを分岐させる。
  // - シャドウバン対策: 全 tweet からアフィ要素を除去
  // - 収益特化: tweet_3 は「リンク・タグなしの交流専用」（プロンプト型）なので、
  //   AI が混入させた [アフィリリンク]/[ad]/PR をここで機械除去する
  const clean = (t: string | null | undefined, key: TweetKey): string => {
    let out = normalizeNewlines(t);
    out = stripBareUrls(out); // 裸URL/偽ドメインは purpose を問わず除去
    const stripAff = isShadowban || key === 'tweet_3';
    if (stripAff) out = stripAffiliateMarkers(out);
    out = replaceBannedPhrases(out);
    out = replaceTemplateQuestions(out);
    if (!stripAff) out = normalizeLinkLayout(out);
    // 最終クランプ: normalizeLinkLayout がリンク/タグ行前後に空行を足して
    // 字数を押し戻すケースがあるため、サニタイズ出力を必ず上限以内へ収める。
    // sanitize は全生成経路の最終工程なので、ここで掛ければ over_max が物理ゼロになる。
    out = hardTruncateTweet(out);
    return out;
  };

  return {
    purpose,
    tweet_1: clean(input.tweet_1, 'tweet_1'),
    tweet_2: clean(input.tweet_2, 'tweet_2'),
    tweet_3: clean(input.tweet_3, 'tweet_3'),
    delicate,
    forcedShadowban,
  };
}
