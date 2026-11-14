/**
 * Spec Launchpad の起票状況（Q3=A の「全バッチ完了」判定）。
 *
 * 画面（TasksPane）のカード文言と、タップ後の行き先（起票シート / 履歴シート）は
 * この純関数の戻り値だけで決まる。判定が 1 か所に閉じているので単体テストで固定できる
 * （node --test は JSX を読めないため、ロジックは .js の lib に置く）。
 */

/** タスクタイトル先頭のバッチ ID（`[B1] タイトル`）。無ければ null。 */
const BATCH_ID_RE = /^\[([^\]]+)\]/

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
 * - `byId`: バッチ ID → そのバッチのタスク（同じ ID が複数あれば最初の 1 件）
 * - `allFiled`: 全バッチにタスクがある
 * - `allDone`: 全バッチにタスクがあり、すべて完了（done / archived）
 *
 * バッチが 0 件のときは両方 false（空の SPEC で「完了」を名乗らない）。
 *
 * @param {Array<{id?: string}>} batches 仕様のバッチ
 * @param {Array<{title?: string, status?: string}>} tasks ボードのタスク
 * @returns {{byId: Map<string, object>, allFiled: boolean, allDone: boolean}} 進捗
 */
export function specProgress(batches, tasks) {
  const byId = new Map()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = batchIdOf(task?.title)
    if (!id || byId.has(id)) continue
    byId.set(id, task)
  }
  const ids = (Array.isArray(batches) ? batches : []).map((b) => String(b?.id ?? '')).filter(Boolean)
  const allFiled = ids.length > 0 && ids.every((id) => byId.has(id))
  const allDone = allFiled && ids.every((id) => CLOSED_STATUSES.has(String(byId.get(id)?.status ?? '')))
  return { byId, allFiled, allDone }
}
