/**
 * レビューシートが生成する「貼り付け用の回答テキスト」の解析。
 *
 * ここは**画面の文言ではなく、外部と共有するデータ形式**（シート HTML / `answer.txt` /
 * レビュー skill の出力）なので、訳すのではなく**両表記を受ける**。
 * 生成側は実行時言語で出し分ける（`apps/bridge/src/review.js` の `toReplyText`）ので、
 * 読み取り側は ja（`補足:` / `全体へのレビュー:` / `(未選択`）と
 * en（`note:` / `Overall Note:` / `(unselected`）のどちらも解釈する必要がある。
 * そのため `apps/web/test/noHardcodedJapanese.test.js` はこのファイルだけを対象外にする。
 *
 * 形式（1 行 1 問・末尾に `---`）:
 *   Q1. A / 補足: 補足テキスト        （en: Q1. A / note: text）
 *   ...（未選択は `(未選択 = お任せ)` / `(unselected = take recommended)`）
 *   全体へのレビュー: 自由記述        （en: Overall Note: text）
 *   ---
 */

/** 補足欄の見出し（シートが出力する・日英）。 */
export const PASTE_NOTE_MARKS = ['補足:', 'note:', 'Note:']
/** 全体メモの見出し（シートが出力する・日英・旧名 `全体への赤ペン:` も受ける）。 */
export const PASTE_GLOBAL_MARKS = ['全体へのレビュー:', '全体への赤ペン:', 'Overall Note:']
/** 未選択を表す接頭辞（シートが出力する・日英）。 */
export const PASTE_UNSELECTED_MARKS = ['(未選択', '(unselected']

/** 旧名（単数・ja 表記）も互換のため残す。 */
export const PASTE_NOTE_MARK = PASTE_NOTE_MARKS[0]
export const PASTE_GLOBAL_MARK = PASTE_GLOBAL_MARKS[0]
export const PASTE_UNSELECTED = PASTE_UNSELECTED_MARKS[0]

/** 正規表現のメタ文字を落とす（見出しは固定文字列だが、後で増やしても壊れないように）。 */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const QUESTION_RE = new RegExp('^Q(\\d+)\\.\\s*(.*?):\\s*(.*)$')
const NOTE_RE = new RegExp(`^(.*?)(?:\\s*\\/\\s*(?:${PASTE_NOTE_MARKS.map(esc).join('|')})\\s*(.*))?$`)
const GLOBAL_RE = new RegExp(`^(?:${PASTE_GLOBAL_MARKS.map(esc).join('|')})\\s*(.*)$`)

/**
 * 未選択（＝お任せ）を表す回答か。
 * @param {string} choice 選択肢の文字列
 * @returns {boolean} 未選択なら true
 */
export function isUnselected(choice) {
  const s = String(choice || '').trim().toLowerCase()
  return PASTE_UNSELECTED_MARKS.some((m) => s.startsWith(m.toLowerCase()))
}

/**
 * `【レビュー回答】` / `[Review Answer]` の貼り付けを最小限パースする（iframe モードのフォールバック）。
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
        choice: isUnselected(choice) ? null : choice,
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
