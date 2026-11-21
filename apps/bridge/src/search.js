import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 全セッションの横断検索。
 *
 * `~/.hermes/state.db` の `messages` を **読み取り専用** で開き、
 * FTS5 の `messages_fts_trigram`（日本語の部分一致が効く）で引く。
 * トリグラム索引は 3 文字未満の語を拾えないので、その場合は LIKE に落とす。
 *
 * 返すのは**抜粋だけ**（本文全体は返さない）。会話を開くのはクライアントの役目。
 */

const MAX_LIMIT = 50
const SNIPPET_PAD = 60

/**
 * FTS5 のクエリ文字列を組み立てる。
 * 演算子（AND/OR/NOT/NEAR）や `-` `*` `(` を語として扱うため、全体をフレーズ引用する。
 * @param {string} raw 入力
 * @returns {string} MATCH に渡す文字列
 */
export function buildMatch(raw) {
  const q = String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
  if (!q) return ''
  // 二重引用符は FTS のフレーズ区切りなのでエスケープ（"" にする）
  return `"${q.replace(/"/g, '""')}"`
}

/**
 * 抜粋を作る（ヒット位置の前後を切り出す）。
 * @param {string} text 本文
 * @param {string} q 検索語
 * @param {number} [pad] 前後の文字数
 * @returns {string} 抜粋
 */
export function makeSnippet(text, q, pad = SNIPPET_PAD) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const needle = String(q ?? '').trim()
  const at = needle ? body.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) return body.slice(0, pad * 2) + (body.length > pad * 2 ? '…' : '')
  const start = Math.max(0, at - pad)
  const end = Math.min(body.length, at + needle.length + pad)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

/**
 * 検索を作る。
 * @param {object} cfg 設定（home / stateDb）
 * @returns {object} 検索 API
 */
export function createSearch(cfg) {
  const dbPath = cfg.stateDb ?? path.join(cfg.home ?? '', '.hermes', 'state.db')

  /** 3文字以上なら trigram、短ければ LIKE（trigram は 2 文字を索引できない）。 */
  function useTrigram(q) {
    return [...q].length >= 3
  }

  /**
   * 1つの DB から検索する。
   * @param {{profile: string, path: string}} target DB情報
   * @param {string} q 検索語
   * @param {number} since 開始秒
   * @param {number} limit 件数上限
   * @returns {Array<object>} ヒット一覧
   */
  function searchOne(target, q, since, limit) {
    let db
    try {
      db = new DatabaseSync(target.path, { readOnly: true })
      const rows = useTrigram(q)
        ? db
            .prepare(
              `SELECT m.id, m.session_id, m.role, m.content, m.timestamp,
                      s.title, s.source, s.chat_type, s.display_name
                 FROM messages_fts_trigram f
                 JOIN messages m ON m.id = f.rowid
                 LEFT JOIN sessions s ON s.id = m.session_id
                WHERE messages_fts_trigram MATCH ?
                  AND m.timestamp >= ?
                ORDER BY m.timestamp DESC
                LIMIT ?`,
            )
            .all(buildMatch(q), since, limit)
        : db
            .prepare(
              `SELECT m.id, m.session_id, m.role, m.content, m.timestamp,
                      s.title, s.source, s.chat_type, s.display_name
                 FROM messages m
                 LEFT JOIN sessions s ON s.id = m.session_id
                WHERE m.content LIKE ?
                  AND m.timestamp >= ?
                ORDER BY m.timestamp DESC
                LIMIT ?`,
            )
            .all(`%${q}%`, since, limit)
      return rows.map((r) => ({
        profile: target.profile || 'default',
        messageId: Number(r.id),
        sessionId: r.session_id,
        sessionTitle: r.title || r.display_name || r.session_id,
        source: r.source ?? '',
        chatType: r.chat_type ?? '',
        role: r.role,
        snippet: makeSnippet(r.content, q),
        at: Math.round(Number(r.timestamp ?? 0) * 1000),
      }))
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * 検索する。
   * @param {{q: string, limit?: number, hours?: number, dbs?: Array<{profile: string, path: string}>}} opts 条件
   * @returns {{ok: boolean, q: string, tookMs: number, total: number, hits: Array<object>, reason?: string}} 結果
   */
  function search(opts = {}) {
    const started = process.hrtime.bigint()
    const q = String(opts.q ?? '').trim().slice(0, 100)
    const limit = Math.min(Math.max(Number(opts.limit ?? 30), 1), MAX_LIMIT)
    const hours = Number(opts.hours ?? 0)
    const out = { ok: true, q, tookMs: 0, total: 0, hits: [] }
    if (!q) return { ...out, ok: false, code: 'QUERY_REQUIRED', reason: 'A query is required' }

    const rawDbs = Array.isArray(opts.dbs) && opts.dbs.length ? opts.dbs : [{ profile: 'default', path: dbPath }]
    const targets = rawDbs.filter((d) => d?.path && fs.existsSync(d.path))
    if (!targets.length) return { ...out, ok: false, code: 'DB_NOT_FOUND', reason: 'Hermes state.db was not found' }

    const since = hours > 0 ? Date.now() / 1000 - hours * 3600 : 0
    const merged = []
    let firstErr = null
    let succeeded = 0
    for (const target of targets) {
      try {
        merged.push(...searchOne(target, q, since, limit))
        succeeded++
      } catch (e) {
        if (!firstErr) firstErr = e
      }
    }
    if (!succeeded && firstErr) {
      return { ...out, ok: false, code: 'SEARCH_FAILED', reason: `Search failed: ${firstErr.message}` }
    }
    merged.sort((a, b) => b.at - a.at)
    out.hits = merged.slice(0, limit)
    out.total = out.hits.length
    out.tookMs = Number(process.hrtime.bigint() - started) / 1e6
    return out
  }

  return { search, buildMatch, makeSnippet }
}
