import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  parseAkapenLine,
  isSafeRel,
  answerHash,
  toReplyText,
  createAkapen,
} from '../src/akapen.js'

test('parseAkapenLine は機械可読行を取り出す', () => {
  const body = '本文\n[akapen] label=cockpit-03 round=2 mode=standard sheet=sheets/cockpit-03-2.html\nおわり'
  const ak = parseAkapenLine(body)
  assert.equal(ak.label, 'cockpit-03')
  assert.equal(ak.round, '2')
  assert.equal(ak.mode, 'standard')
  assert.equal(ak.sheet, 'sheets/cockpit-03-2.html')
})

test('parseAkapenLine は行が無ければ null', () => {
  assert.equal(parseAkapenLine('ただの本文'), null)
})

test('parseAkapenLine は親ディレクトリ参照を拒否する', () => {
  assert.equal(parseAkapenLine('[akapen] label=x sheet=../../etc/passwd'), null)
  assert.equal(parseAkapenLine('[akapen] label=x sheet=/etc/passwd'), null)
})

test('isSafeRel', () => {
  assert.equal(isSafeRel('sheets/a-1.html'), true)
  assert.equal(isSafeRel('../a.html'), false)
  assert.equal(isSafeRel('/a.html'), false)
  assert.equal(isSafeRel(''), false)
})

test('answerHash はキー順に依存せず、内容が変われば変わる', () => {
  const a = answerHash({ answers: [{ id: 'q1', choice: 'A', note: '' }, { id: 'q2', choice: null }], global: 'ok' })
  const b = answerHash({ answers: [{ id: 'q2', choice: null }, { id: 'q1', choice: 'A', note: '' }], global: 'ok' })
  const c = answerHash({ answers: [{ id: 'q1', choice: 'B' }], global: 'ok' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('toReplyText は【赤ペン回答】契約の形になる', () => {
  const txt = toReplyText(
    'cockpit-03',
    [
      { id: 'q1', choice: 'A', note: '映像を隠さない範囲で' },
      { id: 'q2', choice: null },
    ],
    '全体はこれで',
    [{ id: 'q1', text: '既定位置は？' }, { id: 'q2', text: '表示は？' }],
  )
  assert.match(txt, /^【赤ペン回答】cockpit-03\n/)
  assert.match(txt, /Q1\. 既定位置は？: A \/ 補足: 映像を隠さない範囲で/)
  assert.match(txt, /Q2\. 表示は？: \(未選択 = お任せ\)/)
  assert.match(txt, /全体への赤ペン: 全体はこれで/)
  assert.match(txt, /\n---\n/)
})

/** 一時ボード（kanban.db + board.json + sheets）を作る。 */
function tempBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akapen-'))
  const boardDir = path.join(root, 'kanban', 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  const workdir = path.join(root, 'work')
  fs.mkdirSync(path.join(workdir, 'sheets'), { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile', default_workdir: workdir }))
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER, result TEXT,
    last_heartbeat_at INTEGER)`)
  db.prepare('INSERT INTO tasks (id,title,body,status,assignee,created_at) VALUES (?,?,?,?,?,?)').run(
    't_test1',
    'キーボード配置',
    '本文\n[akapen] label=cockpit-03 round=1 mode=standard sheet=sheets/cockpit-03-1.html\n',
    'blocked',
    'mobile',
    Math.floor(Date.now() / 1000),
  )
  db.close()
  fs.writeFileSync(
    path.join(workdir, 'sheets', 'cockpit-03-1.html'),
    '<html><body>sheet</body></html>',
  )
  fs.writeFileSync(
    path.join(workdir, 'sheets', 'cockpit-03-1.json'),
    JSON.stringify({
      label: 'cockpit-03',
      round: 1,
      mode: 'standard',
      title: 'キーボード配置',
      questions: [{ id: 'q1', text: '既定位置は？', options: [{ id: 'A', recommended: true }, { id: 'B' }] }],
    }),
  )
  return { root, workdir }
}

test('list / sheetHtml / sheetData は workdir 配下を解決する', () => {
  const { root, workdir } = tempBoard()
  const api = createAkapen({ kanbanRoot: path.join(root, 'kanban') })
  const items = api.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].akapen.questions, 1)
  assert.equal(items[0].akapen.exists, true)

  const html = api.sheetHtml('t_test1')
  assert.equal(html.ok, true)
  assert.match(html.html, /sheet/)

  const data = api.sheetData('t_test1')
  assert.equal(data.ok, true)
  assert.equal(data.data.questions[0].id, 'q1')
  assert.equal(path.resolve(api.workdir()), path.resolve(workdir))
})

test('answer は保存して comment + unblock を呼び、二重投稿を弾く', async () => {
  const { root, workdir } = tempBoard()
  const calls = []
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const api = createAkapen(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (args) => {
        calls.push(args)
        if (args[0] === 'unblock') {
          const db = new DatabaseSync(dbPath)
          db.prepare("UPDATE tasks SET status='ready' WHERE id='t_test1'").run()
          db.close()
        }
        return { code: 0, out: 'ok' }
      },
    },
  )
  const payload = { answers: [{ id: 'q1', choice: 'A', note: 'これで' }], global: 'お願いします', by: 'hajime' }

  const first = await api.answer('t_test1', payload)
  assert.equal(first.ok, true)
  assert.equal(first.duplicate, false)
  const answerFile = path.join(workdir, 'sheets', 'cockpit-03-1.answer.json')
  const saved = JSON.parse(fs.readFileSync(answerFile, 'utf8'))
  assert.equal(saved.answers[0].choice, 'A')
  assert.equal(saved.task_id, 't_test1')
  const txt = fs.readFileSync(path.join(workdir, 'sheets', 'cockpit-03-1.answer.txt'), 'utf8')
  assert.match(txt, /【赤ペン回答】cockpit-03/)

  assert.deepEqual(calls[0].slice(0, 1), ['comment'])
  assert.deepEqual(calls[1].slice(0, 1), ['unblock'])
  assert.equal(first.moved, 'ready')

  const second = await api.answer('t_test1', payload)
  assert.equal(second.duplicate, true)
  assert.equal(calls.length, 2, '二重投稿では CLI を呼ばない')
})

test('answer はシートの無いタスクを拒否する', async () => {
  const { root } = tempBoard()
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db'))
  db.prepare('INSERT INTO tasks (id,title,body,status,created_at) VALUES (?,?,?,?,?)').run(
    't_plain', 'シート無し', 'ふつうの本文', 'review', Math.floor(Date.now() / 1000),
  )
  db.close()
  const api = createAkapen({ kanbanRoot: path.join(root, 'kanban') }, { runKanban: async () => ({ code: 0, out: '' }) })
  const r = await api.answer('t_plain', { answers: [] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_SHEET')
})

test('answer は赤ペン待ち（blocked）以外を拒否し、answer.json を上書きしない', async () => {
  const { root, workdir } = tempBoard()
  const calls = []
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const setStatus = (status) => {
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, 't_test1')
    db.close()
  }
  const api = createAkapen(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (args) => {
        calls.push(args)
        if (args[0] === 'unblock') setStatus('ready')
        return { code: 0, out: 'ok' }
      },
    },
  )

  const first = await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'A' }], by: 'hajime' })
  assert.equal(first.ok, true)
  assert.equal(first.moved, 'ready')
  const callsAfterFirst = calls.length

  // 反映待ち（ready）へ別の回答 → 拒否。comment も unblock も呼ばない
  const second = await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'B' }], by: 'hajime' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'NOT_WAITING')
  assert.equal(second.status, 'ready')
  assert.equal(calls.length, callsAfterFirst)

  const saved = JSON.parse(fs.readFileSync(path.join(workdir, 'sheets', 'cockpit-03-1.answer.json'), 'utf8'))
  assert.equal(saved.answers[0].choice, 'A', 'answer.json は上書きされない')

  // 完了（done）も同じ扱い
  setStatus('done')
  const third = await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'C' }], by: 'hajime' })
  assert.equal(third.ok, false)
  assert.equal(third.code, 'NOT_WAITING')
  assert.equal(third.status, 'done')
  assert.equal(calls.length, callsAfterFirst)
})

test('parseReplyText はシートが送る【赤ペン回答】を構造化する', async () => {
  const { parseReplyText } = await import('../src/akapen.js')
  const text = [
    '【赤ペン回答】cockpit-03',
    'Q1. 既定位置は？: A / 補足: 映像を隠さない',
    'Q2. 表示は？: (未選択 = お任せ)',
    '全体への赤ペン: 全体OK',
    '---',
    '上の回答を反映して作業を続けてください。',
  ].join('\n')
  const r = parseReplyText(text)
  assert.equal(r.answers.length, 2)
  assert.equal(r.answers[0].choice, 'A')
  assert.equal(r.answers[0].note, '映像を隠さない')
  assert.equal(r.answers[1].choice, null)
  assert.equal(r.global, '全体OK')
})

test('answer は text だけでも受け付ける（シート直送）', async () => {
  const { root } = tempBoard()
  const calls = []
  const api = createAkapen(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async (a) => { calls.push(a); return { code: 0, out: 'ok' } } },
  )
  const r = await api.answer('t_test1', { text: '【赤ペン回答】x\nQ1. 問: B / 補足: n\n全体への赤ペン: g\n---\n' })
  assert.equal(r.ok, true)
  assert.equal(r.moved, 'ready')
  assert.deepEqual(calls[0].slice(0, 1), ['comment'])
})

test('parseAkapenLine は annotation の image を返す', () => {
  const ak = parseAkapenLine('[akapen] label=demo round=1 mode=annotation image=shots/demo-1.png')
  assert.equal(ak.mode, 'annotation')
  assert.equal(ak.image, 'shots/demo-1.png')
})

test('saveAnnotation は画像を保存して unblock を呼ぶ（冪等）', async () => {
  const { root, workdir } = tempBoard()
  // 下地画像と annotation 用のタスク本文に差し替える
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.prepare("UPDATE tasks SET body=? WHERE id='t_test1'").run(
    '[akapen] label=demo round=1 mode=annotation image=shots/demo.png',
  )
  db.close()
  fs.mkdirSync(path.join(workdir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(workdir, 'shots', 'demo.png'), 'PNGDATA')
  const calls = []
  const api = createAkapen(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async (a) => { calls.push(a); return { code: 0, out: 'ok' } } },
  )
  const png = 'data:image/png;base64,' + Buffer.from('annotated-bytes').toString('base64')
  const r = await api.saveAnnotation('t_test1', { annotated_image: png, note: 'ここを詰める', marks: [{ tool: 'pen', points: [[0.1, 0.2], [0.3, 0.4]] }] })
  assert.equal(r.ok, true)
  assert.equal(r.marks, 1)
  assert.equal(r.moved, 'ready')
  assert.deepEqual(calls[1].slice(0, 1), ['unblock'])
  const saved = JSON.parse(fs.readFileSync(path.join(workdir, 'shots/demo.annotation.json'), 'utf8'))
  assert.equal(saved.marks[0].tool, 'pen')
  assert.equal(saved.note, 'ここを詰める')
  const again = await api.saveAnnotation('t_test1', { annotated_image: png })
  assert.equal(again.duplicate, true)
})

test('createFromImage は assignee と target を付けて起票し、blocked にする', async () => {
  const { root } = tempBoard()
  const calls = []
  const api = createAkapen(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (a) => {
        calls.push(a)
        if (a[0] === 'create') return { code: 0, out: 'Created t_abcdef12  (ready, assignee=mobile)' }
        return { code: 0, out: 'ok' }
      },
    },
  )
  const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64')
  const r = await api.createFromImage({ source: 'upload', image: png, title: 'gap test', target: '/tmp/repo' })
  assert.equal(r.ok, true)
  assert.equal(r.taskId, 't_abcdef12')
  const createArgs = calls.find((a) => a[0] === 'create')
  assert.ok(createArgs.includes('--assignee'), 'assignee が無いと dispatcher が拾わない')
  assert.ok(createArgs.join(' ').includes('target=/tmp/repo'))
  assert.deepEqual(calls.find((a) => a[0] === 'block').slice(0, 3), ['block', 't_abcdef12', '注釈待ち（画像から作成）'])
})
