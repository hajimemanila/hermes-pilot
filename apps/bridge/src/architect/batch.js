/**
 * バッチ ID 接頭辞・未起票 SPEC の判定・Review ボードの解決。`architect.js` から分割。
 * 公開契約は `architect.js` の再エクスポートで維持する。
 */
import { taskStampMs } from '../specs.js'
import { DEFAULT_REVIEW_BOARD, SPEC_MTIME_SLACK_MS } from './labels.js'
import { taskSpecPath } from './task.js'

/**
 * slug から推奨バッチ ID 接頭辞を作る（大文字・短く保つ。`specs.BATCH_ID_RE` の 16 文字制限内）。
 *
 * `reliability-guard` → `RG` / `coherence` → `COH` / `v5` → `V5`
 *
 * @param {unknown} slug スラッグ
 * @returns {string} 接頭辞（読めなければ `B`）
 */
export function batchIdPrefixForSlug(slug) {
  const parts = String(slug ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (!parts.length) return 'B'
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase()
  return parts
    .slice(0, 4)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
}

/**
 * バッチ ID の接頭辞（`RG-1` → `RG`、`C1` → `C`）。大文字化して返す（D91 の衝突防止）。
 * @param {unknown} batchId バッチ ID
 * @returns {string} 接頭辞（読めなければ空文字）
 */
export function batchIdPrefixOf(batchId) {
  const s = String(batchId ?? '').trim().toUpperCase()
  if (!s) return ''
  const dash = s.indexOf('-')
  if (dash > 0) return s.slice(0, dash)
  const m = /^[A-Z]+/.exec(s)
  return m ? m[0] : ''
}

/**
 * アクティブ SPEC 群で使用済みのバッチ ID 接頭辞（Architect へ渡して衝突を防ぐ）。
 *
 * @param {Array<{archived?: boolean, batches?: Array<{id?: string}>}>} specs `listSpecs()` の結果
 * @returns {string[]} 接頭辞（昇順・重複なし）
 */
export function usedBatchIdPrefixes(specs) {
  const out = new Set()
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (!spec || spec.archived) continue
    for (const batch of Array.isArray(spec.batches) ? spec.batches : []) {
      const prefix = batchIdPrefixOf(batch?.id)
      if (prefix) out.add(prefix)
    }
  }
  return [...out].sort()
}

/**
 * 指定 SPEC に結びついた「起票済みバッチ ID」を集める（別 SPEC に属する `[ID]` は除外）。
 *
 * - `opts.specMtime` を渡すと、無印（Spec 行の無い）レガシータスクは `specMtime - 猶予` 以降の
 *   ものだけを数える（過去の無印 `[C1]` が新規 SPEC を「起票済み」に見せない。D91）。
 * - `archived`（破棄済み）は**起票済みに数えない**（再起票できる。D92）。
 *
 * @param {Array<{title?: string, status?: string, spec?: string|null, body?: string}>} tasks ボードのタスク
 * @param {string|null} specRelPath SPEC 相対パス
 * @param {{specMtime?: number|null, slackMs?: number}} [opts] 無印タスクの時刻ガード
 * @returns {Set<string>} バッチ ID
 */
export function filedBatchIdsForSpec(tasks, specRelPath = null, opts = {}) {
  const wantSpec = String(specRelPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim() || null
  const specMtime = Number(opts?.specMtime)
  const slack = Number.isFinite(Number(opts?.slackMs)) ? Number(opts.slackMs) : SPEC_MTIME_SLACK_MS
  const since = wantSpec && Number.isFinite(specMtime) && specMtime > 0 ? specMtime - slack : null
  const out = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task) continue
    if (String(task.status ?? '').trim().toLowerCase() === 'archived') continue
    const m = /^\[([^\]]+)\]/.exec(String(task?.title ?? '').trim())
    if (!m || !m[1].trim()) continue
    if (wantSpec) {
      const ts = taskSpecPath(task)
      if (ts && ts !== wantSpec) continue
      if (!ts && since !== null && !(taskStampMs(task) >= since)) continue
    }
    out.add(m[1].trim())
  }
  return out
}

/**
 * タスク一覧から「起票済みのバッチ ID」を集める（`done` は起票済み・`archived` は未起票）。
 *
 * 完了済み（`done`）を未起票と数えると、バナーが「起票して開始」を出して
 * 同じバッチをもう一度起票してしまう（`specs.launchSpec` がスキップするのは
 * **未完了**の重複だけ）。ここは「タスクが 1 つでもあるか」で数える。
 * ただし `archived`（破棄済み）は再起票できるので数えない（D92）。
 *
 * @param {Array<{title?: string, status?: string}>} tasks ボードのタスク
 * @returns {Set<string>} バッチ ID
 */
export function filedBatchIds(tasks) {
  return filedBatchIdsForSpec(tasks, null)
}

/**
 * 未起票の SPEC を数える（A2B の 1 タップ一括起票カード用）。
 * @param {Array<object>} specs `specs.listSpecs` の結果
 * @param {Array<{id: string, title: string, status?: string, spec?: string|null, body?: string}>} tasks ボードのタスク
 * @returns {Array<{path: string, title: string, batchCount: number, pendingCount: number, pending: string[], mtime: number}>} 未起票ありの SPEC
 */
export function pendingSpecs(specs, tasks) {
  const out = []
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (!spec || spec.archived) continue
    const batches = (spec?.batches ?? []).filter((b) => b?.id)
    if (!batches.length) continue
    const filed = filedBatchIdsForSpec(tasks, spec.path, { specMtime: Number(spec.mtime ?? 0) })
    const pending = batches.filter((b) => !filed.has(String(b.id))).map((b) => b.id)
    if (!pending.length) continue
    out.push({
      path: String(spec.path),
      title: String(spec.title ?? spec.path),
      batchCount: batches.length,
      pendingCount: pending.length,
      pending,
      mtime: Number(spec.mtime ?? 0),
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
}

/**
 * 親タスクの状態から「キュー待ち（queued）」と「実行中（running）」を判別する（SPEC V7 §3.1）。
 *
 * `ready` は着手中ではない＝キュー待ち。`running` / `claimed` は実行中。
 * 判定できない状態（`blocked` など）は `null`（UI は従来の表示にフォールバック）。
 *
 * @param {unknown} taskStatus 親 `[ARCH]` タスクの status
 * @returns {'queued'|'running'|null} キュー状態
 */
export function queueStateOf(taskStatus) {
  const s = String(taskStatus ?? '')
    .trim()
    .toLowerCase()
  if (['running', 'claimed', 'in_progress'].includes(s)) return 'running'
  if (['ready', 'todo', 'scheduled', 'blocked'].includes(s)) return 'queued'
  return null
}

/**
 * `[review]` を探すボード（`[job.board, 'mobile']`・重複除去・空文字除外）。SPEC V9 D42。
 * @param {unknown} jobBoard ジョブのボード
 * @returns {string[]} 走査するボード（先頭がジョブ自身のボード）
 */
export function reviewBoardsFor(jobBoard) {
  const own = String(jobBoard ?? '').trim()
  return [...new Set([own, DEFAULT_REVIEW_BOARD].filter(Boolean))]
}
