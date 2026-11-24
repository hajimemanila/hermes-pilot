import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseReviewLine } from './review.js'
import { writeJsonAtomic } from './lib/atomic.js'
import { safeList } from './lib/safe.js'
import { LEGACY_REVIEW_LIKE } from './review/legacy-tags.js'

/**
 * ブリッジ内蔵のレビュー完了ウォッチャー（D7 / SPEC §4.3）。
 *
 * 旧名の外部 cron ウォッチャーを置き換える。カンバン DB を **読み取り専用**で
 * 10 秒ごとに見て、`[review]` タスクの `done` 遷移と `running → blocked` 遷移を
 * `review/feed.jsonl` と `review/chat-reports.jsonl` に 1 行ずつ追記する。
 *
 * 大事な性質:
 *  - **初回起動はベースライン確立のみ**（既存の done / blocked を通知しない。通知スパム防止）
 *  - **冪等**: 状態は `watcher-state.json` に持ち、`reportedDoneAt` / `reportedBlockedAt` が
 *    入っている遷移は二度書かない。`done` から離れたら印を消し、再度 done になったら 1 回だけ書く
 *  - **アトミック**: 状態ファイルは `lib/atomic.js`（tmp → rename）。JSONL は 1 行完結 append
 *
 * @param {object} cfg ブリッジ設定（kanbanRoot / pluginDataDir）
 * @param {{review?: object, intervalMs?: number, dbPaths?: string[], now?: () => number, logger?: object}} [opts]
 */

/** 1 行の末尾改行を保証して追記する（JSONL が途中で連結しないように）。 */
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let prefix = ''
  try {
    const st = fs.statSync(file)
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(1)
      fs.readSync(fd, buf, 0, 1, st.size - 1)
      fs.closeSync(fd)
      if (buf.toString() !== '\n') prefix = '\n'
    }
  } catch {
    /* 無ければそのまま作る */
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(obj)}\n`)
}

/** 結果の 1 行要約（長すぎる result は切る）。 */
function oneLine(text, max = 180) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function createReviewWatcher(cfg, opts = {}) {
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || 10_000)
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const log = opts.logger ?? console
  const root = cfg.reviewDir ?? path.join(cfg.pluginDataDir ?? path.join(cfg.kanbanRoot, '..', 'plugin-data', 'hermes-pilot'), 'review')
  const statePath = path.join(root, 'watcher-state.json')
  const feedPath = path.join(root, 'feed.jsonl')
  const reportsPath = path.join(root, 'chat-reports.jsonl')

  let timer = null
  let running = false
  let ticks = 0
  let lastError = null

  /** 状態を読む（無ければ null = 初回起動）。壊れていても null 扱い（ベースラインからやり直す）。 */
  function readState() {
    try {
      const j = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (!j || typeof j !== 'object' || typeof j.tasks !== 'object' || Array.isArray(j.tasks)) return null
      return j
    } catch {
      return null
    }
  }

  /** 状態を書く（`lib/atomic.js` が tmp → rename を持つ）。 */
  function writeState(state) {
    writeJsonAtomic(statePath, state)
  }

  /** 監視対象の DB。ボードごとの `kanban.db`（＋ルートの `kanban.db` があれば）。 */
  function dbPaths() {
    if (Array.isArray(opts.dbPaths)) return opts.dbPaths
    const out = []
    const boardsDir = path.join(cfg.kanbanRoot, 'boards')
    try {
      for (const e of fs.readdirSync(boardsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = path.join(boardsDir, e.name, 'kanban.db')
        if (fs.existsSync(p)) out.push({ board: e.name, path: p })
      }
    } catch {
      /* boards が無い環境では何もしない */
    }
    const rootDb = path.join(cfg.kanbanRoot, 'kanban.db')
    if (fs.existsSync(rootDb)) out.push({ board: null, path: rootDb })
    return out
  }

  /** 1 つの DB からレビュータスクを読む（読み取り専用・失敗は warn + 空）。 */
  function readTasks(dbPath) {
    const db = safeList('reviewWatcher.openDb', () => new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 }), null)
    if (!db) return []
    try {
      const hasTasks = safeList('reviewWatcher.hasTasks', () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()), false)
      if (!hasTasks) return []
      return safeList('reviewWatcher.readTasks', () =>
        db
          .prepare(
            `SELECT id, title, body, status, result, completed_at, session_id
               FROM tasks
              WHERE COALESCE(body, '') LIKE '%[review]%' OR COALESCE(body, '') LIKE '${LEGACY_REVIEW_LIKE}'
              ORDER BY COALESCE(completed_at, created_at) DESC
              LIMIT 500`,
          )
          .all(),
      )
    } finally {
      try { db.close() } catch { /* noop */ }
    }
  }

  /** 宛先の会話 ID（本文の `chat=` → `task-chats.json`）。 */
  function sessionFor(task, review) {
    const line = parseReviewLine(task.body)
    const fromBody = String(line?.chat ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
    if (fromBody) return fromBody
    if (review && typeof review.chatFor === 'function') {
      const c = review.chatFor(task.id)
      if (c) return c
    }
    return null
  }

  /**
   * 1 ティック分の走査。テストから直接呼べる。
   * @returns {{baseline: boolean, seen: number, reported: Array<object>}}
   */
  function tick() {
    ticks += 1
    const stored = readState()
    const baseline = stored === null
    const state = stored ?? { version: 1, tasks: {}, updatedAt: new Date(now()).toISOString() }
    const reported = []
    let seen = 0
    let dirty = baseline

    const dbs = dbPaths()
    const live = new Set()
    for (const { board, path: dbPath } of dbs) {
      for (const task of readTasks(dbPath)) {
        const line = parseReviewLine(task.body)
        if (!line) continue // `[review]` 行が無い（本文の言及だけ）ものはレビューではない
        seen += 1
        const id = String(task.id)
        live.add(id)
        const status = String(task.status ?? '')
        const prev = state.tasks[id]
        const at = new Date(now()).toISOString()
        const label = line.label ?? null

        if (!prev) {
          // 初回 or 新しいタスク。どちらも「今の状態」を覚えるだけで通知しない（遡って通知しない）
          state.tasks[id] = { board, status, updatedAt: at, reportedDoneAt: null, reportedBlockedAt: null }
          dirty = true
          continue
        }

        if (prev.status === status) {
          if (prev.board !== board) {
            prev.board = board ?? null
            dirty = true
          }
          continue
        }

        const prevStatus = String(prev.status ?? '')
        prev.status = status
        prev.updatedAt = at
        prev.board = board ?? null
        dirty = true

        if (status === 'done' && !prev.reportedDoneAt) {
          const text = `✅ ${oneLine(task.title)} (${id})`
          appendJsonl(feedPath, { at, task_id: id, kind: 'done', label, text })
          const sessionId = sessionFor(task, opts.review)
          if (sessionId) {
            const summary = oneLine(task.result) || oneLine(task.title)
            appendJsonl(reportsPath, { at, session_id: sessionId, task_id: id, label, text: summary })
          }
          prev.reportedDoneAt = at
          reported.push({ kind: 'done', taskId: id, label, sessionId })
        } else if (status === 'blocked' && prevStatus === 'running' && !prev.reportedBlockedAt) {
          const text = `⏸ ${oneLine(task.title)} (${id})`
          appendJsonl(feedPath, { at, task_id: id, kind: 'blocked', label, text })
          prev.reportedBlockedAt = at
          reported.push({ kind: 'blocked', taskId: id, label })
        }

        // done から離れたら印を消す（再度 done になったら 1 回だけ通知する）
        if (status !== 'done') prev.reportedDoneAt = null
        if (status !== 'blocked') prev.reportedBlockedAt = null
      }
    }

    // 消えたタスクは状態から落とす（ボードを消した・アーカイブした等）。印だけ残すと育つため。
    for (const id of Object.keys(state.tasks)) {
      if (!live.has(id)) {
        delete state.tasks[id]
        dirty = true
      }
    }

    if (dirty) {
      state.updatedAt = new Date(now()).toISOString()
      writeState(state)
    }
    return { baseline, seen, reported }
  }

  /** 例外でプロセスを落とさないティック（定期実行用）。 */
  function safeTick() {
    if (running) return null
    running = true
    try {
      const r = tick()
      lastError = null
      return r
    } catch (err) {
      lastError = String(err?.message ?? err)
      log.warn?.(`[review-watcher] ${lastError}`)
      return null
    } finally {
      running = false
    }
  }

  /** 監視を始める（初回は即ティック＝ベースライン確立）。 */
  function start() {
    if (timer) return
    safeTick()
    timer = setInterval(safeTick, intervalMs)
    // ブリッジの停止を妨げない（テストや CLI が終われなくなるため）
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return {
    intervalMs,
    statePath,
    feedPath,
    reportsPath,
    tick,
    start,
    stop,
    status: () => ({ running: Boolean(timer), ticks, lastError, statePath }),
  }
}
