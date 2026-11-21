/**
 * `pipeline-runs.json`（起票ランの記録）の読み書き。`specs.js` から分割。
 * 公開契約は `specs.js` の再エクスポートで維持する（呼び出し側の import は変えない）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSpecRelPath } from './task-body.js'

/** `pipeline-runs.json` に保持するランの上限（古い完了分から剪定する）。 */
export const RUNS_MAX = 50
/**
 * `pipeline-runs.json` のパス（レビューディレクトリ配下。`review-watcher` と同じ解決規則）。
 *
 * @param {object} cfg ブリッジ設定（`reviewDir` / `pluginDataDir` / `kanbanRoot`）
 * @returns {string} 絶対パス
 */
export function runsPathFor(cfg = {}) {
  const root =
    cfg.reviewDir ??
    path.join(
      cfg.pluginDataDir ?? path.join(cfg.kanbanRoot ?? '.', '..', 'plugin-data', 'hermes-pilot'),
      'review',
    )
  return path.join(root, 'pipeline-runs.json')
}

/**
 * ラン記録を読む（壊れていても空。補助情報なので落とさない）。
 *
 * @param {string} file パス
 * @returns {Array<object>} ラン（新しい順は保証しない）
 */
export function readRuns(file) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const j = JSON.parse(raw)
    const list = Array.isArray(j) ? j : j?.runs
    if (!Array.isArray(list)) return []
    return list.filter((r) => r && typeof r === 'object' && String(r.id ?? '').trim())
  } catch {
    return []
  }
}

/**
 * `pipeline-runs.json` のランから、対象 SPEC に紐づく `taskIds` を集める（D91 の第 1 優先）。
 *
 * @param {Array<object>} runs ラン記録（`specRelPath` / `taskIds`）
 * @param {string|null} specRelPath 対象 SPEC 相対パス
 * @returns {string[]} タスク ID（重複なし）
 */
export function runTaskIdsForSpec(runs, specRelPath) {
  const want = normalizeSpecRelPath(specRelPath)
  if (!want) return []
  const out = new Set()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run) continue
    if (normalizeSpecRelPath(run.specRelPath ?? run.spec) !== want) continue
    for (const id of Array.isArray(run.taskIds) ? run.taskIds : []) {
      const v = String(id ?? '').trim()
      if (v) out.add(v)
    }
  }
  return [...out]
}

/**
 * SPEC 一覧の各要素へ `runTaskIds` を添付する（`GET /api/specs` の応答契約）。
 *
 * @param {Array<{path: string}>} specs `listSpecs()` の結果
 * @param {Array<object>} runs `readRuns()` の結果
 * @returns {Array<object>} `runTaskIds` 付きの SPEC 一覧
 */
export function attachRunTaskIds(specs, runs) {
  const list = Array.isArray(specs) ? specs : []
  const records = Array.isArray(runs) ? runs : []
  return list.map((spec) => ({ ...spec, runTaskIds: records.length ? runTaskIdsForSpec(records, spec?.path) : [] }))
}

/**
 * 上限まで剪定する（**古い完了分から**落とす。未報告ランは最後まで残す）。
 *
 * @param {Array<object>} runs ラン
 * @param {number} [max] 上限（既定 50）
 * @returns {Array<object>} 剪定後（元の順序を保つ）
 */
export function pruneRuns(runs, max = RUNS_MAX) {
  const list = Array.isArray(runs) ? runs.slice() : []
  let over = list.length - Math.max(0, Number(max) || 0)
  if (over <= 0) return list
  const byAge = list.slice().sort((a, b) => Number(a?.createdAt ?? 0) - Number(b?.createdAt ?? 0))
  const drop = new Set()
  for (const r of byAge) {
    if (over <= 0) break
    if (!r?.reportedAt) continue
    drop.add(r)
    over -= 1
  }
  for (const r of byAge) {
    if (over <= 0) break
    if (drop.has(r)) continue
    drop.add(r)
    over -= 1
  }
  return list.filter((r) => !drop.has(r))
}

/**
 * ラン記録を `.tmp` → `renameSync` でアトミックに書く。
 *
 * @param {string} file パス
 * @param {Array<object>} runs ラン
 * @returns {void}
 */
export function writeRuns(file, runs) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: pruneRuns(runs) }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * ランを 1 件追記する（同じ ID は置き換え）。
 *
 * @param {object} cfg ブリッジ設定
 * @param {object} run ラン
 * @returns {Array<object>} 書いた内容
 */
export function appendRun(cfg, run) {
  const file = runsPathFor(cfg)
  const runs = readRuns(file)
  const next = [...runs.filter((r) => r.id !== run.id), run]
  writeRuns(file, next)
  return pruneRuns(next)
}

/**
 * ランの ID（`run_<UTC 秒>_<乱数 4>`）。同じ秒に 2 回落としても衝突しない。
 * @param {number} [ms] epoch ms
 * @returns {string} ID
 */
export function makeRunId(ms = Date.now()) {
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const tail = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `run_${stamp}_${tail}`
}
