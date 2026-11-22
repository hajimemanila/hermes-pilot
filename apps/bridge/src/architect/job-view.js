/**
 * ジョブの表示（フェーズ・停滞・公開形）。`architect.js` から分割。
 * 公開契約は `architect.js` の再エクスポートで維持する。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ARCHITECT_PHASES,
  ACTIVE_JOB_STATUSES,
  DISMISSED_MAX,
  SPEC_MTIME_SLACK_MS,
  STALLED_AFTER_MS,
  normalizeExecutionPolicy,
  runnerLabel,
} from './labels.js'
import { queueStateOf } from './batch.js'
import { findActiveJobReviewTask, findJobReviewTask } from './task.js'

/**
 * `reviewDir/sheets/` の中で「このジョブが書いた」Round 1 シートを 1 枚選ぶ（SPEC V9 D42）。
 *
 * `spec-<slug>-1.json` のような JSON シートだけを見る（HTML は対象外）。
 * `mtime >= job.startedAt - 猶予` の最新 1 枚を `sheets/<name>` の相対パスで返す。
 *
 * @param {string|null|undefined} reviewDir レビューディレクトリ（`sheets/` の親）
 * @param {{startedAt?: number}} job ジョブ
 * @param {{slackMs?: number}} [opts] 猶予（秒ズレ対策）
 * @returns {string|null} 相対パス（無ければ null）
 */
export function findRecentSheet(reviewDir, job, { slackMs = SPEC_MTIME_SLACK_MS } = {}) {
  const dir = reviewDir ? path.join(String(reviewDir), 'sheets') : ''
  if (!dir) return null
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null // ディレクトリが無い環境では無害に null
  }
  const since = Number(job?.startedAt ?? 0) - Number(slackMs)
  let best = null
  for (const entry of entries) {
    if (!entry?.isFile?.()) continue
    const name = String(entry.name ?? '')
    if (!/^spec-.+\.json$/i.test(name)) continue
    let mtime = 0
    try {
      mtime = Number(fs.statSync(path.join(dir, name)).mtimeMs)
    } catch {
      continue
    }
    if (mtime < since) continue
    if (!best || mtime > best.mtime) best = { name, mtime }
  }
  return best ? `sheets/${best.name}` : null
}

/**
 * ジョブの現在フェーズ（SPEC V9 D42）。`publicJob().phase` の実体。
 * @param {object} job ジョブ
 * @returns {'spawning'|'round1_sheet'|'awaiting_review'|'round2_spec'|'spec_ready'|'launched'|'failed'} フェーズ
 */
export function computePhase(job) {
  const status = String(job?.status ?? '').trim()
  if (status === 'failed') return 'failed'
  if (status === 'launched') return 'launched'
  if (status === 'spec_ready') return 'spec_ready'
  if (status === 'awaiting_review') return 'awaiting_review'
  // 一度 Review を通過して回答後に `awaiting_spec` へ戻った = Round 2（SPEC 執筆中）
  if (job?.reviewSeenOnce) return 'round2_spec'
  if (job?.sheetPath) return 'round1_sheet'
  return 'spawning'
}

/**
 * ジョブが停滞しているか（SPEC V9 D42）。
 *
 * Hermes Native は起票後にカンバンタスクが動くので、`running` / `awaiting_spec` のまま
 * `STALLED_AFTER_MS` を超えたら停滞とみなす（`queued` は人が着火待ちなので対象外）。
 *
 * @param {object} job ジョブ
 * @param {number} [at] 現在時刻（ミリ秒）
 * @returns {boolean} 停滞なら true
 */
export function isJobStalled(job, at = Date.now()) {
  const status = String(job?.status ?? '').trim()
  if (!['running', 'awaiting_spec'].includes(status)) return false
  if (String(job?.queueState ?? '').trim() === 'queued') return false
  const since = Number(job?.startedAt ?? job?.createdAt ?? 0)
  if (!Number.isFinite(since) || since <= 0) return false
  const elapsed = Number(at) - since
  return Number.isFinite(elapsed) && elapsed >= STALLED_AFTER_MS
}

/**
 * 保存するジョブの形（機密を持たない。種は先頭 400 字だけ）。
 * @param {object} job 内部ジョブ
 * @param {{at?: number}} [opts] 現在時刻（`stalled` の算出に使う）
 * @returns {object} 公開用
 */
export function publicJob(job, { at = Date.now() } = {}) {
  return {
    id: job.id,
    board: job.board,
    status: job.status,
    stage: job.stage ?? job.status,
    runner: job.runner,
    runnerLabel: runnerLabel(job.runner),
    requestedRunner: job.requestedRunner ?? job.runner ?? null,
    fallbackFrom: job.fallbackFrom ?? null,
    fallbackReason: job.fallbackReason ?? null,
    taskId: job.taskId ?? null,
    taskStatus: job.taskStatus ?? null,
    queueState: job.queueState ?? queueStateOf(job.taskStatus),
    executionPolicy: normalizeExecutionPolicy(job.executionPolicy),
    dismissed: Boolean(job.dismissed),
    reviewTaskId: job.reviewTaskId ?? null,
    reviewTitle: job.reviewTitle ?? null,
    reviewBoard: job.reviewBoard ?? null,
    phase: computePhase(job),
    stalled: isJobStalled(job, at),
    sheetPath: job.sheetPath ?? null,
    autoStart: Boolean(job.autoStart),
    seed: String(job.seedText ?? '').slice(0, 400),
    lang: job.lang,
    chat: job.chat ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    spec: job.spec ?? null,
    completedSpec: job.completedSpec ?? null,
    launched: job.launched ?? null,
    error: job.error ?? null,
  }
}

/**
 * 破棄済みレコードを読み取る（旧配列 / `{ ids }` / `{ ids, seeds }` を透過互換・D105）。
 * @param {unknown} raw `JSON.parse` 済みデータ
 * @returns {{ids: Set<string>, seeds: Set<string>}} ID と種ハッシュの集合
 */
export function parseDismissedData(raw) {
  const idList = Array.isArray(raw) ? raw : Array.isArray(raw?.ids) ? raw.ids : []
  const seedList = Array.isArray(raw?.seeds) ? raw.seeds : []
  return {
    ids: new Set(idList.map((v) => String(v ?? '').trim()).filter(Boolean)),
    seeds: new Set(seedList.map((v) => String(v ?? '').trim()).filter(Boolean)),
  }
}

/**
 * 破棄済みセットを上限 `max` で切って永続化 JSON 形へ整形する（D105）。
 * @param {Set<string>} ids
 * @param {Set<string>} seeds
 * @param {number} max
 * @returns {{ids: string[], seeds: string[]}}
 */
export function formatDismissedData(ids, seeds, max = DISMISSED_MAX) {
  return {
    ids: [...ids].slice(-max),
    seeds: [...seeds].slice(-max),
  }
}
