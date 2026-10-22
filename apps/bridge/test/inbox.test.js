import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createInbox, normalizeComment } from '../src/inbox.js'

/** 2ボードの一時 kanban ルートを作る。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-inbox-'))
  const boardsRoot = path.join(root, 'kanban', 'boards')
  const mk = (slug, rows) => {
    const dir = path.join(boardsRoot, slug)
    fs.mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(path.join(dir, 'kanban.db'))
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, block_kind TEXT,
        block_recurrences INTEGER DEFAULT 0, last_failure_error TEXT, worker_pid INTEGER,
        created_at INTEGER, started_at INTEGER, completed_at INTEGER, session_id TEXT);
      CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, author TEXT, body TEXT, created_at INTEGER);
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, payload TEXT, created_at INTEGER);
    `)
    const ins = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    for (const r of rows) ins.run(...r)
    db.close()
    return path.join(dir, 'kanban.db')
  }
  const now = Math.floor(Date.now() / 1000)
  mk('b1', [
    ['t_a1', '質問のあるタスク', 'blocked', 'needs_input', 0, null, null, now - 600, now - 500, now - 100, 's1'],
    ['t_a2', '完了', 'done', null, 0, null, null, now - 600, null, now - 300, null],
    ['t_a3', '失敗したタスク', 'blocked', 'failure', 2, 'boom: exit 1', 123, now - 900, now - 800, now - 50, null],
  ])
  const b2Path = mk('b2', [['t_b1', '別ボードの停止', 'blocked', null, 0, null, null, now - 400, null, null, null]])
  void b2Path
  // コメントとイベントを b1 に入れる
  const db = new DatabaseSync(path.join(boardsRoot, 'b1', 'kanban.db'))
  db.prepare('INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?,?,?,?)').run(
    't_a1', 'hermes', '本番に反映してよいですか？', now - 90,
  )
  db.prepare('INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?,?,?,?)').run(
    't_a1', 'blocked', JSON.stringify({ message: 'デプロイ可否の確認が必要' }), now - 95,
  )
  db.close()
  return { root, b2Path }
}

const fakeKanban = {
  boards: () => [
    { slug: 'b1', name: 'ボード1', archived: false },
    { slug: 'b2', name: 'ボード2', archived: false },
    { slug: 'gone', name: '存在しない', archived: false },
    { slug: 'old', name: 'アーカイブ', archived: true },
  ],
}

test('normalizeComment は空を拒否し、長すぎる本文を切る', () => {
  assert.throws(() => normalizeComment('   '), /コメント/)
  assert.equal(normalizeComment('  ok  '), 'ok')
  assert.equal(normalizeComment('x'.repeat(3000)).length, 2000)
})

test('ボード横断で blocked を集め、理由と直近コメントを付ける', () => {
  const { root } = fixture()
  const inbox = createInbox({ kanbanRoot: path.join(root, 'kanban') }, fakeKanban)
  const r = inbox.list()
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 3) // t_a1, t_a3, t_b1

  const a1 = r.items.find((x) => x.id === 't_a1')
  assert.equal(a1.board, 'b1')
  assert.equal(a1.boardName, 'ボード1')
  assert.equal(a1.blockKind, 'needs_input')
  assert.equal(a1.reason, 'デプロイ可否の確認が必要')
  assert.equal(a1.lastComment.body, '本番に反映してよいですか？')
  assert.equal(a1.lastComment.author, 'hermes')

  const a3 = r.items.find((x) => x.id === 't_a3')
  assert.equal(a3.blockKind, 'failure')
  assert.equal(a3.recurrences, 2)
  assert.equal(a3.reason, 'boom: exit 1')

  const b1 = r.items.find((x) => x.id === 't_b1')
  assert.equal(b1.boardName, 'ボード2')
  assert.equal(b1.blockKind, null)
})

test('並び順は新しいブロックが先頭', () => {
  const { root } = fixture()
  const r = createInbox({ kanbanRoot: path.join(root, 'kanban') }, fakeKanban).list()
  assert.equal(r.items[0].id, 't_a3') // now-50 が最新
})

test('件数の集計は blockKind ごと', () => {
  const { root } = fixture()
  const r = createInbox({ kanbanRoot: path.join(root, 'kanban') }, fakeKanban).list()
  assert.equal(r.counts.needs_input, 1)
  assert.equal(r.counts.failure, 1)
  assert.equal(r.counts.untyped, 1)
})

test('comment は CLI を正しい引数で呼ぶ', async () => {
  const calls = []
  const inbox = createInbox(
    {
      kanbanRoot: '/nonexistent',
      runner: async (args) => {
        calls.push(args)
        return { code: 0, out: 'ok' }
      },
    },
    fakeKanban,
  )
  const r = await inbox.comment('b1', 't_a1', '反映OKです', 'mobile')
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['kanban', '--board', 'b1', 'comment', 't_a1', '反映OKです', '--author', 'mobile'])
})

test('comment は不正なIDと CLI 失敗を弾く', async () => {
  const inbox = createInbox({ kanbanRoot: '/nonexistent', runner: async () => ({ code: 1, out: 'no such task' }) }, fakeKanban)
  await assert.rejects(() => inbox.comment('b1', '../../etc', 'x'), (e) => e.statusCode === 400)
  await assert.rejects(() => inbox.comment('b1', 't_a1', 'x'), (e) => e.statusCode === 502)
})
