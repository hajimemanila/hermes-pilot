/**
 * Spec Launchpad の起票状況（Q3=A の「全バッチ完了」判定）。
 *
 * 画面（TasksPane）のカード文言と、タップ後の行き先（起票シート / 履歴シート）は
 * この純関数の戻り値だけで決まる。判定が 1 か所に閉じているので単体テストで固定できる
 * （node --test は JSX を読めないため、ロジックは .js の lib に置く）。
 *
 * SPEC-RELIABILITY-GUARD D91 / D92: 照合は「`pipeline-runs.json` の `taskIds` →
 * `Spec:` 行一致 → 無印タスク（対象 SPEC の mtime 以降だけ）」の 3 段階に固定し、
 * `archived`（破棄済み）は完了扱いにしない（再起票できる）。
 */

/** タスクタイトル先頭のバッチ ID（`[B1] タイトル`）。無ければ null。 */
const BATCH_ID_RE = /^\[([^\]]+)\]/

/** 本文の `Spec:` 行。 */
const SPEC_LINE_RE = /^Spec:\s*(.+?)\s*$/m

/** 本文の `Batch: <id> — <title>` 固定ヘッダ（`specs.buildTaskBody` が書く行）。 */
const BATCH_LINE_RE = /^Batch:\s*([A-Za-z][A-Za-z0-9._-]{0,15})\s*(?:—|–|-{1,2}|:)(?:\s|$)/m

/** V4 以前の古いタスク本文（先頭数行の `docs/SPEC-*.md`）。 */
const LEGACY_SPEC_RE = /(?:docs\/)?SPEC[A-Za-z0-9._-]*\.md/i

/** 完了とみなす状態。`archived`（破棄済み）は**完了ではない**（D92）。 */
export const DONE_STATUS = 'done'

/** 無印タスクを拾ってよい猶予（ms）。SPEC の mtime とタスク作成時刻の丸め差を吸収する。 */
export const SPEC_MTIME_SLACK_MS = 5000

/** SPEC 相対パスを比較用に正規化する。 */
function normalizeSpecPath(specPath) {
  const s = String(specPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  return s || null
}

/** タイムスタンプ（ms / 秒 / ISO）を epoch ms にする。不明は 0。 */
function toMs(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const raw = String(value).trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return toMs(Number(raw))
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * タスクが属する SPEC 相対パスを返す（`task.spec` 優先、無ければ `task.body`）。
 * @param {object} task タスク
 * @returns {string|null} SPEC パス（不明なレガシータスクは null）
 */
export function taskSpecOf(task) {
  const direct = normalizeSpecPath(task?.spec)
  if (direct) return direct
  const body = String(task?.body ?? '')
  if (!body) return null
  const m = SPEC_LINE_RE.exec(body)
  if (m) return normalizeSpecPath(m[1])
  const head = body.split(/\r?\n/).slice(0, 5).join('\n')
  const leg = LEGACY_SPEC_RE.exec(head)
  return leg ? normalizeSpecPath(leg[0]) : null
}

/**
 * タスクタイトルからバッチ ID を取り出す。
 * @param {unknown} title タスクタイトル
 * @returns {string|null} バッチ ID
 */
export function batchIdOf(title) {
  return BATCH_ID_RE.exec(String(title ?? ''))?.[1] ?? null
}

/**
 * タスク本文の `Batch: <id> — ...` ヘッダからバッチ ID を読む（タイトルに無いときの補助）。
 * @param {object} task タスク
 * @returns {string|null} バッチ ID
 */
export function batchHeaderIdOf(task) {
  const m = BATCH_LINE_RE.exec(String(task?.body ?? ''))
  return m ? m[1] : null
}

/**
 * タスクの最新タイムスタンプ（作成・開始・完了のうち最も新しいもの）。不明は 0。
 * @param {object} task タスク
 * @returns {number} epoch ms
 */
export function taskTimeMs(task) {
  return Math.max(
    toMs(task?.createdAt),
    toMs(task?.startedAt),
    toMs(task?.completedAt),
    toMs(task?.created_at),
    toMs(task?.started_at),
    toMs(task?.completed_at),
  )
}

/** 状態の優先度（`done` ＞ 非終了オープン ＞ `archived`）。小さいほど優先。 */
function statusRank(status) {
  const s = String(status ?? '')
  if (s === DONE_STATUS) return 0
  if (s === 'archived') return 2
  return 1
}

/**
 * 紐づけの優先度（`runTaskIds` 一致 ＞ `Spec:` 一致 ＞ 無印）。対象外は -1。
 *
 * @param {object} task タスク
 * @param {string|null} wantSpec 対象 SPEC 相対パス
 * @param {Set<string>} idSet `pipeline-runs.json` の taskIds
 * @param {number|null} since 無印タスクを許す下限（epoch ms）
 * @returns {number} 0=run / 1=spec / 2=unmarked / -1=対象外
 */
function linkRank(task, wantSpec, idSet, since) {
  const id = String(task?.id ?? task?.taskId ?? '').trim()
  if (idSet.size && id && idSet.has(id)) return 0
  if (!wantSpec) return 1
  const ts = taskSpecOf(task)
  if (ts) return ts === wantSpec ? 1 : -1
  // 無印（レガシー）タスク: 対象 SPEC より前に作られたものは別 SPEC の残骸として除外する。
  if (since !== null && !(taskTimeMs(task) >= since)) return -1
  return 2
}

/**
 * バッチ一覧とボードのタスクから、起票・完了の状況をまとめる。
 *
 * - `specRelPath` 指定時、別の SPEC に属する同名 `[ID]` タスクは除外する
 *   （例: 過去 SPEC の `[C1]` があっても別 SPEC の `C1` を完了扱いしない）。
 * - 紐づけの優先度は **`opts.runTaskIds` 一致 ＞ `Spec:` 一致 ＞ 無印**。
 *   無印タスクは `opts.specMtime` があるとき、`specMtime - 猶予` 以降に触られたものだけを許す
 *   （過去の無印 `[C1]` 等が新規 SPEC に誤マッチしない）。
 * - 同じバッチ ID に複数タスクがあるときは、紐づけ優先度 → 状態（`done` ＞ オープン ＞ `archived`）
 *   の順で良い方を `byId` に残す。
 * - `allDone` は**全バッチのタスクが `done` のときだけ** true（`archived` は完了ではない）。
 *
 * バッチが 0 件のときは両方 false（空の SPEC で「完了」を名乗らない）。
 *
 * @param {Array<{id?: string}>} batches 仕様のバッチ
 * @param {Array<{id?: string, title?: string, status?: string, spec?: string|null, body?: string}>} tasks ボードのタスク
 * @param {string|null} [specRelPath] 対象の SPEC 相対パス
 * @param {{specMtime?: number|null, runTaskIds?: Array<string>|null}} [opts] 照合の補助情報
 * @returns {{byId: Map<string, object>, allFiled: boolean, allDone: boolean}} 進捗
 */
export function specProgress(batches, tasks, specRelPath = null, opts = {}) {
  const wantSpec = normalizeSpecPath(specRelPath)
  const idSet = new Set(
    (Array.isArray(opts?.runTaskIds) ? opts.runTaskIds : []).map((v) => String(v ?? '').trim()).filter(Boolean),
  )
  const specMtime = Number(opts?.specMtime)
  const since = Number.isFinite(specMtime) && specMtime > 0 ? specMtime - SPEC_MTIME_SLACK_MS : null
  /** @type {Map<string, {task: object, link: number, status: number}>} */
  const picked = new Map()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = batchIdOf(task?.title) ?? batchHeaderIdOf(task)
    if (!id) continue
    const link = linkRank(task, wantSpec, idSet, since)
    if (link < 0) continue
    const status = statusRank(task?.status)
    const prev = picked.get(id)
    // 厳密に良いときだけ差し替える（同点は先着を残す＝並びが安定する）。
    if (prev && !(link < prev.link || (link === prev.link && status < prev.status))) continue
    picked.set(id, { task, link, status })
  }
  const byId = new Map([...picked.entries()].map(([id, entry]) => [id, entry.task]))
  const ids = (Array.isArray(batches) ? batches : []).map((b) => String(b?.id ?? '')).filter(Boolean)
  const allFiled = ids.length > 0 && ids.every((id) => byId.has(id))
  const allDone = allFiled && ids.every((id) => String(byId.get(id)?.status ?? '') === DONE_STATUS)
  return { byId, allFiled, allDone }
}
