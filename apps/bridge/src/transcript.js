import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 既定の取得件数（1ターンでツールを多用するとすぐ上限に達するため大きめ）。 */
const DEFAULT_LIMIT = 200
/** 1回の取得で返す最大件数。 */
const MAX_LIMIT = 1000
/** `tool_calls` から引数を復元するとき、1引数あたり保持する最大文字数。 */
const MAX_ARG_CHARS = 500
/** 引数マップ構築でさかのぼる assistant 行の上限（暴走防止）。 */
const MAX_CALL_ROWS = 800
/** 表示に使う引数キー（機密を丸ごと載せないための許可リスト）。 */
const ARG_KEYS = ['command', 'path', 'file_path', 'query', 'goal', 'code', 'url', 'pattern', 'title', 'text', 'task_id']

/** 引数の文字列を最大長へ切り詰める（空白潰しは表示側で行う）。 */
function clip(v) {
  const s = String(v ?? '')
  return s.length > MAX_ARG_CHARS ? s.slice(0, MAX_ARG_CHARS) : s
}

/** 表示用の軽量引数オブジェクトを作る（許可キーのみ・文字列のみ）。 */
function summarizeToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const out = {}
  for (const k of ARG_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) out[k] = clip(v)
  }
  return Object.keys(out).length ? out : null
}

/** `arguments` は JSON 文字列のこともオブジェクトのこともある。 */
function normalizeArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * `tool_calls` 列の JSON を `[{ id, name, args }]` へ正規化する。
 * 配列形式（OpenAI 互換 `[{id, function:{name, arguments}}]`）、
 * 単一オブジェクト形式、`{ <callId>: { name, args } }` 形式のいずれも受ける。
 */
export function parseToolCalls(raw) {
  const out = []
  if (!raw) return out
  let data = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return out
    }
  }
  if (!data || typeof data !== 'object') return out
  const push = (id, name, args) => {
    const callId = String(id ?? '')
    const toolName = typeof name === 'string' ? name : ''
    const parsedArgs = normalizeArgs(args)
    if (callId && (toolName || parsedArgs)) out.push({ id: callId, name: toolName, args: parsedArgs })
  }
  const fromEntry = (item, fallbackId) => {
    if (!item || typeof item !== 'object') return
    const fn = item.function && typeof item.function === 'object' ? item.function : null
    push(
      item.id ?? item.tool_call_id ?? item.call_id ?? fallbackId,
      fn?.name ?? item.name ?? item.tool_name,
      fn?.arguments ?? item.arguments ?? item.args ?? item.input,
    )
  }
  if (Array.isArray(data)) {
    for (const item of data) fromEntry(item, null)
    return out
  }
  if (data.function || data.name || data.tool_name) {
    fromEntry(data, data.id ?? data.tool_call_id ?? data.call_id)
    return out
  }
  for (const [k, v] of Object.entries(data)) fromEntry(v, k)
  return out
}

/**
 * セッションの読み取り専用トランスクリプト。
 *
 * カンバンの作業ログ（`local-…`）は `session.resume` を Hermes が拒否する
 * （code 4132: 盤面が観測できない書き手を作らないため）。そこで state.db から
 * 直接、表示用の抜粋だけを読む。**書き込みはしない**。
 */
export function createTranscript(cfg) {
  const dbPath = cfg.stateDb ?? path.join(cfg.home ?? '', '.hermes', 'state.db')

  /** messages テーブルにある列名の集合（旧スキーマ後方互換のため probe する）。 */
  function columnsOf(db) {
    const names = new Set()
    try {
      for (const r of db.prepare("SELECT name FROM pragma_table_info('messages')").all()) names.add(String(r.name))
    } catch {
      /* pragma が引けない DB は列なし扱い */
    }
    return names
  }

  /**
   * `tool_call_id -> { name, args }` を `tool_calls` から組み立てる。
   * 取得範囲の末尾（page[0].id）以前の assistant 行だけを見る。
   */
  function buildCallMap(db, sessionId, maxId) {
    const map = new Map()
    if (!Number.isFinite(maxId) || maxId <= 0) return map
    let rows = []
    try {
      rows = db
        .prepare(
          `SELECT id, tool_calls
             FROM messages
            WHERE session_id = ?
              AND role = 'assistant'
              AND tool_calls IS NOT NULL
              AND length(COALESCE(tool_calls, '')) > 2
              AND id <= ?
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(sessionId, maxId, MAX_CALL_ROWS)
    } catch {
      return map
    }
    for (const r of rows) {
      for (const call of parseToolCalls(r.tool_calls)) {
        if (!map.has(call.id)) map.set(call.id, call)
      }
    }
    return map
  }

  /**
   * 1セッションのメッセージを古い順に返す。
   * @param {string} sessionId セッションID
   * @param {{limit?: number, before?: number, includeTools?: boolean, dbPath?: string}} [opts] 条件（before はメッセージID）
   * @returns {{ok: boolean, sessionId: string, messages: Array<object>, oldestId: number|null, hasMore: boolean, reason?: string}} 結果
   */
  function read(sessionId, opts = {}) {
    const id = String(sessionId ?? '').slice(0, 128)
    if (!id) return { ok: false, sessionId: id, messages: [], oldestId: null, hasMore: false, code: 'SESSION_REQUIRED', reason: 'session_id が必要です' }
    // プロファイル横断表示のため、呼び出し側が対象 DB を指定できる
    const effectivePath = opts.dbPath || dbPath
    if (!fs.existsSync(effectivePath))
      return { ok: false, sessionId: id, messages: [], oldestId: null, hasMore: false, code: 'DB_NOT_FOUND', reason: 'state.db が見つかりません' }
    const asked = Number(opts.limit)
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), MAX_LIMIT) : DEFAULT_LIMIT
    const before = Number(opts.before ?? 0) || 0

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
      const cols = columnsOf(db)
      const hasToolName = cols.has('tool_name')
      const hasToolCallId = cols.has('tool_call_id')
      const hasToolCalls = cols.has('tool_calls')
      const roles = opts.includeTools ? "('user', 'assistant', 'tool')" : "('user', 'assistant')"
      const selectCols = [
        'id',
        'role',
        'content',
        'timestamp',
        hasToolName ? 'tool_name' : 'NULL AS tool_name',
        hasToolCallId ? 'tool_call_id' : 'NULL AS tool_call_id',
      ].join(', ')
      // hasMore を厳密にするため 1 件多く取り、余りがあるかで判定する
      const rows = db
        .prepare(
          `SELECT ${selectCols}
             FROM messages
            WHERE session_id = ?
              AND role IN ${roles}
              ${opts.includeTools ? '' : 'AND COALESCE(active, 1) = 1'}
              AND length(COALESCE(content, '')) > 0
              ${before ? 'AND id < ?' : ''}
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(...(before ? [id, before, limit + 1] : [id, limit + 1]))
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const callMap = hasToolCalls && opts.includeTools ? buildCallMap(db, id, Number(page[0]?.id)) : new Map()
      const messages = page
        .map((r) => {
          const isTool = r.role === 'tool'
          const callId = String(r.tool_call_id ?? '')
          const call = isTool && callId ? callMap.get(callId) : null
          const msg = {
            id: Number(r.id),
            role: r.role,
            toolName: isTool ? r.tool_name || call?.name || null : null,
            toolArgs: isTool ? summarizeToolArgs(call?.args) : null,
            text: String(r.content ?? '').slice(0, isTool ? 400 : 8000),
            at: Math.round(Number(r.timestamp ?? 0) * 1000),
          }
          if (callId) msg.toolCallId = callId
          return msg
        })
        .reverse()
      // messages[0] は最古（reverse 後）— ページングの `before` にそのまま渡せる
      return { ok: true, sessionId: id, title, messages, oldestId: messages[0]?.id ?? null, hasMore }
    } catch (e) {
      return { ok: false, sessionId: id, messages: [], oldestId: null, hasMore: false, code: 'READ_FAILED', reason: `読み取りに失敗しました: ${e.message}` }
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
