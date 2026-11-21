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
        created_at INTEGER, started_at INTEGER, completed_at INTEGER, session_id TEXT, body TEXT);
      CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, author TEXT, body TEXT, created_at INTEGER);
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, payload TEXT, created_at INTEGER);
    `)
    const ins = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const r of rows) ins.run(...r.slice(0, 11), r[11] ?? null)
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
  assert.throws(() => normalizeComment('   '), (e) => e.code === 'COMMENT_REQUIRED')
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

test('レビュー待ち（本文に [review]）は承認待ちに混ぜない', () => {
  const { root } = fixture()
  // レビューのシート待ちを b1 に足す（blocked + [review] 行）
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'b1', 'kanban.db'))
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    't_ak1', 'レビュー: 帯の形', 'blocked', 'needs_input', 0, null, null,
    Math.floor(Date.now() / 1000) - 10, null, null, null,
    '[review] label=band-01 round=1 mode=standard sheet=sheets/band-01-1.html',
  )
  db.close()

  const r = createInbox({ kanbanRoot: path.join(root, 'kanban') }, fakeKanban).list()
  assert.equal(r.items.some((x) => x.id === 't_ak1'), false, '一覧に出さない（レビュータブが受け持つ）')
  assert.equal(r.counts.needs_input, 1, '件数にも数えない（承認待ちの数字を混ぜない）')
  assert.equal(r.items.length, 3)
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

test('close(done) は complete を理由つきで呼び、status を読み戻す', async () => {
  const { root } = fixture()
  const calls = []
  const inbox = createInbox(
    {
      kanbanRoot: path.join(root, 'kanban'),
      runner: async (args) => {
        calls.push(args)
        return { code: 0, out: 'Completed t_a1' }
      },
    },
    fakeKanban,
  )
  const r = await inbox.close('b1', 't_a1', 'done', 'もう不要', 'mobile', 'ja')
  assert.equal(r.ok, true)
  assert.equal(r.action, 'done')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][3], 'complete')
  assert.equal(calls[0][4], 't_a1')
  assert.ok(calls[0].includes('もう不要'))
  const meta = JSON.parse(calls[0][calls[0].indexOf('--metadata') + 1])
  assert.equal(meta.closed_from, 'mobile')
})

test('close(cancel) は理由をコメントしてから archive する', async () => {
  const { root } = fixture()
  const calls = []
  const inbox = createInbox(
    {
      kanbanRoot: path.join(root, 'kanban'),
      runner: async (args) => {
        calls.push(args)
        return { code: 0, out: 'ok' }
      },
    },
    fakeKanban,
  )
  const r = await inbox.close('b1', 't_a3', 'cancel', '別Issueで扱う', 'mobile', 'ja')
  assert.equal(r.ok, true)
  assert.equal(r.action, 'cancel')
  assert.equal(calls.length, 2)
  assert.equal(calls[0][3], 'comment')
  assert.match(calls[0][5], /取消（アーカイブ）: 別Issueで扱う/)
  assert.deepEqual(calls[1], ['kanban', '--board', 'b1', 'archive', 't_a3'])
})

test('close は閉じ済みなら CLI を呼ばず noop を返す（連打の吸収）', async () => {
  const { root } = fixture()
  const calls = []
  const inbox = createInbox(
    { kanbanRoot: path.join(root, 'kanban'), runner: async (args) => (calls.push(args), { code: 0, out: 'ok' }) },
    fakeKanban,
  )
  const r = await inbox.close('b1', 't_a2', 'done', '', 'mobile') // t_a2 は done
  assert.equal(r.ok, true)
  assert.equal(r.noop, true)
  assert.equal(calls.length, 0)
})

test('close は不正な入力・存在しないタスク・CLI 失敗を弾く', async () => {
  const { root } = fixture()
  const inbox = createInbox(
    { kanbanRoot: path.join(root, 'kanban'), runner: async () => ({ code: 1, out: 'boom' }) },
    fakeKanban,
  )
  await assert.rejects(() => inbox.close('../etc', 't_a1', 'done'), (e) => e.statusCode === 400)
  await assert.rejects(() => inbox.close('b1', '../../etc', 'done'), (e) => e.statusCode === 400)
  await assert.rejects(() => inbox.close('b1', 't_a1', 'delete'), (e) => e.statusCode === 400)
  await assert.rejects(() => inbox.close('b1', 't_ffff', 'done'), (e) => e.statusCode === 404)
  await assert.rejects(() => inbox.close('b1', 't_a1', 'cancel'), (e) => e.statusCode === 502)
})

test('unblock はメモをコメントしてから unblock CLI を呼ぶ', async () => {
  const { root } = fixture()
  const calls = []
  const inbox = createInbox(
    {
      kanbanRoot: path.join(root, 'kanban'),
      runner: async (args) => {
        calls.push(args)
        return { code: 0, out: 'Unblocked t_a1' }
      },
    },
    fakeKanban,
  )
  const r = await inbox.unblock('b1', 't_a1', 'そのまま進めて', 'mobile')
  assert.equal(r.ok, true)
  assert.equal(r.noop, undefined)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], ['kanban', '--board', 'b1', 'comment', 't_a1', 'そのまま進めて', '--author', 'mobile'])
  assert.deepEqual(calls[1], ['kanban', '--board', 'b1', 'unblock', 't_a1', '--reason', 'そのまま進めて'])
})

test('unblock はメモなしでも unblock CLI を呼ぶ', async () => {
  const { root } = fixture()
  const calls = []
  const inbox = createInbox(
    {
      kanbanRoot: path.join(root, 'kanban'),
      runner: async (args) => {
        calls.push(args)
        return { code: 0, out: 'Unblocked t_a3' }
      },
    },
    fakeKanban,
  )
  const r = await inbox.unblock('b1', 't_a3', '', 'mobile', 'ja')
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['kanban', '--board', 'b1', 'unblock', 't_a3', '--reason', 'PWAから再開'])
})

test('unblock は既に ready なら CLI を呼ばず noop を返す', async () => {
  const { root } = fixture()
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'b1', 'kanban.db'))
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', 't_a1')
  db.close()
  const calls = []
  const inbox = createInbox(
    { kanbanRoot: path.join(root, 'kanban'), runner: async (args) => (calls.push(args), { code: 0, out: 'ok' }) },
    fakeKanban,
  )
  const r = await inbox.unblock('b1', 't_a1', '', 'mobile')
  assert.equal(r.ok, true)
  assert.equal(r.noop, true)
  assert.equal(calls.length, 0)
})

test('unblock は不正な入力・存在しないタスク・done タスク・CLI 失敗を弾く', async () => {
  const { root } = fixture()
  const inbox = createInbox(
    { kanbanRoot: path.join(root, 'kanban'), runner: async () => ({ code: 1, out: 'boom' }) },
    fakeKanban,
  )
  await assert.rejects(() => inbox.unblock('../etc', 't_a1', ''), (e) => e.statusCode === 400)
  await assert.rejects(() => inbox.unblock('b1', '../../etc', ''), (e) => e.statusCode === 400)
  await assert.rejects(() => inbox.unblock('b1', 't_ffff', ''), (e) => e.statusCode === 404)
  await assert.rejects(() => inbox.unblock('b1', 't_a2', ''), (e) => e.statusCode === 409) // t_a2 は done
  await assert.rejects(() => inbox.unblock('b1', 't_a1', ''), (e) => e.statusCode === 502)
})

test('close(cancel) は ready（Queued）タスクでも archive CLI を呼び、inbox.js は resolveHermesBin と buildAugmentedPath を使う', async () => {
  const { root } = fixture()
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'b1', 'kanban.db'))
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', 't_a1')
  db.close()

  const calls = []
  const inbox = createInbox(
    {
      kanbanRoot: path.join(root, 'kanban'),
      runner: async (args) => {
        calls.push(args)
        return { code: 0, out: 'Archived t_a1' }
      },
    },
    fakeKanban,
  )
  const res = await inbox.close('b1', 't_a1', 'cancel', 'no longer needed', 'mobile', 'en')
  assert.equal(res.ok, true)
  assert.deepEqual(calls[0], ['kanban', '--board', 'b1', 'comment', 't_a1', 'Archived from PWA: no longer needed', '--author', 'mobile'])
  assert.deepEqual(calls[1], ['kanban', '--board', 'b1', 'archive', 't_a1'])

  const src = fs.readFileSync(new URL('../src/inbox.js', import.meta.url), 'utf8')
  assert.match(src, /resolveHermesBin\(\)/)
  assert.match(src, /buildAugmentedPath\(\)/)
})

