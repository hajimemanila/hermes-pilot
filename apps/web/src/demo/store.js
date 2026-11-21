/**
 * デモの状態ストア（ツアー状態 1 枚 + 購読）。`mockApi.js` から分割した。
 *
 * `state` は **live binding** で公開する（読み手は `import { state }` で最新を見られる）。
 * 代入はこのモジュールの中だけで行い、外からは `resetDemoState()` を使う。
 */
import {
  DEMO_BOARD,
  DEMO_REPO,
  DEMO_REPO_PATH,
  DEMO_SESSION,
  DEMO_SPEC_PATH,
  DEMO_SPEC_V4_PATH,
  DEMO_SPEC_V5_PATH,
  DEMO_TICK_MS,
  DEMO_RUNNER_LABEL,
  MIN,
  SPEC_MTIME_SLACK_MS,
  demoQuestions,
  demoRunnerLabel,
  emptyProgress,
  initialReviewItems,
  stepIndex,
} from './fixtures.js'

let generation = 0
export let state = createDemoState()
const listeners = new Set()

/** ツアー状態の購読（`DemoBanner` が使う）。戻り値を呼ぶと解除。 */
export function subscribeDemo(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 変更を購読側へ流す（デモ専用の軽いバス）。 */
export function publish(kind = 'change') {
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
/**
 * デモの SPEC 一覧に「このセッションで退避したもの」（`state.archivedSpecPaths`）を重ねる。
 *
 * `demoSpeccs`（Launchpad）と `demoSpecContent`（MD プレビュー）が同じ状態を見るための 1 箇所。
 *
 * @param {number} [now] 時刻
 * @returns {Array<object>} SPEC 一覧（アーカイブ済みは `archived: true`）
 */
export function demoSpecsWithArchive(now = Date.now()) {
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
