/**
 * 赤ペンの完了報告（起票した会話に戻る 1 行）の未読判定。
 *
 * 新着は**点だけ**で示す（赤ペン chat-badge-01 q3=B）: 数字は「あなたの番（判断待ち）」の
 * 専用で、同じ数字を 2 つの意味に使わない。既読は端末に残す（サーバに持たない）。
 * 判定は純関数にしてテストで固定する — ここがずれると「点が出ない/消えない」になる。
 */

/** ナビの点の既読時刻（チャットタブを最後に開いた時刻）。 */
export const SEEN_NAV_KEY = 'hm.chatReportSeenAt'
/** 会話一覧の行の点の既読時刻（会話ごと。JSON の object）。 */
export const SEEN_MAP_KEY = 'hm.chatReportSeen'
/** 会話ごとの既読を残す上限（会話は増え続けるので古いものから捨てる）。 */
export const SEEN_MAP_LIMIT = 50
/** 会話の末尾に出す行数（履歴を偽らないため直近だけ）。 */
export const REPORT_LINES = 3

/**
 * `since` より新しい報告だけ（古い順は保つ）。
 *
 * @param {Array<{at: number}>} items `/api/akapen/chat-reports` の items
 * @param {number} since 既読時刻（epoch ms）
 * @returns {Array} 未読だけ
 */
export function newerThan(items, since) {
  const list = Array.isArray(items) ? items : []
  const cut = Number(since) || 0
  return list.filter((i) => i && Number.isFinite(Number(i.at)) && Number(i.at) > cut)
}

/**
 * 未読のある会話の session_id（重複なし・古い順）。
 *
 * 「どの会話に新着があるか」を会話一覧の行に点で出すために使う。既読を持っていない
 * 会話は未読（0 より新しい報告がある）として扱う — 初回起動で取りこぼさない。
 *
 * @param {Array<{at: number, sessionId: string}>} items
 * @param {Record<string, number>} seen 会話ごとの既読時刻
 * @returns {string[]}
 */
export function unreadSessions(items, seen) {
  const map = seen && typeof seen === 'object' ? seen : {}
  const out = []
  const hit = new Set()
  for (const i of Array.isArray(items) ? items : []) {
    const sid = String(i?.sessionId ?? '')
    if (!sid || hit.has(sid)) continue
    const at = Number(i.at)
    if (!Number.isFinite(at)) continue
    if (at <= (Number(map[sid]) || 0)) continue
    hit.add(sid)
    out.push(sid)
  }
  return out
}

/**
 * その会話の末尾に出す 1 行（古い順・直近 `limit` 件）。
 *
 * @param {Array<{at: number, sessionId: string, taskId: string, text: string}>} items
 * @param {string} sessionId
 * @param {number} [limit]
 * @returns {Array<{key: string, at: number, text: string}>}
 */
export function reportLines(items, sessionId, limit = REPORT_LINES) {
  const sid = String(sessionId ?? '')
  if (!sid) return []
  const n = Math.max(1, Number(limit) || REPORT_LINES)
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && String(i.sessionId ?? '') === sid && Number.isFinite(Number(i.at)))
    .slice(-n)
    .map((i) => ({ key: `${i.taskId ?? ''}:${i.at}`, at: Number(i.at), text: String(i.text ?? '') }))
}

/**
 * 端末に保存した既読 map を読む（壊れていても空で返す）。
 *
 * @param {string|Record<string, number>|null|undefined} raw localStorage の値
 * @returns {Record<string, number>}
 */
export function readSeenMap(raw) {
  if (raw && typeof raw === 'object') return { ...raw }
  const text = String(raw ?? '').trim()
  if (!text) return {}
  try {
    const j = JSON.parse(text)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const out = {}
    for (const [k, v] of Object.entries(j)) {
      const n = Number(v)
      if (k && Number.isFinite(n) && n > 0) out[k] = n
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 1 会話ぶんの既読を立てた新しい map（古い順に `SEEN_MAP_LIMIT` 件だけ残す）。
 *
 * @param {Record<string, number>} seen
 * @param {string} sessionId
 * @param {number} at 既読時刻（epoch ms）
 * @returns {Record<string, number>}
 */
export function setSeen(seen, sessionId, at) {
  const sid = String(sessionId ?? '')
  const map = seen && typeof seen === 'object' ? { ...seen } : {}
  const stamp = Number(at)
  if (!sid || !Number.isFinite(stamp) || stamp <= 0) return map
  map[sid] = stamp
  const rows = Object.entries(map).sort((a, b) => a[1] - b[1])
  const keep = rows.slice(-SEEN_MAP_LIMIT)
  const out = {}
  for (const [k, v] of keep) out[k] = v
  return out
}
