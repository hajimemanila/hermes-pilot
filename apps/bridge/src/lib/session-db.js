/**
 * セッション DB（`state.db`）の読み取り（D110 / DRF-5）。
 *
 * `pipeline-watcher` はパイプライン完了報告の宛先を決めるために、ボードの作業
 * ディレクトリと cwd が一致する最新セッションを `state.db` から引く。これは
 * **盤面（`kanban.db`）の走査ではない**ので、盤面ティック（`board-tick.js`）には
 * 混ぜない。ただし `new DatabaseSync(` をウォッチャーに残すと
 * `check:coherence` の `board-tick-owner` が「盤面を直接読んでいる」と区別できない。
 * そこで読み取りだけをこの 1 モジュールへ出し、ウォッチャーは関数を呼ぶだけにする。
 *
 * 読み取り専用（D55 の精神）。`state.db` への書き込みは一切しない。
 */

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * パス比較用に正規化する（末尾の `/` を落とし、絶対パス化する）。
 *
 * 旧 `pipeline-watcher.js` の `normalizePath` をそのまま移した（挙動を変えない）。
 *
 * @param {unknown} p パス
 * @returns {string} 正規化後（空なら空文字）
 */
export function normalizePath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  return path.resolve(s).replace(/[\\/]+$/, '') || '/'
}

/**
 * `state.db` から cwd 一致の最新通常セッション `{ id, at }` を 1 件返す。
 *
 * `id NOT LIKE 'local-%'` で headless な worker セッションを除く（会話に紐づくのは
 * UI 側のセッションだけ・D20②）。読めない DB・列の無い DB は `null`。
 *
 * @param {string} dbPath `state.db` のパス
 * @param {string|null} workdir ボードの作業ディレクトリ
 * @returns {{id: string, at: number}|null} セッション
 */
export function latestSessionForCwd(dbPath, workdir) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 })
  } catch {
    return null
  }
  const want = normalizePath(workdir)
  try {
    const sql = (order) =>
      `SELECT id, cwd, ${order} AS ts FROM sessions
        WHERE cwd IS NOT NULL AND id NOT LIKE 'local-%'
        ORDER BY ${order} DESC LIMIT 300`
    let rows = []
    try {
      rows = db.prepare(sql('COALESCE(last_activity_at, started_at)')).all()
    } catch {
      rows = db.prepare(sql('started_at')).all()
    }
    for (const r of rows) {
      if (normalizePath(r.cwd) === want) {
        return { id: String(r.id), at: Number(r.ts) || 0 }
      }
    }
    return null
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      /* noop */
    }
  }
}
