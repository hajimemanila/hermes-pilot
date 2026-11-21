/**
 * 端末（PTY）WebSocket の再接続間隔。
 *
 * ブリッジの再起動（`launchctl kickstart -k …` や `hermes-pilot service restart`）は
 * **端末ソケットそのものを切る**。切れたまま何もしないと「未接続」で固まり、
 * タブを移動しても戻らない（ペインは `visibility:hidden` で生かしたままなので再マウントもされない）。
 *
 * 1s → 2s → 4s … 最大 15s で繋ぎ直す（`useChatSocket` と同じ刻み）。
 */

/** 上限（ms）。 */
export const RECONNECT_MAX_MS = 15000

/**
 * n 回目の失敗後に待つ時間。
 * @param {number} attempt 1 始まりの試行回数
 * @param {{base?: number, max?: number}} [opts] 調整用
 * @returns {number} 待ち時間（ms）
 */
export function reconnectDelay(attempt, { base = 1000, max = RECONNECT_MAX_MS } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  const delay = base * 2 ** (n - 1)
  return Math.min(max, Number.isFinite(delay) ? delay : max)
}
