import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { ApiError } from './api-errors.js'

/**
 * カンバン（SQLite）の読み取りと、実行中タスクの中断。
 *
 * 読み取りは**読み取り専用**で開く（WAL なので運用中の読み取りは安全）。
 * 中断は正規コマンド `hermes kanban reclaim` → `block` を使う（生の kill はしない）。
 *
 * @param {object} cfg 設定
 * @returns {object} カンバン操作
 */
export function createKanban(cfg) {
  const boardsRoot = path.join(cfg.kanbanRoot, 'boards')
  const defaultDb = cfg.kanbanDb

  /**
   * ボード一覧（board.json + 件数）。
   * @returns {Array<{slug: string, name: string, icon?: string, archived: boolean, workdir?: string, counts: Record<string, number>}>} 一覧
   */
  function boards() {
    let dirs = []
    try {
      dirs = fs.readdirSync(boardsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
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
      db = new DatabaseSync(dbPath, { readOnly: true })
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
   * @param {string} slug ボード
   * @param {{limit?: number, statuses?: string[]}} [opts] オプション
   * @returns {Array<object>} タスク
   */
  function tasks(slug, opts = {}) {
    const limit = Math.min(Number(opts.limit ?? 60), 200)
    const db = new DatabaseSync(dbFor(slug), { readOnly: true })
    try {
      const rows = db
        .prepare(
          `SELECT id, title, status, priority, assignee, created_at, started_at, completed_at,
                  workspace_path, branch_name, worker_pid, last_heartbeat_at, result,
                  consecutive_failures, session_id, current_step_key
             FROM tasks
            ORDER BY COALESCE(completed_at, started_at, created_at) DESC
            LIMIT ?`,
        )
        .all(limit)
      return rows.map((r) => ({
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
      }))
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
    const db = new DatabaseSync(dbFor(slug), { readOnly: true })
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
        `SELECT id, status, started_at, ended_at, exit_code FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 10`,
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
   * 実行中タスクを中断する（reclaim で worker を終了 → block で再実行を止める）。
   * @param {string} slug ボード
   * @param {string} id タスク ID
   * @param {string} reason 理由（監査・イベントに残る）
   * @returns {Promise<{ok: boolean, reclaimed: boolean, blocked: boolean, output: string}>} 結果
   */
  async function abort(slug, id, reason = 'mobile kill switch') {
    const detail = task(slug, id)
    if (detail.status !== 'running' && !detail.workerPid) {
      throw new ApiError('TASK_STATE_LOCKED', { status: detail.status }, 409)
    }
    const reclaim = await runKanban(slug, ['reclaim', id, '--reason', reason])
    const block = await runKanban(slug, ['block', id, `モバイルから中断: ${reason}`, '--kind', 'needs_input'])
    return {
      ok: reclaim.code === 0,
      reclaimed: reclaim.code === 0,
      blocked: block.code === 0,
      workerPid: detail.workerPid,
      output: `${reclaim.out}\n${block.out}`.trim().slice(0, 800),
    }
  }

  /** `hermes kanban` を実行する（シェルを介さない）。 */
  function runKanban(slug, args) {
    return new Promise((resolve) => {
      execFile(
        'hermes',
        ['--board', slug, 'kanban', ...args],
        { timeout: 30000, maxBuffer: 1_000_000, env: { ...process.env } },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })
        },
      )
    })
  }

  function safeAll(db, sql, arg) {
    try {
      return db.prepare(sql).all(arg)
    } catch {
      return []
    }
  }

  function safeJson(v) {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }

  return { boards, tasks, task, abort }
}
