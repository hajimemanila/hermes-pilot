/**
 * 接続状態の正本（SPEC-EXECUTION-MODE-INTEGRITY / D96・§3.1）。
 *
 * 3 系統（http / chat / term）が**報告イベント**を出し、集約状態をここ 1 か所で決める。
 * 丸・赤帯・`gwState`・チャット帯・端末状態はすべて同じ集約値（または同じ系統の状態）を見る。
 *
 * 報告イベントは系統ごとに現行の語彙をそのまま残す（画面の語を増やさない）:
 *   - http: `ok` / `timeout` / `error` / `auth`
 *   - chat: `connecting` / `ready` / `closed` / `error`
 *   - term: `connecting` / `open` / `closed` / `error`
 *
 * 状態語彙（表示・集約で使う 5 語）は `TRANSPORT_STATES`:
 *   ready / connecting / recovering / offline / auth
 *
 * 指数バックオフもここ 1 実装（`reconnectDelay`）。`lib/termReconnect.js` は再エクスポートのみ。
 *
 * React / DOM に依存しないので Node の `node --test` からそのまま検証できる。
 */

/** 報告を受け付ける系統。 */
export const TRANSPORT_SOURCES = ['http', 'chat', 'term']

/** 集約・表示で使う状態語彙（報告イベント名ではない）。 */
export const TRANSPORT_STATES = ['ready', 'connecting', 'recovering', 'offline', 'auth']

/** 再接続の待ち時間の上限（ms）。1s → 2s → 4s … 最大 15s。 */
export const RECONNECT_MAX_MS = 15000

/**
 * 切断とみなすまでの猶予（ms）。
 *
 * `http: 12000` は「`/api/overview` のタイムアウト 8 秒＋ 2 ポーリング相当」で、
 * 電波揺らぎの 1〜2 回の失敗では赤帯を出さないための値。
 * `chat` / `term` の 4000ms は移動中の WS 再接続が 1〜2 回で戻る間は赤帯を出さないための猶予。
 */
export const GRACE_MS = Object.freeze({ http: 12000, chat: 4000, term: 4000 })

/** 赤帯（完全オフライン／認証要）を出すべき状態か（猶予中の `recovering` / `connecting` は出さない）。 */
export function shouldShowBanner(state) {
  return state === 'offline' || state === 'auth'
}

/** 集約の優先順（数値が大きいほど強い）。 */
const SEVERITY = Object.freeze({ ready: 0, connecting: 1, recovering: 2, offline: 3, auth: 4 })

/**
 * 報告イベント名 → 内部の種類。
 *
 * `broken` は「繋がっていない」の 1 種類に畳み、猶予（`GRACE_MS`）と
 * 「一度でも ready したか」で `connecting` / `recovering` / `offline` に分ける。
 */
const REPORT_KINDS = Object.freeze({
  http: Object.freeze({ ok: 'ready', timeout: 'broken', error: 'broken', auth: 'auth' }),
  chat: Object.freeze({ connecting: 'broken', ready: 'ready', closed: 'broken', error: 'broken' }),
  term: Object.freeze({ connecting: 'broken', open: 'ready', closed: 'broken', error: 'broken' }),
})

/** まだ何も報告していない系統の種類（集約では無視する）。 */
const UNKNOWN = 'unknown'

/**
 * 状態の強さ（auth 4 / offline 3 / recovering 2 / connecting 1 / ready 0）。
 *
 * @param {string} state 状態語彙
 * @returns {number} 強さ（未知の語は connecting と同じ 1）
 */
export function severity(state) {
  const n = SEVERITY[state]
  return Number.isFinite(n) ? n : SEVERITY.connecting
}

/**
 * n 回目の失敗後に待つ時間（1→1000, 2→2000, 4→8000, 上限 15000）。
 *
 * @param {number} attempt 1 始まりの試行回数
 * @param {{base?: number, max?: number}} [opts] 調整用
 * @returns {number} 待ち時間（ms）
 */
export function reconnectDelay(attempt, { base = 1000, max = RECONNECT_MAX_MS } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  const delay = base * 2 ** (n - 1)
  return Math.min(max, Number.isFinite(delay) ? delay : max)
}

/**
 * 系統 1 つの内部記録を作る。
 *
 * @returns {{kind: string, everReady: boolean, brokenAt: number}} 記録
 */
function blankRecord() {
  return { kind: UNKNOWN, everReady: false, brokenAt: null }
}

/**
 * 全系統ぶんの空の記録を作る。
 *
 * @returns {Record<string, {kind: string, everReady: boolean, brokenAt: number}>} 記録
 */
export function blankSources() {
  const out = {}
  for (const source of TRANSPORT_SOURCES) out[source] = blankRecord()
  return out
}

/**
 * 系統 1 つの状態を時刻から決める（純関数）。
 *
 * 猶予中は「一度でも ready していれば recovering、していなければ connecting」。
 * `offline` は猶予を超えたときだけ（＝赤帯は 2 秒後・8 秒後に出る）。
 *
 * @param {string} source 系統
 * @param {{kind?: string, everReady?: boolean, brokenAt?: number}|null} record 内部記録
 * @param {number} nowMs 現在時刻（ms）
 * @param {Record<string, number>} [graceMs] 系統ごとの猶予
 * @returns {string} 状態語彙
 */
function sourceStateAt(source, record, nowMs, graceMs = GRACE_MS) {
  const rec = record && typeof record === 'object' ? record : null
  if (!rec || rec.kind === UNKNOWN) return 'connecting'
  if (rec.kind === 'ready') return 'ready'
  if (rec.kind === 'auth') return 'auth'
  const grace = Number(graceMs?.[source] ?? GRACE_MS[source] ?? 0)
  const since = rec.brokenAt === null || rec.brokenAt === undefined ? Number(nowMs) : Number(rec.brokenAt)
  const elapsed = Math.max(0, Number(nowMs) - since)
  if (elapsed < grace) return source === 'http' || rec.everReady ? 'recovering' : 'connecting'
  return 'offline'
}

/**
 * 集約状態を決める（純関数）。優先順は auth > offline > recovering > connecting > ready。
 *
 * まだ何も報告していない系統は**無視**する（チャットや端末タブを開いていないだけで
 * 丸が非接続になるのを防ぐ）。全系統が未報告なら `ready`（起動直後に赤くしない）。
 *
 * @param {Record<string, string|object>|null} sources 系統ごとの内部記録（状態語彙の文字列でもよい）
 * @param {number} nowMs 現在時刻（ms）
 * @param {Record<string, number>} [graceMs] 系統ごとの猶予
 * @returns {string} 集約状態
 */
export function aggregate(sources, nowMs, graceMs = GRACE_MS) {
  let worst = null
  for (const source of TRANSPORT_SOURCES) {
    const value = sources?.[source]
    if (value === undefined || value === null) continue
    if (typeof value === 'object' && value.kind === UNKNOWN) continue
    const state = typeof value === 'string' ? value : sourceStateAt(source, value, nowMs, graceMs)
    if (!TRANSPORT_STATES.includes(state)) continue
    if (worst === null || severity(state) > severity(worst)) worst = state
  }
  return worst ?? 'ready'
}

/**
 * 接続状態のハブ（アプリ全体で 1 つ）。
 *
 * @param {{now?: Function, graceMs?: Record<string, number>, setTimer?: Function, clearTimer?: Function}} [opts]
 *   `now` / `setTimer` / `clearTimer` はテスト用の差し替え口
 * @returns {{report: Function, state: Function, sourceState: Function, subscribe: Function, reset: Function}}
 *   ハブ
 */
export function createTransportHub({
  now = () => Date.now(),
  graceMs = GRACE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let records = blankSources()
  const listeners = new Set()
  let timerId = null

  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        /* 購読側の失敗で他の購読を止めない */
      }
    }
  }

  /**
   * 猶予が切れる瞬間に購読側へ知らせるタイマーを 1 本だけ張り直す
   * （`recovering` → `offline` の切り替わりを画面が踏めるようにする）。
   */
  const schedule = () => {
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
    const at = now()
    let next = 0
    for (const source of TRANSPORT_SOURCES) {
      const rec = records[source]
      if (rec.kind !== 'broken' || rec.brokenAt === null || rec.brokenAt === undefined) continue
      const expiry = rec.brokenAt + Number(graceMs?.[source] ?? GRACE_MS[source] ?? 0)
      if (expiry > at && (!next || expiry < next)) next = expiry
    }
    if (!next) return
    timerId = setTimer(() => {
      timerId = null
      schedule()
      notify()
    }, Math.max(0, next - now()) + 1)
  }

  const snapshot = () => aggregate(records, now(), graceMs)

  const sourceState = (source) => sourceStateAt(source, records[source], now(), graceMs)

  /**
   * 系統からの報告。報告名は系統ごとの現行語彙（`REPORT_KINDS`）。
   * `auth` は `ok` が来るまで固定する（401 のまま回復扱いにしない）。
   */
  const report = (source, type) => {
    const kind = REPORT_KINDS[source]?.[type]
    const rec = records[source]
    if (!rec || !kind) return sourceState(source)
    if (kind === 'ready') {
      rec.kind = 'ready'
      rec.everReady = true
      rec.brokenAt = null
    } else if (kind === 'auth') {
      rec.kind = 'auth'
      rec.brokenAt = null
    } else if (rec.kind !== 'auth') {
      rec.kind = 'broken'
      // 切断開始時刻は上書きしない（再試行のたびに猶予を張り直すと帯が永遠に出ない）
      if (rec.brokenAt === null) rec.brokenAt = now()
    }
    schedule()
    notify()
    return sourceState(source)
  }

  const subscribe = (fn) => {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }

  const reset = () => {
    records = blankSources()
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
    notify()
  }

  return { report, state: snapshot, sourceState, subscribe, reset }
}

/**
 * アプリ全体の正本（丸・赤帯・GW ピル・チャット帯・端末状態が同じこれを見る）。
 * テストは `createTransportHub()` で隔離したハブを作る。
 */
export const transport = createTransportHub()
