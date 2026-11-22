import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAuth, isAllowedWsOrigin } from '../src/auth.js'
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

  // 誤ったトークン（マルチバイト文字でも例外にならない）
  assert.equal(auth.exchange('wrong'), null)
  assert.equal(auth.exchange('あ'.repeat(auth.token.length)), null)

  // ?t= クエリ認証でも書き込み時は X-Client 必須
  assert.equal(auth.authorized({ url: `/api/overview?t=${auth.token}`, headers: {}, method: 'GET' }), true)
  assert.equal(auth.authorized({ url: `/api/tasks/1/reply?t=${auth.token}`, headers: {}, method: 'POST' }), false)
  assert.equal(
    auth.authorized({ url: `/api/tasks/1/reply?t=${auth.token}`, headers: { 'x-client': 'mobile' }, method: 'POST' }),
    true,
  )
})

test('WebSocket Origin 検証: 同一オリジンのみ許可（Origin なしは CLI 扱い）', () => {
  assert.equal(isAllowedWsOrigin({ headers: { host: 'example.ts.net:8444' } }), true)
  assert.equal(
    isAllowedWsOrigin({ headers: { host: 'example.ts.net:8444', origin: 'https://Example.ts.net:8444' } }),
    true,
  )
  assert.equal(
    isAllowedWsOrigin({
      headers: { host: '127.0.0.1:8787', 'x-forwarded-host': 'example.ts.net:8444', origin: 'https://example.ts.net:8444' },
    }),
    true,
  )
  assert.equal(
    isAllowedWsOrigin({ headers: { host: 'example.ts.net:8444', origin: 'https://evil.example' } }),
    false,
  )
  assert.equal(isAllowedWsOrigin({ headers: { host: 'example.ts.net:8444', origin: 'null' } }), false)
  assert.equal(isAllowedWsOrigin({ headers: { host: 'example.ts.net:8444', origin: 'file://' } }), false)
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

test('カンバン: abort は reclaim → block を順に実行し、reclaim 失敗時は block せず ok:false を返す', async () => {
  const dir = tmp('hm-kb-abort-')
  makeBoard(dir, 'alpha')

  const calls = []
  const okKb = createKanban(cfgFor(dir), {
    runKanban: async (slug, args) => {
      calls.push([slug, ...args])
      return { code: 0, out: 'ok' }
    },
  })
  const res = await okKb.abort('alpha', 't_run', 'stop now', 'en')
  assert.equal(res.ok, true)
  assert.equal(res.reclaimed, true)
  assert.equal(res.blocked, true)
  assert.deepEqual(calls, [
    ['alpha', 'reclaim', 't_run', '--reason', 'stop now'],
    ['alpha', 'block', 't_run', 'Interrupted from mobile: stop now', '--kind', 'needs_input'],
  ])

  const failCalls = []
  const failKb = createKanban(cfgFor(dir), {
    runKanban: async (slug, args) => {
      failCalls.push([slug, ...args])
      return { code: 2, out: 'reclaim failed' }
    },
  })
  const failRes = await failKb.abort('alpha', 't_run', 'stop now', 'en')
  assert.equal(failRes.ok, false)
  assert.equal(failRes.reclaimed, false)
  assert.equal(failRes.blocked, false)
  assert.equal(failCalls.length, 1, 'reclaim 失敗時は block に進まない')

  // 実 CLI 呼び出しが `kanban --board <slug>` の正しい語順であることをソースレベルでも固定
  const src = fs.readFileSync(new URL('../src/kanban.js', import.meta.url), 'utf8')
  assert.match(src, /\['kanban',\s*'--board',\s*slug,\s*\.\.\.args\]/)
  // D102: バイナリ解決は `lib/cli.js` の `runHermes()` が持つ（kanban.js は spawn しない）。
  assert.doesNotMatch(src, /execFile\(/)
  assert.match(src, /from '\.\/lib\/cli\.js'/)
  const boundary = fs.readFileSync(new URL('../src/lib/cli.js', import.meta.url), 'utf8')
  assert.match(boundary, /resolveHermesBin\(\)/)
  assert.match(boundary, /buildAugmentedPath\(\)/)
})

test('カンバン: 存在しないボード/タスクは 404', async () => {
  const dir = tmp('hm-kb4-')
  makeBoard(dir, 'alpha')
  const kb = createKanban(cfgFor(dir))
  assert.throws(() => kb.tasks('nope'), (err) => err.statusCode === 404)
  assert.throws(() => kb.task('alpha', 'nope'), (err) => err.statusCode === 404)
})

test('認証: 発行したセッションは再起動（createAuth の作り直し）でも生きている', () => {
  const dir = tmp('hm-a3-')
  const cfg = cfgFor(dir)
  const first = createAuth(cfg)
  const value = first.exchange(first.token)
  assert.ok(fs.existsSync(path.join(dir, 'sessions.json')))

  const second = createAuth(cfg) // プロセス再起動相当
  assert.equal(second.authorized({ url: '/api/x', headers: { cookie: `hm_session=${value}` }, method: 'GET' }), true)
})

test('認証: トークンをローテーションすると全セッションが失効する', () => {
  const dir = tmp('hm-a4-')
  const cfg = cfgFor(dir)
  const first = createAuth(cfg)
  const value = first.exchange(first.token)

  fs.rmSync(path.join(dir, 'token'))
  const rotated = createAuth(cfg) // 新しいトークンを生成
  assert.notEqual(rotated.token, first.token)
  assert.equal(rotated.authorized({ url: '/', headers: { cookie: `hm_session=${value}` }, method: 'GET' }), false)
  assert.equal(rotated.sessions().length, 0)
})

test('認証: revokeAll で端末だけ失効（トークンは有効なまま）', () => {
  const dir = tmp('hm-a5-')
  const cfg = cfgFor(dir)
  const auth = createAuth(cfg)
  const value = auth.exchange(auth.token)
  assert.equal(auth.sessions().length, 1)
  assert.equal(auth.revokeAll(), 1)
  assert.equal(auth.authorized({ url: '/', headers: { cookie: `hm_session=${value}` }, method: 'GET' }), false)
  assert.equal(auth.exchange(auth.token) !== null, true)
})

test('認証: 期限切れは永続化ファイルからも消える', async () => {
  const dir = tmp('hm-a6-')
  const cfg = cfgFor(dir)
  const auth = createAuth(cfg)
  const value = auth.exchange(auth.token)
  await new Promise((r) => setTimeout(r, 1100))
  const again = createAuth({ ...cfg, sessionTtlMs: 500 })
  assert.equal(again.authorized({ url: '/', headers: { cookie: `hm_session=${value}` }, method: 'GET' }), false)
})

test('readPairingConfig: config.json の tailscaleDns / tlsPort を控えとして読む（SPEC §8.2）', async () => {
  const { readPairingConfig } = await import('../src/config.js')
  const dir = tmp('hm-pair-')
  const p = path.join(dir, 'config.json')
  fs.writeFileSync(p, JSON.stringify({ tailscaleDns: 'mini.tail1.ts.net.', tlsPort: 8444 }))
  assert.deepEqual(readPairingConfig(p), { tailscaleDns: 'mini.tail1.ts.net', tlsPort: 8444 })
  // 壊れた JSON・欠損でも起動を止めない
  fs.writeFileSync(p, '{oops')
  assert.deepEqual(readPairingConfig(p), { tailscaleDns: null, tlsPort: null })
  assert.deepEqual(readPairingConfig(path.join(dir, 'nope.json')), { tailscaleDns: null, tlsPort: null })
})
