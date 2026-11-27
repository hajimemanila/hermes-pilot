/**
 * 盤面ティック（D110 / SPEC-COHERENCE-RESIDUAL-DRIFT §4 DRF-5）。
 *
 * これまで `review-watcher` と `pipeline-watcher` が **それぞれ** 10 秒ごとに
 * `kanban.db` を開き、それぞれの列だけを読んでいた。同じ DB を 2 回読み、
 * 同じ遷移を 2 通りの状態管理で判定していたため、完走報告とレビュー完了報告が
 * 「同じ根拠」を見ている保証が無かった。
 *
 * このモジュールはその走査を 1 本にまとめる:
 *
 *  - **1 回の走査で 1 回だけ読む**: ボード DB を `readOnly` で開き（D55）、
 *    `BOARD_ROW_COLUMNS` の全列を 1 クエリで読む。review の `[review]` 判定も
 *    pipeline のグループ判定も、同じ行の同じ列を見る。
 *  - **差分つき**: 前回のスナップショットと比べた `changes`（`kind: 'new' | 'status'`）を
 *    同じオブジェクトに載せる。2 購読者は同じ `changes` を受け取るので、
 *    `running → blocked` の解釈がずれない。
 *  - **タイマーはここ 1 本**: `start()` は 1 回だけ呼ぶ（`server.js`）。
 *    ウォッチャーは `subscribe()` で受け取るだけで、自前のタイマーも DB も持たない
 *    （`check:coherence` の `board-tick-owner` が戻すと RED にする）。
 *  - **`state.db` は対象外**: セッション DB の走査は `lib/session-db.js` のまま
 *    （ティックの周期に混ぜない）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { safeList } from './lib/safe.js'

/**
 * スナップショットの行が必ず持つ列。
 *
 * review 側が必要とする列（`body` の `[review]` 行、`status`、`result`、
 * `completed_at`、`session_id`）と pipeline 側が必要とする列（`body` の
 * `Spec:` 行、`status`、`created_at` / `started_at` / `completed_at`、
 * `session_id`）の和集合。片方だけの列を増やすと、同じ行で判定できなくなる。
 */
export const BOARD_ROW_COLUMNS = Object.freeze([
  'id',
  'title',
  'body',
  'status',
  'result',
  'created_at',
  'started_at',
  'completed_at',
  'session_id',
])

/** 1 DB から読む行数（review は 500、pipeline は 300 だった → 広い方に揃える）。 */
const BOARD_ROW_LIMIT = 500

/** 盤面走査の既定周期（変えない・SPEC 非対象）。 */
const BOARD_TICK_INTERVAL_MS = 10_000

/** アーカイブ済みはどちらの購読者も通知・集計に使わない（読む前に落とす）。 */
const ARCHIVED = 'archived'

/**
 * 監視対象の DB。ボードごとの `kanban.db`（＋ルートの `kanban.db` があれば）。
 *
 * 以前は 2 つのウォッチャーが同じ関数を写経していた。注入（テスト）は
 * `opts.dbPaths` で受け取るが、その口はここ 1 か所だけ。
 *
 * @param {object} [cfg] ブリッジ設定（`kanbanRoot`）
 * @param {Array<{board: string|null, path: string}>} [injected] テスト用の固定リスト
 * @returns {Array<{board: string|null, path: string}>} 読み取り対象
 */
export function boardDbPaths(cfg = {}, injected = null) {
  if (Array.isArray(injected)) return injected
  const root = String(cfg.kanbanRoot ?? '.')
  const out = []
  const boardsDir = path.join(root, 'boards')
  try {
    const entries = fs
      .readdirSync(boardsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    for (const name of entries) {
      const p = path.join(boardsDir, name, 'kanban.db')
      if (fs.existsSync(p)) out.push({ board: name, path: p })
    }
  } catch {
    /* boards が無い環境では何もしない */
  }
  const rootDb = path.join(root, 'kanban.db')
  if (fs.existsSync(rootDb)) out.push({ board: null, path: rootDb })
  return out
}

/**
 * 盤面ティックを作る。
 *
 * @param {object} [cfg] ブリッジ設定（`kanbanRoot`）
 * @param {{
 *   intervalMs?: number,
 *   dbPaths?: Array<{board: string|null, path: string}>,
 *   now?: () => number,
 *   logger?: object,
 * }} [opts] 差し替え（テスト用）
 * @returns {{
 *   intervalMs: number,
 *   tick: () => object,
 *   run: () => Promise<object|null>,
 *   latest: () => object|null,
 *   subscribe: (fn: (snapshot: object) => unknown) => () => void,
 *   start: () => void,
 *   stop: () => void,
 *   status: () => object,
 * }} ティック
 */
export function createBoardTick(cfg = {}, opts = {}) {
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || BOARD_TICK_INTERVAL_MS)
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const log = opts.logger ?? console

  /** 購読者（review / pipeline）。 */
  const listeners = new Set()
  /** 前回の `board:id` → status（差分の基準）。 */
  let previous = new Map()
  /** 最後のスナップショット。 */
  let last = null
  /** 直近ティックの購読者の戻り値（async の完了待ちに使う）。 */
  let pending = []
  let timer = null
  let busy = false
  let ticks = 0
  let lastError = null

  /** 1 つの DB から `BOARD_ROW_COLUMNS` を読む（読み取り専用・失敗は warn + 空）。 */
  function readRows(dbPath) {
    const db = safeList(
      'boardTick.openDb',
      () => new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 }),
      null,
    )
    if (!db) return []
    try {
      const hasTasks = safeList(
        'boardTick.hasTasks',
        () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()),
        false,
      )
      if (!hasTasks) return []
      return safeList('boardTick.readRows', () =>
        db
          .prepare(
            `SELECT ${BOARD_ROW_COLUMNS.join(', ')} FROM tasks
              WHERE COALESCE(status, '') != '${ARCHIVED}'
              ORDER BY COALESCE(completed_at, created_at) DESC
              LIMIT ${BOARD_ROW_LIMIT}`,
          )
          .all(),
      )
    } finally {
      try {
        db.close()
      } catch {
        /* noop */
      }
    }
  }

  /** 全 DB の行を 1 本の配列にする（同じ ID は最初の 1 件・`board` を付ける）。 */
  function readAll(dbs) {
    const out = []
    const seen = new Set()
    for (const { board, path: dbPath } of dbs) {
      for (const row of readRows(dbPath)) {
        const id = String(row?.id ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push({ ...row, id, board: board ?? 'default' })
      }
    }
    return out
  }

  /**
   * 1 ティック分の走査（同期）。テストからも直接呼べる。
   *
   * @returns {object} スナップショット（`at` / `rows` / `changes` / `boards`）
   */
  function tick() {
    ticks += 1
    const at = new Date(now()).toISOString()
    const dbs = boardDbPaths(cfg, opts.dbPaths)
    const rows = readAll(dbs)
    const next = new Map()
    const changes = []
    for (const row of rows) {
      const key = `${row.board}:${row.id}`
      const status = String(row.status ?? '')
      next.set(key, status)
      if (!previous.has(key)) {
        changes.push({ id: row.id, board: row.board, kind: 'new', from: null, to: status })
      } else if (previous.get(key) !== status) {
        changes.push({ id: row.id, board: row.board, kind: 'status', from: previous.get(key), to: status })
      }
    }
    previous = next
    const snapshot = {
      at,
      tick: ticks,
      boards: [...new Set(dbs.map((d) => d.board ?? 'default'))],
      rows,
      changes,
    }
    last = snapshot
    lastError = null
    // 購読者へ同じスナップショット（同じ changes）を配る。1 本が落ちても他は止めない。
    const inFlight = []
    for (const fn of [...listeners]) {
      try {
        const ret = fn(snapshot)
        if (ret && typeof ret.then === 'function') inFlight.push(ret)
      } catch (err) {
        lastError = String(err?.message ?? err)
        log.warn?.(`[board-tick] subscriber failed: ${lastError}`)
      }
    }
    pending = inFlight
    return snapshot
  }

  /**
   * 1 走査して、購読者の async 処理まで待つ（`nudgeWatchers` 用）。
   *
   * @returns {Promise<object|null>} スナップショット
   */
  async function run() {
    if (busy) return last
    busy = true
    try {
      const snapshot = tick()
      const inFlight = pending
      pending = []
      await Promise.allSettled(inFlight)
      return snapshot
    } finally {
      busy = false
    }
  }

  /**
   * 購読する（`review` / `pipeline` の 2 本だけ）。
   *
   * 最新スナップショットは replay しない（購読前の遷移を二重に通知しないため）。
   * ベースラインは購読者が `latest()` から自分の状態で確立する。
   *
   * @param {(snapshot: object) => unknown} fn 購読者
   * @returns {() => void} 解除関数
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }

  /** 走査を始める（初回は即走査）。呼ぶのは `server.js` から 1 回だけ。 */
  function start() {
    if (timer) return
    void run().catch((err) => {
      log.warn?.(`[board-tick] ${err?.message ?? err}`)
    })
    timer = setInterval(() => {
      void run().catch((err) => {
        log.warn?.(`[board-tick] ${err?.message ?? err}`)
      })
    }, intervalMs)
    // ブリッジの停止を妨げない（テストや CLI が終われなくなるため）
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 走査を止める。 */
  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return {
    intervalMs,
    tick,
    run,
    latest: () => last,
    subscribe,
    start,
    stop,
    status: () => ({
      running: Boolean(timer),
      ticks,
      subscribers: listeners.size,
      lastError,
    }),
  }
}
