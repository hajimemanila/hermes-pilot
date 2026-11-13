import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * ライブ進捗（いま何が動いているか）。
 *
 * - 実行中ターン: `state.db` の `session_turn_leases`（本体が張るリース）を読むだけ
 * - 最後のツール: そのセッションの直近 `messages.tool_name`
 * - 実行中タスク: カンバン（既存の kanban モジュール）から status='running'
 *
 * 書き込みはしない。5秒ポーリング前提なので、DB は毎回開いて閉じる（読取のみ・数ms）。
 */

/** holder 文字列から platform を取り出す（例: "pid=123:turn=…:platform=discord"）。 */
export function platformOf(holder) {
  const m = /platform=([a-z0-9_-]+)/i.exec(String(holder ?? ''))
  return m ? m[1] : null
}

export function createLive(cfg, kanban) {
  const dbPath = cfg.stateDb ?? path.join(cfg.home ?? '', '.hermes', 'state.db')

  /**
   * 1つの DB から実行中ターンを読む。
   * @param {{profile: string, path: string}} target DB情報
   * @param {number} at 現在時刻
   * @returns {Array<object>} ターン一覧
   */
  function turnsFrom(target, at) {
    let db
    try {
      db = new DatabaseSync(target.path, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT l.conversation_id, l.holder, l.acquired_at, l.expires_at,
                  s.title, s.source, s.chat_type, s.last_activity_description,
                  s.last_activity_at
             FROM session_turn_leases l
             LEFT JOIN sessions s ON s.id = l.conversation_id
            ORDER BY l.acquired_at DESC`,
        )
        .all()
      const lastToolStmt = db.prepare(
        `SELECT tool_name, timestamp FROM messages
          WHERE session_id = ? AND tool_name IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      return rows.map((r) => {
        let lastTool = null
        try {
          const t = lastToolStmt.get(r.conversation_id)
          if (t?.tool_name) lastTool = { name: t.tool_name, at: Math.round(Number(t.timestamp) * 1000) }
        } catch {
          /* noop */
        }
        const acquired = Math.round(Number(r.acquired_at ?? 0) * 1000)
        const expires = Math.round(Number(r.expires_at ?? 0) * 1000)
        return {
          profile: target.profile || 'default',
          sessionId: r.conversation_id,
          title: r.title || r.conversation_id,
          source: r.source ?? '',
          platform: platformOf(r.holder),
          startedAt: acquired || null,
          elapsedSec: acquired ? Math.max(0, Math.round((at - acquired) / 1000)) : null,
          expiresInSec: expires ? Math.round((expires - at) / 1000) : null,
          lastActivity: r.last_activity_description ?? null,
          lastTool,
        }
      })
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * いま動いているもの。
   * @param {{dbs?: Array<{profile: string, path: string}>}} [opts] 条件
   * @returns {object} スナップショット
   */
  function snapshot(opts = {}) {
    const at = Date.now()
    const out = { ok: true, at, turns: [], tasks: [], counts: { turns: 0, tasks: 0 } }

    // 実行中タスク（ボード横断）
    try {
      const runs = []
      for (const b of kanban.boards()) {
        for (const t of kanban.tasks(b.slug, { limit: 80 })) {
          if (t.status !== 'running') continue
          runs.push({
            id: t.id,
            title: t.title,
            board: b.slug,
            boardName: b.name,
            elapsedSec: t.elapsedSec,
            workerPid: t.workerPid,
          })
        }
      }
      out.tasks = runs.sort((a, b) => (b.elapsedSec ?? 0) - (a.elapsedSec ?? 0))
      out.counts.tasks = runs.length
    } catch {
      out.tasks = []
    }

    // 実行中ターン（リース）
    const rawDbs = Array.isArray(opts.dbs) && opts.dbs.length ? opts.dbs : [{ profile: 'default', path: dbPath }]
    const targets = rawDbs.filter((d) => d?.path && fs.existsSync(d.path))
    if (!targets.length) {
      out.ok = false
      out.reason = 'state.db が見つかりません'
      return out
    }
    const turns = []
    let firstErr = null
    let succeeded = 0
    for (const target of targets) {
      try {
        turns.push(...turnsFrom(target, at))
        succeeded++
      } catch (e) {
        if (!firstErr) firstErr = e
      }
    }
    if (!succeeded && firstErr) {
      out.ok = false
      out.reason = `読み取りに失敗しました: ${firstErr.message}`
      return out
    }
    turns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    out.turns = turns
    out.counts.turns = turns.length
    return out
  }

  return { snapshot }
}
