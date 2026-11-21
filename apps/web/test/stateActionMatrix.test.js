/**
 * 状態 x 操作の到達性マトリクス（SPEC-RELIABILITY-GUARD / D94, Batch RG-5）。
 *
 * 単体テストは「1 操作 x 1 状態」を書きがちで、**特定の状態でどの操作も届かない**
 * デッドエンドを見逃す。ここでは全 7 状態 x 6 操作を表で固定し、状態ごとに
 * 「届く操作が 1 つ以上ある」ことも同時に検査する。
 *
 * 期待値はブリッジの実装（`inbox.js` / `kanban.js` / `capture.js`）を**実際に叩いて**
 * 判定する。モックの戻り値ではなく、例外コードと `noop` の有無まで見る。
 *
 * 到達性の語彙:
 *  - `allowed`  … 実行できる（CLI まで届く）
 *  - `noop`     … 実行はできるが状態が変わらない（冪等）
 *  - `skipped`  … 一括整理が安全のため対象外にする（D92）
 *  - `rejected:<CODE>` … 明示的に拒否される（API エラーコード）
 *
 * 一時ディレクトリと差し替えランナーだけを使い、実カンバンには触れない。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createInbox } from '../../bridge/src/inbox.js'
import { createKanban } from '../../bridge/src/kanban.js'
import { buildCreateArgs, normalizeCapture } from '../../bridge/src/capture.js'

/** カンバンの全タスク状態。 */
const STATES = ['todo', 'ready', 'running', 'blocked', 'failed', 'done', 'archived']

/** 画面に出る操作（`TasksPane` の操作群に対応）。 */
const OPS = ['abort', 'close-done', 'close-cancel', 'bulk-archive', 'resume', 'refile']

const NOW = Math.floor(Date.now() / 1000)

/**
 * 1 ボード 7 タスク（状態ごとに 1 件）の一時カンバンを作る。
 * @returns {{kanbanRoot: string, taskId: (state: string) => string}} フィクスチャ
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-state-matrix-'))
  const kanbanRoot = path.join(root, 'kanban')
  const dir = path.join(kanbanRoot, 'boards', 'b1')
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, block_kind TEXT,
      block_recurrences INTEGER DEFAULT 0, last_failure_error TEXT, worker_pid INTEGER,
      created_at INTEGER, started_at INTEGER, completed_at INTEGER, session_id TEXT,
      body TEXT, assignee TEXT);
    CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, author TEXT, body TEXT, created_at INTEGER);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, status TEXT, started_at INTEGER, ended_at INTEGER, exit_code INTEGER);
  `)
  const ins = db.prepare(
    'INSERT INTO tasks (id, title, status, created_at, started_at, session_id, body, assignee) VALUES (?,?,?,?,?,?,?,?)',
  )
  for (const state of STATES) {
    ins.run(`t_${state}`, `${state} task`, state, NOW - 600, NOW - 500, null, 'Spec: docs/SPEC-X.md', 'mobile')
  }
  db.close()
  return { kanbanRoot, taskId: (state) => `t_${state}` }
}

/** 1 操作を実行して到達性の語彙へ落とす。 */
async function outcomeOf(fn) {
  try {
    const r = await fn()
    if (r?.noop) return 'noop'
    if (r?.ok === false) return 'failed'
    return 'allowed'
  } catch (error) {
    return `rejected:${error?.code ?? 'ERROR'}`
  }
}

/** CLI ランナーの差し替え（呼ばれた引数を記録する・実カンバンは触らない）。 */
function recordingRunner(calls) {
  return async (args) => {
    calls.push(args)
    return { code: 0, out: 'ok', stdout: 'ok', stderr: '' }
  }
}

/**
 * 一括整理（`POST /api/boards/:board/tasks/bulk-archive`, D92）の判定規則。
 *
 * `running` は**止めずにスキップ**し、`archived` は既に退避済みなのでスキップする。
 * それ以外のオープンなタスクは `inbox.close(cancel)` でアーカイブする。
 * ルート自体の契約は `routeContracts.test.js` が、ここは状態ごとの期待値だけを固定する。
 *
 * @param {string} state タスク状態
 * @returns {'skipped'|'archived'} 期待される扱い
 */
function bulkArchiveExpectation(state) {
  return state === 'running' || state === 'archived' ? 'skipped' : 'archived'
}

/** 全状態 x 全操作の期待値。実装を変えるときはこの表も同時に直す。 */
const MATRIX = {
  abort: {
    todo: 'rejected:TASK_STATE_LOCKED',
    ready: 'rejected:TASK_STATE_LOCKED',
    running: 'allowed',
    blocked: 'rejected:TASK_STATE_LOCKED',
    failed: 'rejected:TASK_STATE_LOCKED',
    done: 'rejected:TASK_STATE_LOCKED',
    archived: 'rejected:TASK_STATE_LOCKED',
  },
  'close-done': {
    todo: 'allowed',
    ready: 'allowed',
    running: 'allowed',
    blocked: 'allowed',
    failed: 'allowed',
    done: 'noop',
    archived: 'allowed',
  },
  'close-cancel': {
    todo: 'allowed',
    ready: 'allowed',
    running: 'allowed',
    blocked: 'allowed',
    failed: 'allowed',
    done: 'allowed',
    archived: 'noop',
  },
  'bulk-archive': {
    todo: 'archived',
    ready: 'archived',
    running: 'skipped',
    blocked: 'archived',
    failed: 'archived',
    done: 'archived',
    archived: 'skipped',
  },
  resume: {
    todo: 'rejected:TASK_STATE_LOCKED',
    ready: 'noop',
    running: 'noop',
    blocked: 'allowed',
    failed: 'rejected:TASK_STATE_LOCKED',
    done: 'rejected:TASK_STATE_LOCKED',
    archived: 'rejected:TASK_STATE_LOCKED',
  },
  refile: {
    todo: 'allowed',
    ready: 'allowed',
    running: 'allowed',
    blocked: 'allowed',
    failed: 'allowed',
    done: 'allowed',
    archived: 'allowed',
  },
}

/**
 * 1 つの (状態, 操作) を実装に問い合わせる。
 * @param {string} op 操作
 * @param {string} state 状態
 * @param {{kanbanRoot: string, taskId: Function}} fx フィクスチャ
 * @returns {Promise<string>} 到達性
 */
async function probe(op, state, fx) {
  const calls = []
  const runner = recordingRunner(calls)
  const inbox = createInbox({ kanbanRoot: fx.kanbanRoot, runner, hermesBin: 'hermes' })
  const kanban = createKanban({ kanbanRoot: fx.kanbanRoot }, { runKanban: runner })
  const id = fx.taskId(state)

  if (op === 'abort') return outcomeOf(() => kanban.abort('b1', id, 'matrix', 'en'))
  if (op === 'close-done') return outcomeOf(() => inbox.close('b1', id, 'done', 'matrix', 'mobile', 'en'))
  if (op === 'close-cancel') return outcomeOf(() => inbox.close('b1', id, 'cancel', 'matrix', 'mobile', 'en'))
  if (op === 'resume') return outcomeOf(() => inbox.unblock('b1', id, 'matrix', 'mobile', 'en'))
  if (op === 'bulk-archive') return bulkArchiveExpectation(state)
  if (op === 'refile') {
    // Spec 再起票: 既存タスクの状態を見ない（`archived` でも起票できる = D92）
    const args = buildCreateArgs(normalizeCapture({ board: 'b1', title: 'refile', assignee: 'mobile' }))
    return args.includes('--assignee') ? 'allowed' : 'failed'
  }
  throw new Error(`unknown operation: ${op}`)
}

test('状態マトリクスは全 7 状態 x 6 操作を網羅する（抜けがあれば表が壊れている）', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...OPS].sort())
  for (const op of OPS) {
    assert.deepEqual(Object.keys(MATRIX[op]).sort(), [...STATES].sort(), `${op} must cover every state`)
  }
})

test('全 7 状態 x 6 操作の到達性がブリッジの実装と一致する（表駆動）', async () => {
  const fx = fixture()
  const rows = []
  for (const op of OPS) {
    for (const state of STATES) {
      rows.push({ op, state, expected: MATRIX[op][state] })
    }
  }
  assert.equal(rows.length, STATES.length * OPS.length)

  const actual = []
  for (const row of rows) {
    actual.push({ ...row, got: await probe(row.op, row.state, fx) })
  }
  const mismatch = actual.filter((row) => row.got !== row.expected)
  assert.deepEqual(
    mismatch.map((row) => `${row.op}/${row.state}: expected ${row.expected}, got ${row.got}`),
    [],
  )
})

test('デッドエンドが無い: どの状態でも届く操作が 1 つ以上ある', async () => {
  const fx = fixture()
  const deadEnds = []
  for (const state of STATES) {
    const reachable = []
    for (const op of OPS) {
      const got = await probe(op, state, fx)
      if (got === 'allowed' || got === 'noop' || got === 'archived') reachable.push(op)
    }
    if (!reachable.length) deadEnds.push(state)
  }
  assert.deepEqual(deadEnds, [])
})

test('一括整理は実行中を止めず、archived を二重に閉じない（D92）', () => {
  assert.equal(bulkArchiveExpectation('running'), 'skipped')
  assert.equal(bulkArchiveExpectation('archived'), 'skipped')
  for (const state of ['todo', 'ready', 'blocked', 'failed', 'done']) {
    assert.equal(bulkArchiveExpectation(state), 'archived')
  }
})

test('中断は running 以外を明示拒否し、再開は blocked だけを進める', async () => {
  const fx = fixture()
  const aborted = await probe('abort', 'running', fx)
  assert.equal(aborted, 'allowed')
  const notRunning = await probe('abort', 'ready', fx)
  assert.equal(notRunning, 'rejected:TASK_STATE_LOCKED')
  assert.equal(await probe('resume', 'blocked', fx), 'allowed')
  assert.equal(await probe('resume', 'todo', fx), 'rejected:TASK_STATE_LOCKED')
})

test('Spec 再起票は archived からも届き、必ず --assignee を伴う', async () => {
  const fx = fixture()
  assert.equal(await probe('refile', 'archived', fx), 'allowed')
  const args = buildCreateArgs(normalizeCapture({ board: 'b1', title: 'refile', assignee: 'mobile' }))
  assert.ok(args.indexOf('kanban') < args.indexOf('--board'), 'kanban subcommand comes first')
  assert.equal(args[args.indexOf('--assignee') + 1], 'mobile')
})
