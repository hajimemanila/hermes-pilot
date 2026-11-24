import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApiError } from './api-errors.js'
import { outcomeOf, outputOf, runHermes } from './lib/cli.js'
import { safeList } from './lib/safe.js'

/**
 * タスク本文から紐づく SPEC パス（`Spec: <rel>` または先頭 5 行内の `SPEC*.md`）を読む。
 * @param {unknown} body タスク本文
 * @returns {string|null} 正規化した SPEC 相対パス
 */
export function extractSpecFromBody(body) {
  const text = String(body ?? '')
  if (!text) return null
  const m = /^Spec:\s*(.+?)\s*$/m.exec(text)
  let raw = m ? m[1].trim() : ''
  if (!raw) {
    const head = text.split(/\r?\n/).slice(0, 5).join('\n')
    const legacy = /(?:docs\/)?SPEC[A-Za-z0-9._-]*\.md/i.exec(head)
    if (legacy) raw = legacy[0]
  }
  if (!raw) return null
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/**
 * カンバン（SQLite）の読み取りと、実行中タスクの中断。
 *
 * 読み取りは**読み取り専用**で開く（WAL なので運用中の読み取りは安全）。
 * 中断は正規コマンド `hermes kanban reclaim` → `block` を使う（生の kill はしない）。
 *
 * @param {object} cfg 設定
 * @param {{runKanban?: Function}} [deps] 差し替え（テスト用）
 * @returns {object} カンバン操作
 */
export function createKanban(cfg, deps = {}) {
  const boardsRoot = path.join(cfg.kanbanRoot, 'boards')
  const defaultDb = cfg.kanbanDb
  const runKanbanImpl = async (slug, args) => outcomeOf(await (deps.runKanban ?? cfg.runKanban ?? runKanban)(slug, args))

  /**
   * ボード一覧（board.json + 件数）。
   * @returns {Array<{slug: string, name: string, icon?: string, archived: boolean, workdir?: string, counts: Record<string, number>}>} 一覧
   */
  function boards() {
    if (!fs.existsSync(boardsRoot)) return []
    const dirs = safeList('kanban.boards', () =>
      fs.readdirSync(boardsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
    )
    if (!dirs.length) return []
    let current = ''
    try {
      current = fs.readFileSync(path.join(cfg.kanbanRoot, 'current'), 'utf8').trim()
    } catch {
      current = ''
    }
    const out = []
    for (const slug of dirs) {
      const dir = path.join(boardsRoot, slug)
      let meta = {}
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'))
      } catch {
        meta = { slug, name: slug }
      }
      const db = path.join(dir, 'kanban.db')
      let counts = {}
      let lastActivityAt = null
      if (fs.existsSync(db)) {
        const info = countsFor(db)
        counts = info.counts
        lastActivityAt = info.lastActivityAt
      }
      out.push({
        slug,
        name: meta.name ?? slug,
        icon: meta.icon ?? '📋',
        archived: Boolean(meta.archived),
        workdir: meta.default_workdir ?? null,
        current: slug === current,
        counts,
        lastActivityAt,
      })
    }
    // 並び順: アーカイブでない → **最終活動が新しい順** → 実行中 → 現在のボード → 名前
    // 「current」を先頭に固定すると並び順の規則が見えなくなるので、同着時の優先に留める
    return out.sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        Number(b.lastActivityAt ?? 0) - Number(a.lastActivityAt ?? 0) ||
        Number(b.counts?.running ?? 0) - Number(a.counts?.running ?? 0) ||
        Number(b.current) - Number(a.current) ||
        a.name.localeCompare(b.name),
    )
  }

  /**
   * ステータス別件数と最終活動時刻。
   * 最終活動は tasks の completed_at / started_at / created_at の最大（epoch 秒）。
   */
  function countsFor(dbPath) {
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 })
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all()
      /** @type {Record<string, number>} */
      const counts = {}
      for (const r of rows) counts[String(r.status)] = Number(r.n)
      let lastActivityAt = null
      try {
        const t = db
          .prepare('SELECT MAX(COALESCE(completed_at, started_at, created_at)) AS t FROM tasks')
          .get()
        if (t && t.t != null) lastActivityAt = Number(t.t)
      } catch {
        /* tasks が無い板 */
      }
      return { counts, lastActivityAt }
    } catch {
      return { counts: {}, lastActivityAt: null }
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /** ボードの DB パス（旧: 単一 kanban.db のボードも拾う）。 */
  function dbFor(slug) {
    const p = path.join(boardsRoot, slug, 'kanban.db')
    if (fs.existsSync(p)) return p
    if (fs.existsSync(defaultDb)) return defaultDb
    throw new ApiError('BOARD_NOT_FOUND', { board: slug }, 404)
  }

  /**
   * タスク一覧（更新の新しい順）。
   *
   * `body` は Architect の `findJobReviewTask` が `[review]` の本文を読むために要る
   * （SPEC V7 §3.1①）。重い一覧（PWA のタスク一覧）だけは `withBody: false` で落とせる。
   *
   * **アーカイブは別の LIMIT で引いてから merge する**（D92・SPEC-RELIABILITY-GUARD RG-3）。
   * 1 本の `ORDER BY ... LIMIT 60` に混ぜると、古いアーカイブが新しいタスクを押し出して
   * 「アーカイブ済み (N)」を開いても中身が出ない。表示側（`tasksView.js`）が既定で
   * 隠すので、ここでは落とさない（Launchpad の `specProgress` が `archived` を見るため）。
   *
   * @param {string} slug ボード
   * @param {{limit?: number, archivedLimit?: number, includeArchived?: boolean, withBody?: boolean}} [opts] オプション
   * @returns {Array<object>} タスク
   */
  function tasks(slug, opts = {}) {
    const limit = Math.min(Number(opts.limit ?? 60), 200)
    const archivedLimit = Math.min(Number(opts.archivedLimit ?? 40), 200)
    const includeArchived = opts.includeArchived !== false && archivedLimit > 0
    const withBody = opts.withBody !== false
    const db = new DatabaseSync(dbFor(slug), { readOnly: true, timeout: 3000 })
    try {
      // 古い板の `tasks` に `body` 列が無くても落とさない（無ければ空文字）
      const bodyCol = hasColumn(db, 'tasks', 'body') ? 'body' : "'' AS body"
      const columns = `id, title, ${bodyCol}, status, priority, assignee, created_at, started_at, completed_at,
                  workspace_path, branch_name, worker_pid, last_heartbeat_at, result,
                  consecutive_failures, session_id, current_step_key`
      const order = 'ORDER BY COALESCE(completed_at, started_at, created_at) DESC'
      const openRows = db
        .prepare(`SELECT ${columns} FROM tasks WHERE status <> 'archived' ${order} LIMIT ?`)
        .all(limit)
      const archivedRows = includeArchived
        ? db.prepare(`SELECT ${columns} FROM tasks WHERE status = 'archived' ${order} LIMIT ?`).all(archivedLimit)
        : []
      const rows = [...openRows, ...archivedRows].sort((a, b) => activityOf(b) - activityOf(a))
      return rows.map((r) => {
        const row = {
          id: r.id,
          title: r.title,
          status: r.status,
          priority: Number(r.priority ?? 0),
          assignee: r.assignee,
          createdAt: Number(r.created_at ?? 0) * 1000,
          startedAt: r.started_at ? Number(r.started_at) * 1000 : null,
          completedAt: r.completed_at ? Number(r.completed_at) * 1000 : null,
          workspace: r.workspace_path,
          branch: r.branch_name,
          running: r.status === 'running',
          workerPid: r.worker_pid ?? null,
          elapsedSec: r.started_at ? Math.max(0, Math.round(Date.now() / 1000 - Number(r.started_at))) : null,
          result: r.result ? String(r.result).slice(0, 400) : null,
          failures: Number(r.consecutive_failures ?? 0),
          sessionId: r.session_id ?? null,
          spec: extractSpecFromBody(r.body),
        }
        if (withBody) row.body = r.body == null ? '' : String(r.body)
        return row
      })
    } finally {
      db.close()
    }
  }

  /**
   * ステータス別件数（`archivedCount` の材料）。
   *
   * 一覧の LIMIT と独立に数えるので、アーカイブが 40 件を超えても
   * 「アーカイブ済み (N)」の N は正しい。
   *
   * @param {string} slug ボード
   * @returns {{counts: Record<string, number>, archivedCount: number}} 件数
   */
  function statusCounts(slug) {
    const { counts } = countsFor(dbFor(slug))
    return { counts, archivedCount: Number(counts?.archived ?? 0) }
  }

  /** 一覧の並び替えキー（SQL の `COALESCE(completed_at, started_at, created_at)` と同じ規則）。 */
  function activityOf(r) {
    return Number(r?.completed_at ?? r?.started_at ?? r?.created_at ?? 0)
  }

  /**
   * 実行ワーカーのセッションと、その会話が入っている state.db を引く。
   *
   * `tasks.session_id` は `complete --force` などで空になるので、`task_events` の
   * `owner_admitted` / `worker_bound` / `spawned` の payload も見る。`db` はイベントにしか
   * 残らない（どのプロファイルの state.db か）ため、session_id がタスク行にあっても
   * イベントを読む。
   *
   * @param {import('node:sqlite').DatabaseSync} db ボードの DB（開いているもの）
   * @param {string} id タスク ID
   * @returns {{sessionId: string, db: string|null}|null} 見つからなければ null
   */
  function resolveSessionInfoIn(db, id) {
    let sessionId = null
    try {
      const r = db.prepare('SELECT session_id FROM tasks WHERE id = ?').get(id)
      if (r?.session_id) sessionId = String(r.session_id)
    } catch {
      /* 古い板に session_id 列が無い */
    }
    let dbPath = null
    for (const ev of safeAll(
      db,
      `SELECT payload FROM task_events WHERE task_id = ?
         AND kind IN ('owner_admitted','worker_bound','spawned') ORDER BY id DESC LIMIT 8`,
      id,
    )) {
      const p = safeJson(ev?.payload)
      if (!p || typeof p !== 'object') continue
      if (!sessionId && p.session_id) sessionId = String(p.session_id)
      if (!dbPath && p.db) dbPath = String(p.db)
      if (sessionId && dbPath) break
    }
    return sessionId ? { sessionId, db: dbPath } : null
  }

  /**
   * 実行ワーカーのセッション情報（ボードを指定して引く）。
   * @param {string} slug ボード
   * @param {string} id タスク ID
   * @returns {{sessionId: string, db: string|null}|null} 見つからなければ null
   */
  function taskSession(slug, id) {
    let db
    try {
      db = new DatabaseSync(dbFor(slug), { readOnly: true, timeout: 3000 })
    } catch {
      return null
    }
    try {
      return resolveSessionInfoIn(db, id)
    } finally {
      db.close()
    }
  }

  /**
   * タスク詳細（イベント・実行履歴・コメント付き）。
   * @param {string} slug ボード
   * @param {string} id タスク ID
   * @returns {object} 詳細
   */
  function task(slug, id) {
    const db = new DatabaseSync(dbFor(slug), { readOnly: true, timeout: 3000 })
    try {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      if (!row) throw new ApiError('TASK_NOT_FOUND', { id }, 404)
      const events = safeAll(
        db,
        `SELECT kind, payload, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 40`,
        id,
      ).map((e) => ({
        kind: e.kind,
        at: Number(e.created_at) * 1000,
        payload: safeJson(e.payload),
      }))
      const runs = safeAll(
        db,
        `SELECT id, status, started_at, ended_at FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 10`,
        id,
      ).map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.started_at ? Number(r.started_at) * 1000 : null,
        endedAt: r.ended_at ? Number(r.ended_at) * 1000 : null,
      }))
      const comments = safeAll(
        db,
        `SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 10`,
        id,
      ).map((c) => ({ author: c.author, body: c.body, at: Number(c.created_at) * 1000 }))
      // 実行ワーカーのライブ進捗（`<WorkerFeed>`）は sessionId がある時だけ出す
      const session = resolveSessionInfoIn(db, id)
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        status: row.status,
        assignee: row.assignee,
        priority: Number(row.priority ?? 0),
        workspace: row.workspace_path,
        branch: row.branch_name,
        workerPid: row.worker_pid ?? null,
        sessionId: session?.sessionId ?? null,
        startedAt: row.started_at ? Number(row.started_at) * 1000 : null,
        completedAt: row.completed_at ? Number(row.completed_at) * 1000 : null,
        result: row.result,
        failures: Number(row.consecutive_failures ?? 0),
        events,
        runs,
        comments,
      }
    } finally {
      db.close()
    }
  }

  /**
   * 非アーカイブ全ボードの実行中タスクを列挙する（緊急停止の対象集め）。
   *
   * ボードの `counts.running` は件数しか持たないので、中断対象の `board` / `id` を
   * 得るために板ごとに一覧を読む。1 板が壊れていても他の板は返す（止めることが目的）。
   *
   * @returns {Array<{board: string, id: string, title: string, workerPid: number|null}>} 実行中タスク
   */
  function runningTasks() {
    const out = []
    let list = []
    try {
      list = boards().filter((b) => b && !b.archived)
    } catch {
      list = []
    }
    for (const b of list) {
      let rows = []
      try {
        rows = tasks(b.slug, { limit: 200, withBody: false })
      } catch {
        rows = []
      }
      for (const t of rows) {
        if (t?.status !== 'running') continue
        out.push({ board: b.slug, id: t.id, title: t.title, workerPid: t.workerPid ?? null })
      }
    }
    return out
  }

  /**
   * 実行中タスクを中断する（reclaim で worker を終了 → block で再実行を止める）。
   * @param {string} slug ボード
   * @param {string} id タスク ID
   * @param {string} reason 理由（監査・イベントに残る）
   * @returns {Promise<{ok: boolean, reclaimed: boolean, blocked: boolean, output: string}>} 結果
   */
  async function abort(slug, id, reason = 'mobile kill switch', lang = 'en') {
    const detail = task(slug, id)
    if (detail.status !== 'running' && !detail.workerPid) {
      throw new ApiError('TASK_STATE_LOCKED', { status: detail.status }, 409)
    }
    const reclaim = await runKanbanImpl(slug, ['reclaim', id, '--reason', reason])
    if (reclaim.code !== 0) {
      return {
        ok: false,
        reclaimed: false,
        blocked: false,
        workerPid: detail.workerPid,
        output: outputOf(reclaim).slice(0, 800),
      }
    }
    const note = lang === 'ja' ? `モバイルから中断: ${reason}` : `Interrupted from mobile: ${reason}`
    const block = await runKanbanImpl(slug, ['block', id, note, '--kind', 'needs_input'])
    return {
      ok: block.code === 0,
      reclaimed: true,
      blocked: block.code === 0,
      workerPid: detail.workerPid,
      output: `${outputOf(reclaim)}\n${outputOf(block)}`.trim().slice(0, 800),
    }
  }

  /** `hermes kanban --board <slug> ...` を実行する（戻り値は `lib/cli.js` の統一形）。 */
  function runKanban(slug, args) {
    return runHermes(['kanban', '--board', slug, ...args], {
      bin: cfg.hermesBin,
      timeoutMs: 30_000,
      maxBuffer: 1_000_000,
    })
  }

  function safeAll(db, sql, arg) {
    return safeList('kanban.safeAll', () => db.prepare(sql).all(arg))
  }

  /**
   * テーブルに列があるか（板のスキーマ版差を吸収する）。
   * @param {import('node:sqlite').DatabaseSync} db DB
   * @param {string} table テーブル名
   * @param {string} column 列名
   * @returns {boolean} あれば true
   */
  function hasColumn(db, table, column) {
    try {
      return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => String(c?.name ?? '') === column)
    } catch {
      return false
    }
  }

  function safeJson(v) {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }

  return { boards, tasks, task, taskSession, abort, runningTasks, statusCounts }
}
