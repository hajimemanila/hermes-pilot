/**
 * セッション別の「返信新着」既読と、会話一覧の行バッジ（SPEC-PILOT-V3 §3.1 / D16）。
 *
 * `hm.session.seen.v1` に `{ [sessionId]: { count: number, at: number } }` を持つ。
 * `count` は最後に見たときの `message_count`、`at` はその時刻（epoch ms）。
 * 判定をここへ出してテストで固定する — ここがずれると「行に点が出ない/消えない」になる。
 *
 * 数字（件数）と点の使い分けは D16 のまま:
 *  - 完了報告の未読 → 緑の数値ピル（`.row-badge.done`）
 *  - 返信の新着     → `NEW` / `+N` ピル（`.row-badge.new`）
 *  - 実行中         → 青いドット（`.row-dot.running`）
 */

/** 会話ごとの既読（メッセージ数ベース）を残す localStorage キー。 */
export const SESSION_SEEN_KEY = 'hm.session.seen.v1'
/** 保持する会話数（会話は増え続けるので古いものから捨てる）。 */
export const SESSION_SEEN_LIMIT = 100

/**
 * 1 件ぶんの記録を正規化する（壊れた値は null で落とす）。
 * @param {{count?: unknown, at?: unknown}|null|undefined} rec 保存値
 * @returns {{count: number, at: number}|null} 正規化した記録
 */
function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return null
  const count = Number(rec.count)
  const at = Number(rec.at)
  if (!Number.isFinite(count) || count < 0) return null
  if (!Number.isFinite(at) || at <= 0) return null
  // `opened` を落とすと「一度でも開いたか」の判定が消える（実機の未読バッジ調査）
  return { count: Math.floor(count), at: Math.floor(at), opened: rec.opened === true }
}

/**
 * 古い順に `SESSION_SEEN_LIMIT` 件だけ残す。
 * @param {Record<string, {count: number, at: number}>|null|undefined} map 既読 map
 * @returns {Record<string, {count: number, at: number}>} 間引いた map（新しいオブジェクト）
 */
export function pruneSessionSeen(map) {
  const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  const rows = []
  for (const [sid, raw] of Object.entries(src)) {
    const id = String(sid ?? '').trim()
    const rec = normalizeRecord(raw)
    if (id && rec) rows.push([id, rec])
  }
  rows.sort((a, b) => a[1].at - b[1].at)
  const out = {}
  for (const [id, rec] of rows.slice(-SESSION_SEEN_LIMIT)) out[id] = rec
  return out
}

/**
 * 端末に保存した map を読む（文字列・オブジェクト・壊れた値のどれでも落ちない）。
 * @param {string|object|null|undefined} raw localStorage の値
 * @returns {Record<string, {count: number, at: number}>} 既読 map
 */
export function readSessionSeen(raw) {
  if (raw && typeof raw === 'object') return pruneSessionSeen(raw)
  const text = String(raw ?? '').trim()
  if (!text) return {}
  try {
    const j = JSON.parse(text)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    return pruneSessionSeen(j)
  } catch {
    return {}
  }
}

/**
 * localStorage に書く文字列（上限で間引いたあと）。
 * @param {Record<string, {count: number, at: number}>} map 既読 map
 * @returns {string} JSON 文字列
 */
export function serializeSessionSeen(map) {
  return JSON.stringify(pruneSessionSeen(map))
}

/**
 * 初回の一覧読み込みで、まだ記録の無い会話を「現在のメッセージ数」でベースライン登録する。
 *
 * これをしないと、初回起動で **すべての会話が返信新着として一斉に点く**。
 * 記録済みの会話は触らない（返信の増分は `sessionRowBadges` が判定する）。
 *
 * @param {Record<string, {count: number, at: number}>} prevMap 端末に残っている記録
 * @param {Array<{id: string, message_count?: number}>} sessions `/api/sessions` の一覧
 * @param {number} now 現在時刻（epoch ms）
 * @returns {Record<string, {count: number, at: number}>} 新しい map
 */
export function bootstrapSessionSeen(prevMap, sessions, now) {
  const out = pruneSessionSeen(prevMap)
  const stamp = Number(now) > 0 ? Math.floor(Number(now)) : Date.now()
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const sid = String(s?.id ?? '').trim()
    if (!sid || Object.prototype.hasOwnProperty.call(out, sid)) continue
    // 開いたことがない会話。件数が増えても「未読」にしない（worker 会話が +64 等で並ぶ・実機）
    out[sid] = { count: Math.max(0, Math.floor(Number(s?.message_count) || 0)), at: stamp, opened: false }
  }
  return pruneSessionSeen(out)
}

/**
 * その会話を「見た」として現在のメッセージ数を記録する（行の新着ピルを消す）。
 *
 * **単調増加**: 渡された数が既存の記録より小さくても後退させない（SPEC-PILOT-V4 §3.1 / D22①）。
 * 後退させると、古い `message_count` を渡した瞬間に読んだはずの会話が `NEW` に戻る。
 *
 * @param {Record<string, {count: number, at: number}>} prevMap 既読 map
 * @param {string} sessionId 会話 ID
 * @param {number} messageCount いま見えているメッセージ数
 * @param {number} now 現在時刻（epoch ms）
 * @returns {Record<string, {count: number, at: number}>} 新しい map
 */
export function markSessionSeen(prevMap, sessionId, messageCount, now) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return pruneSessionSeen(prevMap)
  const count = Number(messageCount)
  const at = Number(now) > 0 ? Math.floor(Number(now)) : Date.now()
  const out = pruneSessionSeen(prevMap)
  const prev = out[sid]
  const known = prev?.count ?? 0
  out[sid] = {
    count: Number.isFinite(count) && count >= 0 ? Math.max(known, Math.floor(count)) : known,
    at,
    // 「一度でも開いた」会話だけ新着ピルを出す
    opened: true,
  }
  return pruneSessionSeen(out)
}

/**
 * いま表示している会話（`activeDrawerSid`）の `message_count` を既読として追従させる。
 *
 * これをしないと、会話 B を開いている間にポーリングで B の件数が増えた分が記録されず、
 * 会話 A へ戻った瞬間に B が `NEW` / `+N` で再点灯する（実機 I9①）。
 * 見ている会話が一覧に無い（新着でまだ反映されていない等）ときは何も変えない。
 *
 * @param {Record<string, {count: number, at: number}>} prevMap 既読 map
 * @param {Array<{id: string, message_count?: number}>} sessions `/api/sessions` の一覧
 * @param {string|null} activeDrawerSid 表示中の会話 ID
 * @param {number} now 現在時刻（epoch ms）
 * @returns {Record<string, {count: number, at: number}>} 新しい map
 */
export function syncActiveSessionSeen(prevMap, sessions, activeDrawerSid, now) {
  const sid = String(activeDrawerSid ?? '').trim()
  const out = pruneSessionSeen(prevMap)
  if (!sid) return out
  const target = (Array.isArray(sessions) ? sessions : []).find((s) => String(s?.id ?? '').trim() === sid)
  if (!target) return out
  const prev = out[sid]
  const count = Math.max(0, Math.floor(Number(target?.message_count) || 0))
  if (count > (prev?.count ?? -1)) {
    const at = Number(now) > 0 ? Math.floor(Number(now)) : Date.now()
    // いま開いている会話なので opened:true（新着ピルは出さない）
    out[sid] = { count: Math.max(prev?.count ?? 0, count), at, opened: true }
  }
  return pruneSessionSeen(out)
}

/**
 * 一覧の全会話を「見た」にする（ドロワーの「✓ すべて既読」・D22③）。
 *
 * 記録済みの会話は `count` を後退させない（`Math.max`）。新着で一覧に載ったばかりの
 * 会話も現在の `message_count` で埋まる。
 *
 * @param {Record<string, {count: number, at: number}>} prevMap 既読 map
 * @param {Array<{id: string, message_count?: number}>} sessions `/api/sessions` の一覧
 * @param {number} now 現在時刻（epoch ms）
 * @returns {Record<string, {count: number, at: number}>} 新しい map
 */
export function markAllSessionsSeen(prevMap, sessions, now) {
  const out = pruneSessionSeen(prevMap)
  const at = Number(now) > 0 ? Math.floor(Number(now)) : Date.now()
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const sid = String(s?.id ?? '').trim()
    if (!sid) continue
    out[sid] = {
      count: Math.max(0, Math.floor(Number(s?.message_count) || 0), out[sid]?.count ?? 0),
      at,
      // 「すべて既読」は開いていない会話も既読にする（以後の増分だけ新着）
      opened: out[sid]?.opened === true,
    }
  }
  return pruneSessionSeen(out)
}

/**
 * `unreadReportMap`（`{ [sessionId]: 件数 }` か、報告 items の配列）から 1 会話ぶんの件数を読む。
 * @param {Record<string, number>|Array<{sessionId?: string}>|Map<string, number>|null|undefined} map 未読完了報告
 * @param {string} sid 会話 ID
 * @returns {number} 未読の完了報告件数
 */
function unreadReportCount(map, sid) {
  if (!map) return 0
  if (Array.isArray(map)) {
    return map.reduce((n, i) => (String(i?.sessionId ?? '') === sid ? n + 1 : n), 0)
  }
  if (typeof map.get === 'function') {
    const n = Number(map.get(sid))
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  if (typeof map === 'object') {
    const n = Number(map[sid])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return 0
}

/**
 * `liveSessionIds`（Set か配列）に会話が入っているか。
 * @param {Set<string>|string[]|null|undefined} ids 稼働中の会話 ID
 * @param {string} sid 会話 ID
 * @returns {boolean} 入っているか
 */
function hasLive(ids, sid) {
  if (!ids) return false
  if (typeof ids.has === 'function') return ids.has(sid)
  if (Array.isArray(ids)) return ids.some((x) => String(x ?? '') === sid)
  return false
}

/**
 * 会話一覧の 1 行に出すバッジ（D16②）。
 *
 * - `isActive`: いま画面に出している会話（ドロワーのハイライト。`activeDrawerSid` と一致）
 * - `isRunning`: 実行中（`is_active` か `/api/live` の稼働中に居る）
 * - `unreadReports`: その会話に届いている未読の完了報告件数
 * - `unreadReplies`: **別の会話**で、記録した `count` より `message_count` が増えている分（最低 1）
 *
 * @param {{session?: object, unreadReportMap?: object|Array|Map, seenMap?: Record<string, {count: number, at: number}>, activeDrawerSid?: string|null, liveSessionIds?: Set<string>|string[]|null}} input 入力
 * @returns {{isActive: boolean, isRunning: boolean, unreadReports: number, unreadReplies: number}} 行バッジ
 */
export function sessionRowBadges({
  session,
  unreadReportMap = null,
  seenMap = null,
  activeDrawerSid = null,
  liveSessionIds = null,
} = {}) {
  const sid = String(session?.id ?? '').trim()
  if (!sid) return { isActive: false, isRunning: false, unreadReports: 0, unreadReplies: 0 }
  const isActive = activeDrawerSid != null && String(activeDrawerSid) === sid
  const isRunning = Boolean(session?.is_active) || hasLive(liveSessionIds, sid)
  const unreadReports = unreadReportCount(unreadReportMap, sid)
  const record = seenMap && typeof seenMap === 'object' ? normalizeRecord(seenMap[sid]) : null
  const count = Math.max(0, Math.floor(Number(session?.message_count) || 0))
  const opened = record?.opened === true
  // 開いたことのない会話は件数が増えても未読にしない（過去の worker 会話が +N で並ぶ・実機）
  const unreadReplies = !isActive && opened && count > record.count ? Math.max(1, count - record.count) : 0
  return { isActive, isRunning, unreadReports, unreadReplies }
}

/**
 * ヘッダの `≡` に出す未読会話数（重複なし）。
 * @param {Array<{unreadReports?: number, unreadReplies?: number}>} badges 行バッジの配列
 * @returns {number} 未読のある会話数
 */
export function drawerUnreadCount(badges) {
  return (Array.isArray(badges) ? badges : []).filter(
    (b) => Number(b?.unreadReports) > 0 || Number(b?.unreadReplies) > 0,
  ).length
}

/**
 * 返信新着ピルの文字。1 件は `NEW`、2 件以上は `+N`（数字は「あなたの番」専用にしない）。
 * @param {number} n 新着件数
 * @returns {string} `NEW` / `+N` / ''（0 件）
 */
export function unreadRepliesLabel(n) {
  const v = Math.floor(Number(n) || 0)
  if (v <= 0) return ''
  return v > 1 ? `+${v}` : 'NEW'
}
