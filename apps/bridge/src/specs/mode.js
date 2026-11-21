/**
 * 実行モード・抽象ロール・行動契約（`specs.js` から分割）。
 * 公開契約は `specs.js` の再エクスポートで維持する（呼び出し側の import は変えない）。
 */
import { SCREEN_CHECK_CONTRACT, VERIFY_CONTRACT } from '../contracts/verify.js'

/** タスク本文の上限（カンバン側の実用上限に合わせる）。 */
export const BODY_MAX = 6000
/** 完了してよい状態（これ以外を「未完了」とみなして重複起票を止める）。 */
export const CLOSED_STATUSES = new Set(['done', 'archived'])
/**
 * 実行モード宣言の行（`- **Execution Mode**: `[Mode: Zero-Stop]`` / `- **実行モード**: [Mode: …]`）。
 * バックティック・角括弧・`Mode:` 前置・大小文字をすべて許容する。
 */
export const EXECUTION_MODE_RE =
  /^[-*]?\s*\*\*\s*(?:Execution\s*Mode|実行モード)\s*\*\*\s*[:：]\s*[`\s]*\[?\s*(?:Mode\s*[:：]\s*)?(Zero-Stop|Fast-Track\s*Review|Visual\s*Gate)/im

/**
 * 実行モード表記を正規化する（未知の値・未宣言は `null`）。
 *
 * @param {unknown} raw `Zero-Stop` / `[Mode: Visual Gate]` / `visual-gate` など
 * @returns {'zero-stop'|'fast-track-review'|'visual-gate'|null} 正規化したモード
 */
export function normalizeExecutionMode(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    // `[Mode: Visual Gate]` のような生の宣言もそのまま受けられるように前置を落とす
    .replace(/mode\s*[:：]/g, ' ')
    .replace(/[^a-z-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!s) return null
  if (s === 'zero-stop' || s === 'zerostop' || s === 'zero') return 'zero-stop'
  if (s === 'fast-track-review' || s === 'fast-track' || s === 'fasttrack-review') return 'fast-track-review'
  if (s === 'visual-gate' || s === 'visualgate' || s === 'visual') return 'visual-gate'
  return null
}

/**
 * バッチ本文から実行モードを読む（未宣言は `null`＝後方互換）。
 *
 * @param {string[]|string} section バッチ本文の行（または本文）
 * @returns {'zero-stop'|'fast-track-review'|'visual-gate'|null} モード
 */
export function extractExecutionMode(section) {
  const text = Array.isArray(section) ? section.join('\n') : String(section ?? '')
  const m = EXECUTION_MODE_RE.exec(text)
  return m ? normalizeExecutionMode(m[1]) : null
}

/** 行動契約ブロックの見出し（本文中で一意）。 */
export const CONTRACT_HEADER = '[Hermes Pilot Execution Contract]'

/**
 * 抽象ロールの語彙（D60）。公開コードは**この 4 つだけ**を知り、実モデル名は知らない
 * （プロファイルメモリの割当表が実モデルを決める）。
 */
export const ABSTRACT_ROLES = ['role:planner', 'role:builder', 'role:visual-reviewer', 'role:decision-framer']

/**
 * バッチ本文の推奨ロール宣言行（`- **Recommended Role**: \`role:builder\`` / `- **推奨ロール**: role:planner`）。
 * バックティック・大小文字・全角コロンを許容する。
 */
export const RECOMMENDED_ROLE_RE = /^[-*]?\s*\*\*\s*(?:Recommended Role|推奨ロール)\s*\*\*\s*[:：]\s*(.+)$/im

/**
 * 推奨ロール表記を正規化する（未知・未宣言は `null`）。
 *
 * `role:` 接頭辞の有無、バックティック、前後の空白・句読点を吸収する。
 * 抽象ロール 4 つ以外は**推測せず** `null`（後方互換）。
 *
 * @param {unknown} raw `role:builder` / `builder` / `` `role:planner` `` など
 * @returns {'role:planner'|'role:builder'|'role:visual-reviewer'|'role:decision-framer'|null} 正規化したロール
 */
export function normalizeRecommendedRole(raw) {
  const text = String(raw ?? '')
    .replace(/[`'"「」]/g, '')
    .trim()
    .toLowerCase()
  if (!text) return null
  // 行末に説明が続く場合（`role:builder — 通常実装`）は最初の語だけを見る。
  const token = text.split(/[\s,;/|、。]+/)[0].replace(/^role\s*[:：]\s*/, '')
  const role = `role:${token}`
  return ABSTRACT_ROLES.includes(role) ? role : null
}

/**
 * バッチ本文から推奨ロールを読む（未宣言は `null`＝後方互換）。
 *
 * @param {string[]|string} section バッチ本文の行（または本文）
 * @returns {'role:planner'|'role:builder'|'role:visual-reviewer'|'role:decision-framer'|null} ロール
 */
export function extractRecommendedRole(section) {
  const text = Array.isArray(section) ? section.join('\n') : String(section ?? '')
  const m = RECOMMENDED_ROLE_RE.exec(text)
  return m ? normalizeRecommendedRole(m[1]) : null
}

/** モード別の行動契約（`buildTaskBody` が本文末尾へ注入する）。 */
export const MODE_CONTRACTS = {
  'zero-stop': [
    '- Do not ask confirmation questions in chat.',
    `- Repair autonomously until ${VERIFY_CONTRACT} passes, then mark the task done.`,
    '- Only when a design contradiction is unresolvable, file a `quick-review` sheet and block on it.',
  ],
  'fast-track-review': [
    '- If the change forces a choice between options, file a `quick-review` sheet (each question with `recommended: true`) before implementing, and wait for the 1-tap approval.',
    `- Everything else proceeds without asking: implement, run ${VERIFY_CONTRACT}, then mark the task done.`,
  ],
  'visual-gate': [
    `- After implementing, deploy and verify the real screen at ${SCREEN_CHECK_CONTRACT}; capture the screenshots.`,
    '- If the rendered result differs from the intent, file an `annotation` review (screenshot + marks) and wait for it.',
    `- ${VERIFY_CONTRACT} must pass before you mark the task done.`,
  ],
}

/**
 * モード別の行動契約ブロック（`[Hermes Pilot Execution Contract]`）を組み立てる。
 *
 * モード未宣言でも `recommendedRole` があれば契約を出す（ロール指針だけは届ける）。
 * `recommendedRole` 指定時・`visual-gate` のときは、ネイティブ `delegate_task` ＋
 * フォールバックと外部 AI CLI 禁止を 2 行だけ添える（D61 / D63）。
 *
 * @param {string} mode 正規化済みモード
 * @param {{recommendedRole?: string|null}} [opts] 推奨ロール（未宣言は `null`）
 * @returns {string} 本文末尾に足すブロック（モードもロールも無ければ空文字＝後方互換）
 */
export function buildExecutionContract(mode, { recommendedRole = null } = {}) {
  const key = normalizeExecutionMode(mode)
  const role = normalizeRecommendedRole(recommendedRole)
  const gate = key === 'visual-gate'
  if (!key && !role) return ''
  const rules = key ? (MODE_CONTRACTS[key] ?? []) : []

  const delegation = []
  if (role) {
    delegation.push(
      `- Recommended role: \`${role}\` — resolve it against the profile's abstract-role table before starting.`,
    )
  } else if (gate) {
    delegation.push(
      '- Recommended role: `role:visual-reviewer` — delegate screenshot / annotated-image review through native delegation.',
    )
  }
  if (role || gate) {
    delegation.push(
      '- Delegate only through Hermes native delegation; on error, rate limit, timeout or an unsupported model, continue down the fallback chain instead of blocking.',
      '- Never launch an external AI CLI as a subprocess (no wrapped CLI runs); native providers only.',
    )
  }

  return [
    '',
    CONTRACT_HEADER,
    '',
    ...(key ? [`Mode: ${key}`, ''] : []),
    'This task was filed by the Hermes Pilot Spec Launchpad. The contract below overrides any habit of asking first.',
    ...rules,
    ...delegation,
    '- Finish with a short report: what changed, the verification command and its exit code, and what is still unverified.',
  ].join('\n')
}
