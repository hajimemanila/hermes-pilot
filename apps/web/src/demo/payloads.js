/**
 * デモの応答ペイロード（概要・レシート・保存領域・設定・ログ・検索・コヒーレンス診断）。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import { DEMO_BOARD, DEMO_REPO_PATH, DEMO_SESSION, DEMO_SPEC_PATH, MIN } from './fixtures.js'
import { demoArchitectJobs, demoPublicJob } from './architectDemo.js'
import { createArchitectState, demoSpects, publish, state } from './store.js'

/**
 * `GET /api/coherence/report` のデモ応答（SPEC-COHERENCE §3.4 / D82）。
 *
 * 本番は対象リポジトリで `analyzeCoherence()` を走らせる。デモはバックエンドを持たないので、
 * スイープシートのバッジ・推奨プリセット・起点ファイルが成立する最小の信号集合を返す。
 * `layers` も本番と同じ形（汎用 Layer 1 ＋ リポジトリ固有 Layer 2）で揃えておく。
 * @returns {object} 診断レポート
 */
export function demoCoherenceReport() {
  return {
    ok: false,
    demo: true,
    generatedAt: new Date().toISOString(),
    repoRoot: '/demo/hermes-pilot',
    layers: { universal: true, repoConfig: true, repoChecker: true },
    hardFails: [
      { rule: 'event-contract', file: 'apps/web/src/App.jsx', message: 'event dispatched outside the shared contract' },
      { rule: 'api-parity', file: 'apps/web/src/demo/mockApi.js', message: 'route exists in the web layer only' },
    ],
    softSignals: [
      { rule: 'debt-spike', file: 'apps/web/src/features/ChatPane.jsx', message: '9 TODO/FIXME markers in recently changed code' },
      { rule: 'spec-sprawl', file: 'docs/SPEC-PILOT-V11.md', message: '7 active specs without an archive status' },
    ],
    hotspots: [
      { file: 'apps/web/src/styles.css', touches: 10, lines: 7012 },
      { file: 'apps/web/src/features/ChatPane.jsx', touches: 6, lines: 3331 },
    ],
    summary: {
      hardFailCount: 2,
      softSignalCount: 2,
      hotspotCount: 2,
      activeSpecCount: 7,
      archivedSpecCount: 3,
      deprecatedRoutes: 1,
    },
    recommendedSweep: 'contracts',
  }
}
export function demoPipelineStatus() {
  const optimized = Boolean(state.pipeline?.optimized)
  const pilotProfile = String(state.pipeline?.profile || 'mobile')
  const bundled = ['quick-review', 'annotation', 'spec-architect']
  return {
    ok: true,
    pilotProfile,
    availableProfiles: ['mobile', 'default'],
    soul: {
      applied: optimized,
      profile: pilotProfile,
      path: pilotProfile === 'default' ? '~/.hermes/SOUL.md' : `~/.hermes/profiles/${pilotProfile}/SOUL.md`,
    },
    hermes: { present: optimized ? bundled.slice() : ['quick-review', 'annotation'] },
    bundled: { names: bundled },
    demo: true,
  }
}

/**
 * 擬似 QR の行列（21×21・`'0'`/`'1'`）を作る。
 *
 * V10 §3.3 / D47: 本物の QR ではないが、**3 隅のファインダーパターン**と分離帯・
 * タイミングパターンを持ち、同じ URL（＝同じ入力）なら同じ絵になる決め打ちのデータで埋める。
 * `PairQr` は行列をそのまま canvas に描くので、これで「QR らしい」見た目になる。
 *
 * @param {number} [size] 一辺のモジュール数（既定 21 = QR version 1）
 * @returns {string[]} 行ごとの `'0'`/`'1'` 文字列
 */
export function demoQrRows(size = 21) {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => 0))
  const set = (r, c, v) => {
    if (r >= 0 && c >= 0 && r < size && c < size) grid[r][c] = v ? 1 : 0
  }
  // ファインダー（7x7 の枠＋中心 3x3）を 3 隅に置き、外周 1 モジュールを分離帯（白）にする
  const origins = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]
  for (const [r0, c0] of origins) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        if (!inside) {
          set(r0 + r, c0 + c, 0)
          continue
        }
        const ring = r === 0 || r === 6 || c === 0 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(r0 + r, c0 + c, ring || core)
      }
    }
  }
  /** 予約領域（ファインダー・分離帯・タイミング行/列）か。 */
  const reserved = (r, c) => {
    for (const [r0, c0] of origins) {
      if (r >= r0 - 1 && r <= r0 + 7 && c >= c0 - 1 && c <= c0 + 7) return true
    }
    return r === 6 || c === 6
  }
  // データ領域は決め打ちの擬似パターン（線形合同法・同じ並びを毎回作る）
  let seed = 0x5eed
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved(r, c)) continue
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      set(r, c, (seed >> 16) & 1)
    }
  }
  return grid.map((row) => row.join(''))
}

/**
 * `GET /api/logs?file=&lines=` のデモ応答（`SettingsPane` の「ログを開く」）。
 *
 * @param {string} name ログ名（`gateway` / `errors` 等）
 * @param {number} lines 末尾何行か
 * @returns {{ok: true, file: string, text: string, demo: true}} 応答
 */
export function demoLogText(name = 'gateway', lines = 200) {
  const at = new Date(state.now).toISOString()
  const body = [
    `${at} INFO  demo: bridge is simulated (no real gateway is running)`,
    `${at} INFO  demo: /api/live polled by the PWA shell`,
    `${at} INFO  demo: architect job j_demo_0 is awaiting_review`,
    `${at} INFO  demo: review t_demo_review -> 3 questions, recommended answers`,
    `${at} INFO  demo: pipeline watcher idle (nothing to file)`,
    `${at} INFO  demo: gateway heartbeat ok (0.23.1 simulation)`,
  ]
  const n = Math.min(Math.max(Number(lines) || 200, 1), 1000)
  return { ok: true, file: String(name || 'gateway'), text: body.slice(-n).join('\n'), demo: true }
}

/**
 * `GET /api/search?q=` のデモ応答（`SearchSheet` が読む抜粋の一覧）。
 *
 * 本番は state.db の FTS5 を引くが、デモは固定の 3 件を `q` で絞るだけ。
 * 該当が無ければ `hits: []`（画面は「該当なし」を出す）。
 *
 * @param {string} q 検索語
 * @returns {{ok: true, tookMs: number, hits: Array<object>, demo: true}} 応答
 */
export function demoSearchHits(q = '') {
  const base = [
    {
      profile: 'default',
      messageId: 'm_demo_1',
      sessionId: DEMO_SESSION,
      snippet: '…the visual gate is waiting for a redline stamp or an approval…',
      role: 'assistant',
      at: state.now - 6 * MIN,
      sessionTitle: 'Demo — A2B pipeline in four steps',
      source: 'mobile',
    },
    {
      profile: 'default',
      messageId: 'm_demo_2',
      sessionId: DEMO_SESSION,
      snippet: '…file the batches for the demo spec, then run npm run verify…',
      role: 'user',
      at: state.now - 9 * MIN,
      sessionTitle: 'Demo — A2B pipeline in four steps',
      source: 'mobile',
    },
    {
      profile: 'default',
      messageId: 'm_demo_3',
      sessionId: 'demo-review-01',
      snippet: '…Accept All Recommended answers q1..q3 with the recommended options…',
      role: 'user',
      at: state.now - 14 * MIN,
      sessionTitle: 'Quick Review — three design decisions',
      source: 'discord',
    },
  ]
  const text = String(q ?? '').trim().toLowerCase()
  const hits = text
    ? base.filter(
        (h) =>
          h.snippet.toLowerCase().includes(text) ||
          String(h.sessionTitle ?? '').toLowerCase().includes(text) ||
          String(h.sessionId ?? '').toLowerCase().includes(text),
      )
    : []
  return { ok: true, tookMs: 4, hits, demo: true }
}

/**
 * `fetch` の代わり。パスは本物の API と同じ。
 *
 * @param {string} path `/api/...`
 * @param {{method?: string, body?: any}} [opts] オプション
 * @returns {Promise<any>} 応答（本物の JSON と同じ形）
 */
export function itemById(id) {
  return state.reviewItems.find((x) => x.id === id) || null
}

export function overviewBody() {
  const running = state.tasks.filter((t) => t.status === 'running').length
  return {
    hermes: { version: '0.23.1', model: 'demo', gateway: 'running', sessions: 1, profiles: ['demo'] },
    system: { cpuCount: 10, memory: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 50 }, disk: null, load: null, uptime: null },
    bridge: { ok: true, version: '0.1.0', port: 0, startedAt: state.now, uptimeSec: Math.round((Date.now() - state.now) / 1000) },
    kanban: {
      boards: 1,
      running,
      blocked: state.reviewItems.filter((x) => x.status === 'blocked').length,
      ready: state.tasks.filter((t) => t.status === 'ready').length,
      reviewWaiting: state.reviewItems.filter((x) => x.status === 'blocked').length,
    },
    runningTasks: running,
    checkedAt: Date.now(),
    /** 緊急停止（本番 `ops.paused()` と同じ形）。`gateway.pause` / `gateway.resume` が更新する。 */
    paused: state.demoOps.paused,
    demo: true,
  }
}

/**
 * `GET /api/telemetry/receipt` のデモ応答。
 *
 * 形は本物（`apps/bridge/src/telemetry.js` の `buildReceipt`）に合わせる。
 * 数値は「4 ステップを完走した直後」の見本（402 tests / $1.08 / 99.4% cache / 0 typed chars）。
 */
export function receiptBody() {
  const now = Date.now()
  const base = state.receipt || {}
  return {
    ok: true,
    generatedAt: Number(base.at) || now,
    board: DEMO_BOARD,
    spec: DEMO_SPEC_PATH,
    label: 'Demo pipeline',
    windowHours: 24,
    status: 'done',
    kpi: {
      costUsd: 1.08,
      cacheHitRate: 0.994,
      cachePct: 99,
      savedUsd: 12.4,
      savedRatio: 0.9,
      cacheReadTokens: 12_340_000,
      inputTokens: 12_400_000,
      outputTokens: 96_000,
      toolCalls: 48,
      sessions: 1,
      humanTaps: 12,
      redlines: 3,
      typedChars: 0,
      zeroTypingScore: 100,
      batchesDone: 3,
      batchesTotal: 3,
      durationMin: 6,
      activeDurationMin: 6,
      wallDurationMin: 11,
      durationCapped: false,
      apiCalls: 48,
      totalTokens: 12_448_000,
      tests: 402,
      pwaChecks: 34,
    },
    scope: {
      scoped: true,
      taskIds: ['demo-1', 'demo-2', 'demo-3'],
      batchIds: ['DEMO-1', 'DEMO-2', 'DEMO-3'],
      tasks: 3,
      intervals: 2,
      usage: { sessionIds: 1, sinceMs: null, untilMs: null, fallback: false },
      usageScoped: true,
    },
    missing: [],
    demo: true,
  }
}

/**
 * 完走レポートに付く汎用予兆検知の見本（SPEC-COHERENCE §3.5 / COH-5 / D83）。
 *
 * 形は本番 `pipeline-watcher.js` の `coherence_alert`
 * （`{summary, recommendedSweep, highlights, layers}`）と同じ。自動起票はしない。
 *
 * @returns {object} デモ用の `coherence_alert`
 */
export function demoCoherenceAlert() {
  return {
    summary: { hardFailCount: 0, softSignalCount: 3, hotspotCount: 1 },
    recommendedSweep: 'hotspots',
    highlights: [
      'apps/web/src/features/ChatPane.jsx changed 6 times in 14 days',
      'apps/bridge/src/server.js is 1180 lines (limit 900)',
      '3 active SPEC files (limit 6); archive finished specs',
    ],
    layers: { universal: true, repoConfig: true, repoChecker: true },
  }
}

/** Step 2 の完了（全バッチ done）で統合サマリと完了レシートを作る。 */
export function finishPipeline() {
  const now = Date.now()
  const coherenceAlert = demoCoherenceAlert()
  const reportMarkdown = [
    '# Demo pipeline — 3 batches',
    '',
    '- [DEMO-1] Spec interview and one-tap approval — done',
    '- [DEMO-2] Visual gate — redline stamp and before/after — done',
    '- [DEMO-3] Summary and completion receipt — done',
    '',
    'verify: npm run verify -> exit 0; 402 tests',
    '',
    '#### 🧭 Coherence Signals',
    '- Recommended sweep: hotspots',
    '- 0 hard fail(s) · 3 soft signal(s) · 1 hotspot(s)',
    ...coherenceAlert.highlights.map((h) => `- ${h}`),
  ].join('\n')
  state.report = {
    at: now,
    board: DEMO_BOARD,
    spec: DEMO_SPEC_PATH,
    markdown: reportMarkdown,
    coherence_alert: coherenceAlert,
    demo: true,
  }
  state.receipt = {
    ok: true,
    at: now,
    tests: 402,
    cost: 1.08,
    cacheHitRate: 0.994,
    typedChars: 0,
    saved: 12.4,
    batches: 3,
    tasks: 3,
    markdown: reportMarkdown,
    demo: true,
  }
  state.chatReports = [
    {
      sessionId: DEMO_SESSION,
      taskId: 't_demo_report',
      label: 'Demo pipeline',
      kind: 'pipeline',
      at: now,
      markdown: reportMarkdown,
      summary: '3 batches done — verify exit 0',
      board: DEMO_BOARD,
      demo: true,
    },
  ]
  publish('pipeline')
}

/**
 * 起票したバッチを `tickMs` 間隔で `ready -> running -> done` に進める。
 *
 * Architect の `[ARCH]` タスク（`assignee === 'architect'`）はツアーのバッチではないので触らない
 * （触ると Seed のジョブが勝手に done になり、進行バーの材料が消える）。
 */
export function advanceBatches(gen) {
  // 途中でツアーを最初からやり直したら、古いタイマーは黙って降りる
  if (gen !== state.gen) return
  const pending = state.tasks.filter(
    (t) => (t.status === 'ready' || t.status === 'running') && t.assignee !== 'architect',
  )
  const next = pending.find((t) => t.status === 'ready') || pending.find((t) => t.status === 'running')
  if (!next) {
    if (state.tasks.some((t) => /^\[DEMO-\d\]/.test(t.title)) && !state.report) finishPipeline()
    return
  }
  next.status = next.status === 'ready' ? 'running' : 'done'
  next.updatedAt = Date.now()
  if (next.status === 'done') next.result = 'done'
  publish('tasks')
  setTimeout(() => advanceBatches(gen), state.tickMs)
}

/** テスト用: 状態遷移の間隔を縮める（既定 800ms）。 */
export function setDemoTick(ms) {
  state.tickMs = Math.max(0, Number(ms) || 0)
}
