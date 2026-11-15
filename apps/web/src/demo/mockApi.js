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

export const DEMO_SPEC_PATH = 'docs/SPEC-DEMO-V1.md'
/** V6: 2・3 件目の SPEC（複数 SPEC のアコーディオンと MD プレビューを体験するため）。 */
export const DEMO_SPEC_V5_PATH = 'docs/SPEC-PILOT-V5.md'
export const DEMO_SPEC_V4_PATH = 'docs/SPEC-PILOT-V4.md'
export const DEMO_BOARD = 'mobile'
export const DEMO_SESSION = 'demo-a2b-01'
/** デモのリポジトリ（`/api/specs*` と `/api/repos` が返す値）。 */
export const DEMO_REPO = 'hermes-pilot-demo'
export const DEMO_REPO_PATH = '/demo/hermes-pilot'
/** V6: デモの Architect ランナー（進行バーの表示を試せるよう agy がある体で返す）。 */
export const DEMO_HAS_AGY = true
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
  return {
    ok: true,
    repo: DEMO_REPO,
    label: 'hermes-pilot (demo)',
    path: DEMO_REPO_PATH,
    board: DEMO_BOARD,
    specs: currentSpecs(now),
  }
}

/**
 * デモの SPEC 一覧（固定分 ＋ Seed で生まれた分）。
 *
 * @param {number} [now] 時刻
 * @returns {Array<object>} SPEC（`path` / `title` / `mtime` / `batches`）
 */
export function currentSpecs(now = Date.now()) {
  const seeded = Array.isArray(state?.seededSpecs) ? state.seededSpecs : []
  return [...demoSpecList(now), ...seeded]
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
  const spec = currentSpecs(now).find((s) => s.path === wanted) || null
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
    ],
    report: null,
    receipt: null,
    chatReports: [],
    notified: {},
    architect: createArchitectState(now),
    /** Seed で生まれた SPEC（`demoSpecs` / `/api/specs/content` に出る）。 */
    seededSpecs: [],
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
        runner: 'antigravity',
        requestedRunner: 'antigravity',
        runnerLabel: 'Antigravity (agy)',
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
        taskId: null,
        reviewTaskId: 't_demo_review',
        reviewTitle: '[DEMO-1] Interactive demo — three design decisions',
      },
    ],
  }
}

/** ランナーの表示名（`architect.js` の `runnerLabel` と同じ文字列）。 */
export function demoRunnerLabel(runner) {
  return runner === 'antigravity' ? 'Antigravity (agy)' : 'Hermes Native'
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

import { DEMO_SNIPPETS } from './snippets.js'

/* ------------------------------------------------------------------ *
 * 画像（外部ファイルゼロ: SVG 文字列 -> data URL）
 * ------------------------------------------------------------------ */

const SVG_INK = '#f4f7f8'
const SVG_CARD = '#ffffff'
const SVG_LINE = '#cfdde2'
const SVG_TEXT = '#5c7480'
const SVG_HEAD = '#0f766e'
const SVG_ACCENT = '#0d9488'
const SVG_WARN = '#d97706'
const SVG_BAD = '#b91c1c'

/**
 * 390x844 の擬似スクリーンショット（SVG 文字列）。
 *
 * `variant='before'` はトーストが下部ナビに重なった状態、`'after'` はナビの上へ退避した状態。
 * 画像は外部ファイルに置かず、ここで組み立てる（静的ホスティングでも 404 を出さない）。
 * 明るい配色にしてあるので、注釈（赤入れ）でどこが直ったかがひと目で分かる。
 *
 * @param {'before'|'after'} variant どちらの状態か
 * @returns {string} SVG 文字列
 */
export function mockShotSvg(variant = 'before') {
  const after = variant === 'after'
  // トーストの y 座標: before はナビ（y=760..844）に重なり、after はその上へ退避
  const toastY = after ? 688 : 772
  const rows = [0, 1, 2, 3, 4, 5]
    .map((i) => {
      const y = 150 + i * 84
      return `<g><rect x="24" y="${y}" width="342" height="64" rx="14" fill="${SVG_CARD}" stroke="${SVG_LINE}"/>
      <rect x="40" y="${y + 14}" width="164" height="11" rx="5" fill="${i < 2 ? SVG_TEXT : SVG_LINE}"/>
      <rect x="40" y="${y + 34}" width="104" height="9" rx="4" fill="${SVG_LINE}"/>
      <circle cx="334" cy="${y + 32}" r="12" fill="${i < 2 ? SVG_ACCENT : SVG_LINE}"/></g>`
    })
    .join('')
  const nav = [0, 1, 2, 3, 4]
    .map((i) => `<rect x="${30 + i * 70}" y="798" width="28" height="28" rx="8" fill="${i === 1 ? SVG_ACCENT : SVG_LINE}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
  <rect width="390" height="844" fill="${SVG_INK}"/>
  <rect x="0" y="0" width="390" height="100" fill="${SVG_CARD}"/>
  <rect x="0" y="99" width="390" height="1" fill="${SVG_LINE}"/>
  <text x="24" y="58" font-family="ui-sans-serif,system-ui" font-size="24" font-weight="700" fill="${SVG_HEAD}">Hermes Pilot</text>
  <circle cx="352" cy="50" r="9" fill="${SVG_ACCENT}"/>
  <text x="24" y="132" font-family="ui-sans-serif,system-ui" font-size="15" font-weight="700" fill="${
    after ? SVG_ACCENT : SVG_BAD
  }">${after ? 'AFTER - fixed' : 'BEFORE - reported'}</text>
  ${rows}
  <rect x="0" y="760" width="390" height="84" fill="${SVG_CARD}"/>
  <rect x="0" y="760" width="390" height="1" fill="${SVG_LINE}"/>
  ${nav}
  <g>
    <rect x="24" y="${toastY}" width="342" height="58" rx="14" fill="${after ? '#ecfdf5' : '#fef3c7'}" stroke="${
      after ? SVG_ACCENT : SVG_WARN
    }" stroke-width="2"/>
    <text x="44" y="${toastY + 36}" font-family="ui-sans-serif,system-ui" font-size="17" font-weight="700" fill="${
      after ? '#065f46' : '#7c2d12'
    }">${after ? 'Approved - above the nav' : 'Toast overlaps the nav'}</text>
  </g>
</svg>`
}

/** SVG 文字列をそのまま `<img src>` に渡せる data URL にする。 */
export function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(svg ?? ''))}`
}

/** 擬似スクリーンショットの data URL。 */
export function mockShotDataUrl(variant = 'before') {
  return svgToDataUrl(mockShotSvg(variant))
}

/**
 * `<img src="/api/review/...">` のような **fetch を通らない URL** を data URL に差し替える。
 *
 * 画面コンポーネントは本物のブリッジと同じ URL を書いているので、静的ホスティングでは
 * そのまま 404（コンソールエラー）になる。デモでは画像だけをここで解決する。
 *
 * @param {string} src 元の URL
 * @returns {string|null} 差し替え先（対象外なら null）
 */
export function demoImageFor(src) {
  const url = String(src ?? '')
  if (!url.startsWith('/api/review/')) {
    if (url.startsWith('/api/review/library/file')) return mockShotDataUrl('after')
    return null
  }
  if (url.includes('/thumb/')) return mockShotDataUrl('after')
  if (url.includes('/image')) return mockShotDataUrl(url.includes('compare=1') ? 'before' : 'after')
  if (url.includes('/sheet')) return mockShotDataUrl('after')
  return null
}

/**
 * デモ中だけ DOM の `<img>` と `new Image()` を見張って src を data URL に差し替える。
 *
 * - DOM に挿さる `<img>` は MutationObserver で拾う
 * - AnnotationEditor のように **JS で `img.src = ...` する**（DOM に挿さらない）ものは
 *   `HTMLImageElement.prototype.src` の setter を包んで拾う（デモ中だけ・冪等）
 *
 * 対象外の URL（data: や /assets/…）には触らない。
 *
 * @returns {() => void} 解除関数（テスト用）
 */
export function installDemoImageShim(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || typeof MutationObserver === 'undefined') return () => {}
  if (doc.__hmDemoImgShim) return doc.__hmDemoImgShim

  const fix = (img) => {
    const src = img.getAttribute('src')
    if (!src || img.dataset.demoFixed === '1') return
    const next = demoImageFor(src)
    if (!next) return
    img.dataset.demoFixed = '1'
    img.setAttribute('src', next)
  }
  const scan = (root) => {
    if (!root) return
    if (root.nodeType === 1 && root.tagName === 'IMG') fix(root)
    const list = root.querySelectorAll ? root.querySelectorAll('img[src^="/api/review/"]') : []
    for (const img of list) fix(img)
  }
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') {
        if (rec.target?.dataset?.demoFixed === '1') continue
        if (rec.target?.tagName === 'IMG') fix(rec.target)
        continue
      }
      for (const node of rec.addedNodes) scan(node)
    }
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  scan(doc.documentElement)

  // `new Image()` / `img.src = '/api/review/...'`（DOM に挿さらない画像）を拾う
  const view = doc.defaultView
  const Img = view?.HTMLImageElement
  const desc = Img ? Object.getOwnPropertyDescriptor(Img.prototype, 'src') : null
  let restoreSrc = () => {}
  if (desc?.set) {
    Object.defineProperty(Img.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        const next = demoImageFor(value)
        desc.set.call(this, next || value)
      },
    })
    restoreSrc = () => Object.defineProperty(Img.prototype, 'src', desc)
  }

  const off = () => {
    observer.disconnect()
    restoreSrc()
    delete doc.__hmDemoImgShim
  }
  doc.__hmDemoImgShim = off
  return off
}

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
    return { name: 'review.misc', id, params }
  }
  if (p === '/api/boards') return { name: 'boards', params }
  if (parts[1] === 'boards' && parts[2] && parts[3] === 'tasks') {
    const boardSlug = decodeURIComponent(parts[2])
    const taskId = parts[4] ? decodeURIComponent(parts[4]) : ''
    if (!taskId) return { name: 'board.tasks', id: boardSlug, params }
    if (parts[5] === 'diff') return { name: 'board.taskDiff', id: boardSlug, taskId, params }
    if (parts[5] === 'worker') return { name: 'board.taskWorker', id: boardSlug, taskId, params }
    if (parts[5] === 'abort') return { name: 'board.taskAbort', id: boardSlug, taskId, params }
    return { name: 'board.task', id: boardSlug, taskId, params }
  }
  if (p === '/api/inbox') return { name: 'inbox', params }
  if (p === '/api/specs') return { name: 'specs', params }
  // V6 §3.4: 仕様書の本文（MD プレビュー）
  if (p === '/api/specs/content') return { name: 'specs.content', params }
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
  if (p === '/api/audit') return { name: 'audit', params }
  if (p === '/api/sessions') return { name: 'sessions', params }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'transcript') {
    return { name: 'sessions.transcript', id: decodeURIComponent(parts[2]), params }
  }
  if (p === '/api/snippets') return { name: 'snippets', params }
  if (p === '/api/repos') return { name: 'repos', params }
  if (p === '/api/telemetry/receipt') return { name: 'receipt', params }
  if (p.startsWith('/api/auth/')) return { name: 'auth', params }
  if (p.startsWith('/api/gateway/')) return { name: 'gateway', params }
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

/** Step 2 の完了（全バッチ done）で統合サマリと完了レシートを作る。 */
function finishPipeline() {
  const now = Date.now()
  const reportMarkdown = [
    '# Demo pipeline — 3 batches',
    '',
    '- [DEMO-1] Spec interview and one-tap approval — done',
    '- [DEMO-2] Visual gate — redline stamp and before/after — done',
    '- [DEMO-3] Summary and completion receipt — done',
    '',
    'verify: npm run verify -> exit 0; 402 tests',
  ].join('\n')
  state.report = { at: now, board: DEMO_BOARD, spec: DEMO_SPEC_PATH, markdown: reportMarkdown, demo: true }
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

/** 起票したバッチを `tickMs` 間隔で `ready -> running -> done` に進める。 */
function advanceBatches(gen) {
  // 途中でツアーを最初からやり直したら、古いタイマーは黙って降りる
  if (gen !== state.gen) return
  const pending = state.tasks.filter((t) => t.status === 'ready' || t.status === 'running')
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

/** 公開用のジョブ（形は `architect.publicJob` + V6 の追加フィールド）。 */
export function demoPublicJob(job) {
  return { ...job, runnerLabel: demoRunnerLabel(job.runner) }
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
 * @param {object} input 種（`seedText` / `runner` / `autoStart` / `executionPolicy` / `lang` / `chat`）
 * @returns {object} 作ったジョブ
 */
export function startDemoArchitectJob(input = {}) {
  const now = Date.now()
  const runner = input.runner === 'antigravity' || input.runner === 'hermes' ? input.runner : state.architect.runner
  const executionPolicy = normalizeDemoExecutionPolicy(input.executionPolicy)
  const seq = ++state.architect.seq
  const job = {
    id: `j_demo_${seq}`,
    board: DEMO_BOARD,
    status: 'running',
    runner,
    requestedRunner: runner,
    runnerLabel: demoRunnerLabel(runner),
    fallbackFrom: null,
    fallbackReason: null,
    autoStart: Boolean(input.autoStart),
    // V7 §3.3 ①: 選んだ実行方針（`zero-stop` / `visual-gate`）をジョブに残す
    executionPolicy,
    dismissed: false,
    seed: String(input.seedText ?? '').slice(0, 400),
    lang: input.lang === 'en' ? 'en' : 'ja',
    chat: input.chat ? String(input.chat).slice(0, 128) : DEMO_SESSION,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    spec: null,
    completedSpec: null,
    launched: null,
    error: null,
    taskId: `t_demo_arch_${seq}`,
    reviewTaskId: null,
    reviewTitle: null,
  }
  state.architect.jobs.unshift(job)
  if (state.architect.jobs.length > 8) state.architect.jobs.length = 8
  publish('architect')
  setTimeout(() => advanceArchitectJob(job.id, state.gen), state.tickMs)
  return job
}

/** ジョブを 1 段進める（`running -> awaiting_spec -> spec_ready/launched`）。 */
function advanceArchitectJob(id, gen) {
  if (gen !== state.gen) return
  const job = state.architect.jobs.find((j) => j.id === id)
  if (!job) return
  if (job.status === 'running') {
    job.status = 'awaiting_spec'
    publish('architect')
    setTimeout(() => advanceArchitectJob(id, gen), state.tickMs)
    return
  }
  if (job.status !== 'awaiting_spec') return
  // Seed から生まれた SPEC（V6 §3.3 の「SPEC 検知 → バナー」をデモでも起きるようにする）
  const key = Number(String(job.id).replace(/[^0-9]/g, '')) || 1
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
  publish('architect')
}

/** 起票済みバッチ ID（`[DEMO-1] ...` の先頭から取る。`architect.filedBatchIds` と同じ規則）。 */
function filedBatchIds(tasks) {
  const out = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const m = /^\[([^\]]+)\]/.exec(String(task?.title ?? '').trim())
    if (m && m[1].trim()) out.add(m[1].trim())
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
  const filed = filedBatchIds(state.tasks)
  const pending = []
  for (const spec of currentSpecs(state.now)) {
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
    capabilities: { hasAgyCli: DEMO_HAS_AGY },
    jobs,
    specReady,
    pending,
    demo: true,
  }
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
    case 'boards':
      return {
        boards: [{ slug: DEMO_BOARD, label: 'Mobile (demo)', current: true, counts: { running: state.tasks.filter((t) => t.status === 'running').length } }],
      }
    case 'board.tasks':
      return { board: route.id, tasks: state.tasks.map((x) => ({ ...x })) }
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
    // V6 §3.4: 仕様書の本文（MD プレビュー）
    case 'specs.content':
      return demoSpecContent(route.params.get('path'), state.now)
    // V6 §3.1/§3.2: Architect のランナー設定とジョブ（進行バーの材料）
    case 'architect.config': {
      if (method === 'PUT' || method === 'POST') {
        const next = payload?.runner === 'antigravity' ? 'antigravity' : 'hermes'
        state.architect.runner = next
        publish('architect')
      }
      return { ok: true, runner: state.architect.runner, hasAgyCli: DEMO_HAS_AGY, demo: true }
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
    case 'live':
      return { counts: { turns: state.tasks.filter((t) => t.status === 'running').length }, turns: [] }
    case 'usage':
      return { hours: 24, cacheHitRate: 0.994, totalTokens: 1_240_000, cost: 1.08, saved: 12.4, demo: true }
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
      const lang = String(route.params?.get('lang') || 'en').slice(0, 2) === 'ja' ? 'ja' : 'en'
      const set = DEMO_SNIPPETS[lang]
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
    case 'repos':
      return { repos: [{ id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)', path: '/demo/hermes-pilot', board: DEMO_BOARD }] }
    case 'receipt':
      return receiptBody()
    case 'auth':
      return { ok: true, token: null, demo: true }
    case 'gateway':
      return { ok: true, state: 'running', demo: true }
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
 * `openSocket()` のデモ実装。`WebSocket` と同じ形（`readyState` / `send` / `close` / `onopen` 等）で、
 * 接続すると `gateway.ready` を 1 回だけ流す（本物のゲートウェイと同じ合図）。
 *
 * @returns {object} 擬似ソケット
 */
export function demoSocket() {
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
