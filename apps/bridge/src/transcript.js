import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * セッションの読み取り専用トランスクリプト。
 *
 * カンバンの作業ログ（`local-…`）は `session.resume` を Hermes が拒否する
 * （code 4132: 盤面が観測できない書き手を作らないため）。そこで state.db から
 * 直接、表示用の抜粋だけを読む。**書き込みはしない**。
 */
export function createTranscript(cfg) {
  const dbPath = cfg.stateDb ?? path.join(cfg.home ?? '', '.hermes', 'state.db')

  /**
   * 1セッションのメッセージを古い順に返す。
   * @param {string} sessionId セッションID
   * @param {{limit?: number, before?: number}} [opts] 条件（before はメッセージID）
   * @returns {{ok: boolean, sessionId: string, messages: Array<object>, reason?: string}} 結果
   */
  function read(sessionId, opts = {}) {
    const id = String(sessionId ?? '').slice(0, 128)
    if (!id) return { ok: false, sessionId: id, messages: [], reason: 'session_id が必要です' }
    // プロファイル横断表示のため、呼び出し側が対象 DB を指定できる
    const effectivePath = opts.dbPath || dbPath
    if (!fs.existsSync(effectivePath)) return { ok: false, sessionId: id, messages: [], reason: 'state.db が見つかりません' }
    const limit = Math.min(Math.max(Number(opts.limit ?? 80), 1), 300)
    const before = Number(opts.before ?? 0)

    let db
    try {
      db = new DatabaseSync(effectivePath, { readOnly: true })
      let title = ''
      try {
        const t = db.prepare('SELECT title, display_name FROM sessions WHERE id = ?').get(id)
        title = String(t?.title || t?.display_name || '')
      } catch {
        title = ''
      }
      const rows = db
        .prepare(
          `SELECT id, role, content, timestamp
             FROM messages
            WHERE session_id = ?
              AND role IN ('user', 'assistant')
              AND COALESCE(active, 1) = 1
              AND length(COALESCE(content, '')) > 0
              ${before ? 'AND id < ?' : ''}
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(...(before ? [id, before, limit] : [id, limit]))
      const messages = rows
        .map((r) => ({
          id: Number(r.id),
          role: r.role,
          text: String(r.content ?? '').slice(0, 8000),
          at: Math.round(Number(r.timestamp ?? 0) * 1000),
        }))
        .reverse()
      return { ok: true, sessionId: id, title, messages, hasMore: rows.length >= limit }
    } catch (e) {
      return { ok: false, sessionId: id, messages: [], reason: `読み取りに失敗しました: ${e.message}` }
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  return { read }
}
