import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLive, platformOf, shapeArchitectJob } from '../src/live.js'

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
  assert.equal(/[\u3040-\u30ff\u4e00-\u9fff]/.test(s.reason), false, `reason が英語になっていません: ${s.reason}`)
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
      { profile: 'sample-app', path: '/nonexistent/state.db' },
    ],
  })
  assert.equal(s.ok, true)
  assert.equal(s.counts.turns, 4)
  assert.deepEqual(
    s.turns.map((t) => t.profile).sort(),
    ['default', 'default', 'mobile', 'mobile'],
  )
})

/* ------------------------------------------------------------------ *
 * Architect（仕様策定）ジョブの統合（SPEC-PILOT-V9 §3.2 / D43 前半）
 * ------------------------------------------------------------------ */

const NOW = 1_800_000_000_000

/** `architect.jobs()` の `jobs` 相当（`publicJob` の形）。 */
function archJob(over = {}) {
  return {
    id: 'j1',
    board: 'hermes-pilot',
    status: 'running',
    runner: 'hermes',
    runnerLabel: 'Hermes Native',
    taskId: null,
    reviewTaskId: null,
    reviewBoard: null,
    seed: 'チャット欄の位置を直してほしい',
    createdAt: NOW - 120_000,
    startedAt: NOW - 120_000,
    dismissed: false,
    ...over,
  }
}

test('architect 一覧と counts.architect（running/awaiting_spec のみ数える）', () => {
  const live = createLive({ home: '/nonexistent', stateDb: fixture() }, fakeKanban)
  const s = live.snapshot({
    architect: [
      archJob({ id: 'j1', status: 'running' }),
      archJob({ id: 'j2', status: 'awaiting_spec', startedAt: NOW - 10_000 }),
      // 赤ペン待ちは一覧には出すが、件数は 🔔 判断待ちが数えるので足さない
      archJob({ id: 'j3', status: 'awaiting_review', reviewTaskId: 't_r', reviewBoard: 'mobile' }),
      // 対象外の状態は一覧にも出さない
      archJob({ id: 'j4', status: 'launched' }),
      archJob({ id: 'j5', status: 'failed' }),
      // 破棄済みは出さない
      archJob({ id: 'j6', status: 'running', dismissed: true }),
    ],
  })
  assert.equal(s.counts.architect, 2)
  assert.deepEqual(s.architect.map((j) => j.id), ['j2', 'j1', 'j3'])
  const review = s.architect.find((j) => j.id === 'j3')
  assert.equal(review.reviewTaskId, 't_r')
  assert.equal(review.reviewBoard, 'mobile')
  assert.equal(review.phase, 'awaiting_review')
})

test('tasks/turns の件数と architect は同じスナップショットに共存する', () => {
  const s = createLive({ home: '/nonexistent', stateDb: fixture() }, fakeKanban).snapshot({
    architect: [archJob({ startedAt: Date.now() - 120_000 })],
  })
  assert.equal(s.counts.tasks, 1)
  assert.equal(s.counts.turns, 2)
  assert.equal(s.counts.architect, 1)
  assert.equal(s.architect[0].board, 'hermes-pilot')
  assert.equal(s.architect[0].runnerLabel, 'Hermes Native')
  assert.ok(s.architect[0].elapsedSec >= 120)
})

test('state.db が無くても architect は返す（⚡ 実行中だけは出す）', () => {
  const s = createLive({ home: '/nonexistent', stateDb: '/nonexistent/state.db' }, fakeKanban).snapshot({
    architect: [archJob()],
  })
  assert.equal(s.ok, false)
  assert.equal(s.architect.length, 1)
  assert.equal(s.counts.architect, 1)
})

test('architect 未指定・非配列・throw する供給元でも空配列で返る', () => {
  const live = createLive({ home: '/nonexistent', stateDb: fixture() }, fakeKanban)
  assert.deepEqual(live.snapshot().architect, [])
  assert.equal(live.snapshot().counts.architect, 0)
  assert.deepEqual(live.snapshot({ architect: 'nope' }).architect, [])
  assert.deepEqual(live.snapshot({ architect: () => { throw new Error('boom') } }).architect, [])
})

test('deps.architectJobs（同期）と Promise の両方を受け取る', async () => {
  const jobs = [archJob({ id: 'j9' })]
  const syncLive = createLive({ home: '/nonexistent', stateDb: fixture() }, fakeKanban, {
    architectJobs: () => jobs,
  })
  assert.equal(syncLive.snapshot().architect[0].id, 'j9')

  const asyncLive = createLive({ home: '/nonexistent', stateDb: fixture() }, fakeKanban, {
    architectJobs: () => Promise.resolve(jobs),
  })
  const s = await asyncLive.snapshot()
  assert.equal(s.architect[0].id, 'j9')
  assert.equal(s.counts.architect, 1)
})

test('shapeArchitectJob は stallled を architect.js の値を優先し、無ければ 3 分で判定する', () => {
  const fresh = shapeArchitectJob(archJob({ startedAt: NOW - 10_000 }), NOW)
  assert.equal(fresh.stalled, false)
  const old = shapeArchitectJob(archJob({ startedAt: NOW - 181_000 }), NOW)
  assert.equal(old.stalled, true, '3分以上は停滞')
  const queued = shapeArchitectJob(archJob({ startedAt: NOW - 181_000, queueState: 'queued' }), NOW)
  assert.equal(queued.stalled, false, 'キュー待ちは停滞ではない')
  const authoritative = shapeArchitectJob(archJob({ startedAt: NOW - 10_000, stalled: true }), NOW)
  assert.equal(authoritative.stalled, true, 'architect.js の判定を上書きしない')
  const review = shapeArchitectJob(archJob({ status: 'awaiting_review', startedAt: NOW - 999_000 }), NOW)
  assert.equal(review.stalled, false, '赤ペン待ちは停滞ではない')
})

test('shapeArchitectJob は phase 未算出でも状態から埋める（B1 未適用でも画面が空にならない）', () => {
  assert.equal(shapeArchitectJob(archJob({ status: 'running' }), NOW).phase, 'spawning')
  assert.equal(shapeArchitectJob(archJob({ status: 'awaiting_spec' }), NOW).phase, 'spawning')
  assert.equal(shapeArchitectJob(archJob({ status: 'spec_ready' }), NOW).phase, 'spec_ready')
  assert.equal(shapeArchitectJob(archJob({ status: 'running', phase: 'round1_sheet' }), NOW).phase, 'round1_sheet')
  assert.equal(shapeArchitectJob({ id: 'x', status: 'running' }, NOW).runnerLabel, null)
  assert.equal(shapeArchitectJob({ id: 'x', status: 'running' }, NOW).elapsedSec, null)
})
