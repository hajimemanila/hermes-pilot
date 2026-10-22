import fs from 'node:fs'
import path from 'node:path'

/**
 * Discord のディープリンク。
 *
 * `~/.hermes/sessions/sessions.json` の各エントリは `session_id` と
 * `origin`（platform / guild_id / thread_id / parent_chat_id / message_id）を持つので、
 * 外部 API を叩かずにリンクを組み立てられる（実測で guild_id まで入っている）。
 *
 * kanban-sop の履歴 `metadata.session_anchor.chat_id` はスレッドIDなので、
 * タスク → セッション → リンクの順で解決する。
 */
export function createDiscord(cfg) {
  const sessionsPath = cfg.sessionsFile ?? path.join(cfg.home, '.hermes', 'sessions', 'sessions.json')

  /** @type {{mtimeMs: number, bySession: Map<string, {url: string, threadId: string, guildId: string, chatName: string, messageId: string|null}>}} */
  let cache = { mtimeMs: -1, bySession: new Map() }

  /** sessions.json を読み直す（mtime が変わったときだけ）。 */
  function load() {
    let st
    try {
      st = fs.statSync(sessionsPath)
    } catch {
      return cache.bySession
    }
    if (st.mtimeMs === cache.mtimeMs) return cache.bySession
    let data
    try {
      data = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
    } catch {
      return cache.bySession
    }
    const bySession = new Map()
    for (const [key, v] of Object.entries(data)) {
      if (!v || typeof v !== 'object') continue
      if (v.platform !== 'discord') continue
      let origin = v.origin
      if (typeof origin === 'string') {
        try {
          origin = JSON.parse(origin.replace(/'/g, '"'))
        } catch {
          origin = null
        }
      }
      const guildId = origin?.guild_id ?? null
      const threadId = origin?.thread_id ?? origin?.chat_id ?? null
      const sessionId = v.session_id
      if (!guildId || !threadId || !sessionId) continue
      const messageId = origin?.message_id ?? null
      const url = `https://discord.com/channels/${guildId}/${threadId}`
      bySession.set(sessionId, {
        url,
        threadId,
        guildId,
        messageId,
        chatName: origin?.chat_name ?? key,
        chatType: v.chat_type ?? '',
      })
    }
    cache = { mtimeMs: st.mtimeMs, bySession }
    return bySession
  }

  /**
   * セッションIDからリンクを引く。
   * @param {string|null} sessionId セッションID
   * @returns {object|null} リンク情報
   */
  function forSession(sessionId) {
    if (!sessionId) return null
    return load().get(String(sessionId)) ?? null
  }

  /**
   * タスク（session_anchor）からリンクを引く。アンカーが無ければ null。
   * @param {{session_id?: string}|null} anchor アンカー
   * @returns {object|null} リンク情報
   */
  function forAnchor(anchor) {
    if (!anchor?.session_id) return null
    const hit = load().get(String(anchor.session_id))
    if (!hit) return null
    return { ...hit, messageId: anchor.message_id ?? hit.messageId ?? null }
  }

  return { forSession, forAnchor }
}
