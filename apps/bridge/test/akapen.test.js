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
  injectAkapenBridge,
  createAkapen,
} from '../src/akapen.js'

test('injectAkapenBridge は設問見出しのマーカー装飾を注入し、保存物は変えない', () => {
  const base = '<html><body><section id="akForm"><div class="q"><h3>Q1. 問い</h3></div></section></body></html>'
  const html = injectAkapenBridge(base, 't_abc12345')

  assert.ok(html.includes('<style id="akBridgeStyle">'), 'マーカー用スタイルが入る')
  assert.match(html, /#akForm \.q h3\{[^}]*linear-gradient/, '設問見出しにマーカー (linear-gradient) が当たる')
  assert.ok(html.includes('var TASK = "t_abc12345";'), '送信ブリッジは従来どおり')
  assert.ok(html.indexOf('akBridgeStyle') < html.indexOf('</body>'), '</body> の直前に注入する')

  assert.equal(base.includes('akBridgeStyle'), false, '元のシート HTML は書き換えない')
  assert.equal(base.includes('akapen:reply'), false)

  // </body> が無い断片でも末尾に注入する
  const frag = injectAkapenBridge('<div id="akForm"></div>', 't_1')
  assert.ok(frag.indexOf('akBridgeStyle') > -1)
  assert.ok(frag.indexOf('var TASK = "t_1";') > -1)
})

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
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, 'plugins', 'git-ops', 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'plugins', 'git-ops', 'config', 'repos.json'),
    JSON.stringify({ repos: [{ id: 'hermes-mobile-pwa', label: 'Mobile', path: repoA }] }),
  )
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
  const r = await api.createFromImage({ source: 'upload', image: png, title: 'gap test', target: repoA })
  assert.equal(r.ok, true)
  assert.equal(r.taskId, 't_abcdef12')
  const createArgs = calls.find((a) => a[0] === 'create')
  assert.ok(createArgs.includes('--assignee'), 'assignee が無いと dispatcher が拾わない')
  assert.ok(createArgs.join(' ').includes(`target=${repoA}`))
  assert.deepEqual(calls.find((a) => a[0] === 'block').slice(0, 3), ['block', 't_abcdef12', '注釈待ち（画像から作成）'])
})

test('targets は Git Ops の登録リポジトリだけを返し、未登録の target は拒否する', async () => {
  const { root } = tempBoard()
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, 'plugins', 'git-ops', 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'plugins', 'git-ops', 'config', 'repos.json'),
    JSON.stringify({ repos: [{ id: 'hermes-mobile-pwa', label: 'Mobile', path: repoA }, { id: 'home', label: 'Home', path: root }] }),
  )
  const calls = []
  const api = createAkapen(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async (a) => { calls.push(a); return a[0] === 'create' ? { code: 0, out: 'Created t_11112222' } : { code: 0, out: 'ok' } } },
  )
  const list = api.targets()
  assert.equal(list.length, 1, 'git の無いパスとホームは除外')
  assert.equal(list[0].id, 'hermes-mobile-pwa')

  const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64')
  const bad = await api.createFromImage({ source: 'upload', image: png, target: '/tmp/not-registered' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'UNKNOWN_TARGET')

  const good = await api.createFromImage({ source: 'upload', image: png })
  assert.equal(good.ok, true)
  const createArgs = calls.find((a) => a[0] === 'create').join(' ')
  assert.ok(createArgs.includes(`target=${repoA}`), '既定の target が本文に入る')
})

test('image=<*.html> は sheet の別名として解釈する（NO_SHEET の再発防止）', () => {
  const a = parseAkapenLine('[akapen] label=s-01 round=1 mode=sheet image=sheets/s-01-1.html')
  assert.equal(a.sheet, 'sheets/s-01-1.html')
  const b = parseAkapenLine('[akapen] label=a-01 round=1 mode=annotation image=shots/a-01-1.png')
  assert.equal(b.sheet, undefined, '画像は sheet にしない')
  assert.equal(b.image, 'shots/a-01-1.png')
})

test('library は取得日時とリポジトリ名を返す（画像にリポジトリ情報は無いのでタスクから推定）', () => {
  const { root, workdir } = tempBoard()
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, 'plugins', 'git-ops', 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'plugins', 'git-ops', 'config', 'repos.json'),
    JSON.stringify({ repos: [{ id: 'demo-repo', label: 'Demo', path: repoA }, { id: 'home', label: 'Home', path: root }] }),
  )
  // 赤ペンのタスク本文: image= は完全一致、label= は撮影名の前方一致に使う
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db'))
  db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(
    `[akapen] label=cockpit-03 round=1 mode=annotation image=shots/cockpit-03-202611122105-1.png target=${repoA}`,
    't_test1',
  )
  db.close()
  for (const d of ['shots', path.join('library', 'chat')]) fs.mkdirSync(path.join(workdir, d), { recursive: true })
  fs.writeFileSync(path.join(workdir, 'shots', 'cockpit-03-202611122105-1.png'), 'x')
  fs.writeFileSync(path.join(workdir, 'shots', 'cockpit-03-202611122110-1.before.png'), 'x')
  fs.writeFileSync(path.join(workdir, 'shots', 'unknown-shot.png'), 'x')
  fs.writeFileSync(path.join(workdir, 'library', 'chat', '20261112-2105-shot.png'), 'x')

  const api = createAkapen({ kanbanRoot: path.join(root, 'kanban') })
  const byName = Object.fromEntries(api.library(20).map((i) => [i.name, i]))

  assert.deepEqual(byName['cockpit-03-202611122105-1.png'].repo, { id: 'demo-repo', label: 'Demo' }, 'image= の完全一致')
  assert.deepEqual(byName['cockpit-03-202611122110-1.before.png'].repo, { id: 'demo-repo', label: 'Demo' }, 'label= の前方一致')
  assert.equal(byName['unknown-shot.png'].repo, null, '手掛かりが無い画像は null（UI は —）')
  assert.equal(byName['20261112-2105-shot.png'].repo, null)
  assert.ok(byName['unknown-shot.png'].mtime > 0, '取得日時（mtime, epoch ms）が入る')
  assert.equal(
    typeof byName['cockpit-03-202611122105-1.png'].mtime,
    'number',
    '取得日時はソートに使う数値のまま返す（整形は PWA）',
  )
})
