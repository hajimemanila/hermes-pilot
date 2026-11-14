/**
 * レビューの完了報告（起票した会話に戻る 1 行）の未読判定。
 *
 * 新着は**点だけ**で示す（レビュー chat-badge-01 q3=B）: 数字は「あなたの番（判断待ち）」の
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
/** 現在開いている会話 ID の保存キー。 */
export const ACTIVE_CHAT_KEY = 'hm.storedSid'
/** 新規会話未送信中でも引き継ぐ、直前の会話 ID の保存キー。 */
export const LAST_CHAT_KEY = 'hm.lastStoredSid'
/**
 * 「宛先の会話が決まらなかった」パイプライン統合レポートの仮想セッション ID
 * （SPEC-PILOT-V4 §3.2 ② / §3.3: 対象 repo の最新通常会話も無いとき）。
 * 既読管理（`setSeen`）も通常のセッション ID と同じ扱いで通る。
 */
export const LATEST_REPORT_ID = '__latest__'

/**
 * パイプライン統合レポート（`kind: 'pipeline'`）が持つ追加フィールド。
 * ブリッジが `chat-reports.jsonl` の行に載せた値をそのまま UI まで運ぶ。
 */
export const PIPELINE_KEYS = [
  'kind',
  'status',
  'board',
  'spec',
  'repoPath',
  'markdown',
  'followUpPrompt',
  'counts',
]

/**
 * 行がパイプライン統合レポートか（既存のレビュー完了 1 行には影響しない）。
 * @param {{kind?: string}|null|undefined} row
 * @returns {boolean}
 */
export function isPipelineReport(row) {
  return String(row?.kind ?? '') === 'pipeline'
}

/** 追加フィールドだけを取り出す（未定義・null は落とす）。 */
function pipelineExtras(row) {
  const out = {}
  for (const k of PIPELINE_KEYS) {
    const v = row?.[k]
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/** 現在（または新規未送信時は直前）の会話セッション ID を返す。 */
export function readActiveChatId(storage = globalThis.localStorage) {
  try {
    return String(storage?.getItem(ACTIVE_CHAT_KEY) || storage?.getItem(LAST_CHAT_KEY) || '').trim()
  } catch {
    return ''
  }
}

/**
 * `since` より新しい報告だけ（古い順は保つ）。
 *
 * @param {Array<{at: number}>} items `/api/review/chat-reports` の items
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
 * @param {Array<{at: number, sessionId: string, taskId: string, label?: string|null, text: string}>} items
 * @param {string|string[]} sessionIdOrIds 単一 ID または ID 配列（`storedSid` / `sid` 等）
 * @param {number} [limit]
 * @returns {Array<{key: string, at: number, text: string, taskId: string, label: string|null}>}
 */
export function reportLines(items, sessionIdOrIds, limit = REPORT_LINES) {
  const ids = new Set(
    (Array.isArray(sessionIdOrIds) ? sessionIdOrIds : [sessionIdOrIds])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
  )
  if (!ids.size) return []
  const n = Math.max(1, Number(limit) || REPORT_LINES)
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && ids.has(String(i.sessionId ?? '')) && Number.isFinite(Number(i.at)))
    .slice(-n)
    .map((i) => ({
      key: `${i.taskId ?? ''}:${i.at}`,
      at: Number(i.at),
      text: String(i.text ?? ''),
      taskId: String(i.taskId ?? ''),
      label: i.label ?? null,
      // パイプライン統合レポートは本文・宛先・相談プロンプトも UI まで運ぶ（§3.3 ①）
      ...pipelineExtras(i),
    }))
}

/**
 * 現在開いている会話（`currentIds`）以外に届いている未読の完了報告（セッションごと最新 1 件・新しい順）。
 *
 * @param {Array<{at: number, sessionId: string, taskId: string, label?: string|null, text: string}>} items
 * @param {Record<string, number>} seen 会話ごとの既読時刻
 * @param {string|string[]} [currentIds] 現在開いている会話の ID 群
 * @returns {Array<{sessionId: string, at: number, taskId: string, label: string|null, text: string}>}
 */
export function otherUnreadReports(items, seen, currentIds = []) {
  const map = seen && typeof seen === 'object' ? seen : {}
  const cur = new Set(
    (Array.isArray(currentIds) ? currentIds : [currentIds])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
  )
  const bySession = new Map()
  for (const i of Array.isArray(items) ? items : []) {
    const sid = String(i?.sessionId ?? '').trim()
    const at = Number(i?.at)
    if (!sid || cur.has(sid) || !Number.isFinite(at)) continue
    if (at <= (Number(map[sid]) || 0)) continue
    const prev = bySession.get(sid)
    if (!prev || at >= prev.at) {
      bySession.set(sid, {
        sessionId: sid,
        at,
        taskId: String(i?.taskId ?? ''),
        label: i?.label ?? null,
        text: String(i?.text ?? ''),
        // `__latest__` バナーからリポジトリ・ボード・相談プロンプトへ辿れるようにする
        ...pipelineExtras(i),
      })
    }
  }
  return [...bySession.values()].sort((a, b) => b.at - a.at)
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

/**
 * その会話に届いている完了報告のうち最も新しい `at`（無ければ 0）。
 *
 * 既読として書く時刻をこれと `Date.now()` の大きい方にすると、サーバ側 `at` が端末の
 * 時計より数秒〜数分先でも緑のバッジが消える（時刻スキュー・SPEC-PILOT-V4 §3.1 / D22①）。
 *
 * @param {Array<{at: number, sessionId: string}>} items `/api/review/chat-reports` の items
 * @param {string|string[]} sessionIdOrIds 単一 ID または ID 配列
 * @returns {number} 最新の `at`（epoch ms・無ければ 0）
 */
export function maxReportAtFor(items, sessionIdOrIds) {
  const ids = new Set(
    (Array.isArray(sessionIdOrIds) ? sessionIdOrIds : [sessionIdOrIds])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
  )
  if (!ids.size) return 0
  let max = 0
  for (const i of Array.isArray(items) ? items : []) {
    if (!ids.has(String(i?.sessionId ?? '').trim())) continue
    const at = Number(i?.at)
    if (Number.isFinite(at) && at > max) max = at
  }
  return max
}

/**
 * 全報告を既読にした新しい map（ドロワーの「✓ すべて既読」・D22③）。
 *
 * 会話ごとに `Math.max(now, その会話の最新 at)` を書くので、未来時刻の報告も既読になる。
 *
 * @param {Record<string, number>} prevSeenMap 会話ごとの既読時刻
 * @param {Array<{at: number, sessionId: string}>} items `/api/review/chat-reports` の items
 * @param {number} now 現在時刻（epoch ms）
 * @returns {Record<string, number>} 新しい map
 */
export function markAllReportsSeenMap(prevSeenMap, items, now) {
  const stamp = Number(now) > 0 ? Math.floor(Number(now)) : Date.now()
  let map = readSeenMap(prevSeenMap)
  const latest = new Map()
  for (const i of Array.isArray(items) ? items : []) {
    const sid = String(i?.sessionId ?? '').trim()
    const at = Number(i?.at)
    if (!sid || !Number.isFinite(at)) continue
    if (at > (latest.get(sid) ?? 0)) latest.set(sid, at)
  }
  for (const [sid, at] of latest) map = setSeen(map, sid, Math.max(stamp, at))
  return map
}

/**
 * 時刻表現（epoch sec/ms・ISO文字列）を epoch ms に正規化する。解釈不能なら null。
 *
 * @param {number|string|null|undefined} raw
 * @returns {number|null}
 */
export function toEpochMs(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return null
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/**
 * タイムラインに出す報告を引くための ID 配列を作る（SPEC-PILOT-V4 §3.3 ①②）。
 *
 * `'__latest__'`（宛先の会話が決まらなかった統合レポート）は**開いている会話のリポジトリに
 * 一致するときだけ**合流させる。無条件に混ぜると別リポジトリの完走報告が今の会話に現れる。
 *
 * @param {string|string[]} currentIds 現在開いている会話の ID 群
 * @param {Array<{sessionId?: string, repoPath?: string}>} items `/api/review/chat-reports` の items
 * @param {string} [repoPath] 開いている会話のリポジトリ（`repo.path`）
 * @returns {string[]}
 */
export function reportIdsFor(currentIds, items, repoPath = '') {
  const ids = (Array.isArray(currentIds) ? currentIds : [currentIds])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  const path = String(repoPath ?? '').trim().toLowerCase()
  if (!path || ids.includes(LATEST_REPORT_ID)) return ids
  const hit = (Array.isArray(items) ? items : []).some(
    (i) =>
      String(i?.sessionId ?? '').trim() === LATEST_REPORT_ID &&
      String(i?.repoPath ?? '').trim().toLowerCase() === path,
  )
  return hit ? [...ids, LATEST_REPORT_ID] : ids
}

/**
 * 統合レポートの 1 行要約（バナー・折りたたみ時の見出しに使う）。
 *
 * Markdown の記号を落として最初の非空行を返す。長すぎるときは末尾を `…` にする
 * （390px 幅で折り返しが破綻しないように）。
 *
 * @param {{summary?: string, markdown?: string, text?: string}|null|undefined} report
 * @param {number} [max] 最大文字数
 * @returns {string}
 */
export function reportSummaryLine(report, max = 96) {
  const raw = String(report?.summary ?? report?.markdown ?? report?.text ?? '')
  const limit = Math.max(8, Number(max) || 96)
  for (const line of raw.split('\n')) {
    const s = line
      .replace(/^\s*(?:[>#]+|[-*+]|\d+\.)\s*/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!s) continue
    return s.length > limit ? `${s.slice(0, limit - 1)}…` : s
  }
  return ''
}

/**
 * 「次の一手を相談」で入力欄に置く文面（レポートが持つ `followUpPrompt` が優先）。
 * @param {{followUpPrompt?: string}|null|undefined} report
 * @param {string} [fallback] 訳文（レポートに相談文が無いとき）
 * @returns {string}
 */
export function followUpPromptFor(report, fallback = '') {
  const own = String(report?.followUpPrompt ?? '').trim()
  return own || String(fallback ?? '').trim()
}

/**
 * 会話ブロック列とレビュー完了報告を時系列で統合する。
 * 報告の時刻より後の発言（`b.at >= r.at`）が存在する場合、報告はその手前に差し込まれ、
 * 新しい会話履歴が増えても完了通知が常に最下部に張り付かないようにする。
 *
 * @param {Array<{at?: number|null}>} blocks
 * @param {Array<{key: string, at: number, text: string}>} reports 古い順
 * @returns {Array<{kind: 'block', block: object, index: number}|{kind: 'report', report: object}>}
 */
export function mergeTimeline(blocks, reports) {
  const bList = Array.isArray(blocks) ? blocks : []
  const rList = Array.isArray(reports) ? reports : []
  if (!rList.length) return bList.map((block, index) => ({ kind: 'block', block, index }))

  const out = []
  let ri = 0
  for (let i = 0; i < bList.length; i += 1) {
    const block = bList[i]
    const bt = Number(block?.at)
    if (Number.isFinite(bt) && bt > 0) {
      while (ri < rList.length && rList[ri].at <= bt) {
        out.push({ kind: 'report', report: rList[ri] })
        ri += 1
      }
    }
    out.push({ kind: 'block', block, index: i })
  }
  while (ri < rList.length) {
    out.push({ kind: 'report', report: rList[ri] })
    ri += 1
  }
  return out
}
