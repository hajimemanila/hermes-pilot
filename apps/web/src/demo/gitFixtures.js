/**
 * デモのタスク詳細・差分・ワーカーフィードの定型データ。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import { DEMO_BOARD, DEMO_REPO_PATH, DEMO_SESSION } from './fixtures.js'

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
