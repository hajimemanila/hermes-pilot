/**
 * 定型スニペット（入力欄の上のチップ）。
 *
 * - `hot: true` をバーに出す（既定6個・`HOT_LIMIT` は 8）
 * - `trigger: true` は意思決定トリガー（赤ペン起票など）。UI がアクセント枠で描く
 * - 文言は**ユーザー発話として挿入**する（送信はしない。長押しで即送信）
 * - 組み込みは en / ja の両文面を持つ（`listSnippets(custom, lang, overrides)`・SPEC §3.2）
 * - ユーザー定義は最大16個（設定タブ）。保存先は `~/.hermes/plugin-data/hermes-pilot/snippets.json`
 *
 * カスタマイズモデル（SPEC §3.4 / D13）: 組み込みは `overrides[id] = {hot, hidden}` で
 * Hot の ON/OFF と非表示を切り替え、`custom[]` で追加・編集・削除する。
 * 保存形式は `{version: 2, overrides, custom}`（version 1 は読取時に補完）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** @typedef {{label: string, text: string, placeholder?: string}} SnippetText */
/** @typedef {{id: string, hot?: boolean, trigger?: boolean, en: SnippetText, ja: SnippetText}} BuiltinSnippet */

/** @type {BuiltinSnippet[]} */
const BUILTIN = [
  // --- Hot 6（バーに出す）----------------------------------------------------
  {
    id: 'quick-review',
    hot: true,
    trigger: true,
    en: {
      label: '📋 Quick Review',
      text:
        'Summarize the open design decisions into a Quick Review sheet (HTML + JSON under review/sheets/) using the quick-review skill, file a blocked [review] task on kanban, and wait for my 1-tap answer.',
    },
    ja: {
      label: '📋 Quick Review起票',
      text:
        'いま判断が必要な論点を quick-review スキルで設問シート（review/sheets/ の HTML + JSON）にまとめ、カンバンに blocked の [review] タスクとして起票して回答を待って。',
    },
  },
  {
    id: 'annotate-shot',
    hot: true,
    trigger: true,
    en: {
      label: '📸 Annotate Shot',
      text:
        'Deploy the latest build, take a 390x844 screenshot into review/shots/, and file a blocked [review] mode=annotation task using the annotation skill so I can redline it.',
    },
    ja: {
      label: '📸 スクショ注釈起票',
      text:
        '最新ビルドを反映して 390x844 の実機スクショを review/shots/ に撮り、annotation スキルで赤入れ用の blocked [review] タスクを起票して。',
    },
  },
  {
    id: 'approve',
    hot: true,
    en: {
      label: '⚡ Approve & Go',
      text: 'Approved with the recommended option. Proceed with implementation and run verification.',
    },
    ja: {
      label: '⚡ 推奨案で承認・続行',
      text: '推奨案で承認します。このまま実装を進めて検証（verify）まで実行して。',
    },
  },
  {
    id: 'spec-kanban',
    hot: true,
    en: {
      label: '🚀 Spec → Kanban',
      text:
        'Read the latest docs/SPEC-*.md in this repo, create the kanban batch tasks in order, and start autonomous execution from the first batch.',
    },
    ja: {
      label: '🚀 SPECから自走',
      text:
        'このリポジトリの最新の docs/SPEC-*.md を読み、バッチ順にカンバンタスクを起票して最初のバッチから自走を開始して。',
    },
  },
  {
    id: 'retry',
    hot: true,
    en: {
      label: '🔄 Alt Approach',
      text: 'Stop repeating the last steps. Propose and execute a different approach to solve the root issue.',
    },
    ja: {
      label: '🔄 別アプローチ',
      text: '同じ手順の繰り返しを止め、根本原因に対する別のアプローチでやり直して。',
    },
  },
  {
    id: 'summary',
    hot: true,
    en: {
      label: '📝 Summary',
      text: 'Summarize the decisions made, remaining open items, and next steps from this conversation in concise bullets.',
    },
    ja: {
      label: '📝 要点まとめ',
      text: 'ここまでの決定事項・未解決の論点・次の一手を簡潔な箇条書きで整理して。',
    },
  },

  // --- シート（8個）----------------------------------------------------------
  {
    id: 'git-diff',
    en: { label: 'git diff', text: 'Run git diff in the working repo and summarize the key changes in 3 lines.' },
    ja: { label: 'git diff', text: '作業中のリポジトリで git diff を実行し、主要な変更点を3行で要約して。' },
  },
  {
    id: 'git-status',
    en: { label: 'git status', text: 'Run git status --short and list any uncommitted or untracked files.' },
    ja: { label: 'git status', text: 'git status --short を実行して、未コミット・未追跡ファイルを一覧にして。' },
  },
  {
    id: 'test',
    en: { label: 'Run Verify', text: 'Run npm run verify (or the project test suite) and fix any failing tests.' },
    ja: { label: 'テスト・検証', text: 'npm run verify（または関連テスト）を実行し、失敗があれば修正して。' },
  },
  {
    id: 'review',
    en: {
      label: 'Bug Review',
      text: 'Review the latest diff focusing on bugs and regressions. List by severity with file:line (do not edit yet).',
    },
    ja: {
      label: 'バグ監査',
      text: '直前の差分をバグ・デグレ優先で監査して。重大度順・file:line 付きで列挙し、まだコードは変えないで。',
    },
  },
  {
    id: 'explain',
    en: {
      label: 'Explain 3L',
      text: 'Explain the code or behavior we just touched in 3 lines for someone seeing it for the first time.',
    },
    ja: { label: '3行で説明', text: '直前に触ったコードや挙動を、初見の人向けに3行で説明して。' },
  },
  {
    id: 'cause',
    en: {
      label: 'Diagnose',
      text: 'Identify the root cause of this error and propose the single safest fix.\nError: {{paste here}}',
      placeholder: '{{paste here}}',
    },
    ja: {
      label: '原因特定',
      text: '次のエラーの根本原因を特定し、最も安全な修正案を1つ提案して。\nエラー: {{ここに貼り付け}}',
      placeholder: '{{ここに貼り付け}}',
    },
  },
  {
    id: 'handoff',
    en: {
      label: 'Handoff',
      text: 'Write a compact handoff note (current state / decisions / next action) so a background worker can continue.',
    },
    ja: {
      label: '引き継ぎメモ',
      text: '自律ワーカーがそのまま引き継げるよう、現状・決定事項・次の一手をコンパクトにまとめて。',
    },
  },
  {
    id: 'kanban',
    en: {
      label: 'Kanban Next',
      text: 'Check the running and blocked kanban tasks and tell me the single highest-priority item.',
    },
    ja: { label: 'カンバン確認', text: 'カンバンの実行中・ブロック中タスクを確認し、最優先で片付けるべき1件を教えて。' },
  },
]

export const HOT_LIMIT = 8
export const CUSTOM_MAX = 16
export const LABEL_MAX = 20
export const TEXT_MAX = 400

/** 組み込み ID の一覧（overrides の検証に使う）。 */
export const BUILTIN_IDS = BUILTIN.map((s) => s.id)

/**
 * 言語コードを `en` / `ja` に落とす（それ以外は en）。
 * @param {unknown} lang 言語
 * @returns {'en'|'ja'} 言語
 */
export function langOf(lang) {
  return String(lang ?? '').trim().toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * 組み込み 1 件を UI 用の形にする。
 * @param {BuiltinSnippet} s 組み込み
 * @param {'en'|'ja'} lang 言語
 * @returns {{id: string, label: string, hot: boolean, trigger: boolean, hidden: boolean, custom: false, hasPlaceholder: boolean, text: string}} UI 用
 */
function toUi(s, lang) {
  const src = s[lang] ?? s.en
  return {
    id: s.id,
    label: src.label,
    hot: Boolean(s.hot),
    trigger: Boolean(s.trigger),
    hidden: false,
    custom: false,
    hasPlaceholder: Boolean(src.placeholder),
    text: src.text,
  }
}

/**
 * 組み込みの上書き設定を検証する（未知の id・非真偽値は落とす）。
 * @param {unknown} input `{id: {hot?, hidden?}}`
 * @param {string[]} [ids] 許可する id
 * @returns {Record<string, {hot?: boolean, hidden?: boolean}>} 正規化
 */
export function normalizeOverrides(input, ids = BUILTIN_IDS) {
  /** @type {Record<string, {hot?: boolean, hidden?: boolean}>} */
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  const allowed = new Set(ids)
  for (const [id, raw] of Object.entries(input)) {
    if (!allowed.has(id) || !raw || typeof raw !== 'object') continue
    /** @type {{hot?: boolean, hidden?: boolean}} */
    const o = {}
    if (typeof raw.hot === 'boolean') o.hot = raw.hot
    if (typeof raw.hidden === 'boolean') o.hidden = raw.hidden
    if (Object.keys(o).length) out[id] = o
  }
  return out
}

/**
 * ユーザー定義を検証・正規化する。
 * @param {unknown} input 入力
 * @param {{max?: number, withRun?: boolean}} [opts] 上限と端末用フィールド
 * @returns {Array<object>} 正規化（`custom: true`）
 */
export function normalizeCustom(input, { max = CUSTOM_MAX, withRun = false } = {}) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const raw of input.slice(0, max)) {
    if (!raw || typeof raw !== 'object') continue
    const label = String(raw.label ?? '').trim().slice(0, LABEL_MAX)
    const text = String(raw.text ?? '').trim().slice(0, TEXT_MAX)
    if (!label || !text) continue
    const given = String(raw.id ?? '')
    const id =
      /^c-[a-z0-9]{1,20}$/.test(given) && !seen.has(given)
        ? given
        : `c-${(seen.size + 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    seen.add(id)
    /** @type {Record<string, unknown>} */
    const item = { id, label, text, hot: Boolean(raw.hot), custom: true }
    if (raw.hidden === true) item.hidden = true
    if (withRun) {
      item.run = raw.run !== false
      const note = String(raw.note ?? '').trim().slice(0, TEXT_MAX)
      if (note) item.note = note
    }
    out.push(item)
  }
  return out
}

/**
 * UI 向け一覧（組み込み + ユーザー定義）。`hidden` も含む（設定画面用）。
 * @param {Array<object>} [custom] ユーザー定義
 * @param {'en'|'ja'} [lang] 表示言語（既定 en・SPEC D5）
 * @param {Record<string, object>} [overrides] 組み込みの上書き
 * @returns {Array<object>} 一覧
 */
export function allSnippets(custom = [], lang = 'en', overrides = {}) {
  const l = langOf(lang)
  const ov = normalizeOverrides(overrides)
  const builtin = BUILTIN.map((s) => {
    const o = ov[s.id] ?? {}
    return {
      ...toUi(s, l),
      hot: typeof o.hot === 'boolean' ? o.hot : Boolean(s.hot),
      hidden: o.hidden === true,
    }
  })
  const user = normalizeCustom(custom).map((s) => ({
    id: s.id,
    label: s.label,
    text: s.text,
    hot: Boolean(s.hot),
    trigger: false,
    hidden: s.hidden === true,
    custom: true,
    hasPlaceholder: false,
  }))
  return [...builtin, ...user]
}

/**
 * 会話画面向け一覧（`hidden` を除く）。
 * @param {Array<object>} [custom] ユーザー定義
 * @param {'en'|'ja'} [lang] 表示言語
 * @param {Record<string, object>} [overrides] 組み込みの上書き
 * @returns {Array<object>} 一覧
 */
export function listSnippets(custom = [], lang = 'en', overrides = {}) {
  return allSnippets(custom, lang, overrides).filter((s) => !s.hidden)
}

/** 既定言語（en）で組み立てた組み込み一覧（後方互換・テスト用）。 */
export const SNIPPETS = BUILTIN.map((s) => toUi(s, 'en'))

/**
 * 保存済みスニペット設定を読む（version 1 は読取時に version 2 へ補完）。
 * @param {string} file 保存先
 * @param {{ids?: string[], withRun?: boolean, max?: number}} [opts] 許可 id・端末用フィールド
 * @returns {{version: 2, overrides: Record<string, object>, custom: Array<object>}} 設定
 */
export function readSnippetStore(file, { ids = BUILTIN_IDS, withRun = false, max = CUSTOM_MAX } = {}) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    version: 2,
    overrides: normalizeOverrides(src.overrides, ids),
    custom: normalizeCustom(src.custom ?? [], { max, withRun }),
  }
}

/**
 * スニペット設定をアトミックに書く（`0600`・version 2）。
 * @param {string} file 保存先
 * @param {{custom?: unknown, overrides?: unknown}} store 設定
 * @param {{ids?: string[], withRun?: boolean, max?: number}} [opts] 許可 id・端末用フィールド
 * @returns {{version: 2, overrides: Record<string, object>, custom: Array<object>}} 保存した設定
 */
export function writeSnippetStore(file, { custom, overrides } = {}, { ids = BUILTIN_IDS, withRun = false, max = CUSTOM_MAX } = {}) {
  /** @type {{version: 2, overrides: Record<string, object>, custom: Array<object>}} */
  const data = {
    version: 2,
    overrides: normalizeOverrides(overrides, ids),
    custom: normalizeCustom(custom ?? [], { max, withRun }),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return data
}

export { BUILTIN }
