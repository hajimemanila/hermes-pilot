/**
 * 定型スニペット（入力欄の上のチップ）。
 *
 * - `hot: true` をバーに出す（既定5個）。残りはシートから
 * - 文言は**ユーザー発話として挿入**する（送信はしない。長押しで即送信）
 * - ユーザー定義は最大12個（設定タブ）。保存先は `~/.hermes/mobile-pwa/snippets.json`
 */

/** @typedef {{id: string, label: string, hot?: boolean, text: string, custom?: boolean}} Snippet */

/** @type {Snippet[]} */
const BUILTIN = [
  { id: 'summary', label: 'まとめ', hot: true, text: 'ここまでのやりとりから、決定事項・積み残し・TODO を箇条書きで整理して。' },
  { id: 'retry', label: '別解', hot: true, text: '直前のタスクを別のアプローチでやり直して。同じ手順の繰り返しは禁止。' },
  { id: 'approve', label: '承認', hot: true, text: '直前の回答を承認。そのまま次の手順に進んで。' },
  { id: 'git-diff', label: 'git diff', hot: true, text: '作業中のリポジトリで `git diff` を実行して、変更点を3行で要約して。' },
  { id: 'git-status', label: 'git status', hot: true, text: '作業中のリポジトリで `git status` を実行して、未コミット・未追跡を一覧で。' },
  { id: 'test', label: 'テスト', text: '関連するテストを実行して、失敗があれば修正まで。' },
  { id: 'review', label: 'レビュー', text: '直前の差分をバグ優先でレビュー。重大度順、file:line 付き。修正は書かない。' },
  { id: 'explain', label: '説明', text: '直前に触ったコードを、初見の人向けに3行で説明して。' },
  { id: 'continue', label: '続きを', text: '続きを。' },
  { id: 'commit-msg', label: 'コミット文', text: 'コミットメッセージ案だけ。コードは変更しない。' },
  { id: 'cause', label: '原因特定', text: '次のエラーの原因を特定して。修正案は最後に1つだけ。\nエラー: {{ここに貼り付け}}', placeholder: '{{ここに貼り付け}}' },
  { id: 'handoff', label: 'ハンドオフ', text: 'この会話を引き継ぎメモ（現状／決定／次の一手）にまとめて。' },
  { id: 'kanban', label: 'カンバン確認', text: 'カンバンの実行中・ブロック中のタスクを確認して、次にやるべき1件を提案して。' },
  { id: 'new-project', label: '新規PJ', text: '新しいプロジェクトとしてセッションを開始。まず実装方針の提案だけ（実装はしない）。' },
]

export const HOT_LIMIT = 8
export const CUSTOM_MAX = 12
export const LABEL_MAX = 20
export const TEXT_MAX = 400

/**
 * ユーザー定義を検証・正規化する。
 * @param {unknown} input 入力
 * @returns {Array<{id: string, label: string, text: string, hot: boolean, custom: true}>} 正規化
 */
export function normalizeCustom(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const raw of input.slice(0, CUSTOM_MAX)) {
    if (!raw || typeof raw !== 'object') continue
    const label = String(raw.label ?? '').trim().slice(0, LABEL_MAX)
    const text = String(raw.text ?? '').trim().slice(0, TEXT_MAX)
    if (!label || !text) continue
    const given = String(raw.id ?? '')
    const id = /^c-[a-z0-9]{1,20}$/.test(given) && !seen.has(given) ? given : `c-${(seen.size + 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    seen.add(id)
    out.push({ id, label, text, hot: Boolean(raw.hot), custom: true })
  }
  return out
}

/**
 * UI 向け一覧（組み込み + ユーザー定義）。
 * @param {Array<object>} custom ユーザー定義
 * @returns {Array<object>} 一覧
 */
export function listSnippets(custom = []) {
  const all = [...BUILTIN.map((s) => ({ ...s, custom: false })), ...normalizeCustom(custom)]
  return all.map((s) => ({
    id: s.id,
    label: s.label,
    hot: Boolean(s.hot),
    custom: Boolean(s.custom),
    hasPlaceholder: Boolean(s.placeholder),
    text: s.text,
  }))
}

export { BUILTIN as SNIPPETS }
