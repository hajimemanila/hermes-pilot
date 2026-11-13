import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLive, platformOf } from '../src/live.js'

test('platformOf は holder から platform を取り出す', () => {
  assert.equal(platformOf('pid=1:turn=x:platform=discord'), 'discord')
  assert.equal(platformOf('pid=1:platform=local:turn=x'), 'local')
  assert.equal(platformOf('pid=1:turn=x'), null)
  assert.equal(platformOf(undefined), null)
})

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-live-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, chat_type TEXT,
      last_activity_description TEXT, last_activity_at REAL);
    CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      tool_name TEXT, timestamp REAL);
  `)
  const now = Date.now() / 1000
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
    's1', 'Discord の依頼', 'discord', 'thread', 'browser_exec 実行中', now,
  )
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('s2', 'CLI', 'cli', '', null, now)
  db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
    's1', 'pid=1:turn=a:platform=discord', now - 90, now + 210,
  )
  db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
    's2', 'pid=2:turn=b:platform=local', now - 5, now + 295,
  )
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)')
  ins.run('s1', 'assistant', 'a', 'terminal', now - 30)
  ins.run('s1', 'assistant', 'b', 'browser_exec', now - 10)
  ins.run('s1', 'user', 'c', null, now - 5)
  db.close()
  return dbPath
}

const fakeKanban = {
  boards: () => [
    { slug: 'b1', name: 'ボード1' },
    { slug: 'b2', name: 'ボード2' },
  ],
  tasks: (slug) =>
    slug === 'b1'
      ? [
          { id: 't_1', title: '実行中タスク', status: 'running', elapsedSec: 120, workerPid: 999 },
          { id: 't_2', title: '完了', status: 'done', elapsedSec: null, workerPid: null },
        ]
      : [],
}

test('実行中ターンとタスクを合成する', () => {
  const live = createLive({ home: '/nonexistent', stateDb: fixture() }, fakeKanban)
  const s = live.snapshot()
  assert.equal(s.ok, true)
  assert.equal(s.turns.length, 2)
  assert.equal(s.tasks.length, 1)
  assert.equal(s.counts.turns, 2)
  assert.equal(s.counts.tasks, 1)

  const t = s.turns.find((x) => x.sessionId === 's1')
  assert.equal(t.title, 'Discord の依頼')
  assert.equal(t.platform, 'discord')
  assert.ok(t.elapsedSec >= 90)
  assert.ok(t.expiresInSec > 0)
  // 最後のツールは browser_exec（新しい方）
  assert.equal(t.lastTool.name, 'browser_exec')

  assert.equal(s.tasks[0].id, 't_1')
  assert.equal(s.tasks[0].board, 'b1')
  assert.equal(s.tasks[0].boardName, 'ボード1')
})

test('リースが無ければ空配列', () => {
  const dbPath = fixture()
  const db = new DatabaseSync(dbPath)
  db.exec('DELETE FROM session_turn_leases')
  db.close()
  const s = createLive({ home: '/nonexistent', stateDb: dbPath }, fakeKanban).snapshot()
  assert.deepEqual(s.turns, [])
  assert.equal(s.counts.turns, 0)
})

test('期限切れのリースは実行中として数えない（前日の行が稼働中に並ぶ不具合）', () => {
  const dbPath = fixture()
  const db = new DatabaseSync(dbPath)
  const now = Date.now() / 1000
  // 昨日のまま残ったリース（終わったターンの行が消えていない）
  db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
    's1', 'pid=9:turn=old:platform=local', now - 80000, now - 79700,
  )
  db.close()
  const s = createLive({ home: '/nonexistent', stateDb: dbPath }, fakeKanban).snapshot()
  assert.equal(s.turns.length, 2)
  assert.equal(s.turns.some((t) => t.sessionId === 's1'), true) // 生きているリースは残る
  assert.ok(s.turns.every((t) => (t.expiresInSec ?? 0) > 0))
  assert.equal(s.counts.turns, 2)
})

test('期限の 60 秒以内は猶予として残す（更新の遅れを誤判定しない）', () => {
  const dbPath = fixture()
  const db = new DatabaseSync(dbPath)
  const now = Date.now() / 1000
  db.exec('DELETE FROM session_turn_leases')
  db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
    's2', 'pid=3:turn=late:platform=local', now - 30, now - 20,
  )
  db.close()
  const s = createLive({ home: '/nonexistent', stateDb: dbPath }, fakeKanban).snapshot()
  assert.equal(s.turns.length, 1)
  assert.equal(s.turns[0].sessionId, 's2')
})

test('state.db が無くてもタスクは返す', () => {
  const s = createLive({ home: '/nonexistent', stateDb: '/nonexistent/state.db' }, fakeKanban).snapshot()
  assert.equal(s.ok, false)
  assert.equal(s.tasks.length, 1)
  assert.match(s.reason, /state\.db/)
})

test('カンバンが落ちてもターンは返す', () => {
  const broken = {
    boards: () => {
      throw new Error('board read failed')
    },
    tasks: () => [],
  }
  const s = createLive({ home: '/nonexistent', stateDb: fixture() }, broken).snapshot()
  assert.equal(s.turns.length, 2)
  assert.deepEqual(s.tasks, [])
})

test('複数プロファイルの state.db を横断してターンを統合する', () => {
  const dbDefault = fixture()
  const dbMobile = fixture()
  const s = createLive({ home: '/nonexistent', stateDb: dbDefault }, fakeKanban).snapshot({
    dbs: [
      { profile: 'default', path: dbDefault },
      { profile: 'mobile', path: dbMobile },
      { profile: 'nanokvm', path: '/nonexistent/state.db' },
    ],
  })
  assert.equal(s.ok, true)
  assert.equal(s.counts.turns, 4)
  assert.deepEqual(
    s.turns.map((t) => t.profile).sort(),
    ['default', 'default', 'mobile', 'mobile'],
  )
})
