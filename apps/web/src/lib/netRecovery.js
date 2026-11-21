/**
 * 通信断（Tailscale 未接続・移動中の不安定回線）からの復帰判定とタイムアウト補助（純関数）。
 *
 * React / DOM に依存しないため Node の `node --test` からそのまま検証できる。
 */

/** GET リクエストの既定タイムアウト（パケット破棄で無限待ちになるのを防ぐ）。 */
export const DEFAULT_GET_TIMEOUT_MS = 15_000

/** 接続確認 `/api/overview` 用の短めタイムアウト。 */
export const OVERVIEW_TIMEOUT_MS = 8_000

/** WebSocket の `CONNECTING` ハングを切るハンドシェイク上限。 */
export const WS_HANDSHAKE_TIMEOUT_MS = 10_000

/** 開いたまま半開きになった WebSocket の生存確認タイムアウト。 */
export const WS_PROBE_TIMEOUT_MS = 4_000

/** 非オフライン系エラーの背景トースト連続表示を抑える間隔。 */
export const ERROR_TOAST_COOLDOWN_MS = 30_000

/**
 * HTTP メソッドと明示指定から `fetch` タイムアウト（ms）を決める（0 は無効）。
 *
 * @param {string} [method] HTTP メソッド
 * @param {number|null|undefined} [timeoutMs] 呼び出し側の明示指定
 * @returns {number} タイムアウト（ms）。0 以下なら無効
 */
export function resolveTimeoutMs(method = 'GET', timeoutMs = undefined) {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs
  }
  if (timeoutMs === 0 || timeoutMs === null) return 0
  return String(method ?? 'GET').toUpperCase() === 'GET' ? DEFAULT_GET_TIMEOUT_MS : 0
}

/**
 * 接続状態が「非接続/エラー → 正常（ok）」へ遷移した瞬間か。
 *
 * @param {string} prevConn 遷移前の接続状態
 * @param {string} nextConn 遷移後の接続状態
 * @returns {boolean} 回復した瞬間なら true
 */
export function isConnectivityRecovery(prevConn, nextConn) {
  return prevConn !== 'ok' && nextConn === 'ok'
}

/**
 * 例外が一時的なオフライン／タイムアウト系かどうかを判定する。
 *
 * @param {unknown} err 捕捉した例外
 * @returns {boolean}
 */
export function isOfflineError(err) {
  if (!err || typeof err !== 'object') return false
  return Boolean(
    err.code === 'OFFLINE' ||
      err.code === 'TIMEOUT' ||
      err.timedOut === true ||
      err.name === 'AbortError' ||
      err.name === 'TimeoutError',
  )
}

/**
 * エラーをトースト通知すべきか判定する（手動更新時は常に出し、バックグラウンドの
 * オフラインエラーは上部のオフライン帯に任せて連打を抑える）。
 *
 * @param {{silent?: boolean, offline?: boolean, lastAt?: number, now?: number, cooldownMs?: number}} [opts]
 * @returns {boolean}
 */
export function shouldNotifyError({
  silent = false,
  offline = false,
  lastAt = 0,
  now = Date.now(),
  cooldownMs = ERROR_TOAST_COOLDOWN_MS,
} = {}) {
  if (!silent) return true
  if (offline) return false
  return !lastAt || now - lastAt >= cooldownMs
}
