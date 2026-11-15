import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKanban } from '../src/kanban.js'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/**
 * 板を1つ作る。
 * @param {string} root kanban ルート
 * @param {string} slug スラッグ
 * @param {{name?: string, archived?: boolean, tasks?: Array<{status: string, at: number}>}} opts 中身
 */
function makeBoard(root, slug, opts = {}) {
  const dir = path.join(root, 'boards', slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'board.json'),
    JSON.stringify({ slug, name: opts.name ?? slug, archived: opts.archived ?? false }),
  )
  const db = new DatabaseSync(path.join(dir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT,
      priority INTEGER,
      assignee TEXT,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    )
  `)
  const ins = db.prepare(
    'INSERT INTO tasks (id, title, status, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  ;(opts.tasks ?? []).forEach((t, i) => {
    ins.run(`${slug}-${i}`, `task ${i}`, t.status, t.at, t.at, t.status === 'done' ? t.at : null)
  })
  db.close()
}

function cfgFor(dir) {
  return {
    dataDir: dir,
    tokenPath: path.join(dir, 'token'),
    auditPath: path.join(dir, 'audit.jsonl'),
    kanbanRoot: path.join(dir, 'kanban'),
    kanbanDb: path.join(dir, 'kanban.db'),
  }
}

test('ボード一覧は最終活動の新しい順（アーカイブは最後・current は同着時の優先のみ）', () => {
  const dir = tmp('hm-boards-')
  const root = path.join(dir, 'kanban')
  fs.mkdirSync(path.join(root, 'boards'), { recursive: true })

  // 活動時刻をわざと名前順と逆にする（名前順なら alpha が先だが、活動は omega が最新）
  makeBoard(root, 'alpha', { name: 'Alpha', tasks: [{ status: 'done', at: 1000 }] })
  makeBoard(root, 'omega', { name: 'Omega', tasks: [{ status: 'done', at: 3000 }] })
  makeBoard(root, 'middle', { name: 'Middle', tasks: [{ status: 'running', at: 2000 }] })
  makeBoard(root, 'old', { name: 'Old Archive', archived: true, tasks: [{ status: 'done', at: 9000 }] })
  fs.writeFileSync(path.join(root, 'current'), 'alpha')

  const boards = createKanban(cfgFor(dir)).boards()
  const slugs = boards.map((b) => b.slug)

  // 活動の新しい順。current(alpha) でも活動が古ければ先頭には来ない
  assert.deepEqual(slugs.slice(0, 3), ['omega', 'middle', 'alpha'])
  assert.equal(slugs[slugs.length - 1], 'old')

  // 最終活動が返る（epoch 秒）
  assert.equal(boards.find((b) => b.slug === 'omega').lastActivityAt, 3000)
  // 活動が全く無い板は null（非アーカイブの中では末尾に落ち、アーカイブより前）
  makeBoard(root, 'empty', { name: 'Empty' })
  const withEmpty = createKanban(cfgFor(dir)).boards()
  assert.equal(withEmpty.find((b) => b.slug === 'empty').lastActivityAt, null)
  const order = withEmpty.map((b) => b.slug)
  assert.equal(order[order.length - 1], 'old') // アーカイブは常に最後
  assert.ok(order.indexOf('empty') < order.indexOf('old'))
  assert.equal(order.filter((s) => s !== 'old').pop(), 'empty')
})

test('task / taskSession はワーカーの sessionId と state.db を返す（V8-B3）', () => {
  const dir = tmp('hm-board-session-')
  const root = path.join(dir, 'kanban')
  makeBoard(root, 'arch', { tasks: [{ status: 'running', at: 1700000000 }] })
  const dbPath = path.join(root, 'boards', 'arch', 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec('ALTER TABLE tasks ADD COLUMN session_id TEXT')
  db.exec('CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, payload TEXT, created_at INTEGER)')
  db.prepare("UPDATE tasks SET session_id = 'sess_row' WHERE id = 'arch-0'").run()
  db.prepare("INSERT INTO task_events (task_id,kind,payload,created_at) VALUES ('arch-0','owner_admitted',?,1)").run(
    JSON.stringify({ session_id: 'sess_row', db: '/tmp/profiles/mobile/state.db' }),
  )
  db.close()

  const kanban = createKanban(cfgFor(dir))
  const detail = kanban.task('arch', 'arch-0')
  assert.equal(detail.sessionId, 'sess_row', '詳細に sessionId が入っていない')
  const info = kanban.taskSession('arch', 'arch-0')
  assert.equal(info.sessionId, 'sess_row')
  assert.equal(info.db, '/tmp/profiles/mobile/state.db', 'db が取れていない')
})

test('taskSession は手掛かりが無ければ null（古い板でも落ちない）', () => {
  const dir = tmp('hm-board-nosession-')
  const root = path.join(dir, 'kanban')
  makeBoard(root, 'plain', { tasks: [{ status: 'done', at: 1700000000 }] })
  const kanban = createKanban(cfgFor(dir))
  assert.equal(kanban.taskSession('plain', 'plain-0'), null)
  assert.equal(kanban.task('plain', 'plain-0').sessionId, null)
})
