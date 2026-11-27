/**
 * `Spec Seed` の純粋ロジック（SPEC V5 §3.3 ① / D26①・SPEC V7 §3.3 / D33・D35）。
 *
 * 画面（`features/SpecSeedSheet.jsx`）から切り離しておき、DOM 無しで単体テストする。
 * 文言は i18n 辞書（`seed.*`）が持ち、ここには英語の ASCII ロジックだけを置く
 * （`noHardcodedJapanese.test.js` は `src/` を丸ごと走査するため）。
 *
 * 音声は OS キーボードの標準入力に一本化したので、Web Speech API のヘルパーは持たない
 * （非 Secure Context の Tailscale HTTP や Android Chrome の `continuous` 非互換で
 * 必ず失敗していた。SPEC V7 §1.3）。
 */

import { getLocale } from './format.js'

/** 種の最大文字数（ブリッジの `SEED_MAX` と一致させる）。 */
export const SEED_MAX = 4000

/** テンプレートチップの ID（ラベル・本文は i18n の `seed.tpl.<id>` / `seed.tpl.<id>Text`）。 */
export const TEMPLATE_IDS = ['feature', 'ux', 'bug']

/**
 * 実行方針（SPEC-PILOT-V7 §3.3 ② / D35）。
 *
 * どちらでも Round 1 の Quick Review インタビューは実施し、生成する SPEC の
 * 各バッチに付す既定 `Execution Mode` だけを切り替える。
 */
export const EXECUTION_POLICIES = Object.freeze(['zero-stop', 'visual-gate'])

/** 既定の実行方針（止まらず自律完走）。 */
export const DEFAULT_EXECUTION_POLICY = 'zero-stop'

/**
 * 実行方針を正規化する（未知値・未指定は既定へ落とす）。
 * @param {unknown} value 入力
 * @returns {'zero-stop'|'visual-gate'} 正規化した方針
 */
export function normalizeExecutionPolicy(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return EXECUTION_POLICIES.includes(v) ? v : DEFAULT_EXECUTION_POLICY
}

/**
 * 実行方針 → ピルのラベル i18n キー。
 * @param {unknown} policy 方針
 * @returns {string} キー
 */
export function executionPolicyKey(policy) {
  return normalizeExecutionPolicy(policy) === 'visual-gate' ? 'seed.policyVisualGate' : 'seed.policyZeroStop'
}

/**
 * 実行方針 → 説明文の i18n キー。
 * @param {unknown} policy 方針
 * @returns {string} キー
 */
export function executionPolicyHintKey(policy) {
  return normalizeExecutionPolicy(policy) === 'visual-gate'
    ? 'seed.policyVisualGateHint'
    : 'seed.policyZeroStopHint'
}

/**
 * 送信できる状態か。
 * @param {string} text 種
 * @returns {boolean} 送信可否
 */
export function canSubmit(text) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length > 0 && trimmed.length <= SEED_MAX
}

/**
 * `POST /api/architect/seed` の本文。
 *
 * SPEC-PILOT-V11 §3.3 / D51: ランナーは `Hermes Native` のみなので `runner` は送らない
 * （受け取っても常に `hermes` を載せる。API は `hermes` 以外を `INVALID_RUNNER` で弾く）。
 *
 * @param {{seedText: string, autoStart?: boolean, executionPolicy?: string, board?: string, repo?: string|null, chat?: string|null, lang?: string}} input 入力
 * @returns {object} 本文
 */
export function buildSeedPayload({
  seedText,
  autoStart = false,
  executionPolicy = DEFAULT_EXECUTION_POLICY,
  autopilot = false,
  board,
  repo = null,
  chat = null,
  // 既定は**現在の UI 言語**。`'ja'` 固定だと、lang を渡し忘れた呼び出し元が
  // 英語 UI でも日本語のインタビューを始めてしまう（言語の既定は 1 か所に揃える）。
  lang = getLocale(),
}) {
  const body = {
    seedText: String(seedText ?? '').trim().slice(0, SEED_MAX),
    autoStart: Boolean(autoStart),
    executionPolicy: normalizeExecutionPolicy(executionPolicy),
    runner: 'hermes',
    lang: lang === 'en' ? 'en' : 'ja',
  }
  if (autopilot) body.autopilot = true
  if (board) body.board = String(board)
  if (repo) body.repo = String(repo)
  if (chat) body.chat = String(chat)
  return body
}

/**
 * ジョブの状態 → i18n キー。
 * @param {string} status 状態
 * @returns {string} キー
 */
export function jobStatusKey(status) {
  switch (status) {
    case 'running':
      return 'seed.statusRunning'
    case 'awaiting_review':
      return 'seed.statusAwaitingReview'
    case 'awaiting_spec':
      return 'seed.statusAwaiting'
    case 'spec_ready':
      return 'seed.statusReady'
    case 'launched':
      return 'seed.statusLaunched'
    case 'failed':
      return 'seed.statusFailed'
    default:
      return 'seed.statusUnknown'
  }
}

/** 進行バー（`ArchitectJobBar`）に出す状態（SPEC V6 §3.3 ①）。 */
const JOB_ACTIVE_STATUSES = Object.freeze(['running', 'awaiting_review', 'awaiting_spec', 'failed'])

/**
 * キュー状態 → 表示チップの i18n キー（SPEC V7 §3.3 ③ / D33）。
 *
 * Bridge は親 `[ARCH]` タスクの status から `queueState` を返す（`ready` = `queued`、
 * `running`/`claimed` = `running`）。判定できないときは `null` を返し、UI は
 * 従来どおり状態文だけを出す。
 *
 * @param {object|null} job ジョブ
 * @returns {string|null} キー
 */
export function jobQueueKey(job) {
  const q = String(job?.queueState ?? '')
  if (q === 'queued') return 'seed.queueQueued'
  if (q === 'running') return 'seed.queueRunning'
  return null
}

/**
 * 待機中（キュー待ち）か。経過時間の文言を「待機」に切り替えるのに使う。
 * @param {object|null} job ジョブ
 * @returns {boolean} 待機中なら true
 */
export function isQueuedJob(job) {
  return String(job?.queueState ?? '') === 'queued'
}

/**
 * 進行バーのタイトル i18n キー（待機中は「キュー待ち」、Round 2 は「回答受領後の待機」を明示する）。
 * @param {object|null} job ジョブ
 * @returns {string} キー
 */
export function jobTitleKey(job) {
  if (isQueuedJob(job)) {
    return job?.phase === 'round2_spec' || job?.reviewSeenOnce
      ? 'seed.statusQueuedRound2'
      : 'seed.statusQueued'
  }
  return jobStatusKey(job?.status)
}

/**
 * ジョブ破棄のエンドポイント（`POST`。SPEC V7 §3.3 ③）。
 *
 * サーバー側に永続化するので、リロードしても進行バーに戻ってこない。
 * @param {string} jobId ジョブ ID
 * @returns {string} パス
 */
export function dismissJobPath(jobId) {
  return `/api/architect/jobs/${encodeURIComponent(String(jobId ?? ''))}/dismiss`
}

/** 進行中（自律で進む）ジョブのポーリング間隔。 */
const JOB_POLL_ACTIVE_MS = 4000

/** 待機中（人待ち・停止）と、ジョブが無いときのポーリング間隔。 */
const JOB_POLL_IDLE_MS = 20000

/**
 * 進行バーに出すジョブを 1 件選ぶ（SPEC V6 §3.3 ①・SPEC-PILOT-V9 §3.3 ① / D43）。
 *
 * `spec_ready` / `launched` は既存の `SpecReadyBanner` が引き継ぐので出さない
 * （二重カードにしない）。新しいジョブを優先し、同時刻なら `failed` を先に見せる
 * （止まっているものを黙って隠さない）。`×` で閉じたジョブ・サーバー側で破棄済み
 * （`dismissed`）のジョブは再表示しない。
 *
 * `preferredBoard` を渡すと、そのボードのジョブを優先しつつ、1 件も無ければ
 * 別ボードのアクティブジョブをフォールバックで返す（ブリッジの `jobsFor()` が
 * ボード横断でアクティブジョブを返すようになったため、リポジトリ未選択の
 * チャットからでも進行バーが消えない）。2 引数呼び出しは従来と同一。
 *
 * @param {Array<object>} jobs `/api/architect/jobs` の `jobs`
 * @param {string[]} [dismissedIds] 閉じたジョブの ID
 * @param {string} [preferredBoard] 優先するボード slug（空なら従来どおり）
 * @returns {object|null} ジョブ（無ければ null）
 */
export function pickActiveArchitectJob(jobs, dismissedIds = [], preferredBoard = '') {
  const list = (Array.isArray(jobs) ? jobs : []).filter(
    (job) => job && JOB_ACTIVE_STATUSES.includes(String(job.status)) && !job.dismissed,
  )
  const dismissed = new Set((Array.isArray(dismissedIds) ? dismissedIds : []).map((id) => String(id)))
  const candidates = list.filter((job) => !dismissed.has(String(job.id)))
  if (!candidates.length) return null
  const preferred = String(preferredBoard ?? '').trim()
  const boardRank = (job) => (preferred && String(job.board ?? '') === preferred ? 0 : 1)
  return candidates.sort((a, b) => {
    // ボード一致を先に（別ボードしか無ければ両方 1 で従来の並びに戻る）
    const byBoard = preferred ? boardRank(a) - boardRank(b) : 0
    if (byBoard) return byBoard
    const diff = (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
    if (diff) return diff
    return (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1)
  })[0]
}

/**
 * ジョブの現在フェーズ → i18n キー（SPEC-PILOT-V9 §3.3 ① / D42・D43）。
 *
 * ブリッジの `phase`（`spawning` 〜 `failed`）をそのまま写像する。旧ブリッジは
 * `phase` を返さないので `null`（＝UI はフェーズ札を出さない）にフォールバックする。
 *
 * @param {object|null} job ジョブ
 * @returns {string|null} キー（未知・未指定は null）
 */
export function jobPhaseKey(job) {
  switch (String(job?.phase ?? '')) {
    case 'spawning':
      return 'seed.phaseSpawning'
    case 'round1_sheet':
      return 'seed.phaseRound1Sheet'
    case 'awaiting_review':
      return 'seed.statusAwaitingReview'
    case 'round2_spec':
      return 'seed.phaseRound2Spec'
    case 'spec_ready':
      return 'seed.statusReady'
    case 'launched':
      return 'seed.statusLaunched'
    case 'failed':
      return 'seed.statusFailed'
    default:
      return null
  }
}

/**
 * 検知済みのシート（`job.sheetPath`）から表示用のファイル名を取る。
 * @param {object|null} job ジョブ
 * @returns {string} ファイル名（未検知は空文字）
 */
export function jobSheetName(job) {
  const path = String(job?.sheetPath ?? '').trim()
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return String(parts[parts.length - 1] ?? '').trim()
}

/**
 * Hermes Native での再試行を**明示ボタンとして**出すか（SPEC-PILOT-V11 §3.1 / D54）。
 *
 * ランナーは `Hermes Native` だけになったので、失敗・停滞をそのまま放置せず、
 * 同じ種で撃ち直せる 1 タップの逃げ道を必ず出す。
 *  - `failed`: 止まったものを黙って放置しない
 *  - `stalled`（3 分以上無進展）: 動いているのか止まっているのか分からないので出す
 *
 * `awaiting_review` は人の回答待ちでブリッジも `stalled` を立てないため、通常は出ない
 * （返答すれば進む）。判定は `failed` と `stalled` の 2 つだけに保つ。
 *
 * @param {object|null} job ジョブ
 * @returns {boolean} 出すなら true
 */
export function shouldOfferHermesRetry(job) {
  if (!job) return false
  if (String(job.status) === 'failed') return true
  return Boolean(job.stalled)
}

/**
 * 稼働中（＝実行中として数える）Architect ジョブの件数（D43）。
 *
 * `/api/live` の `counts.architect` と同じ規則（`running` / `awaiting_spec`）。
 * `awaiting_review` は「判断待ち」ピルの担当なので、ここでは数えない。
 *
 * @param {Array<object>} jobs ジョブ一覧
 * @returns {number} 件数
 */
export function countRunningArchitect(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(
    (job) => job && !job.dismissed && ['running', 'awaiting_spec'].includes(String(job.status)),
  ).length
}

/**
 * ジョブの状態に応じたポーリング間隔（SPEC V6 §3.3 ③・SPEC V7 §3.3 ③）。
 *
 * 自律で進む `running` / `awaiting_spec` だけ 4 秒。`awaiting_review` / `failed` は
 * 人の操作待ちなので 20 秒のまま（不要な問い合わせを増やさない）。
 * キュー待ち（`queueState === 'queued'`）はディスパッチャ（既定 60 秒間隔）が拾う
 * まで進まないので、遅い側に落とさず 4 秒で「実行中へ変わった瞬間」を拾う。
 *
 * @param {object|null} job ジョブ
 * @returns {number} ミリ秒
 */
export function jobPollMs(job) {
  const status = String(job?.status ?? '')
  if (isQueuedJob(job)) return JOB_POLL_ACTIVE_MS
  return status === 'running' || status === 'awaiting_spec' ? JOB_POLL_ACTIVE_MS : JOB_POLL_IDLE_MS
}

/**
 * ジョブのランナー表示 → i18n キー（SPEC-PILOT-V11 §3.3 / D51）。
 *
 * ランナーは `Hermes Native` だけになったので、常に同じキーを返す
 * （旧ブリッジが `runner` を欠いたジョブでも表示が空にならない）。
 *
 * @returns {string} キー
 */
export function jobRunnerKey() {
  return 'seed.runnerHermes'
}

/**
 * 経過時間を「時・分・秒」へ分解する（表示は i18n の `seed.elapsed*`）。
 * @param {number} ms ミリ秒
 * @returns {{h: number, m: number, s: number}} 分解結果
 */
export function elapsedParts(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  }
}

/**
 * Chat / Tasks に出す A2B クイック起票カードの材料を 1 つ選ぶ。
 *
 * 優先順: ① Architect が完成した SPEC（未起票あり・未起票のまま）→ ② 未起票 SPEC のうち最新。
 * 起票済み（`launched`）は出さない（二重起票の押し間違いを作らない）。
 *
 * @param {{specReady?: Array<object>, pending?: Array<object>}} input 入力
 * @returns {{kind: 'ready'|'pending', path: string, title: string, count: number, ids: string[], jobId: string|null, autoStart: boolean}|null} バナー
 */
export function pickSpecBanner({ specReady = [], pending = [] } = {}) {
  const ready = (Array.isArray(specReady) ? specReady : []).find(
    (row) => row && !row.launched && Number(row.batchCount) > 0,
  )
  if (ready) {
    const ids = (Array.isArray(ready.batches) ? ready.batches : []).map((b) => String(b?.id ?? '')).filter(Boolean)
    return {
      kind: 'ready',
      path: String(ready.spec),
      title: String(ready.title ?? ready.spec),
      count: Number(ready.batchCount) || ids.length,
      ids,
      jobId: ready.jobId ?? null,
      autoStart: Boolean(ready.autoStart),
      // ジョブが属するボード（`GET /api/specs/content` の解決に使う。チャットが
      // まだボードに紐づいていないときでも正しいリポジトリで仕様書を読める）
      board: ready.board ?? null,
    }
  }
  const next = (Array.isArray(pending) ? pending : []).find((row) => row && Number(row.pendingCount) > 0)
  if (!next) return null
  return {
    kind: 'pending',
    path: String(next.path),
    title: String(next.title ?? next.path),
    count: Number(next.pendingCount) || 0,
    ids: (Array.isArray(next.pending) ? next.pending : []).map((id) => String(id ?? '')).filter(Boolean),
    jobId: null,
    autoStart: false,
    board: next.board ?? null,
  }
}
