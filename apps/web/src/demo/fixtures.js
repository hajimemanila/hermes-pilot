/**
 * デモのデータ（SPEC・設問・タスク・レビュー）と初期状態の組み立て。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import { DEMO_SNIPPETS, DEMO_TERM_SNIPPETS } from './snippets.js'
// 退避済み / 種から作った SPEC は状態を参照する（読み取りだけ。代入は store.js が持つ）。


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

export const MIN = 60_000

/** 無印（Spec 行の無い）タスクを拾ってよい猶予（ms）。`specs.SPEC_MTIME_SLACK_MS` と同じ値。 */
export const SPEC_MTIME_SLACK_MS = 5000

/** デモタスクの Spec パス（`spec` 優先・本文の `Spec:` 行・先頭 5 行の `docs/SPEC-*.md`）。 */
export function demoTaskSpecOf(task) {
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
export function demoTaskStampMs(task) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  return Math.max(n(task?.createdAt), n(task?.startedAt), n(task?.completedAt))
}

/** 3 問の設計判断（各問に推奨 1 つ。`⚡ Accept All Recommended` の材料）。 */
export function demoQuestions() {
  return [
    {
      id: 'q1',
      text: 'Which screen should the guided tour open first?',
      visualMock: { shot: 'shots/demo-q1.png', layoutVariant: 'A', template: 'layout-card' },
      options: [
        {
          id: 'A',
          label: 'Review — one tap on the decision sheet',
          detail: 'Opens the pending Quick Review sheet with the recommended answers pre-selected.',
          recommended: true,
          visualMock: { shot: 'shots/demo-q1-a.png', layoutVariant: 'A', theme: 'cyan' },
        },
        {
          id: 'B',
          label: 'Tasks — read the board first',
          detail: 'Slower start; the tour would need an extra tap.',
          visualMock: { shot: 'shots/demo-q1-b.png', layoutVariant: 'B', theme: 'amber' },
        },
      ],
    },
    {
      id: 'q2',
      text: 'How should the completion receipt be shared?',
      visualMock: { shot: 'shots/demo-q2.png', layoutVariant: 'A', template: 'flow-card' },
      options: [
        {
          id: 'A',
          label: 'Copy an X post + download the 1200x630 PNG',
          detail: 'Matches SPEC-PILOT-V5 D26: the receipt is a shareable card.',
          recommended: true,
          visualMock: { shot: 'shots/demo-q2-a.png', layoutVariant: 'A', theme: 'cyan' },
        },
        {
          id: 'B',
          label: 'PNG only',
          detail: 'No text for a post.',
          visualMock: { shot: 'shots/demo-q2-b.png', layoutVariant: 'B', theme: 'violet' },
        },
      ],
    },
    {
      id: 'q3',
      text: 'Which Vibe mode should the demo start in on a PC?',
      visualMock: { shot: 'shots/demo-q3.png', layoutVariant: 'A', template: 'policy-card' },
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


/** ランナーの表示名（本番 `architect.js` の `runnerLabel` と同じ文字列）。 */
export function demoRunnerLabel() {
  return DEMO_RUNNER_LABEL
}

