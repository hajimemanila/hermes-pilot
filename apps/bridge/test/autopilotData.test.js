import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createReview,
  isSafeVisualMockRel,
  parseReplyText,
  sanitizeVisualMock,
  toReplyText,
} from '../src/review.js'

function tempJsonOnlyBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap1-review-'))
  const boardDir = path.join(root, 'kanban', 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  const workdir = path.join(root, 'work')
  fs.mkdirSync(path.join(workdir, 'sheets'), { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile', default_workdir: workdir }))
  fs.writeFileSync(
    path.join(workdir, 'sheets', 'json-only-1.json'),
    JSON.stringify({
      title: 'Deck 1',
      deck: true,
      questions: [
        {
          id: 'q1',
          text: 'Main layout',
          options: [
            { id: 'A', label: 'Option A', recommended: true },
            { id: 'B', label: 'Option B' },
          ],
        },
      ],
    }),
  )
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER, result TEXT,
    last_heartbeat_at INTEGER)`)
  const insert = db.prepare('INSERT INTO tasks (id,title,body,status,assignee,created_at) VALUES (?,?,?,?,?,?)')
  const now = Math.floor(Date.now() / 1000)
  insert.run(
    't_sheetjson',
    'HTML 無しシート',
    '本文\n[review] label=json-only round=1 mode=sheet sheet=sheets/json-only-1.html\n',
    'blocked',
    'mobile',
    now,
  )
  db.close()
  return { root, workdir }
}

test('AP-1: visualMock の安全パス判定と sheetData の非破壊サニタイズ', () => {
  assert.equal(isSafeVisualMockRel('shots/focus-1-q1.png'), true)
  assert.equal(isSafeVisualMockRel('thumbs/focus-1-q1.jpg'), true)
  assert.equal(isSafeVisualMockRel('sheets/focus-1-q1.html'), true)
  assert.equal(isSafeVisualMockRel('../../etc/passwd'), false)
  assert.equal(isSafeVisualMockRel('secrets/token.png'), false)
  assert.equal(isSafeVisualMockRel('/abs/path.png'), false)

  const sanitized = sanitizeVisualMock({
    shot: 'shots/ok.png',
    html: '../evil.html',
    layoutVariant: 'A',
    template: 'timer-card',
  })
  assert.deepEqual(sanitized, {
    shot: 'shots/ok.png',
    html: null,
    layoutVariant: 'A',
    template: 'timer-card',
  })

  const { root, workdir } = tempJsonOnlyBoard()
  const jsonPath = path.join(workdir, 'sheets', 'json-only-1.json')
  const orig = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  orig.questions[0].visualMock = {
    shot: 'shots/q1.png',
    html: 'secrets/leak.html',
    layoutVariant: 'A',
  }
  fs.writeFileSync(jsonPath, JSON.stringify(orig))

  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const res = api.sheetData('t_sheetjson')
  assert.equal(res.ok, true)
  assert.deepEqual(res.data.questions[0].visualMock, {
    shot: 'shots/q1.png',
    html: null,
    layoutVariant: 'A',
  })
})

test('AP-1: annotations 付き answer の .answer.txt 整形と parseReplyText 互換性', async () => {
  const txt = toReplyText(
    'ap-deck-1',
    [{ id: 'q1', choice: 'A', note: '' }],
    'Overall looks good',
    [{ id: 'q1', text: 'Main layout' }],
    'en',
    [{ questionId: 'q1', shot: 'shots/q1.png', marks: [{ type: 'rect' }], note: 'Make CTA larger' }],
  )
  assert.match(txt, /Annotations:\n- \[q1\] \(shots\/q1\.png\) \[1 marks\] Make CTA larger/)
  const parsed = parseReplyText(txt)
  assert.equal(parsed.global, 'Overall looks good')
  assert.equal(parsed.answers[0].choice, 'A')

  const { root, workdir } = tempJsonOnlyBoard()
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async () => ({ code: 0, stdout: 'ok', stderr: '' }) },
  )
  const r = await api.answer(
    't_sheetjson',
    {
      answers: [{ id: 'q1', choice: 'A', note: '' }],
      global: 'OK',
      annotations: [{ questionId: 'q1', shot: 'shots/q1.png', marks: [{ type: 'arrow' }], note: 'Bottom CTA' }],
    },
    'ja',
  )
  assert.equal(r.ok, true)
  const ansTxt = fs.readFileSync(path.join(workdir, 'sheets', 'json-only-1.answer.txt'), 'utf8')
  assert.match(ansTxt, /赤入れ注釈:\n- \[q1\] \(shots\/q1\.png\) \[1 marks\] Bottom CTA/)
})

test('AP-1: remix は .remix.json を書いて blocked を unblock し、非 blocked は NOT_WAITING', async () => {
  const { root, workdir } = tempJsonOnlyBoard()
  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (args) => {
        calls.push(args)
        return { code: 0, stdout: 'ok', stderr: '' }
      },
    },
  )
  const r = await api.remix(
    't_sheetjson',
    { questionId: 'q1', reason: 'simpler', hint: 'Fewer cards', by: 'mobile' },
    'en',
  )
  assert.equal(r.ok, true)
  assert.equal(r.moved, 'ready')
  assert.equal(r.files.remix, 'sheets/json-only-1.remix.json')
  const saved = JSON.parse(fs.readFileSync(path.join(workdir, 'sheets', 'json-only-1.remix.json'), 'utf8'))
  assert.equal(saved.questionId, 'q1')
  assert.equal(saved.reason, 'simpler')
  assert.equal(saved.hint, 'Fewer cards')
  assert.ok(calls.some((c) => c[0] === 'comment' && c[1] === 't_sheetjson'))
  assert.ok(calls.some((c) => c[0] === 'unblock' && c[1] === 't_sheetjson'))

  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db'))
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't_sheetjson'").run()
  db.close()
  const notWaiting = await api.remix('t_sheetjson', { questionId: 'q1' }, 'en')
  assert.equal(notWaiting.ok, false)
  assert.equal(notWaiting.code, 'NOT_WAITING')
})
