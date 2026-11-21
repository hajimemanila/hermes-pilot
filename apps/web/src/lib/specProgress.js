/**
 * Spec Launchpad の起票状況（Q3=A の「全バッチ完了」判定）。
 *
 * 画面（TasksPane）のカード文言と、タップ後の行き先（起票シート / 履歴シート）は
 * この純関数の戻り値だけで決まる。判定が 1 か所に閉じているので単体テストで固定できる
 * （node --test は JSX を読めないため、ロジックは .js の lib に置く）。
 */

/** タスクタイトル先頭のバッチ ID（`[B1] タイトル`）。無ければ null。 */
const BATCH_ID_RE = /^\[([^\]]+)\]/

/** 本文の `Spec:` 行。 */
const SPEC_LINE_RE = /^Spec:\s*(.+?)\s*$/m

/** V4 以前の古いタスク本文（先頭数行の `docs/SPEC-*.md`）。 */
const LEGACY_SPEC_RE = /(?:docs\/)?SPEC[A-Za-z0-9._-]*\.md/i

/** SPEC 相対パスを比較用に正規化する。 */
function normalizeSpecPath(specPath) {
  const s = String(specPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  return s || null
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

/** 完了とみなす状態。起票済みでも未完了なら「全バッチ完了」にしない。 */
export const CLOSED_STATUSES = new Set(['done', 'archived'])

/**
 * バッチ一覧とボードのタスクから、起票・完了の状況をまとめる。
 *
 * - `specRelPath` 指定時、別の SPEC に属する同名 `[ID]` タスクは除外する
 *   （例: 過去 SPEC の `[C1]` があっても別 SPEC の `C1` を完了扱いしない）。
 * - `byId`: バッチ ID → そのバッチのタスク（同じ ID が複数あれば最初の 1 件）
 * - `allFiled`: 全バッチにタスクがある
 * - `allDone`: 全バッチにタスクがあり、すべて完了（done / archived）
 *
 * バッチが 0 件のときは両方 false（空の SPEC で「完了」を名乗らない）。
 *
 * @param {Array<{id?: string}>} batches 仕様のバッチ
 * @param {Array<{title?: string, status?: string, spec?: string|null, body?: string}>} tasks ボードのタスク
 * @param {string|null} [specRelPath] 対象の SPEC 相対パス
 * @returns {{byId: Map<string, object>, allFiled: boolean, allDone: boolean}} 進捗
 */
export function specProgress(batches, tasks, specRelPath = null) {
  const wantSpec = normalizeSpecPath(specRelPath)
  const byId = new Map()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = batchIdOf(task?.title)
    if (!id) continue
    const ts = wantSpec ? taskSpecOf(task) : null
    if (wantSpec && ts && ts !== wantSpec) continue
    if (byId.has(id)) {
      const prev = byId.get(id)
      const prevSpec = wantSpec ? taskSpecOf(prev) : null
      if (!(wantSpec && !prevSpec && ts === wantSpec)) continue
    }
    byId.set(id, task)
  }
  const ids = (Array.isArray(batches) ? batches : []).map((b) => String(b?.id ?? '')).filter(Boolean)
  const allFiled = ids.length > 0 && ids.every((id) => byId.has(id))
  const allDone = allFiled && ids.every((id) => CLOSED_STATUSES.has(String(byId.get(id)?.status ?? '')))
  return { byId, allFiled, allDone }
}
