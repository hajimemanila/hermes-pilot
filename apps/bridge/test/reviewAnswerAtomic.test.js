/**
 * `review.answer()` の原子ペア書込失敗伝播（D101）および `answeredAtForReview` の回帰テスト。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { answeredAtForReview, createReview } from '../src/review.js'

function setupReviewFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rev-atomic-'))
  const boardDir = path.join(root, 'kanban', 'boards', 'mobile')
  const workdir = path.join(root, 'work')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.mkdirSync(path.join(workdir, 'sheets'), { recursive: true })
  fs.mkdirSync(path.join(workdir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile', default_workdir: workdir }))
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, status TEXT,
      priority INTEGER, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
      workspace_path TEXT, branch_name TEXT, worker_pid INTEGER, last_heartbeat_at INTEGER,
      result TEXT)
    ;
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, created_at INTEGER);
    CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, author TEXT, body TEXT, created_at INTEGER);
  `)
  db.prepare(
    'INSERT INTO tasks (id, title, body, assignee, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    't_ans1',
    '[review] atomic test',
    '[review] label=atomic-01 round=1 mode=standard sheet=sheets/atomic-01-1.html\n',
    'mobile',
    'blocked',
    1_700_000_000,
  )
  db.close()
  fs.writeFileSync(
    path.join(workdir, 'sheets', 'atomic-01-1.json'),
    JSON.stringify({
      title: 'Atomic check',
      questions: [{ id: 'q1', text: 'Q1', options: [{ id: 'A', label: 'Yes' }] }],
    }),
  )
  return { root, workdir }
}

test('review.answer は正本 answer.json 書き込み失敗 (failedAt===0) で throw し、unblock しない', async () => {
  const { root } = setupReviewFixture()
  const calls = []
  try {
    const api = createReview(
      { kanbanRoot: path.join(root, 'kanban'), pluginDataDir: path.join(root, 'pdata') },
      {
        runKanban: async (args) => {
          calls.push(args)
          return { code: 0, out: 'ok' }
        },
        writePairAtomic: () => ({ written: [], failedAt: 0, error: new Error('ENOSPC: no space') }),
      },
    )
    await assert.rejects(
      () => api.answer('t_ans1', { answers: [{ id: 'q1', choice: 'A', note: '' }] }),
      /ENOSPC/,
    )
    assert.deepEqual(calls, [], '正本書き込み失敗時はコメントも unblock も呼ばない')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('review.answer は派生 answer.txt 失敗 (failedAt===1) では警告のみ出して unblock まで完了する', async () => {
  const { root } = setupReviewFixture()
  const calls = []
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    const api = createReview(
      { kanbanRoot: path.join(root, 'kanban'), pluginDataDir: path.join(root, 'pdata') },
      {
        runKanban: async (args) => {
          calls.push(args)
          return { code: 0, out: 'ok' }
        },
        writePairAtomic: ([primary]) => ({
          written: [primary[0]],
          failedAt: 1,
          error: new Error('EACCES: txt readonly'),
        }),
      },
    )
    const res = await api.answer('t_ans1', { answers: [{ id: 'q1', choice: 'A', note: '' }] })
    assert.equal(res.ok, true)
    assert.equal(calls.length, 2, 'comment と unblock が順に呼ばれる')
    assert.equal(calls[0][0], 'comment')
    assert.equal(calls[1][0], 'unblock')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /\[review\.answer\]/)
  } finally {
    console.warn = origWarn
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('answeredAtForReview は answer.json / annotation.json / approval.json から回答日時を解決する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rev-ansat-'))
  try {
    fs.mkdirSync(path.join(dir, 'sheets'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true })
    const resolveInside = (rel) => path.join(dir, rel)
    const readJson = (abs) => (fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, 'utf8')) : null)

    fs.writeFileSync(
      path.join(dir, 'sheets', 's1-1.answer.json'),
      JSON.stringify({ answered_at: '2026-11-22T10:00:00.000Z' }),
    )
    assert.equal(
      answeredAtForReview({ sheet: 'sheets/s1-1.html' }, resolveInside, readJson, 't_1'),
      '2026-11-22T10:00:00.000Z',
    )

    fs.writeFileSync(
      path.join(dir, 'shots', 'shot1.annotation.json'),
      JSON.stringify({ task_id: 't_ann1', annotated_at: '2026-11-22T11:00:00.000Z' }),
    )
    assert.equal(
      answeredAtForReview({ image: 'shots/shot1.png' }, resolveInside, readJson, 't_ann1'),
      '2026-11-22T11:00:00.000Z',
    )
    // task_id 不一致なら流用しない
    assert.equal(
      answeredAtForReview({ image: 'shots/shot1.png' }, resolveInside, readJson, 't_other'),
      null,
    )

    fs.writeFileSync(
      path.join(dir, 'shots', 'shot2.approval.json'),
      JSON.stringify({ task_id: 't_app1', approved_at: '2026-11-22T12:00:00.000Z' }),
    )
    assert.equal(
      answeredAtForReview({ image: 'shots/shot2.png' }, resolveInside, readJson, 't_app1'),
      '2026-11-22T12:00:00.000Z',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
