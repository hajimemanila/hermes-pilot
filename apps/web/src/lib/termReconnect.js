/**
 * 端末（PTY）WebSocket の再接続間隔。
 *
 * ブリッジの再起動（`launchctl kickstart -k …` や `hermes-pilot service restart`）は
 * **端末ソケットそのものを切る**。切れたまま何もしないと「未接続」で固まり、
 * タブを移動しても戻らない（ペインは `visibility:hidden` で生かしたままなので再マウントもされない）。
 *
 * 刻み（1s → 2s → 4s … 最大 15s）の正本は `lib/transport.js` に移した
 * （SPEC-EXECUTION-MODE-INTEGRITY / D96「バックオフ式も `transport.js` に移し、
 * `termReconnect.js` は再エクスポートのみ」）。ここは既存の import 経路を保つだけ。
 */

export { RECONNECT_MAX_MS, reconnectDelay } from './transport.js'
