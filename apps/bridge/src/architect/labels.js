/**
 * Architect の語彙（ランナー・実行ポリシー・フェーズ・上限値）。`architect.js` から分割。
 * 公開契約は `architect.js` の再エクスポートで維持する。
 */

/** `chat-reports.jsonl` の行種別（仕様書が完成した）。 */
export const SPEC_READY_KIND = 'spec_ready'
/** `chat-reports.jsonl` の行種別（autoStart がバッチを起票した）。 */
export const SPEC_LAUNCH_KIND = 'spec_launch'

/**
 * 選べるランナー。**`Hermes Native` の 1 本だけ**（SPEC V11 D50）。
 *
 * 外部 AI CLI をラップ起動するランナーは規約違反（サブスク枠の消費）なので、
 * 検出もパス解決も子プロセス起動もこのファイルには置かない。
 */
export const RUNNERS = ['hermes']

/**
 * 実行方針（生成する SPEC 各バッチの既定 Execution Mode）。SPEC V7 §3.1 / D35。
 *
 * どちらの方針でも Round 1 の Quick Review インタビューは必ず行い、
 * 変わるのは「各バッチを止まらずに完走させるか・要所で視覚確認を挟むか」だけ。
 */
export const EXECUTION_POLICIES = ['zero-stop', 'visual-gate']
/** 実行方針の既定値（未指定・不正値はこれへ正規化する）。 */
export const DEFAULT_EXECUTION_POLICY = 'zero-stop'

/** 親 `[ARCH]` タスクがこの状態になったらジョブは終端（進行バーに残さない）。 */
export const TERMINAL_TASK_STATUSES = ['done', 'archived']

/**
 * Quick Review（`[review]`）が撒かれる既定ボード（SPEC V9 D42）。
 *
 * 種は `hermes-pilot` などリポジトリ固有ボードで撒かれても、Round 1 のシートは `mobile` に届く。
 * 走査対象を `[job.board, DEFAULT_REVIEW_BOARD]` に広げないと `awaiting_review` を取りこぼす。
 */
export const DEFAULT_REVIEW_BOARD = 'mobile'

/** 進行バーに残す「アクティブ」状態（ボード横断で返す対象。`failed` も人が気づくまで残す）。 */
export const ACTIVE_JOB_STATUSES = ['running', 'awaiting_spec', 'awaiting_review', 'failed']

/** `publicJob().phase` が返すフェーズ（SPEC V9 D42）。 */
export const ARCHITECT_PHASES = [
  'spawning',
  'round1_sheet',
  'awaiting_review',
  'round2_spec',
  'spec_ready',
  'launched',
  'failed',
]

/** 進展が無いままこの時間を超えたら `stalled`（3 分。SPEC V9 D42/D43）。 */
export const STALLED_AFTER_MS = 180_000
/** 破棄したジョブ ID を保持する上限（古いものから落とす）。 */
export const DISMISSED_MAX = 500

/** 0 行の種はインタビューにならない。長すぎる種はプロンプトを壊す。 */
export const SEED_MIN = 1
/** 種の最大文字数。 */
export const SEED_MAX = 4000
/** 保持するジョブ数（古いものから落とす）。 */
export const JOBS_MAX = 40
/** 「このジョブが作った SPEC」と見なす mtime の猶予（秒ズレ対策）。 */
export const SPEC_MTIME_SLACK_MS = 5000
/** ランナーの既定タイムアウト（ミリ秒）。 */
export const RUNNER_TIMEOUT_MS = 15 * 60 * 1000
/** ボード名の書式（`specs.launchSpec` と同じ）。 */
export const BOARD_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** ランナーの表示名（ランナーは 1 本だけ）。 */
export const RUNNER_LABELS = {
  hermes: 'Hermes Native',
}

/** ランナー名として受け付ける値（空・未指定は Hermes Native へ倒す）。 */
export const DEFAULT_RUNNER = 'hermes'

/**
 * ランナー ID を正規化する（**常に `hermes`**。SPEC V11 D50）。
 *
 * 受け付ける値は `hermes` だけだが、`sanitizeRunner()` は表示用の緩い正規化なので
 * 未知の値も既定へ倒す。API 入力の可否判定は `isSupportedRunner()` で行う。
 * @param {unknown} value 入力
 * @returns {'hermes'} ランナー
 */
export function sanitizeRunner(value) {
  return DEFAULT_RUNNER
}

/**
 * 明示されたランナーが受け付けられるか（`''` / 未指定は既定として許す）。
 * @param {unknown} value 入力
 * @returns {boolean} `hermes` か未指定なら true
 */
export function isSupportedRunner(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  return text === '' || text === DEFAULT_RUNNER
}

/**
 * ランナーの表示名。
 * @param {unknown} value 入力
 * @returns {string} 表示名
 */
/**
 * `config.json` 等の `pilotProfile` 解決ヘルパ（未設定・空文字は `'mobile'`）。
 * @param {object} [cfg] 設定（`pilotProfile` は文字列または関数）
 * @returns {string} 担当プロファイル名
 */
export function pilotAssigneeOf(cfg = {}) {
  const raw = typeof cfg?.pilotProfile === 'function' ? cfg.pilotProfile() : cfg?.pilotProfile
  return String(raw ?? '').trim() || 'mobile'
}

export function runnerLabel(value) {
  return RUNNER_LABELS[sanitizeRunner(value)]
}

/**
 * 実行方針を正規化する（未指定・不正値は `zero-stop`）。
 * @param {unknown} value 入力
 * @returns {'zero-stop'|'visual-gate'} 実行方針
 */
export function normalizeExecutionPolicy(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  return EXECUTION_POLICIES.includes(text) ? text : DEFAULT_EXECUTION_POLICY
}

/**
 * 実行方針に対応する SPEC バッチの `Execution Mode` 表記。
 * @param {unknown} value 実行方針
 * @returns {string} `[Mode: Zero-Stop]` / `[Mode: Visual Gate]`
 */
export function executionModeLabel(value) {
  return normalizeExecutionPolicy(value) === 'visual-gate' ? '[Mode: Visual Gate]' : '[Mode: Zero-Stop]'
}

/**
 * プロンプトへ差し込む実行方針の指示（両方針共通で Quick Review は必須）。
 * @param {unknown} value 実行方針
 * @returns {string[]} 行
 */
export function executionPolicyLines(value) {
  const policy = normalizeExecutionPolicy(value)
  const mode = executionModeLabel(policy)
  const intent =
    policy === 'visual-gate'
      ? 'pause at the visual checkpoints and wait for approval before going further'
      : 'do not stop for approval: run every batch autonomously to done'
  return [
    `- Round 1 Quick Review interview is mandatory under both policies: still write the sheet and stop.`,
    `- Execution policy chosen by the user: \`${policy}\`. Every batch in the generated SPEC must default to`,
    `  **Execution Mode**: \`${mode}\` : ${intent}.`,
  ]
}
