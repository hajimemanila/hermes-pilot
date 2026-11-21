/**
 * デモのルーティング（`/api/...` を「どのハンドラで答えるか」に分類する純関数）。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */

/**
 * パスを「どのハンドラで答えるか」に分類する純関数。
 *
 * @param {string} path `/api/...`（クエリ付き可）
 * @returns {{name: string, id?: string, params: URLSearchParams}} 分類結果
 */
export function demoRoute(path) {
  const raw = String(path ?? '')
  const [p, query = ''] = raw.split('?')
  const params = new URLSearchParams(query)
  const parts = p.split('/').filter(Boolean)
  const at = (i) => parts[i] ?? ''
  if (p === '/api/overview') return { name: 'overview', params }
  if (p === '/api/review') return { name: 'review.list', params }
  if (p === '/api/review/feed') return { name: 'review.feed', params }
  if (p === '/api/review/chat-reports') return { name: 'review.chatReports', params }
  // 1 会話ぶんの完了報告（`MemosPane` が未読バッジの材料に読む。本番 `/api/review/chat-report`）
  if (p === '/api/review/chat-report') return { name: 'review.chatReport', params }
  if (p === '/api/review/library') return { name: 'review.library', params }
  if (p === '/api/review/targets') return { name: 'review.targets', params }
  if (p.startsWith('/api/review/annotation')) return { name: 'review.annotationNew', params }
  if (parts[1] === 'review' && parts[2]) {
    const id = decodeURIComponent(parts[2])
    const leaf = parts[3] ?? ''
    if (leaf === 'data') return { name: 'review.data', id, params }
    if (leaf === 'annotation') return { name: 'review.annotation', id, params }
    if (leaf === 'answer') return { name: 'review.answer', id, params }
    if (leaf === 'approve') return { name: 'review.approve', id, params }
    if (leaf === 'reopen') return { name: 'review.reopen', id, params }
    if (leaf === 'worker') return { name: 'review.worker', id, params }
    if (leaf === 'session') return { name: 'review.session', id, params }
    // 非 JSON（画像・HTML）。デモでは img/iframe のシムが差し替えるので、ここは marker を返す。
    if (leaf === 'image') return { name: 'review.image', id, params }
    if (leaf === 'thumb') return { name: 'review.thumb', id, params }
    if (leaf === 'sheet') return { name: 'review.sheet', id, params }
    if (leaf === 'view') return { name: 'review.view', id, params }
    return { name: 'review.misc', id, params }
  }
  if (p === '/api/boards') return { name: 'boards', params }
  if (parts[1] === 'boards' && parts[2] && parts[3] === 'tasks') {
    const boardSlug = decodeURIComponent(parts[2])
    // D92: 整理モードの一括アーカイブ（`/tasks/bulk-archive` を taskId と誤読しない）
    if (parts[4] === 'bulk-archive') return { name: 'board.bulkArchive', id: boardSlug, params }
    const taskId = parts[4] ? decodeURIComponent(parts[4]) : ''
    if (!taskId) return { name: 'board.tasks', id: boardSlug, params }
    if (parts[5] === 'diff') return { name: 'board.taskDiff', id: boardSlug, taskId, params }
    if (parts[5] === 'worker') return { name: 'board.taskWorker', id: boardSlug, taskId, params }
    if (parts[5] === 'abort') return { name: 'board.taskAbort', id: boardSlug, taskId, params }
    return { name: 'board.task', id: boardSlug, taskId, params }
  }
  if (p === '/api/inbox') return { name: 'inbox', params }
  if (p === '/api/specs') return { name: 'specs', params }
  // SPEC-COHERENCE §3.4: ライブ診断（デモは固定フィクスチャを返す）
  if (p === '/api/coherence/report') return { name: 'coherence.report', params }
  // V6 §3.4: 仕様書の本文（MD プレビュー）
  if (p === '/api/specs/content') return { name: 'specs.content', params }
  // D92: SPEC のアーカイブ退避（ヘッダ追記）
  if (p === '/api/specs/archive') return { name: 'specs.archive', params }
  if (p === '/api/specs/launch') return { name: 'specs.launch', params }
  if (p === '/api/specs/reports') return { name: 'specs.reports', params }
  // V6 §3.2: Architect（仕様策定 → SPEC）と進行バーの材料
  if (p === '/api/architect/config') return { name: 'architect.config', params }
  if (p === '/api/architect/jobs') return { name: 'architect.jobs', params }
  if (p === '/api/architect/seed') return { name: 'architect.seed', params }
  // V7 §3.1: 進行バーの ×（ジョブ破棄）。本物と同じ `POST /api/architect/jobs/:id/dismiss`
  if (parts[1] === 'architect' && parts[2] === 'jobs' && parts[3] && parts[4] === 'dismiss') {
    return { name: 'architect.jobDismiss', id: decodeURIComponent(parts[3]), params }
  }
  if (p === '/api/live') return { name: 'live', params }
  if (p === '/api/usage') return { name: 'usage', params }
  // V10 §3.3 / D47: デモでも本番と同じエンドポイントを拾う（画面側にデモ分岐を作らない）
  if (p === '/api/pipeline/status') return { name: 'pipeline.status', params }
  if (p === '/api/pipeline/profile') return { name: 'pipeline.profile', params }
  if (p === '/api/pipeline/optimize') return { name: 'pipeline.optimize', params }
  if (p === '/api/auth/pairing') return { name: 'auth.pairing', params }
  if (p === '/api/logs') return { name: 'logs', params }
  if (p === '/api/search') return { name: 'search', params }
  if (p === '/api/audit') return { name: 'audit', params }
  if (p === '/api/sessions') return { name: 'sessions', params }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'transcript') {
    return { name: 'sessions.transcript', id: decodeURIComponent(parts[2]), params }
  }
  if (p === '/api/snippets' || p === '/api/snippets/term') {
    return { name: 'snippets', kind: p.endsWith('/term') ? 'term' : 'chat', params }
  }
  if (p === '/api/memos') return { name: 'memos.list', params }
  if (parts[1] === 'memos' && parts[2]) return { name: 'memos.item', id: decodeURIComponent(parts[2]), params }
  if (p === '/api/repos') return { name: 'repos', params }
  if (p === '/api/telemetry/receipt') return { name: 'receipt', params }
  // Discord ディープリンク（本番 `/api/discord/session`）。デモは「リンク無し」を明示して返す。
  if (p === '/api/discord/session') return { name: 'discord.session', params }
  if (p.startsWith('/api/auth/')) return { name: 'auth', params }
  // D90: 全タスク緊急停止（ESTOP ＋ 実行中一括中断）。本番と同じ 1 本のエンドポイント。
  if (p === '/api/emergency/stop-all') return { name: 'emergency.stopAll', params }
  if (p.startsWith('/api/gateway/')) {
    // 緊急停止は状態を持つ（`/api/overview` の `paused` とタスク一覧へ連動する）
    const action = parts[2] ?? ''
    if (action === 'pause' || action === 'resume') return { name: `gateway.${action}`, action, params }
    return { name: 'gateway', params }
  }
  if (p === '/api/client-error') return { name: 'clientError', params }
  return { name: 'fallback', params }
}
