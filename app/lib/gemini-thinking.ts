/**
 * gemini-2.5-flash の思考（thinking）トークン上限。
 *
 * thinkingConfig を渡さないと 2.5-flash は思考トークンを使い放題になる。思考は画面に
 * 出ないが出力と同単価（$2.50/1M）で課金されるため、これが API 料金の主因だった。
 *
 * 2026-08-05 の実測（本番と同じ cron プロンプト）:
 *   未設定    : 思考 3,682〜7,884 tok / 実出力 690〜803 tok → 1.80〜3.40円/回
 *   budget 512: 思考 485 tok        / 実出力 803 tok       → 0.60円/回
 * 同時に測った tweet の 100〜120字レンジ遵守は悪化せず（未設定 1/6 → 512 で 3/6）、
 * レンジ外はすべて超過側＝ hardTruncateTweet が 120字に確定クランプするため実害なし。
 *
 * 2026-08-07 の本番規模フォロー実測（Supabase実データ523件）で under_min（100字未満）が
 * 8.2%→20.5%に悪化していたと判明。原因を本番プロンプトでのA/Bライブテストで特定：
 * シャドウバン対策（デリケート話題＝訃報/事件/離婚等）はアフィリンク・絵文字多用・煽り
 * 問いかけが禁止され「字数を稼ぐ手段」が少ないため、通常トピックより多くの推敲が要る。
 * budget=512 は通常トピックには足りるが、デリケート話題では不足して下振れしやすい
 * （同一トピックで budget=0: [109,114,116]字 → budget=512: [93,83,88]字 に悪化するのを確認）。
 * budget=768/1024 で再テストすると under_min は解消し、外れる場合は over_max 側に倒れる
 * （over_max は hardTruncateTweet が確定クランプするため実害なし）。よってデリケート話題
 * だけ budget を引き上げる。
 *
 * ⚠️ gemini-2.5-flash-lite は既定で思考オフ（実測 思考 0 tok）。ここを明示指定すると
 *    逆に思考が発生してコストが増える（実測 0.006円 → 0.033円）。lite には渡さないこと。
 * ⚠️ SDK @google/generative-ai@0.24.1 の GenerationConfig 型に thinkingConfig が無いので
 *    ここで型を拡張している。generationConfig は v1beta へ素通しされるため実挙動では効く。
 *
 * 戻し方: 各呼び出し側の withThinkingBudget(...) を元の generationConfig に戻す。
 */
import type { GenerationConfig } from '@google/generative-ai';

export const GEMINI_THINKING_BUDGET = 512;
export const GEMINI_THINKING_BUDGET_DELICATE = 768;

type GenerationConfigWithThinking = GenerationConfig & {
  thinkingConfig?: { thinkingBudget: number };
};

/** gemini-2.5-flash 向け generationConfig を組み立てる（lite には使わない）。 */
export function withThinkingBudget(
  config: GenerationConfig = {},
  budget: number = GEMINI_THINKING_BUDGET
): GenerationConfigWithThinking {
  return {
    ...config,
    thinkingConfig: { thinkingBudget: budget },
  };
}
