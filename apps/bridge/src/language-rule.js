/**
 * 出力言語の規則（1 か所だけに置く。SPEC-i18n-gen §3.4 / D2）。
 *
 * 「この言語で書け」は**両層**に要る。スキルはエージェントが作業中に読み直すもの、
 * プロンプトは最初に読むもの。片方だけだと日本語の散文に引き戻される。
 * そこで規則文を本モジュールの**定数 1 つ**にまとめ、
 *
 * - ブリッジが組むプロンプト（`architect.js` の 2 つのビルダー）が `languageRule(lang)` を差し込み、
 * - リポジトリ同梱の 3 スキル（`skills/quick-review` / `skills/annotation` / `skills/spec-architect`）が
 *   `LANGUAGE_RULE_MARKER` をそのまま 1 行持つ
 *
 * 状態にして、`apps/bridge/test/languageRule.test.js` が突き合わせる（片側だけの変更で落ちる）。
 *
 * 機械トークン（`label=` / `sheet=` / `mode=` / `round=` / `target=` / タスク id / パス /
 * SPEC の見出しキー）は**言語に追従させない**。人が読む散文だけが言語で変わる。
 */

/**
 * 機械検査の基準文（スキルとプロンプトが同じ 1 文を持つ）。
 *
 * この文字列を変えるときは 3 スキルの `## Language` 節も同じ 1 文へ直すこと
 * （`languageRule.test.js` が不一致を検出する）。
 */
export const LANGUAGE_RULE_MARKER = "Write user-facing prose in the run's UI language"

/** EN の規則文（プロンプトへ差し込む全文）。 */
export const LANGUAGE_RULE_EN =
  `${LANGUAGE_RULE_MARKER} — sheet title/topic/question/option text, SPEC prose, the comments and summaries you post. ` +
  'Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, ' +
  'and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.'

/** JA の規則文（同じ内容。機械トークンは ASCII のまま）。 */
export const LANGUAGE_RULE_JA =
  '人が読む散文は実行時の UI 言語で書く — シートの title / topic / 設問 / 選択肢、SPEC 本文、' +
  '投稿するコメントと summary が対象。' +
  '機械トークンは ASCII のまま変えない: `label=` / `sheet=` / `mode=` / `round=` / `target=` / タスク id / ファイルパス、' +
  'および SPEC の見出しキー **Execution Mode** / **Objective** / **Files** / **Verify**。'

/**
 * `'ja'` だけを ja とみなす（それ以外は既定 `en` に倒す判定を 1 か所に置く）。
 *
 * @param {unknown} [lang] 言語
 * @returns {boolean} ja なら true
 */
export function isJaLang(lang) {
  return String(lang ?? '').trim() === 'ja'
}

/**
 * 言語に合った規則文を返す。
 *
 * `'ja'` 以外（未指定・未知・大文字）はすべて EN に倒す（既定は `en`・SPEC §3.1）。
 *
 * @param {unknown} [lang] 言語（`en` / `ja`）
 * @returns {string} 規則文
 */
export function languageRule(lang) {
  return isJaLang(lang) ? LANGUAGE_RULE_JA : LANGUAGE_RULE_EN
}
