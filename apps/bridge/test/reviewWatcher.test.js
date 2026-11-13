import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createReviewWatcher } from '../src/review-watcher.js'

/**
 * 一時環境（home/kanban/boards/mobile/kanban.db + review ディレクトリ）を作る。
 * `tasks` はウォッチャーが読む列だけを持つ（実 DB と同じ名前）。
 */
function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-watcher-'))
  const kanbanRoot = path.join(root, 'kanban')
  const boardDir = path.join(kanbanRoot, 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile' }))
  const dbPath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
    result TEXT, session_id TEXT)`)
  db.close()
  const reviewDir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(reviewDir, { recursive: true })
  return { root, kanbanRoot, dbPath, reviewDir }
}

function addTask(dbPath, task) {
  const db = new DatabaseSync(dbPath)
  db.prepare(
    'INSERT INTO tasks (id,title,body,status,created_at,result,session_id) VALUES (?,?,?,?,?,?,?)',
  ).run(
    task.id,
    task.title ?? 'タスク',
    task.body ?? '[review] label=x-01 round=1 mode=sheet sheet=sheets/x-01-1.html',
    task.status ?? 'ready',
    Math.floor(Date.now() / 1000),
    task.result ?? null,
    task.session_id ?? null,
  )
  db.close()
}

function setStatus(dbPath, id, status) {
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id)
  db.close()
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

test('初回起動はベースライン確立のみ（過去の done を通知しない）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_old1', title: '昔の完了', status: 'done' })
  const state = { now: () => Date.parse('2026-11-13T22:00:00+08:00') }
  const w = createReviewWatcher(
    { kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir },
    { ...state, intervalMs: 10_000 },
  )

  const r = w.tick()
  assert.equal(r.baseline, true, 'state ファイルが無ければ初回 = ベースライン')
  assert.equal(r.reported.length, 0, '過去分は通知しない')
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'feed.jsonl')), [])
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')), [])

  const saved = JSON.parse(fs.readFileSync(path.join(env.reviewDir, 'watcher-state.json'), 'utf8'))
  assert.equal(saved.tasks.t_old1.status, 'done', '現在の状態だけ記録する')
  assert.equal(saved.tasks.t_old1.reportedDoneAt, null)
  // アトミック更新: .tmp が残らない
  assert.equal(fs.existsSync(path.join(env.reviewDir, 'watcher-state.json.tmp')), false)
})

test('done 遷移で feed と chat-reports に 1 行ずつ追記し、2 回目は増えない', () => {
  const env = tempEnv()
  addTask(env.dbPath, {
    id: 't_done1',
    title: 'レビュー: 帯の形',
    body: '[review] label=strip-01 round=1 mode=sheet sheet=sheets/strip-01-1.html chat=20261113_011804_9597b4',
    status: 'running',
  })
  const w = createReviewWatcher(
    { kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir },
    { intervalMs: 10_000, now: () => Date.parse('2026-11-13T22:10:00+08:00') },
  )
  w.tick() // ベースライン（running）

  setStatus(env.dbPath, 't_done1', 'done')
  const r = w.tick()
  assert.equal(r.reported.length, 1)
  assert.equal(r.reported[0].kind, 'done')

  const feed = readJsonl(path.join(env.reviewDir, 'feed.jsonl'))
  assert.equal(feed.length, 1, 'フィードは 1 行')
  assert.equal(feed[0].kind, 'done')
  assert.equal(feed[0].task_id, 't_done1')
  assert.equal(feed[0].label, 'strip-01')
  assert.match(feed[0].text, /^✅ /)
  assert.match(feed[0].text, /\(t_done1\)$/)

  const reports = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))
  assert.equal(reports.length, 1, '会話宛ての完了報告も 1 行')
  assert.equal(reports[0].session_id, '20261113_011804_9597b4', '本文の chat= を宛先にする')
  assert.equal(reports[0].task_id, 't_done1')

  // 同じ状態のまま何度ティックしても増えない（冪等）
  w.tick()
  w.tick()
  assert.equal(readJsonl(path.join(env.reviewDir, 'feed.jsonl')).length, 1)
  assert.equal(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')).length, 1)
})

test('result があれば完了報告の本文にする（無ければタイトル）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_r1', title: 'タイトル', status: 'running', body: '[review] label=r-01 chat=chat-r' })
  const w = createReviewWatcher({ kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir }, { intervalMs: 10_000 })
  w.tick()
  setStatus(env.dbPath, 't_r1', 'done')
  const db = new DatabaseSync(env.dbPath)
  db.prepare("UPDATE tasks SET result=? WHERE id='t_r1'").run('verify=npm run verify → exit 0')
  db.close()
  w.tick()
  const reports = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))
  assert.equal(reports.length, 1)
  assert.match(reports[0].text, /exit 0/)
})

test('running → blocked の遷移は kind=blocked で 1 行（会話報告は書かない）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_b1', title: '2 巡目', status: 'running', body: '[review] label=r2-01 round=2 chat=chat-b' })
  const w = createReviewWatcher({ kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir }, { intervalMs: 10_000 })
  w.tick()

  setStatus(env.dbPath, 't_b1', 'blocked')
  const r = w.tick()
  assert.equal(r.reported.length, 1)
  assert.equal(r.reported[0].kind, 'blocked')
  const feed = readJsonl(path.join(env.reviewDir, 'feed.jsonl'))
  assert.equal(feed.length, 1)
  assert.equal(feed[0].kind, 'blocked')
  assert.match(feed[0].text, /^⏸ /)
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')), [], 'ブロックは会話報告に書かない')
})

test('blocked へ別の状態から入っても通知しない（spec は running → blocked のみ）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_b2', title: '待機', status: 'ready', body: '[review] label=x-02' })
  const w = createReviewWatcher({ kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir }, { intervalMs: 10_000 })
  w.tick()
  setStatus(env.dbPath, 't_b2', 'blocked')
  const r = w.tick()
  assert.equal(r.reported.length, 0)
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'feed.jsonl')), [])
})

test('レビュー行を持たないタスクは監視しない（[review] の言及だけの本文も除外）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_plain', title: '普通のタスク', body: 'ふつうの本文', status: 'done' })
  addTask(env.dbPath, { id: 't_mention', title: '言及だけ', body: 'レビューは [review] タグで起票する', status: 'done' })
  const w = createReviewWatcher({ kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir }, { intervalMs: 10_000 })
  const r = w.tick()
  assert.equal(r.seen, 0, '機械可読行が先頭に無いものはレビューではない')
})

test('移行前の [akapen] タスクも監視する（移行前でもレビューが消えない）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_legacy', title: '旧タグ', status: 'running', body: '[akapen] label=old-01' })
  const w = createReviewWatcher({ kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir }, { intervalMs: 10_000 })
  w.tick()
  setStatus(env.dbPath, 't_legacy', 'done')
  w.tick()
  const feed = readJsonl(path.join(env.reviewDir, 'feed.jsonl'))
  assert.equal(feed.length, 1)
  assert.equal(feed[0].kind, 'done')
})

test('start / stop はタイマーを持ち、tick はテストから直接呼べる', () => {
  const env = tempEnv()
  const w = createReviewWatcher(
    { kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir },
    { intervalMs: 60_000 },
  )
  w.start()
  assert.equal(w.status().running, true)
  assert.equal(w.status().ticks, 1, 'start は即 1 ティック（ベースライン）')
  w.stop()
  assert.equal(w.status().running, false)
})
