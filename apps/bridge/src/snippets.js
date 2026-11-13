/**
 * 定型スニペット（入力欄の上のチップ）。
 *
 * - `hot: true` をバーに出す（既定5個）。残りはシートから
 * - 文言は**ユーザー発話として挿入**する（送信はしない。長押しで即送信）
 * - ユーザー定義は最大12個（設定タブ）。保存先は `~/.hermes/plugin-data/hermes-pilot/snippets.json`
 * - 組み込みは en / ja の両文面を持つ（`listSnippets(custom, lang)`・SPEC §6.3）
 */

/** @typedef {{label: string, text: string, placeholder?: string}} SnippetText */
/** @typedef {{id: string, hot?: boolean, en: SnippetText, ja: SnippetText}} BuiltinSnippet */

/** @type {BuiltinSnippet[]} */
const BUILTIN = [
  {
    id: 'summary',
    hot: true,
    en: { label: 'Summary', text: 'Summarize the decisions, open items and TODOs from this conversation as a bullet list.' },
    ja: { label: 'まとめ', text: 'ここまでのやりとりから、決定事項・積み残し・TODO を箇条書きで整理して。' },
  },
  {
    id: 'retry',
    hot: true,
    en: { label: 'Alt take', text: 'Redo the last task with a different approach. Do not repeat the same steps.' },
    ja: { label: '別解', text: '直前のタスクを別のアプローチでやり直して。同じ手順の繰り返しは禁止。' },
  },
  {
    id: 'approve',
    hot: true,
    en: { label: 'Approve', text: 'Approve the last answer and continue with the next step.' },
    ja: { label: '承認', text: '直前の回答を承認。そのまま次の手順に進んで。' },
  },
  {
    id: 'git-diff',
    hot: true,
    en: { label: 'git diff', text: 'Run `git diff` in the working repo and summarize the changes in three lines.' },
    ja: { label: 'git diff', text: '作業中のリポジトリで `git diff` を実行して、変更点を3行で要約して。' },
  },
  {
    id: 'git-status',
    hot: true,
    en: { label: 'git status', text: 'Run `git status` in the working repo and list uncommitted and untracked files.' },
    ja: { label: 'git status', text: '作業中のリポジトリで `git status` を実行して、未コミット・未追跡を一覧で。' },
  },
  {
    id: 'test',
    en: { label: 'Tests', text: 'Run the related tests and fix any failures.' },
    ja: { label: 'テスト', text: '関連するテストを実行して、失敗があれば修正まで。' },
  },
  {
    id: 'review',
    en: { label: 'Review', text: 'Review the latest diff, bugs first. Order by severity and give file:line. Do not write fixes.' },
    ja: { label: 'レビュー', text: '直前の差分をバグ優先でレビュー。重大度順、file:line 付き。修正は書かない。' },
  },
  {
    id: 'explain',
    en: { label: 'Explain', text: 'Explain the code you just touched in three lines for someone new to it.' },
    ja: { label: '説明', text: '直前に触ったコードを、初見の人向けに3行で説明して。' },
  },
  {
    id: 'continue',
    en: { label: 'Continue', text: 'Continue.' },
    ja: { label: '続きを', text: '続きを。' },
  },
  {
    id: 'commit-msg',
    en: { label: 'Commit msg', text: 'Commit message suggestion only. Do not change any code.' },
    ja: { label: 'コミット文', text: 'コミットメッセージ案だけ。コードは変更しない。' },
  },
  {
    id: 'cause',
    en: {
      label: 'Diagnose',
      text: 'Find the root cause of the following error. At most one fix at the end.\nError: {{paste here}}',
      placeholder: '{{paste here}}',
    },
    ja: {
      label: '原因特定',
      text: '次のエラーの原因を特定して。修正案は最後に1つだけ。\nエラー: {{ここに貼り付け}}',
      placeholder: '{{ここに貼り付け}}',
    },
  },
  {
    id: 'handoff',
    en: { label: 'Handoff', text: 'Turn this conversation into a handoff note (status / decisions / next step).' },
    ja: { label: 'ハンドオフ', text: 'この会話を引き継ぎメモ（現状／決定／次の一手）にまとめて。' },
  },
  {
    id: 'kanban',
    en: { label: 'Kanban', text: 'Check the running and blocked kanban tasks and propose the single next thing to do.' },
    ja: { label: 'カンバン確認', text: 'カンバンの実行中・ブロック中のタスクを確認して、次にやるべき1件を提案して。' },
  },
  {
    id: 'new-project',
    en: { label: 'New project', text: 'Start a session as a new project. Propose an implementation plan first (do not implement).' },
    ja: { label: '新規PJ', text: '新しいプロジェクトとしてセッションを開始。まず実装方針の提案だけ（実装はしない）。' },
  },
]

export const HOT_LIMIT = 8
export const CUSTOM_MAX = 12
export const LABEL_MAX = 20
export const TEXT_MAX = 400

/**
 * 言語コードを `en` / `ja` に落とす（それ以外は en）。
 * @param {unknown} lang 言語
 * @returns {'en'|'ja'} 言語
 */
function langOf(lang) {
  return String(lang ?? '').trim().toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * 組み込み 1 件を UI 用の形にする。
 * @param {BuiltinSnippet} s 組み込み
 * @param {'en'|'ja'} lang 言語
 * @returns {{id: string, label: string, hot: boolean, custom: false, hasPlaceholder: boolean, text: string}} UI 用
 */
function toUi(s, lang) {
  const src = s[lang] ?? s.en
  return {
    id: s.id,
    label: src.label,
    hot: Boolean(s.hot),
    custom: false,
    hasPlaceholder: Boolean(src.placeholder),
    text: src.text,
  }
}

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
 * @param {Array<object>} [custom] ユーザー定義
 * @param {'en'|'ja'} [lang] 表示言語（既定 en・SPEC D5）
 * @returns {Array<object>} 一覧
 */
export function listSnippets(custom = [], lang = 'en') {
  const l = langOf(lang)
  const user = normalizeCustom(custom).map((s) => ({
    id: s.id,
    label: s.label,
    hot: Boolean(s.hot),
    custom: true,
    hasPlaceholder: Boolean(s.placeholder),
    text: s.text,
  }))
  return [...BUILTIN.map((s) => toUi(s, l)), ...user]
}

/** 既定言語（en）で組み立てた組み込み一覧（後方互換・テスト用）。 */
export const SNIPPETS = BUILTIN.map((s) => toUi(s, 'en'))

export { BUILTIN }
