/**
 * レビューシートが生成する「貼り付け用の回答テキスト」の解析。
 *
 * ここだけは**日本語のまま**にしてある。画面の文言ではなく、シート（HTML）と
 * レビュー skill が出力する**外部と共有するデータ形式**なので、訳すと解析が壊れる。
 * そのため `apps/web/test/noHardcodedJapanese.test.js` はこのファイルだけを対象外にする。
 *
 * 形式（1 行 1 問）:
 *   Q1. A: 補足テキスト
 *   ...
 *   全体へのレビュー: 自由記述
 *   ---
 */

/** 補足欄の見出し（シートが出力する）。 */
export const PASTE_NOTE_MARK = '補足:'
/** 全体メモの見出し（シートが出力する）。 */
export const PASTE_GLOBAL_MARK = '全体へのレビュー:'
/** 未選択を表す接頭辞（シートが出力する）。 */
export const PASTE_UNSELECTED = '(未選択'

const QUESTION_RE = new RegExp(`^Q(\\d+)\\.\\s*(.*?):\\s*(.*)$`)
const NOTE_RE = new RegExp(`^(.*?)(?:\\s*\\/\\s*${PASTE_NOTE_MARK}\\s*(.*))?$`)
const GLOBAL_RE = new RegExp(`^${PASTE_GLOBAL_MARK}\\s*(.*)$`)

/**
 * `【レビュー回答】` の貼り付けを最小限パースする（iframe モードのフォールバック）。
 * @param {string} text 貼り付けられたテキスト
 * @returns {{answers: Array<{id: string, choice: string|null, note: string}>, global: string}} 解析結果
 */
export function parsePastedReply(text) {
  const out = { answers: [], global: '' }
  const lines = String(text || '').split('\n')
  let inGlobal = false
  for (const line of lines) {
    const q = QUESTION_RE.exec(line)
    if (q) {
      const rest = q[3]
      const m = NOTE_RE.exec(rest)
      const choice = (m?.[1] || '').trim()
      out.answers.push({
        id: `q${q[1]}`,
        choice: choice.startsWith(PASTE_UNSELECTED) ? null : choice,
        note: (m?.[2] || '').trim(),
      })
      inGlobal = false
      continue
    }
    const g = GLOBAL_RE.exec(line)
    if (g) {
      out.global = g[1] || ''
      inGlobal = true
      continue
    }
    if (line.trim() === '---') break
    if (inGlobal) out.global += `\n${line}`
  }
  out.global = out.global.trim()
  return out
}
