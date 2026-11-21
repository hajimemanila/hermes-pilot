/**
 * デモモード（`npm run build:demo` / `VITE_DEMO_MODE=1`）専用のインメモリ API。
 *
 * 目的（SPEC-PILOT-V5 §3.4 / D27）: バックエンド（ブリッジ・ゲートウェイ・カンバン DB）が
 * 一切無い静的ホスティングでも、A2B パイプラインの 4 ステップを体験できること。
 *
 * 約束:
 * - **本番バンドルに混ざらない**: `api.js` / `openSocket()` が
 *   `import.meta.env.VITE_DEMO_MODE === '1'` の分岐の中でだけこのモジュールを動的 import する。
 *   Vite は `import.meta.env.VITE_DEMO_MODE` を静的に畳むので、通常ビルドではこの
 *   ファイルはチャンクとしても生成されない（`npm run verify` 後に `apps/web/dist` を grep して確認）。
 * - **外部依存ゼロ**: 画像は SVG 文字列から data URL を作る（ネットワークも外部ファイルも使わない）。
 * - **状態は 1 枚のオブジェクト**: `createDemoState()` を作り直せばツアーを最初から再生できる。
 *
 * 画面側は `demoFetch(path, opts)` を `fetch` の代わりに呼ぶだけ。パスは本物の
 * ブリッジ API と同じ形にしてあるので、画面コンポーネント側にデモ分岐は要らない。
 */

import { DEMO_SNIPPETS, DEMO_TERM_SNIPPETS } from './snippets.js'

export const DEMO_SPEC_PATH = 'docs/SPEC-DEMO-V1.md'
/** V6: 2・3 件目の SPEC（複数 SPEC のアコーディオンと MD プレビューを体験するため）。 */
export const DEMO_SPEC_V5_PATH = 'docs/SPEC-PILOT-V5.md'
export const DEMO_SPEC_V4_PATH = 'docs/SPEC-PILOT-V4.md'
export const DEMO_BOARD = 'mobile'
export const DEMO_SESSION = 'demo-a2b-01'
/** デモのリポジトリ（`/api/specs*` と `/api/repos` が返す値）。 */
export const DEMO_REPO = 'hermes-pilot-demo'
export const DEMO_REPO_PATH = '/demo/hermes-pilot'
/**
 * V11 §3.3 / D51: デモの Architect ランナー表示名。
 *
 * ランナーは `Hermes Native` だけになったので、デモもその 1 種類しか返さない
 * （進行バーと Seed シートのランナーピルが本番と同じ文字列になる）。
 */
export const DEMO_RUNNER_LABEL = 'Hermes Native'
/** バッチの状態遷移（`ready -> running -> done`）の間隔。 */
export const DEMO_TICK_MS = 800
export const STEPS = 4

/** 体験ツアーの段階（1..4）。`progress` から純関数で決める（テストで固定する）。 */
export function stepIndex(progress) {
  const p = progress || {}
  if (!p.review) return 1
  if (!p.batches) return 2
  if (!p.visual) return 3
  return 4
}

/** 進捗の初期値。 */
export function emptyProgress() {
  return { review: false, batches: false, visual: false, receipt: false }
}

const MIN = 60_000

/** 無印（Spec 行の無い）タスクを拾ってよい猶予（ms）。`specs.SPEC_MTIME_SLACK_MS` と同じ値。 */
const SPEC_MTIME_SLACK_MS = 5000

/** デモタスクの Spec パス（`spec` 優先・本文の `Spec:` 行・先頭 5 行の `docs/SPEC-*.md`）。 */
function demoTaskSpecOf(task) {
  const direct = String(task?.spec ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (direct) return direct
  const body = String(task?.body ?? '')
  if (!body) return null
  const line = /^Spec:\s*(.+?)\s*$/m.exec(body)
  if (line) return String(line[1]).replace(/\\/g, '/').replace(/^\.\//, '').trim() || null
  const head = body.split(/\r?\n/).slice(0, 5).join('\n')
  const leg = /(?:docs\/)?SPEC[A-Za-z0-9._-]*\.md/i.exec(head)
  return leg ? leg[0].replace(/\\/g, '/').replace(/^\.\//, '').trim() : null
}

/** デモタスクの最新タイムスタンプ（ms）。不明は 0。 */
function demoTaskStampMs(task) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  return Math.max(n(task?.createdAt), n(task?.startedAt), n(task?.completedAt))
}

/** 3 問の設計判断（各問に推奨 1 つ。`⚡ Accept All Recommended` の材料）。 */
export function demoQuestions() {
  return [
    {
      id: 'q1',
      text: 'Which screen should the guided tour open first?',
      options: [
        {
          id: 'A',
          label: 'Review — one tap on the decision sheet',
          detail: 'Opens the pending Quick Review sheet with the recommended answers pre-selected.',
          recommended: true,
        },
        { id: 'B', label: 'Tasks — read the board first', detail: 'Slower start; the tour would need an extra tap.' },
      ],
    },
    {
      id: 'q2',
      text: 'How should the completion receipt be shared?',
      options: [
        {
          id: 'A',
          label: 'Copy an X post + download the 1200x630 PNG',
          detail: 'Matches SPEC-PILOT-V5 D26: the receipt is a shareable card.',
          recommended: true,
        },
        { id: 'B', label: 'PNG only', detail: 'No text for a post.' },
      ],
    },
    {
      id: 'q3',
      text: 'Which Vibe mode should the demo start in on a PC?',
      options: [
        { id: 'A', label: 'Dopamine', detail: 'Full reward feedback; it is the default for first run.', recommended: true },
        { id: 'B', label: 'Serotonin', detail: 'Quiet mode; keeps the standard haptics only.' },
      ],
    },
  ]
}

/** 初期レビュー待ち（Step 1 の設計判断シート ＋ Step 3 の視覚検収）。 */
export function initialReviewItems(now = Date.now()) {
  return [
    {
      id: 't_demo_review',
      board: DEMO_BOARD,
      title: '[DEMO-1] Interactive demo — three design decisions',
      status: 'blocked',
      assignee: 'mobile',
      createdAt: now - 2 * MIN,
      completedAt: null,
      result: null,
      progress: { lastEvent: 'blocked', lastEventAt: now - MIN, heartbeatAt: now - MIN, startedAt: now - 2 * MIN },
      review: {
        label: 'demo-review-01',
        image: null,
        hasCompare: false,
        target: 'hermes-pilot-demo',
        repo: { id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)' },
        chat: DEMO_SESSION,
        mode: 'standard',
        round: 1,
        sheet: null,
        exists: true,
        title: 'Interactive demo — three design decisions',
        topic: 'Every question has a recommended option; Accept All finishes the step.',
      },
    },
    {
      id: 't_demo_visual',
      board: DEMO_BOARD,
      title: '[DEMO-2] Toast overlaps the bottom navigation',
      status: 'blocked',
      assignee: 'mobile',
      createdAt: now - 90_000,
      completedAt: null,
      result: null,
      progress: { lastEvent: 'blocked', lastEventAt: now - 60_000, heartbeatAt: now - 60_000, startedAt: now - 90_000 },
      review: {
        label: 'demo-visual-01',
        image: 'demo/visual-01.svg',
        hasCompare: true,
        target: 'hermes-pilot-demo',
        repo: { id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)' },
        chat: DEMO_SESSION,
        mode: 'annotation',
        round: 1,
        sheet: null,
        exists: true,
        title: 'Toast overlaps the bottom navigation',
        topic: 'The toast sits on top of the navigation bar; lift it above the bar.',
      },
    },
  ]
}

/**
 * Step 2 の一括起票で作られるバッチ（本編 SPEC の 3 バッチと 1:1）。
 *
 * V6（D29 / D30 / D32）: **複数 SPEC を返す**。1 件目がツアーの本編、2・3 件目は
 * 「SPEC セレクタのアコーディオン」「MD プレビュー」「バッチ詳細」を試すための追加分
 * （実物の V5 / V4 仕様書のダイジェスト）。
 * 並びは「本編が先頭」（`specPath` の既定値になるため。本物の `specs.listSpecs` は mtime 順）。
 * 先頭 SPEC だけが `[DEMO-n]` バッチを持つ（起票→進行→レシートのツアーはこの 3 件で回す）。
 */
export function demoSpects(now = Date.now()) {
  // Launchpad は既定でアクティブ SPEC だけを出す（`?includeArchived=1` は本番のみ）。
  // アーカイブ済みは `archivedSpecs` に分けて返し、「Show archived (N)」の材料にする（D84）。
  // D92: デモで退避した SPEC（`archivedSpecPaths`）も同じ扱いに落とす。
  const all = demoSpecsWithArchive(now)
  const active = all.filter((s) => !s.archived)
  const archived = all.filter((s) => s.archived)
  // `GET /api/specs` の応答契約（D91）: 各要素は `runTaskIds` を持つ（デモはラン記録を持たない）。
  const withRuns = (list) => list.map((spec) => ({ ...spec, runTaskIds: [] }))
  return {
    ok: true,
    repo: DEMO_REPO,
    label: 'hermes-pilot (demo)',
    path: DEMO_REPO_PATH,
    board: DEMO_BOARD,
    specs: withRuns(active),
    archivedSpecs: withRuns(archived),
    archivedCount: archived.length,
  }
}

/**
 * デモの SPEC 一覧に「このセッションで退避したもの」（`state.archivedSpecPaths`）を重ねる。
 *
 * `demoSpects`（Launchpad）と `demoSpecContent`（MD プレビュー）が同じ状態を見るための 1 箇所。
 *
 * @param {number} [now] 時刻
 * @returns {Array<object>} SPEC 一覧（アーカイブ済みは `archived: true`）
 */
function demoSpecsWithArchive(now = Date.now()) {
  return currentSpecs(now).map((s) =>
    state.archivedSpecPaths.includes(s.path) ? { ...s, archived: true, status: 'archived' } : s,
  )
}

/**
 * アーカイブ済みのデモ SPEC（3 件）。
 *
 * `Show archived (3)` を実機幅で確認するための固定データ。バッチは 1〜2 件だけ持ち、
 * `archived: true` / `status: 'archived'` を付ける（本番の `specs.listSpecs` と同じ形）。
 *
 * @param {number} [now] 時刻
 * @returns {Array<object>} アーカイブ済み SPEC
 */
export function demoArchivedSpecList(now = Date.now()) {
  const mk = (path, title, n, ageDays) => ({
    path,
    title,
    mtime: now - ageDays * 24 * 60 * MIN,
    valid: true,
    archived: true,
    status: 'archived',
    batches: Array.from({ length: n }, (_, i) => ({
      id: `AR${i + 1}`,
      title: `${title.split('—')[0].trim()} step ${i + 1}`,
      objective: 'Shipped earlier; kept for history.',
      mode: 'zero-stop',
      section: '',
    })),
  })
  return [
    mk('docs/SPEC-DEMO-V3.md', 'SPEC: Demo — three tabs and the review sheet', 2, 9),
    mk('docs/SPEC-DEMO-V2.md', 'SPEC: Demo — first kanban round trip', 2, 16),
    mk('docs/SPEC-DEMO-V1.md', 'SPEC: Demo — static shell', 1, 23),
  ]
}

/**
 * デモの SPEC 一覧（固定分 ＋ Seed で生まれた分）。
 *
 * @param {number} [now] 時刻
 * @returns {Array<object>} SPEC（`path` / `title` / `mtime` / `batches`）
 */
export function currentSpecs(now = Date.now()) {
  const seeded = Array.isArray(state?.seededSpecs) ? state.seededSpecs : []
  return [...demoSpecList(now), ...demoArchivedSpecList(now), ...seeded]
}

/**
 * 固定のデモ SPEC（3 件）。バッチは `mode` と `section`（仕様抜粋 Markdown）を持つ
 * （V6-4 の「詳細 ▾」「受入条件・仕様抜粋」がデモでも読める形）。
 *
 * @param {number} [now] 時刻
 * @returns {Array<object>} SPEC
 */
export function demoSpecList(now = Date.now()) {
  return [
    {
      path: DEMO_SPEC_PATH,
      title: 'SPEC: Demo — A2B pipeline in four steps',
      mtime: now - 3 * MIN,
      valid: true,
      batches: [
        {
          id: 'DEMO-1',
          title: 'Spec interview and one-tap approval',
          objective: 'Approve the design decisions with one tap.',
          mode: 'Zero-Stop',
          section: '- Interview sheet with 3 questions\n- Accept All Recommended\n- Verify: `npm test`',
        },
        {
          id: 'DEMO-2',
          title: 'Visual gate — redline stamp and before/after',
          objective: 'Accept the visual fix after the redline.',
          mode: 'Visual Gate',
          section: '- 390x844 screenshot before / after\n- Mark the red area\n- Verify: `npm run verify`',
        },
        {
          id: 'DEMO-3',
          title: 'Summary and completion receipt',
          objective: 'Publish the receipt.',
          mode: 'Zero-Stop',
          section: '- Pipeline summary markdown\n- 1200x630 receipt card\n- Verify: `npm run verify`',
        },
      ],
    },
    {
      path: DEMO_SPEC_V5_PATH,
      title: 'SPEC: Pilot V5 — interactive demo and A2B',
      mtime: now - 60 * MIN,
      valid: true,
      batches: [
        {
          id: 'V5-1',
          title: 'Demo shell with a device frame',
          objective: 'Show the PWA inside a phone frame on a PC.',
          mode: 'Visual Gate',
          section: '- 390x844 and 820x1180 frames\n- Vibe / sound / theme switch',
        },
        {
          id: 'V5-2',
          title: 'Spec seed sheet',
          objective: 'Turn a spoken idea into a SPEC.',
          mode: 'Zero-Stop',
          section: '- POST /api/architect/seed\n- Poll /api/architect/jobs',
        },
        {
          id: 'V5-3',
          title: 'Completion receipt',
          objective: 'One card that proves the pipeline ran.',
          mode: 'Zero-Stop',
          section: '- kpi block\n- 1200x630 PNG',
        },
      ],
    },
    {
      path: DEMO_SPEC_V4_PATH,
      title: 'SPEC: Pilot V4 — pipeline watcher',
      mtime: now - 120 * MIN,
      valid: true,
      batches: [
        {
          id: 'V4-1',
          title: 'Pipeline report watcher',
          objective: 'Post one report per finished pipeline.',
          mode: 'Zero-Stop',
          section: '- chat-reports.jsonl\n- unread dot per session',
        },
        {
          id: 'V4-2',
          title: 'Quick launch bar',
          objective: 'File every pending batch in one tap.',
          mode: 'Zero-Stop',
          section: '- filed batch detection\n- idempotent launch',
        },
      ],
    },
  ]
}

/**
 * `GET /api/specs/content?board=&repo=&path=` のデモ応答（V6 §3.4 / D30）。
 *
 * 形は本物（`specs.readSpecContent`）に合わせる:
 * `{ok, path, title, mtime, batchCount, truncated, markdown}`。
 * 本文はその場で組み立てる（外部ファイルを読まない = 静的ホスティングで 404 を出さない）。
 *
 * @param {string} specPath `docs/SPEC-*.md`
 * @param {number} [now] 時刻
 * @returns {object} 応答
 */
export function demoSpecContent(specPath, now = Date.now()) {
  const wanted = String(specPath ?? '').trim()
  const spec = demoSpecsWithArchive(now).find((s) => s.path === wanted) || null
  if (!spec) {
    return { ok: false, code: 'NOT_FOUND', error: 'spec not found', path: wanted, demo: true }
  }
  const lines = [
    `# ${spec.title}`,
    '',
    '> Demo fixture: this markdown is generated in the browser, no file is read.',
    '',
    '## 1. Goal',
    '',
    'Run the A2B tour on a static host (URL embed or single-file embed) with zero backend.',
    '',
    '## 2. Decisions',
    '',
    '| # | Topic | Decision |',
    '| --- | --- | --- |',
    '| D1 | Where the demo state lives | one in-memory object (`createDemoState`) |',
    '| D2 | Images | SVG string -> data URL (no external file) |',
    '| D3 | Embedding | static site plus a single self-contained HTML |',
    '',
    '## 3. Batches',
    '',
  ]
  for (const b of spec.batches) {
    lines.push(`### Batch ${b.id}: ${b.title}`, '')
    lines.push(`- Mode: ${b.mode}`, `- Objective: ${b.objective}`, '')
    if (b.section) {
      for (const row of String(b.section).split('\n')) lines.push(row)
      lines.push('')
    }
  }
  lines.push('## 4. Verify', '', '- `npm run build:demo`', '- `npm run verify`', '')
  return {
    ok: true,
    path: spec.path,
    title: spec.title,
    mtime: spec.mtime,
    batchCount: spec.batches.length,
    truncated: false,
    markdown: lines.join('\n'),
    // D92: アーカイブ退避ボタンの表示判定（`SpecMarkdownSheet` が読む）
    archived: Boolean(spec.archived),
    status: spec.archived ? 'archived' : 'active',
    demo: true,
  }
}


/** ツアー状態。`createDemoState()` を呼び直すと最初から。 */
export function createDemoState(now = Date.now()) {
  return {
    now,
    gen: ++generation,
    tickMs: DEMO_TICK_MS,
    progress: emptyProgress(),
    reviewItems: initialReviewItems(now),
    tasks: [
      {
        id: 't_demo_done',
        board: DEMO_BOARD,
        title: '[DEMO-0] Static demo shell builds with npm run build:demo',
        status: 'done',
        assignee: 'mobile',
        createdAt: now - 30 * MIN,
        updatedAt: now - 25 * MIN,
        priority: 0,
        result: 'dist-demo generated',
      },
      {
        // V11 §3.3 / D51: 初期ジョブ `j_demo_0`（awaiting_review）の `[ARCH]` タスク。
        // Review の回答待ちなので `blocked`（進行バーの「🔍 進捗詳細」が本物のタスクを開ける）。
        id: 't_demo_arch_0',
        board: DEMO_BOARD,
        title: '[ARCH] Add a spec markdown preview to the demo shell',
        status: 'blocked',
        assignee: 'architect',
        body: 'Add a spec markdown preview to the demo shell.',
        createdAt: now - 6 * MIN,
        updatedAt: now - 6 * MIN,
        priority: 0,
        result: 'Round 1 sheet filed: review t_demo_review',
      },
    ],
    report: null,
    receipt: null,
    chatReports: [],
    notified: {},
    architect: createArchitectState(now),
    /** Seed で生まれた SPEC（`demoSpecs` / `/api/specs/content` に出る）。 */
    seededSpecs: [],
    /** D92: `POST /api/specs/archive` で退避した SPEC のパス（デモはファイルを持たない）。 */
    archivedSpecPaths: [],
    /**
     * V10 §3.3 / D47: 1 タップ環境最適化の適用状態。
     * `pipeline.optimize` で true になり、`pipeline.status` がそのまま返す
     * （デモで「適用前 → 適用後」を目で見られる）。
     */
    pipeline: { optimized: false, profile: 'mobile' },
    /**
     * COH-2: 実行制御（緊急停止）の状態。本番の `ops.paused()` と同じ形で、
     * `POST /api/gateway/{pause,resume}` が更新し、`/api/overview` の `paused` と
     * タスク一覧の `paused` が同じ値を返す（デモでも停止バナーと解除を体験できる）。
     */
    demoOps: { paused: { engaged: false, reason: null, engagedAt: null } },
  }
}

/**
 * V6（D28 / D32）: Architect の進行状態。
 *
 * 初期値に「インタビューシートが Review に届いた」ジョブを 1 件置く。デモを開いた直後に
 * `ArchitectJobBar`（進行バー）と待ち受けカードをそのまま体験できる。
 *
 * @param {number} now 時刻
 * @returns {{runner: string, seq: number, jobs: Array<object>}} 状態
 */
export function createArchitectState(now = Date.now()) {
  return {
    runner: 'hermes',
    seq: 1,
    jobs: [
      {
        id: 'j_demo_0',
        board: DEMO_BOARD,
        status: 'awaiting_review',
        runner: 'hermes',
        requestedRunner: 'hermes',
        runnerLabel: DEMO_RUNNER_LABEL,
        fallbackFrom: null,
        fallbackReason: null,
        autoStart: false,
        // V7 §3.3 ①: 実行方針と破棄フラグ（本番 `publicJob` と同じフィールドを持つ）
        executionPolicy: 'zero-stop',
        dismissed: false,
        seed: 'Add a spec markdown preview to the demo shell.',
        lang: 'en',
        chat: DEMO_SESSION,
        createdAt: now - 6 * MIN,
        startedAt: now - 6 * MIN,
        finishedAt: null,
        spec: null,
        completedSpec: null,
        launched: null,
        error: null,
        // V11 §3.3 / D51: Hermes Native のジョブは必ず `[ARCH]` タスクを持つ
        // （進行バーの「🔍 進捗詳細」から本物のタスクを開ける）
        taskId: 't_demo_arch_0',
        reviewTaskId: 't_demo_review',
        reviewTitle: '[DEMO-1] Interactive demo — three design decisions',
      },
    ],
    memos: [
      {
        id: 'm_demo_1',
        title: 'Quick idea: Voice brainstorm flow',
        body: 'Expand one-line ideas into checklists before turning them into a full Spec Seed.',
        tags: ['idea', 'ux'],
        pinned: true,
        color: 'teal',
        kind: 'note',
        checklist: [
          { id: 'c1', text: 'Capture one-line spark', done: true },
          { id: 'c2', text: 'Run brainstorm checklist', done: false },
          { id: 'c3', text: 'Promote to Spec Seed', done: false },
        ],
        source: null,
        createdAt: new Date(now - 30 * MIN).toISOString(),
        updatedAt: new Date(now - 10 * MIN).toISOString(),
      },
      {
        id: 'm_demo_2',
        title: 'Daily Pipeline Digest',
        body: '3 batches completed cleanly on mobile board. Zero OAuth boundary violations.',
        tags: ['report', 'digest'],
        pinned: false,
        color: 'amber',
        kind: 'report',
        checklist: [],
        source: { board: DEMO_BOARD, repo: 'hermes-pilot-demo' },
        createdAt: new Date(now - 2 * 60 * MIN).toISOString(),
        updatedAt: new Date(now - 2 * 60 * MIN).toISOString(),
      },
    ],
  }
}

/** ランナーの表示名（本番 `architect.js` の `runnerLabel` と同じ文字列）。 */
export function demoRunnerLabel() {
  return DEMO_RUNNER_LABEL
}

let generation = 0
let state = createDemoState()
const listeners = new Set()
/** ツアー状態の購読（`DemoBanner` が使う）。戻り値を呼ぶと解除。 */
export function subscribeDemo(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function publish(kind = 'change') {
  for (const fn of [...listeners]) {
    try {
      fn(kind, snapshot())
    } catch {
      /* 購読側の失敗でデモを止めない */
    }
  }
}

/** 画面に渡す読み取り専用のスナップショット。 */
export function snapshot() {
  return {
    step: stepIndex(state.progress),
    progress: { ...state.progress },
    tasks: state.tasks.map((x) => ({ ...x })),
    reviewItems: state.reviewItems.map((x) => ({ ...x })),
  }
}

/** 現在のツアー段階。 */
export function currentStep() {
  return stepIndex(state.progress)
}

/** テスト用: 状態を初期化する（`npm run build:demo` の「最初から」も同じ経路）。 */
export function resetDemoState(now = Date.now()) {
  state = createDemoState(now)
  publish('reset')
  return snapshot()
}

/** テスト用: 直接読みたいとき。 */
export function demoState() {
  return state
}

/*
 * 画像（SVG → data URL）と GIF 生成は `demo/shots.js` へ分割した（公開契約は再エクスポートで維持）。
 */
export { demoImageFor, installDemoImageShim, mockShotDataUrl, mockShotSvg, svgToDataUrl } from './shots.js'

/* ------------------------------------------------------------------ *
 * ルーティング（純関数。テストはここを直接叩く）
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 応答
 * ------------------------------------------------------------------ */

function itemById(id) {
  return state.reviewItems.find((x) => x.id === id) || null
}

function overviewBody() {
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
function receiptBody() {
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
function demoCoherenceAlert() {
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
function finishPipeline() {
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
function advanceBatches(gen) {
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

/* ------------------------------------------------------------------ *
 * V6: タスク詳細・差分（履歴シートの「🔍 タスク詳細・差分を見る」）
 * ------------------------------------------------------------------ */

/** タスクごとの擬似コミット（形は `gitinfo.forTask` に合わせる）。 */
const DEMO_COMMITS = {
  t_demo_done: {
    head: 'd3m0a1b',
    branch: 'main',
    subject: 'feat(demo): static demo shell builds with npm run build:demo',
    files: [
      { path: 'apps/web/src/demo/mockApi.js', add: 42, del: 6 },
      { path: 'apps/web/src/demo/DemoStage.jsx', add: 18, del: 2 },
    ],
  },
  't_demo_demo-1': {
    head: 'd3m0c11',
    branch: 'main',
    subject: 'feat(demo): approve the design decisions in one tap',
    files: [
      { path: 'apps/web/src/features/ReviewPane.jsx', add: 31, del: 4 },
      { path: 'apps/web/src/i18n/ja.json', add: 6, del: 0 },
    ],
  },
  't_demo_demo-2': {
    head: 'd3m0c22',
    branch: 'main',
    subject: 'feat(demo): lift the toast above the bottom navigation',
    files: [
      { path: 'apps/web/src/styles.css', add: 22, del: 9 },
      { path: 'apps/web/src/components/Toast.jsx', add: 11, del: 3 },
    ],
  },
  't_demo_demo-3': {
    head: 'd3m0c33',
    branch: 'main',
    subject: 'feat(demo): publish the completion receipt',
    files: [{ path: 'apps/web/src/components/MissionReceiptSheet.jsx', add: 27, del: 5 }],
  },
}

/**
 * タスク詳細のデモ応答（形は `kanban.task` に合わせる）。
 *
 * `events` は本物（`task_events` を `ORDER BY id DESC`）と同じ**新しい順**で返す。
 * 実行中／待機中は heartbeat を 3 連続で入れ、詳細シートの折りたたみを体験できるようにする。
 *
 * @param {object} task 一覧の行
 * @returns {object} 詳細
 */
export function demoTaskDetail(task) {
  const commit = DEMO_COMMITS[task.id] || null
  const startedAt = task.createdAt ? task.createdAt + 5_000 : null
  const endedAt = task.status === 'done' ? task.updatedAt ?? Date.now() : null
  const lastBeat = endedAt ?? Date.now()
  const beats = [0, 1, 2].map((i) => ({
    kind: 'heartbeat',
    at: lastBeat - i * 60_000,
    payload: {},
  }))
  const tail = [
    { kind: 'claimed', at: startedAt ?? lastBeat, payload: { run_id: 1 } },
    { kind: 'created', at: task.createdAt ?? lastBeat, payload: { status: 'ready' } },
  ]
  return {
    id: task.id,
    board: task.board ?? DEMO_BOARD,
    title: task.title,
    body: `Demo task: ${task.title}`,
    status: task.status,
    assignee: task.assignee ?? 'mobile',
    priority: Number(task.priority ?? 0),
    workspace: DEMO_REPO_PATH,
    branch: commit?.branch ?? 'main',
    workerPid: null,
    sessionId: DEMO_SESSION,
    startedAt,
    completedAt: task.status === 'done' ? (task.updatedAt ?? Date.now()) : null,
    result: task.result ?? null,
    // 新しい順（本物の `kanban.task()` と同じ）。done は heartbeat の代わりに completed。
    events:
      task.status === 'done'
        ? [{ kind: 'completed', at: endedAt ?? Date.now(), payload: { outcome: 'done' } }, ...tail]
        : [...beats, ...tail],
    runs: [{ id: 1, status: task.status === 'done' ? 'done' : 'running', startedAt, endedAt }],
    comments: [{ author: 'mobile', body: 'demo comment', at: task.createdAt ?? Date.now() }],
    git: commit
      ? { head: commit.head, branch: commit.branch, subject: commit.subject, dirty: false }
      : { head: null, branch: 'main', subject: '', dirty: false },
    demo: true,
  }
}

/**
 * worker のライブ進捗のデモ応答（形は `transcript.read` に合わせる）。
 * @param {string} taskId タスク ID
 * @returns {object} フィード（messages は古い順）
 */
export function demoWorkerFeed(taskId) {
  const now = Date.now()
  const row = (id, role, text, toolName = null) => ({
    id,
    role,
    at: now - (5 - id) * 40_000,
    text,
    toolName,
    toolArgs: null,
  })
  return {
    ok: true,
    sessionId: DEMO_SESSION,
    title: `demo worker ${taskId}`,
    messages: [
      row(1, 'assistant', 'Reading the task body and the files it names.'),
      row(2, 'tool', 'node --test apps/web/test/tasksView.test.js', 'terminal'),
      row(3, 'tool', 'grep -n "heartbeat" apps/web/src/features/TasksPane.jsx', 'terminal'),
      row(4, 'assistant', 'Collapsing consecutive heartbeats into one row.'),
      row(5, 'tool', 'npm test', 'terminal'),
    ],
    oldestId: 1,
    hasMore: false,
  }
}

/**
 * 差分サマリのデモ応答（形は `gitinfo.diffSummary` に合わせる）。
 * @param {object} task 一覧の行
 * @returns {object} サマリ
 */
export function demoDiffSummary(task) {
  const commit = DEMO_COMMITS[task.id] || null
  if (!commit) return { ok: false, reason: 'this demo task has no git record', demo: true }
  const files = commit.files.map((f) => ({ path: f.path, add: f.add, del: f.del, binary: false }))
  const total = files.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 })
  return {
    ok: true,
    repo: DEMO_REPO_PATH,
    head: commit.head,
    subject: commit.subject,
    dirty: false,
    files,
    total,
    truncated: false,
    changedFilesFallback: [],
    demo: true,
  }
}

/**
 * 1 ファイルのパッチのデモ応答（形は `gitinfo.filePatch` に合わせる）。
 * @param {object} task 一覧の行
 * @param {string} file パス
 * @returns {object} パッチ
 */
export function demoFilePatch(task, file) {
  const summary = demoDiffSummary(task)
  if (!summary.ok) return summary
  const hit = summary.files.find((f) => f.path === file)
  if (!hit) return { ok: false, reason: 'file is not part of that commit', demo: true }
  const text = [
    `diff --git a/${file} b/${file}`,
    '--- a/' + file,
    '+++ b/' + file,
    `@@ -1,3 +1,${Math.min(9, hit.add + 3)} @@`,
    '-  demo: before',
    '+  demo: after',
    '+  demo: kept the layout tokens',
    '',
  ].join('\n')
  return { ok: true, path: file, text, lines: 6, truncated: false, demo: true }
}

/* ------------------------------------------------------------------ *
 * V6: Architect（Seed → 仕様書 → Review → 起票）の進行
 * ------------------------------------------------------------------ */

/** 停滞とみなす無進展時間（本番 `architect.js` の `STALLED_AFTER_MS` と同じ 3 分）。 */
export const DEMO_STALLED_AFTER_MS = 180_000

/**
 * 公開用のジョブ（形は `architect.publicJob` + V6 の追加フィールド）。
 *
 * V9 §3.1 / D42・D43: ブリッジと同じ `phase` / `stalled` / `sheetPath` / `reviewBoard` を
 * 返す（デモでも進行バーがフェーズ・停滞警告・進捗詳細を本番と同じ見た目で出せる）。
 */
export function demoPublicJob(job) {
  return {
    ...job,
    runnerLabel: demoRunnerLabel(),
    phase: demoJobPhase(job),
    stalled: demoJobStalled(job),
    sheetPath: job.sheetPath ?? null,
    reviewBoard: job.reviewTaskId ? DEMO_BOARD : null,
  }
}

/**
 * ジョブの現在フェーズ（本番 `architect.computePhase` と同じ規則・SPEC-PILOT-V9 §3.1 / D42）。
 * @param {object} job ジョブ
 * @returns {'spawning'|'round1_sheet'|'awaiting_review'|'round2_spec'|'spec_ready'|'launched'|'failed'} フェーズ
 */
export function demoJobPhase(job) {
  const status = String(job?.status ?? '')
  if (status === 'failed') return 'failed'
  if (status === 'launched') return 'launched'
  if (status === 'spec_ready') return 'spec_ready'
  if (status === 'awaiting_review') return 'awaiting_review'
  // 一度 Review まで行って回答後に戻ったジョブは Round 2（仕様書の執筆）
  if (job?.reviewSeenOnce) return 'round2_spec'
  if (job?.sheetPath) return 'round1_sheet'
  return 'spawning'
}

/**
 * 停滞しているか（本番 `architect.isJobStalled` と同じ規則・180 秒）。
 * @param {object} job ジョブ
 * @param {number} [at] 現在時刻
 * @returns {boolean} 停滞なら true
 */
export function demoJobStalled(job, at = Date.now()) {
  const status = String(job?.status ?? '')
  if (!['running', 'awaiting_spec'].includes(status)) return false
  // キュー待ちはディスパッチャ待ちなので「停滞」ではない
  if (String(job?.queueState ?? '') === 'queued') return false
  const start = Number(job?.startedAt ?? job?.createdAt ?? 0)
  if (!Number.isFinite(start) || start <= 0) return false
  return at - start >= DEMO_STALLED_AFTER_MS
}

/**
 * `/api/live` の Architect 行（本番 `live.snapshot` の整形と同じ形・V9 §3.2 / D43）。
 * @param {object} job ジョブ
 * @param {number} [at] 現在時刻
 * @returns {object} 行
 */
export function demoLiveArchitect(job, at = Date.now()) {
  const startedAt = Number(job.startedAt ?? job.createdAt ?? 0) || null
  return {
    id: job.id,
    board: job.board,
    runner: job.runner,
    runnerLabel: demoRunnerLabel(),
    status: job.status,
    phase: demoJobPhase(job),
    stalled: demoJobStalled(job, at),
    taskId: job.taskId ?? null,
    reviewTaskId: job.reviewTaskId ?? null,
    reviewBoard: job.reviewTaskId ? DEMO_BOARD : null,
    seed: String(job.seed ?? '').slice(0, 200),
    startedAt,
    elapsedSec: startedAt ? Math.max(0, Math.round((at - startedAt) / 1000)) : null,
  }
}

/**
 * 実行方針を正規化する（本番 `architect.js` の `normalizeExecutionPolicy` と同じ規則:
 * 未指定・不正値は `zero-stop`）。
 * @param {unknown} value 入力
 * @returns {'zero-stop'|'visual-gate'} 実行方針
 */
export function normalizeDemoExecutionPolicy(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  return text === 'visual-gate' ? 'visual-gate' : 'zero-stop'
}

/**
 * 実行方針に対応する SPEC バッチの `Execution Mode` 表記（本番 `executionModeLabel` と同じ）。
 * @param {unknown} value 実行方針
 * @returns {'Visual Gate'|'Zero-Stop'} バッチのモード表記
 */
export function demoExecutionMode(value) {
  return normalizeDemoExecutionPolicy(value) === 'visual-gate' ? 'Visual Gate' : 'Zero-Stop'
}

/**
 * Seed を受けてジョブを 1 件作る（`POST /api/architect/seed` のデモ実装）。
 *
 * 本物は 202 で即返り、背後で SPEC を書く。デモも同じで、`tickMs` ごとに
 * `running -> awaiting_spec -> spec_ready`（`autoStart` なら `launched`）と進める。
 *
 * V11 §3.3 / D51: ランナーは `Hermes Native` 固定（外部 CLI は起動しない）。
 * 送られてきた `runner` は見ない（本番ブリッジも `hermes` 以外を 400 で弾く）。
 *
 * @param {object} input 種（`seedText` / `autoStart` / `executionPolicy` / `lang` / `chat`）
 * @returns {object} 作ったジョブ
 */
export function startDemoArchitectJob(input = {}) {
  const now = Date.now()
  const runner = 'hermes'
  const executionPolicy = normalizeDemoExecutionPolicy(input.executionPolicy)
  const seq = ++state.architect.seq
  const seedText = String(input.seedText ?? '').slice(0, 400)
  // Hermes Native は必ず `[ARCH] ...` の実行中タスクを 1 件立てる（`taskId` で進捗詳細から開ける）
  const taskId = `t_demo_arch_${seq}`
  const job = {
    id: `j_demo_${seq}`,
    board: DEMO_BOARD,
    status: 'running',
    runner,
    requestedRunner: runner,
    runnerLabel: demoRunnerLabel(),
    fallbackFrom: null,
    fallbackReason: null,
    autoStart: Boolean(input.autoStart),
    // V7 §3.3 ①: 選んだ実行方針（`zero-stop` / `visual-gate`）をジョブに残す
    executionPolicy,
    dismissed: false,
    seed: seedText,
    lang: input.lang === 'en' ? 'en' : 'ja',
    chat: input.chat ? String(input.chat).slice(0, 128) : DEMO_SESSION,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    spec: null,
    completedSpec: null,
    launched: null,
    error: null,
    // Round 1（設問シート）→ Round 2（SPEC 執筆）の通過フラグ（`advanceArchitectJob` が立てる）
    sheetPath: null,
    reviewSeenOnce: false,
    taskId,
    reviewTaskId: null,
    reviewTitle: null,
  }
  if (taskId) {
    state.tasks.unshift({
      id: taskId,
      board: DEMO_BOARD,
      title: `[ARCH] ${seedText.slice(0, 48)}`,
      status: 'running',
      assignee: 'architect',
      body: seedText,
      events: [{ kind: 'spawned', at: now }],
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      priority: 0,
    })
  }
  state.architect.jobs.unshift(job)
  if (state.architect.jobs.length > 8) state.architect.jobs.length = 8
  publish('architect')
  setTimeout(() => advanceArchitectJob(job.id, state.gen), state.tickMs)
  return job
}

/**
 * ジョブを 1 段進める（V10 §3.3 / D47・本番 `architect` の段階遷移に合わせる）。
 *
 * `running` →（Round 1 の設問シート）`awaiting_spec` + `sheetPath` →（Round 2 の SPEC 執筆）
 * `reviewSeenOnce` → `spec_ready`（`autoStart` なら `launched`）。各段の間は `tickMs`。
 *
 * テストから段階を手で進められるよう公開している（タイマーだと速すぎて観測できない）。
 *
 * @param {string} id ジョブ ID
 * @param {number} [gen] ツアー世代（作り直されたら古いタイマーは降りる）
 * @returns {object|null} 進めた後のジョブ（見つからなければ null）
 */
export function advanceArchitectJob(id, gen = state.gen) {
  if (gen !== state.gen) return null
  const job = state.architect.jobs.find((j) => j.id === id)
  if (!job) return null
  const key = Number(String(job.id).replace(/[^0-9]/g, '')) || 1
  // 段 1: 設問シートを作る（`phase` は `sheetPath` から `round1_sheet` になる）
  if (job.status === 'running' && !job.sheetPath) {
    job.sheetPath = `sheets/spec-demo-seed-${key}-1.json`
    job.status = 'awaiting_spec'
    publish('architect')
    setTimeout(() => advanceArchitectJob(id, gen), state.tickMs)
    return job
  }
  // 段 2: 回答を受けて SPEC を書き始める（`phase` は `round2_spec`）
  if (job.status === 'awaiting_spec' && !job.reviewSeenOnce) {
    job.reviewSeenOnce = true
    publish('architect')
    setTimeout(() => advanceArchitectJob(id, gen), state.tickMs)
    return job
  }
  if (job.status !== 'awaiting_spec') return job
  // 段 3: 仕上げ（Seed から生まれた SPEC を公開する）
  // バッチの Execution Mode は選んだ実行方針に従う（本番の生成 SPEC と同じ表記）
  const mode = demoExecutionMode(job.executionPolicy)
  const spec = {
    path: `docs/SPEC-DEMO-SEED-${key}.md`,
    title: `SPEC: Demo seed — ${String(job.seed || 'seeded idea').slice(0, 48)}`,
    mtime: Date.now(),
    valid: true,
    batches: [
      {
        id: `SEED${key}-1`,
        title: 'Interview questions',
        objective: 'Ask only what the machine cannot decide.',
        mode,
        section: '- 3 questions\n- each option shows both pictures',
      },
      {
        id: `SEED${key}-2`,
        title: 'Implementation and verify',
        objective: 'Ship the change with a receipt.',
        mode,
        section: '- `npm run verify`\n- completion report',
      },
    ],
  }
  if (!state.seededSpecs.some((s) => s.path === spec.path)) state.seededSpecs.push(spec)
  job.spec = spec.path
  job.completedSpec = {
    path: spec.path,
    title: spec.title,
    batchCount: spec.batches.length,
    batches: spec.batches.map((b) => ({ id: b.id, title: b.title, mode: b.mode ?? null })),
  }
  job.finishedAt = Date.now()
  job.status = job.autoStart ? 'launched' : 'spec_ready'
  if (job.autoStart) {
    job.launched = { ok: true, created: [], skipped: [], failed: [], reason: 'demo' }
  }
  // Hermes Native が立てた `[ARCH]` タスクも SPEC が出来た時点で終わらせる
  // （残すと `/api/live` の実行中タスクに居座り、進捗詳細の状態も嘘になる）
  const archTask = job.taskId ? state.tasks.find((t) => t.id === job.taskId) : null
  if (archTask) {
    archTask.status = 'done'
    archTask.updatedAt = Date.now()
    archTask.result = `SPEC written: ${spec.path}`
    archTask.events = [...(archTask.events ?? []), { kind: 'done', at: Date.now(), payload: { spec: spec.path } }]
  }
  publish('architect')
  return job
}

/**
 * 指定 SPEC に起票済みのバッチ ID（`architect.filedBatchIdsForSpec` と同じ規則・D91/D92）。
 *
 * - 別 SPEC に属する `[ID]` は除外する（未スコープの照合で他 SPEC の同名バッチを
 *   「起票済み」に見せない）。
 * - `archived`（破棄済み）は起票済みに数えない（再起票できる）。
 * - 無印（Spec 行の無い）タスクは、対象 SPEC の mtime 以降に触られたものだけを数える。
 *
 * @param {Array<object>} tasks デモのタスク
 * @param {string|null} [specPath] 対象 SPEC の相対パス
 * @param {{specMtime?: number|null, slackMs?: number}} [opts] 無印タスクの時刻ガード
 * @returns {Set<string>} バッチ ID
 */
function filedBatchIdsForSpec(tasks, specPath = null, opts = {}) {
  const want = String(specPath ?? '').trim() || null
  const specMtime = Number(opts?.specMtime)
  const slack = Number.isFinite(Number(opts?.slackMs)) ? Number(opts.slackMs) : SPEC_MTIME_SLACK_MS
  const since = want && Number.isFinite(specMtime) && specMtime > 0 ? specMtime - slack : null
  const out = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task) continue
    if (String(task.status ?? '').trim().toLowerCase() === 'archived') continue
    const m = /^\[([^\]]+)\]/.exec(String(task?.title ?? '').trim())
    if (!m || !m[1].trim()) continue
    if (want) {
      const ts = demoTaskSpecOf(task)
      if (ts && ts !== want) continue
      if (!ts && since !== null && !(demoTaskStampMs(task) >= since)) continue
    }
    out.add(m[1].trim())
  }
  return out
}

/** `GET /api/architect/jobs` のデモ応答。 */
export function demoArchitectJobs(board = DEMO_BOARD) {
  const slug = String(board ?? '').trim() || DEMO_BOARD
  const jobs = state.architect.jobs.filter((j) => !slug || j.board === slug).map(demoPublicJob)
  const specReady = jobs
    .filter((j) => j.completedSpec && (j.status === 'spec_ready' || j.status === 'launched'))
    .map((j) => ({
      jobId: j.id,
      board: j.board,
      repoPath: DEMO_REPO_PATH,
      spec: j.completedSpec.path,
      title: j.completedSpec.title,
      batchCount: j.completedSpec.batchCount,
      batches: j.completedSpec.batches,
      autoStart: j.autoStart,
      launched: j.status === 'launched',
      launchedCount: j.launched?.created?.length ?? 0,
    }))
  const pending = []
  for (const spec of demoSpecsWithArchive(state.now)) {
    if (!spec || spec.archived) continue
    // 未起票の判定は SPEC スコープで行う（別 SPEC の同名バッチを「起票済み」にしない・D91）。
    const filed = filedBatchIdsForSpec(state.tasks, spec.path, { specMtime: spec.mtime })
    const ids = spec.batches.map((b) => b.id).filter((id) => !filed.has(id))
    if (!ids.length) continue
    pending.push({
      path: spec.path,
      title: spec.title,
      batchCount: spec.batches.length,
      pendingCount: ids.length,
      pending: ids,
      mtime: spec.mtime,
      board: slug,
      repoPath: DEMO_REPO_PATH,
    })
  }
  pending.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  return {
    ok: true,
    board: slug,
    runner: state.architect.runner,
    jobs,
    specReady,
    pending,
    demo: true,
  }
}


/**
 * `GET /api/pipeline/status` のデモ応答（本番 `getOptimizeStatus` と同じく「適用済みか」を返す）。
 *
 * V10 §3.3 / D47: 未適用なら SOUL 未適用・同梱スキル 3 つのうち 2 つだけ。
 * `POST /api/pipeline/optimize` の後は SOUL 適用済み＋3 スキル揃い。
 *
 * @returns {object} `PipelinePanel` が読む形
 */
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
export async function demoFetch(path, { method = 'GET', body } = {}) {
  const route = demoRoute(path)
  const payload = body === undefined ? undefined : typeof body === 'string' ? JSON.parse(body) : body
  switch (route.name) {
    case 'overview':
      return overviewBody()
    case 'review.list':
      return { board: DEMO_BOARD, workdir: '/demo/review', items: state.reviewItems.map((x) => ({ ...x })), demo: true }
    case 'review.feed':
      return { items: state.progress.visual ? [{ at: Date.now(), text: 'demo-visual-01 accepted', kind: 'done' }] : [] }
    case 'review.chatReports':
      return { items: state.chatReports.map((x) => ({ ...x })) }
    case 'review.library':
      return { items: [{ path: 'demo/visual-01.svg', name: 'visual-01.svg', source: 'library', repo: { id: 'hermes-pilot-demo', label: 'demo' } }] }
    case 'review.targets':
      return { targets: [{ id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)', path: '/demo/hermes-pilot' }] }
    case 'review.data': {
      const item = itemById(route.id)
      if (!item) return { data: { questions: [] }, answer: null }
      const answered = item.status === 'done'
      return {
        data: { title: item.review?.title || item.title, questions: item.review?.mode === 'standard' ? demoQuestions() : [] },
        answer: answered ? { answers: [{ id: 'q1', choice: 'A' }], global: '', by: 'mobile' } : null,
      }
    }
    case 'review.annotation':
      return { image: 'demo/visual-01.svg', marks: [], note: '', demo: true }
    case 'review.answer': {
      const item = itemById(route.id)
      if (item) {
        item.status = 'done'
        item.completedAt = Date.now()
        item.review = { ...item.review, answeredAt: new Date().toISOString() }
        state.progress.review = true
      }
      publish('review')
      return { ok: true, files: { answer: 'answer.json', sheet: null }, duplicate: false }
    }
    case 'review.approve': {
      const item = itemById(route.id)
      if (item) {
        item.status = 'done'
        item.completedAt = Date.now()
        item.review = { ...item.review, answeredAt: new Date().toISOString(), approved: true }
        state.progress.visual = true
      }
      publish('review')
      return { ok: true, moved: 'done', files: { approval: 'approved.json' }, duplicate: false }
    }
    case 'review.reopen':
      return { ok: true, moved: 'blocked' }
    case 'review.worker':
      return { taskId: route.id, status: 'running', sessionId: DEMO_SESSION, db: null, profile: null, feed: demoWorkerFeed(route.id) }
    case 'review.annotationNew':
      return { ok: false, message: 'demo', demo: true }
    case 'review.misc':
      return { ok: true, demo: true }
    // COH-2: 1 会話ぶんの完了報告（未読の点の材料）。`{ items: [...] }` は本番と同じ形。
    case 'review.chatReport':
      return {
        sessionId: String(route.params.get('session_id') || ''),
        items: state.chatReports.filter((x) => !route.params.get('session_id') || x.sessionId === route.params.get('session_id')),
      }
    // COH-2: 実行ワーカーの session_id 解決（`ChatPane` の worker 連携が読む）
    case 'review.session':
      return { taskId: route.id, status: 'running', sessionId: DEMO_SESSION, demo: true }
    // COH-2: 非 JSON 応答（画像・HTML）。デモでは img/iframe のシムが差し替えるので marker を返す。
    case 'review.image':
    case 'review.thumb':
    case 'review.sheet':
    case 'review.view':
      return { ok: true, nonJson: true, path: route.name, id: route.id, demo: true }
    case 'boards':
      return {
        boards: [{ slug: DEMO_BOARD, label: 'Mobile (demo)', current: true, counts: { running: state.tasks.filter((t) => t.status === 'running').length } }],
      }
    case 'board.tasks':
      // COH-2: 緊急停止の状態も返す（本番の `/api/overview` の `paused` と同じ値）。
      // D92: `archivedCount` は一覧の LIMIT と独立に数える（「アーカイブ済み (N)」の N）。
      return {
        board: route.id,
        tasks: state.tasks.map((x) => ({ ...x })),
        archivedCount: state.tasks.filter((t) => t.status === 'archived').length,
        paused: state.demoOps.paused,
      }
    // D92: 整理モードの一括アーカイブ（本番と同じく running はスキップして返す）
    case 'board.bulkArchive': {
      const ids = Array.isArray(payload?.taskIds) ? payload.taskIds.map((x) => String(x ?? '').trim()).filter(Boolean) : []
      const archived = []
      const skippedRunning = []
      const skippedArchived = []
      const failed = []
      for (const id of ids) {
        const task = state.tasks.find((t) => t.id === id)
        if (!task) {
          failed.push({ id, code: 'TASK_NOT_FOUND' })
          continue
        }
        if (task.status === 'running') {
          skippedRunning.push(id)
          continue
        }
        if (task.status === 'archived') {
          skippedArchived.push(id)
          continue
        }
        task.status = 'archived'
        task.updatedAt = Date.now()
        archived.push(id)
      }
      if (archived.length) publish('tasks')
      return { ok: true, board: route.id, archived, skippedRunning, skippedArchived, failed, demo: true }
    }
    // V6 §3.5: 履歴の詳細・差分（`🔍 タスク詳細・差分を見る`）
    case 'board.task': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: 'task not found', id: route.taskId, demo: true }
      return demoTaskDetail(task)
    }
    case 'board.taskDiff': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (!task) return { ok: false, reason: 'task not found', demo: true }
      const file = route.params.get('file')
      if (!file) return demoDiffSummary(task)
      return demoFilePatch(task, String(file))
    }
    // V8-B3: 任意のボードの実行中タスクでも worker のライブ進捗を出す
    case 'board.taskWorker': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: 'task not found', id: route.taskId, demo: true }
      return {
        taskId: task.id,
        status: task.status,
        sessionId: DEMO_SESSION,
        db: null,
        profile: null,
        feed: demoWorkerFeed(task.id),
      }
    }
    case 'board.taskAbort': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (task) {
        task.status = 'ready'
        task.updatedAt = Date.now()
        publish('tasks')
      }
      return { ok: true, reclaimed: 1, blocked: 0, demo: true }
    }
    case 'inbox':
      return { items: [] }
    case 'specs':
      return demoSpects(state.now)
    // SPEC-COHERENCE §3.4 / D82: スイープシートのライブ診断（バッジ・推奨プリセットの材料）
    case 'coherence.report':
      return demoCoherenceReport()
    // V6 §3.4: 仕様書の本文（MD プレビュー）
    case 'specs.content':
      return demoSpecContent(route.params.get('path'), state.now)
    // D92: SPEC をヘッダ追記でアーカイブ退避する（デモはメモリ上で同じ効果を出す）
    case 'specs.archive': {
      const wanted = String(payload?.path ?? route.params.get('path') ?? '').trim()
      if (!wanted) return { ok: false, code: 'SPEC_PATH_REQUIRED', error: 'path is required', demo: true }
      if (wanted.startsWith('/') || wanted.includes('..')) {
        return { ok: false, code: 'SPEC_PATH_OUTSIDE', error: 'path must stay inside the repository', demo: true }
      }
      const spec = currentSpecs(state.now).find((s) => s.path === wanted)
      if (!spec) return { ok: false, code: 'SPEC_READ_FAILED', error: 'spec not found', path: wanted, demo: true }
      if (spec.archived || state.archivedSpecPaths.includes(wanted)) {
        return { ok: true, path: wanted, noop: true, archived: true, status: 'archived', demo: true }
      }
      state.archivedSpecPaths.push(wanted)
      publish('specs')
      return { ok: true, path: wanted, noop: false, archived: true, status: 'archived', demo: true }
    }
    // V6 §3.1/§3.2: Architect のランナー設定とジョブ（進行バーの材料）
    // V11 §3.3 / D51: ランナーは `Hermes Native` 固定。`PUT` で別の値を送られても
    // 本番ブリッジと同じく `hermes` のまま返す（UI から切り替える手段はもう無い）。
    case 'architect.config': {
      return { ok: true, runner: state.architect.runner, demo: true }
    }
    case 'architect.jobs':
      return demoArchitectJobs(route.params.get('board'))
    case 'architect.seed': {
      const job = startDemoArchitectJob(payload)
      // 本物は 202（ジョブは動き出したが SPEC はまだ無い）。`executionPolicy` を返し、
      // 画面が「選んだ方針で走っている」ことを表示できるようにする（V7 §3.3 ①）。
      return {
        ok: true,
        jobId: job.id,
        status: job.status,
        runner: job.runner,
        executionPolicy: job.executionPolicy,
        autoStart: job.autoStart,
        demo: true,
      }
    }
    // V7 §3.1: ジョブ破棄はサーバー側に永続化する（デモでは一覧から消える）。
    case 'architect.jobDismiss': {
      const job = state.architect.jobs.find((j) => j.id === route.id)
      if (!job) {
        return { ok: false, code: 'JOB_NOT_FOUND', error: 'job not found', jobId: route.id, demo: true }
      }
      job.dismissed = true
      publish('architect')
      return { ok: true, jobId: job.id, persisted: true, demo: true }
    }
    case 'specs.launch': {
      const ids = Array.isArray(payload?.batchIds) ? payload.batchIds : []
      const created = []
      for (const id of ids) {
        if (state.tasks.some((t) => t.title.startsWith(`[${id}]`))) continue
        const batch = currentSpecs(state.now)
          .flatMap((s) => s.batches)
          .find((b) => b.id === id)
        const task = {
          id: `t_demo_${String(id).toLowerCase()}`,
          board: DEMO_BOARD,
          title: `[${id}] ${batch?.title ?? `Demo batch — ${id}`}`,
          status: 'ready',
          assignee: 'mobile',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          priority: 0,
        }
        state.tasks.unshift(task)
        created.push({ id: task.id, batchId: id })
      }
      if (created.length) {
        state.progress.batches = true
        publish('tasks')
        setTimeout(() => advanceBatches(state.gen), state.tickMs)
      }
      return { ok: true, created, skipped: [] }
    }
    case 'specs.reports':
      return { reports: state.report ? [{ ...state.report }] : [] }
    case 'live': {
      /*
       * V9 §3.2 / D43 + V10 §3.3 / D47: 本番 `live.snapshot` と同じ形
       * （`{ok, counts:{turns,tasks,architect}, turns, tasks, architect}`）を返す。
       * `counts.architect` は `running` / `awaiting_spec` だけを数え、一覧には
       * `awaiting_review`（判断待ち）も含める — デモでも LiveSheet の 3 列目が点灯する。
       * `ok` が無いと LiveSheet が「失敗」表示になる（実測）。
       */
      const at = Date.now()
      const architect = state.architect.jobs
        .filter((j) => !j.dismissed && ['running', 'awaiting_spec', 'awaiting_review'].includes(String(j.status)))
        .map((j) => demoLiveArchitect(j, at))
      const tasks = state.tasks
        .filter((t) => t.status === 'running')
        .map((t, i) => {
          const startedAt = Number(t.startedAt ?? t.createdAt ?? 0) || at
          return {
            id: t.id,
            board: DEMO_BOARD,
            boardName: DEMO_BOARD,
            title: t.title,
            assignee: t.assignee ?? 'mobile',
            startedAt,
            elapsedSec: Math.max(0, Math.round((at - startedAt) / 1000)),
            workerPid: 42400 + i,
          }
        })
      const architectRunning = architect.filter((j) => ['running', 'awaiting_spec'].includes(String(j.status))).length
      // 何か動いていればターン 1 本を見せる（Discord / PWA のターンに相当する行）
      const turns =
        tasks.length || architectRunning
          ? [
              {
                profile: 'default',
                sessionId: DEMO_SESSION,
                title: 'Demo — A2B pipeline in four steps',
                source: 'mobile',
                platform: 'pwa',
                startedAt: at - 40_000,
                elapsedSec: 40,
                expiresInSec: 280,
                lastActivity: 'Running verification suite',
                lastTool: { name: 'exec', at: at - 4_000 },
              },
            ]
          : []
      return {
        ok: true,
        counts: { turns: turns.length, tasks: tasks.length, architect: architectRunning },
        turns,
        tasks,
        architect,
        demo: true,
      }
    }
    case 'usage': {
      /*
       * V10 §3.3 / D47: UsageSheet（`UsageSheet.jsx`）が読む形を本番 `usage.summary` と揃える。
       * `totals` / `models` / `topSessions` が無いとシートが「失敗」表示になる（実測）。
       */
      const hours = Number(route.params.get('hours')) || 24
      const at = Date.now()
      return {
        ok: true,
        hours,
        cacheHitRate: 0.994,
        totalTokens: 1_240_000,
        cost: 1.08,
        saved: 12.4,
        totals: {
          cost: 1.08,
          input: 1_232_500,
          output: 7_500,
          cacheRead: 1_225_100,
          calls: 42,
          sessions: 4,
          messages: 28,
          tools: 64,
        },
        models: [
          {
            model: 'deepseek/deepseek-v4.1-flash',
            calls: 34,
            input: 1_180_000,
            output: 6_400,
            cacheRead: 1_172_000,
            cost: 0.92,
          },
          {
            model: 'deepseek/deepseek-v4.1-pro',
            calls: 8,
            input: 52_500,
            output: 1_100,
            cacheRead: 53_100,
            cost: 0.16,
          },
        ],
        topSessions: [
          {
            id: DEMO_SESSION,
            profile: 'default',
            title: 'Demo — A2B pipeline in four steps',
            source: 'mobile',
            input: 980_000,
            output: 5_200,
            at: state.now - 4 * MIN,
            cost: 0.86,
          },
          {
            id: 'demo-review-01',
            profile: 'default',
            title: 'Quick Review — three design decisions',
            source: 'discord',
            input: 252_500,
            output: 2_300,
            at: state.now - 12 * MIN,
            cost: 0.22,
          },
        ],
        demo: true,
      }
    }
    case 'audit':
      return { lines: ['demo: audit log is generated in memory'] }
    case 'sessions':
      return {
        sessions: [
          {
            id: DEMO_SESSION,
            title: 'Demo — A2B pipeline in four steps',
            source: 'demo',
            profile: 'demo',
            messages: 6,
            updatedAt: state.now,
          },
        ],
      }
    case 'sessions.transcript':
      return {
        ok: true,
        messages: [
          { id: 'm1', role: 'user', text: 'File the batches for the demo spec.', at: state.now },
          {
            id: 'm2',
            role: 'assistant',
            text: 'Filed 3 batches. The visual gate is waiting for a redline stamp or an approval.',
            at: state.now + 1,
          },
        ],
        hasMore: false,
        oldestId: 'm1',
      }
    case 'snippets': {
      // 本物のブリッジと同じ形を返す（`items: []` だと定型チップ帯が空になり、
      // 「仕様策定」だけが残って見える・実測）。label/text は i18n の辞書に合わせる。
      // V10 §3.3 / D47: `kind === 'term'`（端末タブ）も本番と同じ構造で返す。
      const lang = String(route.params?.get('lang') || 'en').slice(0, 2) === 'ja' ? 'ja' : 'en'
      const set = (route.kind === 'term' ? DEMO_TERM_SNIPPETS : DEMO_SNIPPETS)[lang]
      return {
        snippets: set,
        allSnippets: set,
        overrides: {},
        custom: [],
        customMax: 16,
        hotLimit: 8,
        lang,
      }
    }
    case 'memos.list': {
      if (method === 'POST') {
        const nowIso = new Date().toISOString()
        const memo = {
          id: `m_${Math.random().toString(16).slice(2, 10)}`,
          title: String(payload?.title ?? '').trim(),
          body: String(payload?.body ?? '').trim(),
          tags: Array.isArray(payload?.tags) ? payload.tags.map((x) => String(x).replace(/^#+/, '').trim()).filter(Boolean) : [],
          pinned: Boolean(payload?.pinned),
          color: payload?.color || 'default',
          kind: payload?.kind || 'note',
          checklist: Array.isArray(payload?.checklist) ? payload.checklist : [],
          source: payload?.source || null,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        state.memos = [memo, ...(state.memos || [])]
        return { ok: true, memo }
      }
      const sorted = [...(state.memos || [])].sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
        return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
      })
      return { ok: true, memos: sorted }
    }
    case 'memos.item': {
      const list = state.memos || []
      const idx = list.findIndex((m) => m.id === route.id)
      if (idx === -1) return { ok: false, error: 'MEMO_NOT_FOUND' }
      if (method === 'DELETE') {
        state.memos = list.filter((m) => m.id !== route.id)
        return { ok: true, id: route.id }
      }
      if (method === 'PATCH') {
        const updated = { ...list[idx], ...(payload || {}), updatedAt: new Date().toISOString() }
        list[idx] = updated
        return { ok: true, memo: updated }
      }
      return { ok: true, memo: list[idx] }
    }
    case 'repos':
      return { repos: [{ id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)', path: '/demo/hermes-pilot', board: DEMO_BOARD }] }
    case 'receipt':
      return receiptBody()
    // V10 §3.3 / D47: 1 タップ環境最適化（SOUL.md ＋ 同梱 3 スキル）と専用プロファイル選択
    case 'pipeline.status':
      return demoPipelineStatus()
    case 'pipeline.profile': {
      const next = String(payload?.profile || '').trim()
      if (next) state.pipeline.profile = next === 'default' ? 'default' : next
      publish('pipeline')
      return {
        ok: true,
        pilotProfile: state.pipeline.profile,
        status: demoPipelineStatus(),
        demo: true,
      }
    }
    case 'pipeline.optimize': {
      // 本番は書き込み（専用プロファイル SOUL.md への冪等追記＋スキル配置）。デモはフラグを立てるだけ。
      if (typeof payload?.profile === 'string' && payload.profile.trim()) {
        state.pipeline.profile = payload.profile.trim()
      }
      const doSoul = payload?.soul !== false
      const doSkills = payload?.skills !== false
      if (doSoul && doSkills) state.pipeline.optimized = true
      publish('pipeline')
      return {
        ok: true,
        pilotProfile: state.pipeline.profile,
        soul: { ok: true, applied: doSoul, changed: doSoul },
        skills: { ok: true, placed: doSkills ? 3 : 0 },
        status: demoPipelineStatus(),
        demo: true,
      }
    }
    // V10 §3.3 / D47: ワンタップ QR ペアリング（`SettingsPane` のペアリングシート）
    case 'auth.pairing': {
      const targets = [
        {
          kind: 'tailscale',
          label: 'Tailscale HTTPS (demo)',
          url: 'https://demo.tailnet.ts.net:8444/?token=demo-only',
        },
        { kind: 'lan', label: 'LAN (demo)', url: 'http://192.168.1.42:4097/?token=demo-only' },
      ]
      return {
        ok: true,
        port: 4097,
        tlsPort: 8444,
        tailscale: true,
        dnsName: 'demo.tailnet.ts.net',
        lanIp: '192.168.1.42',
        targets,
        expiresAt: Date.now() + 300_000,
        qrRows: demoQrRows(),
        qrMargin: 4,
        demo: true,
      }
    }
    case 'logs':
      return demoLogText(route.params.get('file') || 'gateway', Number(route.params.get('lines') || 200))
    case 'search':
      return demoSearchHits(route.params.get('q') || '')
    case 'auth':
      return { ok: true, token: null, demo: true }
    // COH-2: Discord スレッドへのリンク。デモは「リンク無し」を明示する（本番 404 と同じ意味）。
    case 'discord.session':
      return { ok: true, found: false, link: null, demo: true }
    // COH-2: 緊急停止（新規作業のみ停止）。本番 `ops.pause()` / `ops.resume()` と同じ形の状態を返し、
    // `/api/overview` の `paused` とタスク一覧と連動させる（デモでも停止バナーが出る）。
    case 'gateway.pause':
    case 'gateway.resume': {
      const action = route.name === 'gateway.pause' ? 'pause' : 'resume'
      const expected = action.toUpperCase()
      // 本番は `confirm` が一致しないと 400（`CONFIRM_MISMATCH`）。デモも同じ扱いにする。
      if (String(payload?.confirm ?? '').toUpperCase() !== expected) {
        return { ok: false, code: 'CONFIRM_MISMATCH', expected, demo: true }
      }
      const nowIso = new Date().toISOString()
      state.demoOps.paused = action === 'pause'
        ? { engaged: true, reason: String(payload?.reason ?? 'mobile'), engagedAt: nowIso }
        : { engaged: false, reason: null, engagedAt: null }
      publish('overview')
      return { ok: true, action, state: state.demoOps.paused, output: 'demo', at: Date.now(), demo: true }
    }
    case 'gateway':
      return { ok: true, state: 'running', demo: true }
    // D90: 全タスク緊急停止（ESTOP ＋ 実行中一括中断）。本番 `ops.stopAll()` と同じ形を返し、
    // `/api/overview` の `paused` とタスク一覧へ連動させる（デモでも 1 タップ停止を体験できる）。
    case 'emergency.stopAll': {
      if (String(payload?.confirm ?? '').toUpperCase() !== 'STOP_ALL') {
        return { ok: false, code: 'CONFIRM_MISMATCH', params: { expected: 'STOP_ALL' }, demo: true }
      }
      const nowIso = new Date().toISOString()
      state.demoOps.paused = {
        engaged: true,
        reason: String(payload?.reason ?? 'mobile'),
        engagedAt: nowIso,
      }
      const running = state.tasks.filter((t) => t.status === 'running')
      for (const t of running) {
        t.status = 'blocked'
        t.updatedAt = Date.now()
      }
      publish('tasks')
      publish('overview')
      return {
        ok: true,
        paused: state.demoOps.paused,
        aborted: running.length,
        abortedTasks: running.map((t) => ({ board: t.board, id: t.id })),
        failed: [],
        remainingRunning: state.tasks.filter((t) => t.status === 'running').length,
        at: Date.now(),
        demo: true,
      }
    }
    case 'clientError':
      return { ok: true }
    default:
      // 未知のパスでも画面を壊さない（空の入れ物を返す）
      return { ok: true, items: [], turns: [], sessions: [], boards: [], reports: [], specs: [], demo: true }
  }
}

/* ------------------------------------------------------------------ *
 * WebSocket（JSON-RPC）モック
 * ------------------------------------------------------------------ */

const DEMO_SESSIONS = [{ id: DEMO_SESSION, title: 'Demo — A2B pipeline in four steps', profile: 'demo', message_count: 6 }]

function rpcResult(method, params) {
  if (method === 'session.list') return { sessions: DEMO_SESSIONS }
  if (method === 'session.resume') {
    return {
      session_id: DEMO_SESSION,
      resumed: params?.session_id || DEMO_SESSION,
      info: { cwd: '/demo/hermes-pilot', model: 'demo' },
      messages: [],
    }
  }
  if (method === 'session.create') return { session_id: DEMO_SESSION, stored_session_id: DEMO_SESSION }
  if (method === 'prompt.submit') return { ok: true, session_id: params?.session_id || DEMO_SESSION }
  return { ok: true }
}

/**
 * 端末タブ（`/ws/term`）の擬似シェル。
 *
 * 本番は PTY を中継する（`{t:'in', d}` / `{t:'out', d}` / `{t:'resize'}` の 3 種だけ）。
 * デモは同じフレームで「読めるが何も起きない」端末を返す（デモから実ホストを触らせない）。
 *
 * @param {(payload: object) => void} emit 端末フレームを 1 つ流す関数
 * @returns {{send: (raw: string) => void}} 端末用の送信関数
 */
function termShell(emit) {
  /** コマンド行 → 擬似標準出力。 */
  const reply = (line) => {
    const cmd = String(line ?? '').trim()
    const head = cmd.split(/\s+/)[0] ?? ''
    if (!cmd) return ''
    if (head === 'help') {
      return [
        'Demo shell commands (nothing is executed):',
        '  hermes <status|gateway status|kanban list>',
        '  npx hermes-pilot <start|qr|service status>',
        '  npm run <verify|build|build:demo>',
        '  git <status|log>',
        '  ls | pwd | whoami | clear | help',
      ].join('\r\n')
    }
    if (head === 'hermes') {
      const tail = cmd.slice(head.length).trim()
      if (tail.startsWith('gateway status')) return 'gateway: running (pid 4242, uptime 1h 12m) — demo'
      if (tail.startsWith('kanban list')) {
        return [
          'mobile/t_demo_review   blocked  [DEMO-1] Interactive demo — three design decisions',
          'mobile/t_demo_done     done     [DEMO-0] Static demo shell builds with npm run build:demo',
        ].join('\r\n')
      }
      if (tail.startsWith('gateway')) return 'gateway: running (demo)'
      return 'hermes: demo shell — nothing is executed'
    }
    if (head === 'npx' && String(cmd).includes('hermes-pilot')) {
      const tail = cmd.slice(cmd.indexOf('hermes-pilot') + 'hermes-pilot'.length).trim()
      if (tail.startsWith('qr')) return 'Pairing QR (demo): https://demo.tailnet.ts.net:8444/?token=demo-only'
      if (tail.startsWith('service')) return 'Hermes Pilot (demo): running on 127.0.0.1:4097'
      return 'Hermes Pilot (demo) started — http://127.0.0.1:4097'
    }
    if (head === 'npm') {
      if (/\bverify\b/.test(cmd)) return 'verify: 812 tests, 0 fail — build ok — demo (not a real run)'
      if (/build:demo/.test(cmd)) return 'dist-demo written: google-sites-embed.html (demo)'
      if (/\bbuild\b/.test(cmd)) return 'vite build (demo) — dist/ written'
      return 'npm (demo) — nothing is executed'
    }
    if (head === 'git') {
      if (/log/.test(cmd)) return 'd3m0a1b feat(demo): static demo shell builds with npm run build:demo'
      return 'On branch main\r\nnothing to commit, working tree clean (demo)'
    }
    if (head === 'ls') return 'apps  docs  package.json  plugin.json  scripts  skills'
    if (head === 'pwd') return '/demo/hermes-pilot'
    if (head === 'whoami') return 'demo'
    if (head === 'clear') return '\x1b[2J\x1b[H'
    if (head === 'echo') return cmd.slice(5)
    return `zsh: command not found: ${head} (demo shell)`
  }
  let buffer = ''
  return {
    send(raw) {
      let msg = null
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (!msg || msg.t !== 'in') return
      const data = String(msg.d ?? '')
      buffer += data
      if (!/[\r\n]/.test(data)) return
      const line = buffer.replace(/[\r\n]+$/, '')
      buffer = ''
      // 入力のエコー → コマンド出力 → 次のプロンプト（本物の端末と同じ並び）
      const out = `${data.replace(/\r/g, '')}${reply(line)}\r\n$ `
      setTimeout(() => emit({ t: 'out', d: out }), 0)
    },
  }
}

/**
 * `openSocket()` のデモ実装。`WebSocket` と同じ形（`readyState` / `send` / `close` / `onopen` 等）で、
 * 接続すると `gateway.ready` を 1 回だけ流す（本物のゲートウェイと同じ合図）。
 *
 * V10 §3.3 / D47: `path` が `/ws/term` のときは端末プロトコル（`{t:'out', d}`）で応答する。
 *
 * @param {string} [path] 接続先（`/ws/chat` 既定）
 * @returns {object} 擬似ソケット
 */
export function demoSocket(path = '/ws/chat') {
  const isTerm = String(path ?? '').startsWith('/ws/term')
  if (isTerm) {
    const sock = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(raw) {
        shell.send(raw)
      },
      close() {
        sock.readyState = 3
        sock.onclose?.({})
      },
      addEventListener(type, fn) {
        if (type === 'open') sock.onopen = fn
        if (type === 'message') sock.onmessage = fn
        if (type === 'close') sock.onclose = fn
        if (type === 'error') sock.onerror = fn
      },
      removeEventListener() {},
    }
    const shell = termShell((payload) => sock.onmessage?.({ data: JSON.stringify(payload) }))
    // 端末のバナーは `socket.onmessage` を張った後に届ける（張る前に流すと捨てられる）
    setTimeout(() => {
      sock.readyState = 1
      sock.onopen?.({})
      sock.onmessage?.({
        data: JSON.stringify({
          t: 'out',
          d: '\r\n\x1b[36mHermes Pilot Demo Shell (read-only simulation)\x1b[0m\r\n$ ',
        }),
      })
    }, 0)
    return sock
  }
  const sock = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(raw) {
      let msg = null
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (!msg || msg.id == null) return
      const reply = { jsonrpc: '2.0', id: msg.id, result: rpcResult(msg.method, msg.params) }
      setTimeout(() => sock.onmessage?.({ data: JSON.stringify(reply) }), 0)
    },
    close() {
      sock.readyState = 3
      sock.onclose?.({})
    },
    addEventListener(type, fn) {
      if (type === 'open') sock.onopen = fn
      if (type === 'message') sock.onmessage = fn
      if (type === 'close') sock.onclose = fn
      if (type === 'error') sock.onerror = fn
    },
    removeEventListener() {},
  }
  setTimeout(() => {
    sock.readyState = 1
    sock.onopen?.({})
    sock.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'gateway.ready', params: { type: 'gateway.ready' } }) })
  }, 0)
  return sock
}

/**
 * `GET /api/coherence/report` のデモ応答（SPEC-COHERENCE §3.4 / D82）。
 *
 * 本番は対象リポジトリで `analyzeCoherence()` を走らせる。デモはバックエンドを持たないので、
 * スイープシートのバッジ・推奨プリセット・起点ファイルが成立する最小の信号集合を返す。
 * `layers` も本番と同じ形（汎用 Layer 1 ＋ リポジトリ固有 Layer 2）で揃えておく。
 * @returns {object} 診断レポート
 */
function demoCoherenceReport() {
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
