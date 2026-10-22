import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAuth } from '../src/auth.js'
import { createKanban } from '../src/kanban.js'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/** テスト用の設定。 */
function cfgFor(dir) {
  return {
    dataDir: dir,
    tokenPath: path.join(dir, 'token'),
    auditPath: path.join(dir, 'audit.jsonl'),
    cookieName: 'hm_session',
    sessionTtlMs: 1000,
    kanbanRoot: path.join(dir, 'kanban'),
    kanbanDb: path.join(dir, 'kanban.db'),
  }
}

test('認証: トークン交換した Cookie だけが通る', () => {
  const dir = tmp('hm-auth-')
  const auth = createAuth(cfgFor(dir))
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600)

  // 素のリクエストは拒否
  assert.equal(auth.authorized({ url: '/api/overview', headers: {}, method: 'GET' }), false)

  // 交換 → Cookie で通る
  const value = auth.exchange(auth.token)
  assert.ok(value)
  const req = { url: '/api/overview', headers: { cookie: `hm_session=${value}` }, method: 'GET' }
  assert.equal(auth.authorized(req), true)

  // 書き込みは X-Client 必須（CSRF 多層防御）
  const write = { ...req, method: 'POST' }
  assert.equal(auth.authorized(write), false)
  assert.equal(auth.authorized({ ...write, headers: { ...write.headers, 'x-client': 'mobile' } }), true)

  // 誤ったトークン
  assert.equal(auth.exchange('wrong'), null)
})

test('認証: 期限切れの Cookie は落ちる', async () => {
  const dir = tmp('hm-auth2-')
  const auth = createAuth(cfgFor(dir))
  const value = auth.exchange(auth.token)
  await new Promise((r) => setTimeout(r, 1100))
  assert.equal(auth.authorized({ url: '/', headers: { cookie: `hm_session=${value}` }, method: 'GET' }), false)
})

/** 合成カンバン DB を作る。 */
function makeBoard(dir, slug) {
  const boardDir = path.join(dir, 'kanban', 'boards', slug)
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug, name: 'Test Board', icon: '🧪' }))
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, status TEXT,
      priority INTEGER, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
      workspace_path TEXT, branch_name TEXT, worker_pid INTEGER, last_heartbeat_at INTEGER,
      result TEXT, consecutive_failures INTEGER, session_id TEXT, current_step_key TEXT);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, run_id INTEGER, kind TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, status TEXT, started_at INTEGER, ended_at INTEGER, exit_code INTEGER);
    CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT, author TEXT, body TEXT, created_at INTEGER);
  `)
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    't_done',
    '完了タスク',
    'body',
    'default',
    'done',
    0,
    now - 100,
    now - 90,
    now - 60,
    null,
    null,
    null,
    null,
    'ok',
    0,
    null,
    null,
  )
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    't_run',
    '実行中タスク',
    'body',
    'default',
    'running',
    0,
    now - 30,
    now - 20,
    null,
    null,
    null,
    4242,
    now,
    null,
    0,
    null,
    null,
  )
  db.prepare('INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?,?,?,?)').run('t_run', 'claimed', '{}', now - 20)
  db.prepare('INSERT INTO task_runs (task_id, status, started_at, ended_at) VALUES (?,?,?,?)').run('t_run', 'running', now - 20, null)
  db.close()
  return boardDir
}

test('カンバン: ボード一覧と件数、current の判定', () => {
  const dir = tmp('hm-kb-')
  makeBoard(dir, 'alpha')
  const cfg = cfgFor(dir)
  fs.writeFileSync(path.join(cfg.kanbanRoot, 'current'), 'alpha\n')
  const kb = createKanban(cfg)
  const boards = kb.boards()
  assert.equal(boards.length, 1)
  assert.equal(boards[0].slug, 'alpha')
  assert.equal(boards[0].current, true)
  assert.equal(boards[0].counts.done, 1)
  assert.equal(boards[0].counts.running, 1)
})

test('カンバン: 一覧は新しい順、詳細はイベント付き', () => {
  const dir = tmp('hm-kb2-')
  makeBoard(dir, 'alpha')
  const kb = createKanban(cfgFor(dir))
  const tasks = kb.tasks('alpha', { limit: 10 })
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].id, 't_run') // started_at が新しい
  assert.equal(tasks[0].running, true)
  const detail = kb.task('alpha', 't_run')
  assert.equal(detail.events.length, 1)
  assert.equal(detail.runs.length, 1)
  assert.equal(detail.workerPid, 4242)
})

test('カンバン: 実行中でないタスクの中断は 409', async () => {
  const dir = tmp('hm-kb3-')
  makeBoard(dir, 'alpha')
  const kb = createKanban(cfgFor(dir))
  await assert.rejects(() => kb.abort('alpha', 't_done', 'test'), (err) => err.statusCode === 409)
})

test('カンバン: 存在しないボード/タスクは 404', async () => {
  const dir = tmp('hm-kb4-')
  makeBoard(dir, 'alpha')
  const kb = createKanban(cfgFor(dir))
  assert.throws(() => kb.tasks('nope'), (err) => err.statusCode === 404)
  assert.throws(() => kb.task('alpha', 'nope'), (err) => err.statusCode === 404)
})
