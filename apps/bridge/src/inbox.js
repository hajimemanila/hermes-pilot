import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'

/**
 * 承認待ちインボックス。
 *
 * ボード横断で `status='blocked'` のタスクを集め、**エージェントからの質問を読んで
 * コメントで答える**だけの画面を作る。ステータスは変えない（再開は Discord / ダッシュボード）。
 *
 * 読み取りは SQLite を readOnly、書き込み（コメント）は `hermes kanban comment` を CLI で実行する。
 */

const TEXT_MAX = 2000

/**
 * コメント本文を検証する。
 * @param {unknown} raw 入力
 * @returns {string} 正規化済み本文
 */
export function normalizeComment(raw) {
  const body = String(raw ?? '').trim()
  if (!body) throw Object.assign(new Error('コメントを入力してください'), { statusCode: 400 })
  if (body.length > TEXT_MAX) return body.slice(0, TEXT_MAX)
  return body
}

export function createInbox(cfg, kanban) {
  const boardsRoot = path.join(cfg.kanbanRoot, 'boards')

  /** 1ボードの blocked タスク（理由・直近コメント付き）。 */
  function boardItems(slug, name) {
    const dbPath = path.join(boardsRoot, slug, 'kanban.db')
    if (!fs.existsSync(dbPath)) return []
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT id, title, status, block_kind, block_recurrences, last_failure_error,
                  worker_pid, created_at, started_at, completed_at, session_id
             FROM tasks
            WHERE status = 'blocked'
            ORDER BY COALESCE(completed_at, started_at, created_at) DESC
            LIMIT 30`,
        )
        .all()
      const commentStmt = db.prepare(
        'SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      )
      const eventStmt = db.prepare(
        `SELECT payload, created_at FROM task_events
          WHERE task_id = ? AND kind IN ('blocked', 'failed', 'needs_input')
          ORDER BY id DESC LIMIT 1`,
      )
      return rows.map((r) => {
        let lastComment = null
        let reason = r.last_failure_error ?? null
        let blockedAt = null
        try {
          const c = commentStmt.get(r.id)
          if (c) {
            lastComment = {
              author: c.author ?? '',
              body: String(c.body ?? '').slice(0, 600),
              at: Math.round(Number(c.created_at ?? 0) * 1000),
            }
          }
        } catch {
          /* noop */
        }
        try {
          const e = eventStmt.get(r.id)
          if (e) {
            blockedAt = Math.round(Number(e.created_at ?? 0) * 1000)
            try {
              const p = JSON.parse(e.payload)
              const msg = p?.message ?? p?.reason ?? p?.summary
              if (typeof msg === 'string' && msg.trim()) reason = msg.trim()
            } catch {
              /* payload が JSON でない場合は無視 */
            }
          }
        } catch {
          /* noop */
        }
        return {
          id: r.id,
          title: r.title,
          board: slug,
          boardName: name,
          status: r.status,
          blockKind: r.block_kind ?? null,
          recurrences: Number(r.block_recurrences ?? 0),
          reason: reason ? String(reason).slice(0, 400) : null,
          blockedAt: blockedAt ?? (r.completed_at ? Number(r.completed_at) * 1000 : null),
          createdAt: r.created_at ? Number(r.created_at) * 1000 : null,
          sessionId: r.session_id ?? null,
          lastComment,
        }
      })
    } catch {
      return []
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * 承認待ちの一覧（ボード横断）。
   * @returns {{ok: boolean, at: number, items: Array<object>, counts: Record<string, number>}} 一覧
   */
  function list() {
    const items = []
    let boards = []
    try {
      boards = kanban.boards().filter((b) => !b.archived)
    } catch {
      boards = []
    }
    for (const b of boards) items.push(...boardItems(b.slug, b.name))
    items.sort((a, b) => (b.blockedAt ?? 0) - (a.blockedAt ?? 0))
    /** @type {Record<string, number>} */
    const counts = {}
    for (const it of items) counts[it.blockKind ?? 'untyped'] = (counts[it.blockKind ?? 'untyped'] ?? 0) + 1
    return { ok: true, at: Date.now(), items, counts }
  }

  /**
   * コメントを付ける（ステータスは変えない）。
   * @param {string} board ボード
   * @param {string} id タスクID
   * @param {string} text 本文
   * @param {string} by 実行者
   * @returns {Promise<object>} 結果
   */
  async function comment(board, id, text, by = 'mobile') {
    const body = normalizeComment(text)
    if (!/^t_[0-9a-z]+$/i.test(String(id))) {
      throw Object.assign(new Error('タスクIDが不正です'), { statusCode: 400 })
    }
    const res = await run(cfg, ['kanban', '--board', board, 'comment', id, body, '--author', String(by).slice(0, 40)])
    if (res.code !== 0) {
      throw Object.assign(new Error((res.out || 'コメントに失敗しました').slice(0, 400)), { statusCode: 502 })
    }
    return { ok: true, id, output: res.out.slice(0, 400), at: Date.now() }
  }

  /** CLI 実行（runner で差し替え可）。 */
  function run(c, args) {
    if (c.runner) return c.runner(args)
    return new Promise((resolve) => {
      execFile(
        c.hermesBin ?? 'hermes',
        args,
        { timeout: 20_000, maxBuffer: 500_000, env: { ...process.env } },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })
        },
      )
    })
  }

  return { list, comment }
}
