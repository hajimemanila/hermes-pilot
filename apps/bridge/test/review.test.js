import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWorkerFeed, feedCandidates, pickFeed } from '../src/workerFeed.js'
import {
  parseReviewLine,
  parseReplyText,
  isSafeRel,
  answerHash,
  toReplyText,
  injectReviewBridge,
  compareCandidates,
  reviewSheetHeaders,
  reviewViewHeaders,
  reviewViewHtml,
  renderSheetHtmlFromData,
  createReview,
} from '../src/review.js'
import { readServerSource } from './helpers/moduleSource.js'

test('injectReviewBridge は設問見出しのマーカー装飾を注入し、保存物は変えない', () => {
  const base = '<html><body><section id="akForm"><div class="q"><h3>Q1. 問い</h3></div></section></body></html>'
  const html = injectReviewBridge(base, 't_abc12345')

  assert.ok(html.includes('<style id="akBridgeStyle">'), 'マーカー用スタイルが入る')
  assert.match(html, /#akForm \.q h3\{[^}]*linear-gradient/, '設問見出しにマーカー (linear-gradient) が当たる')
  assert.ok(html.includes('var TASK = "t_abc12345";'), '送信ブリッジは従来どおり')
  assert.ok(html.indexOf('akBridgeStyle') < html.indexOf('</body>'), '</body> の直前に注入する')
  assert.equal(base.includes('akBridgeStyle'), false, '元のシート HTML は書き換えない')
  assert.equal(base.includes('review:reply'), false)

  // </body> が無い断片でも末尾に注入する
  const frag = injectReviewBridge('<div id="akForm"></div>', 't_1')
  assert.ok(frag.indexOf('akBridgeStyle') > -1)
  assert.ok(frag.indexOf('var TASK = "t_1";') > -1)
})

test('parseReviewLine は機械可読行を取り出す', () => {
  const body = '本文\n[review] label=cockpit-03 round=2 mode=standard sheet=sheets/cockpit-03-2.html\nおわり'
  const ak = parseReviewLine(body)
  assert.equal(ak.label, 'cockpit-03')
  assert.equal(ak.round, '2')
  assert.equal(ak.mode, 'standard')
  assert.equal(ak.sheet, 'sheets/cockpit-03-2.html')
})

test('parseReviewLine は行が無ければ null', () => {
  assert.equal(parseReviewLine('ただの本文'), null)
})

test('parseReviewLine は親ディレクトリ参照を拒否する', () => {
  assert.equal(parseReviewLine('[review] label=x sheet=../../etc/passwd'), null)
  assert.equal(parseReviewLine('[review] label=x sheet=/etc/passwd'), null)
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

test('toReplyText は【レビュー回答】契約の形になる', () => {
  const txt = toReplyText(
    'cockpit-03',
    [
      { id: 'q1', choice: 'A', note: '映像を隠さない範囲で' },
      { id: 'q2', choice: null },
    ],
    '全体はこれで',
    [{ id: 'q1', text: '既定位置は？' }, { id: 'q2', text: '表示は？' }],
    'ja',
  )
  assert.match(txt, /^【レビュー回答】cockpit-03\n/)
  assert.match(txt, /Q1\. 既定位置は？: A \/ 補足: 映像を隠さない範囲で/)
  assert.match(txt, /Q2\. 表示は？: \(未選択 = お任せ\)/)
  assert.match(txt, /全体へのレビュー: 全体はこれで/)
  assert.match(txt, /\n---\n/)
})

/** 一時ボード（kanban.db + board.json + sheets）を作る。 */
function tempBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'))
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
    '本文\n[review] label=cockpit-03 round=1 mode=standard sheet=sheets/cockpit-03-1.html\n',
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

/**
 * `.json` だけを持つレビューの一時ボード（`.html` 不在）。
 *
 * 2 件入れる: `mode=sheet` × `sheet=...html`（`.json` だけ置く＝実機のデグレ形）と、
 * `mode=standard` × `sheet=...json`（JSON ファーストの新形）。
 */
function tempJsonOnlyBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-json-'))
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
  insert.run(
    't_stdjson',
    'JSON シート',
    '本文\n[review] label=json-native round=1 mode=standard sheet=sheets/json-native-1.json\n',
    'blocked',
    'mobile',
    now,
  )
  db.close()
  const payload = {
    title: '危険な <script>alert(1)</script> タイトル',
    topic: 'A & B の比較 "quoted" it\'s',
    questions: [
      {
        id: 'q1',
        text: 'どれにする？ <b>強調</b>',
        options: [
          { id: 'A', label: 'A & B <b>太字</b>', detail: '推奨案です', recommended: true },
          { id: 'B', label: 'it\'s "quoted"' },
        ],
      },
      { id: 'q2', text: '2 問目', options: [{ id: 'A', label: '非推奨です' }] },
    ],
  }
  for (const name of ['json-only-1.json', 'json-native-1.json']) {
    fs.writeFileSync(path.join(workdir, 'sheets', name), JSON.stringify(payload))
  }
  return { root, workdir }
}

test('list / sheetHtml / sheetData は workdir 配下を解決する', () => {
  const { root, workdir } = tempBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const items = api.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].review.questions, 1)
  assert.equal(items[0].review.exists, true)

  const html = api.sheetHtml('t_test1')
  assert.equal(html.ok, true)
  assert.match(html.html, /sheet/)

  const data = api.sheetData('t_test1')
  assert.equal(data.ok, true)
  assert.equal(data.data.questions[0].id, 'q1')
  assert.equal(path.resolve(api.workdir()), path.resolve(workdir))
})

test('list は .json だけでも exists: true、sheetHtml は .json からエスケープ済み HTML を生成する', () => {
  const { root } = tempJsonOnlyBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const items = api.list()
  assert.equal(items.length, 2)
  for (const it of items) {
    assert.equal(it.review.exists, true, '.html が無くても .json があれば存在として扱う')
    assert.equal(it.review.questions, 2, '設問数は .json から読む')
    assert.equal(it.review.title, '危険な <script>alert(1)</script> タイトル', 'title はデータのまま返す（HTML 化は表示側）')
  }

  // ① mode=sheet で .html 不在（実機で起票されていた形）
  const sheetMode = api.sheetHtml('t_sheetjson')
  assert.equal(sheetMode.ok, true)
  assert.equal(sheetMode.generated, true, '.html 不在なので動的生成')
  assert.match(sheetMode.html, /^<!DOCTYPE html>/)
  assert.match(sheetMode.html, /<meta charset="utf-8">/, '単体タブで開くので UTF-8 を明示')

  // ② mode=standard で sheet が .json を指す（生 JSON を返さない）
  const standard = api.sheetHtml('t_stdjson')
  assert.equal(standard.ok, true)
  assert.equal(standard.generated, true)
  assert.doesNotMatch(standard.html, /^\s*\{/, '生の JSON をそのまま返さない')

  for (const r of [sheetMode, standard]) {
    // XSS 対策: JSON 由来の文字列はタグとして解釈されない
    assert.ok(!r.html.includes('<script>alert(1)</script>'), 'title のタグを生で出さない')
    assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'title は実体参照にする')
    assert.ok(r.html.includes('A &amp; B &lt;b&gt;太字&lt;/b&gt;'), '選択肢ラベルのタグと & をエスケープ')
    assert.ok(r.html.includes('&quot;quoted&quot;'), 'ダブルクォートをエスケープ')
    assert.ok(r.html.includes('it&#39;s'), 'シングルクォートをエスケープ')
    assert.ok(r.html.includes('A &amp; B の比較'), 'topic もエスケープする')
    // 推奨バッジは推奨の 1 件だけ（「非推奨」は推奨にしない）。既定 lang は en（SPEC-i18n-gen §3.1）
    assert.equal((r.html.match(/<span class="rec-badge">Recommended<\/span>/g) || []).length, 1)
    // 回答はアプリのドロワー（StandardForm）で行うので、生成 HTML に送信欄は置かない
    assert.ok(!r.html.includes('id="out"'))
  }
})

test('answer は保存して comment + unblock を呼び、二重投稿を弾く', async () => {
  const { root, workdir } = tempBoard()
  const calls = []
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const api = createReview(
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
  const payload = { answers: [{ id: 'q1', choice: 'A', note: 'これで' }], global: 'お願いします', by: 'alice' }

  const first = await api.answer('t_test1', payload, 'ja')
  assert.equal(first.ok, true)
  assert.equal(first.duplicate, false)
  const answerFile = path.join(workdir, 'sheets', 'cockpit-03-1.answer.json')
  const saved = JSON.parse(fs.readFileSync(answerFile, 'utf8'))
  assert.equal(saved.answers[0].choice, 'A')
  assert.equal(saved.task_id, 't_test1')
  const txt = fs.readFileSync(path.join(workdir, 'sheets', 'cockpit-03-1.answer.txt'), 'utf8')
  assert.match(txt, /【レビュー回答】cockpit-03/)

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
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') }, { runKanban: async () => ({ code: 0, out: '' }) })
  const r = await api.answer('t_plain', { answers: [] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_SHEET')
})

test('answer はレビュー待ち（blocked）以外を拒否し、answer.json を上書きしない', async () => {
  const { root, workdir } = tempBoard()
  const calls = []
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const setStatus = (status) => {
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, 't_test1')
    db.close()
  }
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (args) => {
        calls.push(args)
        if (args[0] === 'unblock') setStatus('ready')
        return { code: 0, out: 'ok' }
      },
    },
  )

  const first = await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'A' }], by: 'alice' })
  assert.equal(first.ok, true)
  assert.equal(first.moved, 'ready')
  const callsAfterFirst = calls.length

  // 反映待ち（ready）へ別の回答 → 拒否。comment も unblock も呼ばない
  const second = await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'B' }], by: 'alice' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'NOT_WAITING')
  assert.equal(second.status, 'ready')
  assert.equal(calls.length, callsAfterFirst)

  const saved = JSON.parse(fs.readFileSync(path.join(workdir, 'sheets', 'cockpit-03-1.answer.json'), 'utf8'))
  assert.equal(saved.answers[0].choice, 'A', 'answer.json は上書きされない')

  // 完了（done）も同じ扱い
  setStatus('done')
  const third = await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'C' }], by: 'alice' })
  assert.equal(third.ok, false)
  assert.equal(third.code, 'NOT_WAITING')
  assert.equal(third.status, 'done')
  assert.equal(calls.length, callsAfterFirst)
})

test('parseReplyText はシートが送る【レビュー回答】を構造化する', async () => {
  const { parseReplyText } = await import('../src/review.js')
  const text = [
    '【レビュー回答】cockpit-03',
    'Q1. 既定位置は？: A / 補足: 映像を隠さない',
    'Q2. 表示は？: (未選択 = お任せ)',
    '全体へのレビュー: 全体OK',
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
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async (a) => { calls.push(a); return { code: 0, out: 'ok' } } },
  )
  const r = await api.answer('t_test1', { text: '【レビュー回答】x\nQ1. 問: B / 補足: n\n全体へのレビュー: g\n---\n' })
  assert.equal(r.ok, true)
  assert.equal(r.moved, 'ready')
  assert.deepEqual(calls[0].slice(0, 1), ['comment'])
})

test('parseReviewLine は annotation の image を返す', () => {
  const ak = parseReviewLine('[review] label=demo round=1 mode=annotation image=shots/demo-1.png')
  assert.equal(ak.mode, 'annotation')
  assert.equal(ak.image, 'shots/demo-1.png')
})

test('saveAnnotation は画像を保存して unblock を呼ぶ（冪等）', async () => {
  const { root, workdir } = tempBoard()
  // 下地画像と annotation 用のタスク本文に差し替える
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.prepare("UPDATE tasks SET body=? WHERE id='t_test1'").run(
    '[review] label=demo round=1 mode=annotation image=shots/demo.png',
  )
  db.close()
  fs.mkdirSync(path.join(workdir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(workdir, 'shots', 'demo.png'), 'PNGDATA')
  const calls = []
  const api = createReview(
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
  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      targets: () => [{ id: 'hermes-mobile-pwa', label: 'Mobile', path: repoA }],
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
  assert.deepEqual(calls.find((a) => a[0] === 'block').slice(0, 3), ['block', 't_abcdef12', 'Awaiting annotation (from image)'])
})

test('targets は渡された登録リポジトリだけを返し、未登録の target は拒否する', async () => {
  const { root } = tempBoard()
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      // 一覧の出所は repos.js（ここでは差し替え）。review 側は絞り込みをしない
      targets: () => [{ id: 'hermes-mobile-pwa', label: 'Mobile', path: repoA }],
      runKanban: async (a) => { calls.push(a); return a[0] === 'create' ? { code: 0, out: 'Created t_11112222' } : { code: 0, out: 'ok' } },
    },
  )
  const list = api.targets()
  assert.equal(list.length, 1)
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
  const a = parseReviewLine('[review] label=s-01 round=1 mode=sheet image=sheets/s-01-1.html')
  assert.equal(a.sheet, 'sheets/s-01-1.html')
  const b = parseReviewLine('[review] label=a-01 round=1 mode=annotation image=shots/a-01-1.png')
  assert.equal(b.sheet, undefined, '画像は sheet にしない')
  assert.equal(b.image, 'shots/a-01-1.png')
})

test('library は取得日時とリポジトリ名を返す（画像にリポジトリ情報は無いのでタスクから推定）', () => {
  const { root, workdir } = tempBoard()
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  // レビューのタスク本文: image= は完全一致、label= は撮影名の前方一致に使う
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db'))
  db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(
    `[review] label=cockpit-03 round=1 mode=annotation image=shots/cockpit-03-202611122105-1.png target=${repoA}`,
    't_test1',
  )
  db.close()
  for (const d of ['shots', path.join('library', 'chat')]) fs.mkdirSync(path.join(workdir, d), { recursive: true })
  fs.writeFileSync(path.join(workdir, 'shots', 'cockpit-03-202611122105-1.png'), 'x')
  fs.writeFileSync(path.join(workdir, 'shots', 'cockpit-03-202611122110-1.before.png'), 'x')
  fs.writeFileSync(path.join(workdir, 'shots', 'unknown-shot.png'), 'x')
  fs.writeFileSync(path.join(workdir, 'library', 'chat', '20261112-2105-shot.png'), 'x')

  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    { targets: () => [{ id: 'demo-repo', label: 'Demo', path: repoA }] },
  )
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

test('feed は監視 cron の 1 行ログを末尾から読み、since で絞る', () => {
  const { root } = tempBoard()
  // kanbanRoot = <root>/kanban なので home = <root>
  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { at: '2026-11-12T22:26:38+08:00', text: '✅ 完了 22:26 タスクA' },
    { at: '2026-11-12T22:27:09+08:00', text: '✅ verify: npm run verify → exit 0' },
  ]
  fs.writeFileSync(path.join(dir, 'feed.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const all = api.feed(10)
  assert.equal(all.length, 2)
  assert.match(all[0].text, /完了/)
  assert.ok(all[0].at > 1_700_000_000_000, 'ISO 文字列は epoch ms に直す')

  const newer = api.feed(10, Date.parse('2026-11-12T22:27:00+08:00'))
  assert.equal(newer.length, 1, 'since より新しい行だけ')
  assert.match(newer[0].text, /verify/)

  assert.equal(api.feed(1).length, 1, 'limit は末尾 N 行')
})

test('feed はファイルが無い/壊れていても空で返る（補助情報で画面を壊さない）', () => {
  const { root } = tempBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  assert.deepEqual(api.feed(5), [])

  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feed.jsonl'), 'not json\n{"at":"bad"}\n{"at":"2026-11-12T22:00:00+08:00","text":"ok"}\n')
  const r = api.feed(5)
  assert.equal(r.length, 1, '壊れた行は捨てる')
  assert.equal(r[0].text, 'ok')
})

test('chatReport は会話ごとの完了報告だけを返す（起票したチャットへ流す 1 行）', () => {
  const { root } = tempBoard()
  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { at: '2026-11-13T02:10:00+08:00', session_id: 'chat-a', task_id: 't_1', label: 'x-01', text: '完了 A' },
    { at: '2026-11-13T02:12:00+08:00', session_id: 'chat-b', task_id: 't_2', label: 'y-01', text: '完了 B' },
    { at: '2026-11-13T02:14:00+08:00', session_id: 'chat-a', task_id: 't_3', label: 'x-02', text: '完了 C' },
  ]
  fs.writeFileSync(path.join(dir, 'chat-reports.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const mine = api.chatReport('chat-a', { limit: 5 })
  assert.equal(mine.length, 2, '別の会話の報告は混ぜない')
  assert.deepEqual(mine.map((m) => m.taskId), ['t_1', 't_3'], '古い順')
  assert.equal(mine[1].label, 'x-02')
  assert.ok(mine[0].at > 1_700_000_000_000, 'ISO 文字列は epoch ms に直す')

  assert.equal(api.chatReport('chat-a', { limit: 1 }).length, 1, 'limit は末尾 N 件')
  assert.equal(api.chatReport('chat-a', { since: Date.parse('2026-11-13T02:13:00+08:00') }).length, 1, 'since で絞る')
  assert.deepEqual(api.chatReport(''), [], 'session_id が無ければ空')
  assert.deepEqual(api.chatReport('chat-z'), [], '知らない会話は空')
})

test('chatReport はファイルが無い/壊れていても空で返る', () => {
  const { root } = tempBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  assert.deepEqual(api.chatReport('chat-a'), [])

  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'chat-reports.jsonl'),
    'not json\n{"at":"bad","session_id":"chat-a"}\n{"at":"2026-11-13T02:00:00+08:00","session_id":"chat-a","task_id":"t_9","text":"ok"}\n',
  )
  const r = api.chatReport('chat-a')
  assert.equal(r.length, 1, '壊れた行は捨てる')
  assert.equal(r[0].text, 'ok')
})

test('chatReports は全会話ぶんを返す（未読の点は 1 回の取得で出す）', () => {
  const { root } = tempBoard()
  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  const rows = [
    { at: '2026-11-13T02:10:00+08:00', session_id: 'chat-a', task_id: 't_1', label: 'x-01', text: '完了 A' },
    { at: '2026-11-13T02:12:00+08:00', session_id: 'chat-b', task_id: 't_2', label: 'y-01', text: '完了 B' },
    { at: '2026-11-13T02:14:00+08:00', session_id: 'chat-a', task_id: 't_3', label: 'x-02', text: '完了 C' },
    { at: '2026-11-13T02:15:00+08:00', task_id: 't_4', text: '宛先なし' },
    'not json',
  ]
  fs.writeFileSync(
    path.join(dir, 'chat-reports.jsonl'),
    rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n',
  )
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })

  const all = api.chatReports()
  assert.equal(all.length, 3, '会話が分かる行だけ（宛先なし・壊れた行は捨てる）')
  assert.deepEqual(all.map((r) => r.sessionId), ['chat-a', 'chat-b', 'chat-a'], '古い順・別会話も混ぜて返す')
  assert.equal(all[0].taskId, 't_1')

  assert.equal(api.chatReports({ limit: 2 }).length, 2, 'limit は末尾 N 件')
  assert.equal(api.chatReports({ limit: 2 })[1].taskId, 't_3')
  assert.equal(api.chatReports({ since: Date.parse('2026-11-13T02:13:00+08:00') }).length, 1, 'since で絞る')
  assert.deepEqual(api.chatReports({ limit: 0 }), all, 'limit 0 は既定（末尾 200 件）')
})

test('chatReports はファイルが無ければ空（補助情報なので落とさない）', () => {
  const { root } = tempBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  assert.deepEqual(api.chatReports(), [])
})

test('createFromImage は chat= を本文に付ける（注釈タスクの完了も会話に戻す）', async () => {
  const { root } = tempBoard()
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      targets: () => [{ id: 'hermes-mobile-pwa', label: 'Mobile', path: repoA }],
      runKanban: async (a) => {
        calls.push(a)
        if (a[0] === 'create') return { code: 0, out: 'Created t_abcdef12  (ready, assignee=mobile)' }
        return { code: 0, out: 'ok' }
      },
    },
  )
  const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64')

  const r = await api.createFromImage({ source: 'upload', image: png, target: repoA, chat: '20260101_120000_cafebabe' })
  assert.equal(r.ok, true)
  const line = calls.find((a) => a[0] === 'create').join(' ')
  assert.ok(line.includes('chat=20260101_120000_cafebabe'), '端末が渡した会話 ID が本文に入る')

  // 記号は落とす（本文の機械可読行が壊れないように）
  calls.length = 0
  await api.createFromImage({ source: 'upload', image: png, target: repoA, chat: ' ab c/../d ' })
  assert.ok(calls.find((a) => a[0] === 'create').join(' ').includes('chat=abcd'))

  // 宛先が無ければ付けない（従来どおり）
  calls.length = 0
  await api.createFromImage({ source: 'upload', image: png, target: repoA })
  assert.equal(calls.find((a) => a[0] === 'create').join(' ').includes('chat='), false)
})

test('answer は chat を task-chats.json に覚え、session_id 欠落の完了報告を補完する（list も chat/target を返す）', async () => {
  const { root } = tempBoard()
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  // target を持つタスクを 1 件追加（body に chat= が無くても answer 時に紐づける）
  const db = new DatabaseSync(dbPath)
  db.prepare(
    "INSERT INTO tasks (id, title, body, status, created_at) VALUES ('t_extra', '追加', '[review] label=extra-01 round=1 mode=standard sheet=sheets/x-01-1.html target=/tmp/repo-x', 'blocked', 1700000001)",
  ).run()
  db.close()

  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async () => ({ code: 0, out: 'ok' }) },
  )
  const r = await api.answer('t_test1', {
    answers: [{ id: 'q1', choice: 'A', note: '' }],
    global: '',
    by: 'mobile',
    chat: 'chat_recovered_1',
  })
  assert.equal(r.ok, true)

  // list が chat と target を返す
  const items = api.list()
  const t1 = items.find((x) => x.id === 't_test1')
  const t2 = items.find((x) => x.id === 't_extra')
  assert.equal(t1?.review?.chat, 'chat_recovered_1')
  assert.equal(t2?.review?.target, '/tmp/repo-x')

  // chat-reports.jsonl に session_id が無くても task-chats.json から補完して返す
  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'chat-reports.jsonl'),
    JSON.stringify({ at: '2026-11-13T05:00:00+08:00', task_id: 't_test1', label: 'x-01', text: '補完テスト' }) + '\n',
  )
  const all = api.chatReports()
  assert.equal(all.length, 1)
  assert.equal(all[0].sessionId, 'chat_recovered_1')
  assert.equal(api.chatReport('chat_recovered_1').length, 1)
})

test('image(id, { annotated: true }) は注釈済み画像があればそちらを返す', async () => {
  const { root, workdir } = tempBoard()
  const shotAbs = path.join(workdir, 'shots', 'demo-1.png')
  fs.mkdirSync(path.dirname(shotAbs), { recursive: true })
  fs.writeFileSync(shotAbs, Buffer.from('BASE'))

  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.prepare(
    "INSERT INTO tasks (id, title, body, status, created_at) VALUES ('t_img1', '画像注釈', '[review] label=demo round=1 mode=annotation image=shots/demo-1.png', 'blocked', 1700000002)",
  ).run()
  db.close()

  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async () => ({ code: 0, out: 'ok' }) },
  )
  // 注釈前は下地画像にフォールバック
  assert.equal(api.image('t_img1', { annotated: true }).data.toString(), 'BASE')

  const annotatedDataUrl = 'data:image/png;base64,' + Buffer.from('ANNOTATED').toString('base64')
  const saved = await api.saveAnnotation('t_img1', {
    annotated_image: annotatedDataUrl,
    note: 'ここを修正',
    marks: [{ tool: 'pen', points: [[0.1, 0.1], [0.2, 0.2]] }],
    chat: 'chat_anno_1',
  })
  assert.equal(saved.ok, true)
  assert.equal(api.image('t_img1').data.toString(), 'BASE')
  assert.equal(api.image('t_img1', { annotated: true }).data.toString(), 'ANNOTATED')
})

test('parseReviewLine は旧 [akapen] タグも読む（移行前のボードでもレビューが消えない）', () => {
  const a = parseReviewLine('本文\n[akapen] label=old-01 round=2 mode=sheet sheet=sheets/old-01-2.html')
  assert.equal(a.label, 'old-01')
  assert.equal(a.sheet, 'sheets/old-01-2.html')
  assert.equal(parseReviewLine('[review] label=new-01').label, 'new-01')
})

test('parseReplyText は英語見出しも旧【赤ペン回答】も受理する（SPEC §4.1）', () => {
  const en = parseReplyText('[Review Answer] strip-01\nQ1. Which?: A\nOverall Note: keep color\n---\n')
  assert.equal(en.answers[0].choice, 'A')
  assert.equal(en.global, 'keep color')

  const legacy = parseReplyText(
    ['【赤ペン回答】strip-01', 'Q1. どれ: B / 補足: 小さく', '全体への赤ペン: 現行のまま', '---'].join('\n'),
  )
  assert.equal(legacy.answers[0].choice, 'B')
  assert.equal(legacy.answers[0].note, '小さく')
  assert.equal(legacy.global, '現行のまま')
})

test('toReplyText は en 指定で英語見出しになり、parseReplyText と往復できる', () => {
  const txt = toReplyText('strip-01', [{ id: 'q1', choice: 'A' }], 'ok', [{ id: 'q1', text: 'Which?' }], 'en')
  assert.match(txt, /^\[Review Answer\] strip-01\n/)
  assert.match(txt, /Overall Note: ok/)
  const back = parseReplyText(txt)
  assert.equal(back.answers[0].choice, 'A')
  assert.equal(back.global, 'ok')

  const ja = toReplyText('strip-01', [{ id: 'q1', choice: 'A' }], 'ok', [], 'ja')
  assert.match(ja, /^【レビュー回答】strip-01\n/)
  assert.match(ja, /全体へのレビュー: ok/)
})

test('injectReviewBridge は window.__reviewSubmit だけを定義する（旧エイリアスは持たない）', () => {
  const html = injectReviewBridge('<html><body><div id="akForm"></div></body></html>', 't_1')
  assert.ok(html.includes('window.__reviewSubmit = submit;'))
  assert.equal(html.includes('__akapenSubmit'), false, '移行前のエイリアスは残さない')
  assert.ok(html.includes("type: 'review:reply'"))
  // 旧シートが吐く【赤ペン回答】でも送信できる（判定は両対応。CJK は \u エスケープで埋める）
  assert.ok(html.includes('u3010'), '旧マーカーの正規表現が入っている')
  assert.ok(html.includes('u30ec') && html.includes('u8d64'), 'レビュー / 赤ペンの両方を受ける')
})

// --- D57: レビューシートの常時サンドボックス化 & ラッパー経由 postMessage ---------

const SERVER_SRC = readServerSource()

test('シートの CSP は sec-fetch-dest で分岐せず、常に sandbox を含む', () => {
  const headers = reviewSheetHeaders()
  const csp = headers['content-security-policy']
  // SPEC-CATALOG-ADMISSION C3 の文字列そのもの
  assert.equal(
    csp,
    "sandbox allow-scripts allow-forms; default-src 'none'; style-src 'unsafe-inline'; " +
      "img-src data: blob:; script-src 'unsafe-inline'; font-src data:",
  )
  assert.match(csp, /^sandbox allow-scripts allow-forms;/)
  assert.equal(csp.includes('connect-src'), false, 'same-origin への書き込みを許さない')
  assert.equal(headers['content-type'], 'text/html; charset=utf-8')
  // リクエストヘッダに依存しない（同じ値を何度でも返す）
  assert.deepEqual(reviewSheetHeaders(), headers)
  // ルート側にも分岐が残っていない（単体タブで開いても同じ CSP）
  assert.equal(SERVER_SRC.includes('sec-fetch-dest'), false, 'server.js に sec-fetch-dest の分岐が残っている')
  assert.match(
    SERVER_SRC,
    /if \(c === 'sheet' && req\.method === 'GET'\)[\s\S]{0,400}reviewSheetHeaders\(\)/,
    'sheet ルートは共通ヘッダを使う',
  )
  // 単体タブ用ラッパーのルートが存在する
  assert.match(
    SERVER_SRC,
    /if \(c === 'view' && req\.method === 'GET'\)[\s\S]{0,400}reviewViewHtml\(b, lang\)/,
    '/api/review/:id/view がラッパー HTML を lang つきで返す',
  )
  // 存在判定は sheetHtml（.json を持たない HTML だけのシートでも 409 にしない）
  assert.match(
    SERVER_SRC,
    /if \(c === 'view' && req\.method === 'GET'\)[\s\S]{0,200}review\.sheetHtml\(b, lang\)/,
    'view は sheetData（DATA_MISSING）ではなく sheetHtml で存在を判定する',
  )
})

test('injectReviewBridge はシート内から直接 fetch せず、postMessage 一本にする', () => {
  const html = injectReviewBridge('<html><body><div id="akForm"></div></body></html>', 't_1', 'ja')
  assert.equal(html.includes("fetch('/api/review/"), false, 'sandbox 下では same-origin fetch が通らない')
  assert.ok(html.includes("window.parent.postMessage({ type: 'review:reply'"))
  // 単体で開かれたときは「/view から開け」と案内する（無言で失敗させない）
  assert.ok(html.includes('から開いてください'), 'ja の案内文')
  assert.ok(html.includes("'/api/review/' + TASK + '/view'"), '案内に /view の URL を差し込む')
  // 既定（en）は同じ導線を英語で案内する（SPEC-i18n-gen §3.2）
  const en = injectReviewBridge('<html><body><div id="akForm"></div></body></html>', 't_1')
  assert.ok(en.includes('or from {view}'), 'en の案内文')
  assert.ok(en.includes("'/api/review/' + TASK + '/view'"), 'en でも /view の URL を差し込む')
  assert.equal(en.includes('から開いてください'), false, 'en に日本語の案内を出さない')
})

test('/api/review/:id/view ラッパーは sandbox iframe を埋め、回答を同じオリジンから中継する', () => {
  const html = reviewViewHtml('t_test1')
  // 内側の iframe はブラウザが直接 GET するので、言語はクエリで渡す（§3.1）
  assert.match(html, /<iframe[^>]+src="\/api\/review\/t_test1\/sheet\?lang=en"[^>]*sandbox="allow-scripts allow-forms"/)
  assert.ok(html.includes("window.addEventListener('message'"))
  assert.ok(html.includes("d.type !== 'review:reply'") && !html.includes('akapen:reply'), '現行のメッセージ型だけを受ける')
  assert.ok(html.includes("'/api/review/' + encodeURIComponent(TASK) + '/answer'"))
  assert.ok(html.includes("credentials: 'same-origin'"), '回答は same-origin で POST する')
  assert.ok(html.includes("JSON.stringify({ text: text, by: 'web' })"))
  // ラッパー自身は same-origin（sandbox を付けると fetch が不透明オリジンになる）
  const csp = reviewViewHeaders()['content-security-policy']
  assert.match(csp, /frame-src 'self'/)
  assert.match(csp, /connect-src 'self'/)
  assert.equal(/(^|;)\s*sandbox/.test(csp), false)
  assert.equal(reviewViewHeaders()['content-type'], 'text/html; charset=utf-8')
})

test('view ラッパーは taskId を HTML 属性と script の両方でエスケープする', () => {
  const evil = 't_"><script>alert(1)</script>'
  const html = reviewViewHtml(evil)
  assert.equal(html.includes('<script>alert(1)'), false, '生の script タグを出さない')
  assert.ok(html.includes('&lt;script&gt;alert(1)'), 'title 側は実体参照へ')
  assert.ok(html.includes('\\u003cscript\\u003e'), 'script 側は \\u003c へ')
  // iframe の src は URL エンコード済み
  assert.ok(html.includes('/api/review/t_%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E/sheet'))
})

test('データの置き場は ~/.hermes/plugin-data/hermes-pilot/review（旧 akapen を参照しない）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-root-'))
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  assert.equal(api.dataRoot(), path.join(root, 'plugin-data', 'hermes-pilot'))
  assert.equal(api.reviewRoot(), path.join(root, 'plugin-data', 'hermes-pilot', 'review'))
  // ボードに default_workdir が無ければ review ワークスペースを使う
  assert.equal(path.resolve(api.workdir()), path.resolve(api.reviewRoot()))
})

test('chatFor は本文の chat= を優先し、無ければ task-chats.json を返す', async () => {
  const { root } = tempBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') }, { runKanban: async () => ({ code: 0, out: 'ok' }) })
  await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'A' }], chat: 'chat_flow_1' })
  assert.equal(api.chatFor('t_test1'), 'chat_flow_1')

  const review = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(review, { recursive: true })
  fs.writeFileSync(path.join(review, 'task-chats.json'), JSON.stringify({ t_other: 'chat_map_1' }))
  assert.equal(api.chatFor('t_other'), 'chat_map_1')
  assert.equal(api.chatFor('t_unknown'), null)
})

/** 注釈ボード（`shots/` に画像を置く）。tasks は {id, body, status, started_at} の配列。 */
function annoBoard(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-anno-'))
  const boardDir = path.join(root, 'kanban', 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  const workdir = path.join(root, 'work')
  fs.mkdirSync(path.join(workdir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile', default_workdir: workdir }))
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER, result TEXT,
    last_heartbeat_at INTEGER)`)
  let t = 1000
  for (const x of tasks) {
    db.prepare('INSERT INTO tasks (id,title,body,status,assignee,created_at,started_at) VALUES (?,?,?,?,?,?,?)').run(
      x.id,
      x.title || x.id,
      x.body,
      x.status,
      'mobile',
      (t += 10),
      x.started_at ?? null,
    )
  }
  db.close()
  return { root, workdir }
}

test('compareCandidates は .before / 前ラウンド / 同一 label の .annotated を優先順で返す', () => {
  const a = compareCandidates({ image: 'shots/x-1.png', round: 1 })
  assert.deepEqual(a.slice(0, 1), ['shots/x-1.before.png'], '同名 .before が最優先')
  assert.equal(a.includes('shots/'), false)

  const b = compareCandidates({ image: 'shots/x-2.after.png', round: 2 })
  assert.ok(b.includes('shots/x-2.before.png'), '.after から .before を作る')
  assert.ok(b.includes('shots/x-1.png'), 'round 2 → round 1')

  const c = compareCandidates({
    image: 'shots/x-1.png',
    round: 1,
    others: [{ image: 'shots/x-0.png', round: 1 }, { image: 'shots/x-1.annotated.png', round: 1 }],
  })
  assert.ok(c.includes('shots/x-1.annotated.png') || c.includes('shots/x-0.annotated.png'), '前回の赤入れを候補にする')
  assert.ok(c.includes('shots/x-0.png'), '元画像も候補にする')

  assert.deepEqual(compareCandidates({ image: 'sheets/a.html' }), [], '画像以外は候補にしない')
  assert.deepEqual(
    compareCandidates({ image: 'shots/x.png', round: 3 }),
    ['shots/x.before.png'],
    '名前にラウンド番号が無ければ前ラウンドは作らない（body の round だけでは決めない）',
  )
})

test('list は比較画像があるタスクに hasCompare: true を付ける（無いものは false）', () => {
  const { root, workdir } = annoBoard([
    {
      id: 't_anno1',
      body: '[review] label=demo-01 round=1 mode=annotation image=shots/demo-01-1.png target=/tmp/repo',
      status: 'blocked',
    },
    {
      id: 't_anno2',
      body: '[review] label=demo-02 round=1 mode=annotation image=shots/demo-02-1.png target=/tmp/repo',
      status: 'blocked',
    },
  ])
  fs.writeFileSync(path.join(workdir, 'shots', 'demo-01-1.png'), 'AFTER')
  fs.writeFileSync(path.join(workdir, 'shots', 'demo-01-1.before.png'), 'BEFORE')
  fs.writeFileSync(path.join(workdir, 'shots', 'demo-02-1.png'), 'ONLY')

  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const byId = Object.fromEntries(api.list().map((i) => [i.id, i]))
  assert.equal(byId.t_anno1.review.hasCompare, true, '.before があるので比較できる')
  assert.equal(byId.t_anno2.review.hasCompare, false, '比較相手が無ければ false')

  const img = api.image('t_anno1', { compare: true })
  assert.equal(img.ok, true)
  assert.equal(img.data.toString(), 'BEFORE', 'compare=1 は Before（前回）を返す')
  assert.equal(api.image('t_anno1').data.toString(), 'AFTER', '既定は After（いまの下地）')

  const none = api.image('t_anno2', { compare: true })
  assert.equal(none.ok, false)
  assert.equal(none.code, 'NO_COMPARE')
})

test('list は同一 label の前ラウンド（archived）の赤入れ画像を Before として解決する', () => {
  const { root, workdir } = annoBoard([
    {
      id: 't_prev',
      body: '[review] label=rounds-01 round=1 mode=annotation image=shots/rounds-01-a.png target=/tmp/repo',
      status: 'archived',
    },
    {
      id: 't_now',
      body: '[review] label=rounds-01 round=2 mode=annotation image=shots/rounds-01-b.png target=/tmp/repo',
      status: 'blocked',
    },
  ])
  fs.writeFileSync(path.join(workdir, 'shots', 'rounds-01-a.png'), 'PREV')
  fs.writeFileSync(path.join(workdir, 'shots', 'rounds-01-a.annotated.png'), 'PREV-RED')
  fs.writeFileSync(path.join(workdir, 'shots', 'rounds-01-b.png'), 'NOW')

  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const now = api.list().find((i) => i.id === 't_now')
  assert.equal(now.review.hasCompare, true, 'archived の前ラウンドも見る（status で絞らない）')
  assert.equal(api.image('t_now', { compare: true }).data.toString(), 'PREV-RED', '赤入れ済みを優先する')
})

test('approve は コメント Visual check passed を残し、作業済みなら done へ進める（冪等）', async () => {
  const { root, workdir } = annoBoard([
    {
      id: 't_done1',
      body: '[review] label=ok-01 round=1 mode=annotation image=shots/ok-01-1.png target=/tmp/repo',
      status: 'blocked',
      started_at: 2000,
    },
  ])
  fs.writeFileSync(path.join(workdir, 'shots', 'ok-01-1.png'), 'AFTER')
  const calls = []
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const setStatus = (status) => {
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, 't_done1')
    db.close()
  }
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (args) => {
        calls.push(args)
        if (args[0] === 'complete') setStatus('done')
        return { code: 0, out: 'ok' }
      },
    },
  )

  const r = await api.approve('t_done1', { note: 'この見た目でOK', by: 'mobile' })
  assert.equal(r.ok, true)
  assert.equal(r.duplicate, false)
  assert.equal(r.moved, 'done', '検収 OK は完了（done）')
  const comment = calls.find((a) => a[0] === 'comment')
  assert.ok(comment.includes('Visual check passed'), 'コメント本文は固定文言')
  const saved = JSON.parse(fs.readFileSync(path.join(workdir, 'shots', 'ok-01-1.approval.json'), 'utf8'))
  assert.equal(saved.task_id, 't_done1')
  assert.equal(saved.note, 'この見た目でOK')
  assert.equal(saved.verdict, 'visual-check-passed')

  const again = await api.approve('t_done1', { note: 'この見た目でOK', by: 'mobile' })
  assert.equal(again.duplicate, true)
  assert.equal(calls.filter((a) => a[0] === 'comment').length, 1, '再送でコメントを増やさない')
})

test('approve は未作業の注釈タスクも完了にし、complete が通らないときだけ unblock する', async () => {
  const { root, workdir } = annoBoard([
    {
      id: 't_new1',
      body: '[review] label=new-01 round=1 mode=annotation image=shots/new-01-1.png target=/tmp/repo',
      status: 'blocked',
    },
    {
      id: 't_new3',
      body: '[review] label=new-03 round=1 mode=annotation image=shots/new-03-1.png target=/tmp/repo',
      status: 'blocked',
    },
    {
      id: 't_ready1',
      body: '[review] label=new-02 round=1 mode=annotation image=shots/new-02-1.png target=/tmp/repo',
      status: 'ready',
    },
  ])
  fs.writeFileSync(path.join(workdir, 'shots', 'new-01-1.png'), 'A')
  fs.writeFileSync(path.join(workdir, 'shots', 'new-02-1.png'), 'B')
  fs.writeFileSync(path.join(workdir, 'shots', 'new-03-1.png'), 'C')
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const setStatus = (id, status) => {
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id)
    db.close()
  }
  // t_new3 だけ complete が失敗する状況（ワーカーが抱えたまま等）を作る
  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (a) => {
        calls.push(a)
        if (a[0] === 'complete' && a[1] === 't_new3') return { code: 1, out: 'task is running' }
        if (a[0] === 'complete') setStatus(a[1], 'done')
        if (a[0] === 'unblock') setStatus(a[1], 'ready')
        return { code: 0, out: 'ok' }
      },
    },
  )

  const r = await api.approve('t_new1', {})
  assert.equal(r.ok, true)
  assert.equal(r.moved, 'done', 'Looks Good は合格＝完了（未作業でも止まっている理由が済んだ）')

  const fallback = await api.approve('t_new3', {})
  assert.equal(fallback.ok, true)
  assert.equal(fallback.moved, 'ready', 'complete が通らないときだけ unblock に落とす')

  const notWaiting = await api.approve('t_ready1', {})
  assert.equal(notWaiting.ok, false)
  assert.equal(notWaiting.code, 'NOT_WAITING')

  const missing = await api.approve('t_nope', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')
})

test('approve はコメントが残せなかったとき記録を消して再挑戦できる（コメント欠落を残さない）', async () => {
  const { root, workdir } = annoBoard([
    {
      id: 't_retry1',
      body: '[review] label=retry-01 round=1 mode=annotation image=shots/retry-01-1.png target=/tmp/repo',
      status: 'blocked',
    },
  ])
  fs.writeFileSync(path.join(workdir, 'shots', 'retry-01-1.png'), 'A')
  let failComment = true
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      runKanban: async (a) => {
        if (a[0] === 'comment' && failComment) return { code: 1, out: 'database is locked' }
        return { code: 0, out: 'ok' }
      },
    },
  )
  const bad = await api.approve('t_retry1', {})
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'COMMENT_FAILED')
  assert.equal(fs.existsSync(path.join(workdir, 'shots', 'retry-01-1.approval.json')), false, '記録を残さない')

  failComment = false
  const retry = await api.approve('t_retry1', {})
  assert.equal(retry.ok, true)
  assert.equal(retry.duplicate, false, '再挑戦は duplicate ではなく本処理からやり直す')
  assert.equal(fs.existsSync(path.join(workdir, 'shots', 'retry-01-1.approval.json')), true)
})

test('sheetPaths: .html でも .json シートでも回答は設問ファイルを上書きしない', async () => {
  const { sheetPaths } = await import('../src/review.js')
  assert.deepEqual(sheetPaths('sheets/a-1.html'), { dataRel: 'sheets/a-1.json', answerRel: 'sheets/a-1.answer.json' })
  // mode=standard（.json シート）は設問と回答が同一ファイルに潰れていた（実測のバグ）
  assert.deepEqual(sheetPaths('sheets/a-1.json'), { dataRel: 'sheets/a-1.json', answerRel: 'sheets/a-1.answer.json' })
})

test('answer: .json シート（mode=standard）でも設問 JSON を壊さず .answer.json に保存する', async () => {
  const { root, workdir } = tempBoard()
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO tasks (id,title,body,status,assignee,created_at) VALUES (?,?,?,?,?,?)').run(
    't_std01',
    '標準スモーク',
    '本文\n[review] label=std-01 round=1 mode=standard sheet=sheets/std-01-1.json\n',
    'blocked',
    'mobile',
    Math.floor(Date.now() / 1000),
  )
  db.close()
  const questions = {
    label: 'std-01',
    round: 1,
    mode: 'standard',
    title: '標準スモーク',
    questions: [
      { id: 'q1', text: '問1', options: [{ id: 'A', recommended: true }, { id: 'B' }] },
      { id: 'q2', text: '問2', options: [{ id: 'A' }, { id: 'B', recommended: true }] },
    ],
  }
  const sheetFile = path.join(workdir, 'sheets', 'std-01-1.json')
  fs.writeFileSync(sheetFile, JSON.stringify(questions))
  const before = fs.readFileSync(sheetFile, 'utf8')

  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    { runKanban: async () => ({ code: 0, out: 'ok' }) },
  )
  const r = await api.answer('t_std01', { answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', choice: 'B' }], by: 'alice' })
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(sheetFile, 'utf8'), before, '設問 JSON が上書きされた')
  const answerFile = path.join(workdir, 'sheets', 'std-01-1.answer.json')
  const saved = JSON.parse(fs.readFileSync(answerFile, 'utf8'))
  assert.deepEqual(saved.answers.map((a) => `${a.id}:${a.choice}`), ['q1:A', 'q2:B'])
  // 回答後もシート構造が読める（再回答・比較の前提）
  const data = api.sheetData('t_std01')
  assert.equal(data.ok, true)
  assert.equal(data.data.questions.length, 2)
  assert.equal(data.answer.answers[1].choice, 'B')
})

test('chatReports はパイプライン統合レポートの追加フィールドを透過的に返す（V4-2 / D20）', () => {
  const { root } = tempBoard()
  const dir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(dir, { recursive: true })
  const rows = [
    // 既存のレビュー 1 行レポート（追加フィールドは既定値のまま）
    { at: '2026-11-15T00:00:00.000Z', session_id: 'chat-a', task_id: 't_1', label: 'x-01', text: '完了' },
    {
      at: '2026-11-15T00:30:00.000Z',
      kind: 'pipeline',
      status: 'done',
      session_id: 'chat-a',
      task_id: 'pipeline:mobile:run_1',
      label: 'SPEC: V4',
      board: 'mobile',
      spec: 'docs/SPEC-PILOT-V4.md',
      repo_path: '/tmp/repo',
      text: '🎉 SPEC: V4 (4/4 done)',
      markdown: '### 🎉 Pipeline Completed: SPEC: V4 (4/4 done)',
      follow_up_prompt: '次の一手を相談したいです',
      counts: { done: 4, blocked: 0, failed: 0, total: 4 },
    },
  ]
  fs.writeFileSync(
    path.join(dir, 'chat-reports.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const mine = api.chatReport('chat-a', { limit: 5 })
  assert.equal(mine.length, 2)
  const plain = mine[0]
  assert.equal(plain.kind, null, '既存行は kind なしのまま（後方互換）')
  assert.equal(plain.markdown, '')
  assert.equal(plain.counts, null)
  const pipe = mine[1]
  assert.equal(pipe.kind, 'pipeline')
  assert.equal(pipe.status, 'done')
  assert.equal(pipe.board, 'mobile')
  assert.equal(pipe.spec, 'docs/SPEC-PILOT-V4.md')
  assert.equal(pipe.repoPath, '/tmp/repo')
  assert.match(pipe.markdown, /Pipeline Completed/)
  assert.equal(pipe.followUpPrompt, '次の一手を相談したいです')
  assert.deepEqual(pipe.counts, { done: 4, blocked: 0, failed: 0, total: 4 })
})

test('answer: 担当の無いタスクは回答後に assign してワーカーが起動できるようにする', async () => {
  const { root, workdir } = tempBoard()
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO tasks (id,title,body,status,assignee,created_at) VALUES (?,?,?,?,?,?)').run(
    't_noassign',
    '未割当のレビュー',
    '本文\n[review] label=cockpit-04 round=1 mode=standard sheet=sheets/cockpit-03-1.html\n',
    'blocked',
    null,
    Math.floor(Date.now() / 1000),
  )
  db.close()
  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      assignee: 'mobile',
      runKanban: async (args) => {
        calls.push(args)
        if (args[0] === 'unblock') {
          const d = new DatabaseSync(dbPath)
          d.prepare("UPDATE tasks SET status='ready' WHERE id='t_noassign'").run()
          d.close()
        }
        return { code: 0, out: 'ok' }
      },
    },
  )
  const r = await api.answer('t_noassign', { answers: [{ id: 'q1', choice: 'A' }], by: 'alice' })
  assert.equal(r.ok, true)
  assert.equal(r.assigned, 'mobile')
  const assign = calls.find((c) => c[0] === 'assign')
  assert.deepEqual(assign, ['assign', 't_noassign', 'mobile'], 'assign が呼ばれていない')
})

/* ------------------------------------------------------------------ *
 * V8-B3: 実行ワーカーのセッション解決と、プロファイル横断の feed 検索
 * ------------------------------------------------------------------ */

/**
 * `session_id` 列と `task_events` を持つ一時ボードを作る。
 * @param {{sessionId?: string|null, events?: Array<{kind: string, payload: object}>}} [opts] 中身
 * @returns {{root: string, dbPath: string}} 置き場所
 */
function sessionBoard({ sessionId = null, events = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-session-'))
  const boardDir = path.join(root, 'kanban', 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile' }))
  const dbPath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
    result TEXT, last_heartbeat_at INTEGER, session_id TEXT)`)
  db.exec(`CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, payload TEXT, created_at INTEGER)`)
  db.prepare('INSERT INTO tasks (id,title,status,created_at,session_id) VALUES (?,?,?,?,?)').run(
    't_worker',
    'worker の進捗',
    'running',
    Math.floor(Date.now() / 1000),
    sessionId,
  )
  for (const e of events) {
    db.prepare('INSERT INTO task_events (task_id,kind,payload,created_at) VALUES (?,?,?,?)').run(
      't_worker',
      e.kind,
      JSON.stringify(e.payload ?? {}),
      Math.floor(Date.now() / 1000),
    )
  }
  db.close()
  return { root, dbPath }
}

test('review.sessionId は tasks 行に session_id があっても task_events の db を補完する', () => {
  const { root } = sessionBoard({
    sessionId: 'sess_row',
    events: [{ kind: 'owner_admitted', payload: { session_id: 'sess_row', db: '/tmp/profiles/mobile/state.db' } }],
  })
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const info = api.sessionId('t_worker')
  assert.equal(info.sessionId, 'sess_row')
  assert.equal(info.db, '/tmp/profiles/mobile/state.db', 'db が補完されていない')
  assert.equal(info.status, 'running')
})

test('review.sessionId は tasks 行が空でもイベントの session_id で解決する', () => {
  const { root } = sessionBoard({
    sessionId: null,
    events: [{ kind: 'worker_bound', payload: { session_id: 'sess_event', db: '/tmp/p/state.db' } }],
  })
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const info = api.sessionId('t_worker')
  assert.equal(info.sessionId, 'sess_event')
  assert.equal(info.db, '/tmp/p/state.db')
})

test('review.sessionId は手掛かりが無ければ null', () => {
  const { root } = sessionBoard({})
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  assert.equal(api.sessionId('t_worker'), null)
})

test('workerFeed は info.db を優先し、空なら全プロファイルを横断して messages のある DB を採る', async () => {
  const calls = []
  const read = (sid, opts) => {
    calls.push(opts.dbPath)
    // イベントが指す DB は空、profile 側にだけ会話がある（実測: 別プロファイルで動いた worker）
    if (opts.dbPath === '/tmp/event/state.db') return { ok: true, sessionId: sid, messages: [] }
    if (opts.dbPath === '/tmp/default/state.db') return { ok: true, sessionId: sid, messages: [] }
    if (opts.dbPath === '/tmp/mobile/state.db')
      return { ok: true, sessionId: sid, messages: [{ id: 1, role: 'tool', text: 'npm test' }] }
    return { ok: false, sessionId: sid, messages: [], reason: 'no db' }
  }
  const readWorkerFeed = createWorkerFeed({
    listStateDbs: async () => [
      { profile: 'default', path: '/tmp/default/state.db' },
      { profile: 'mobile', path: '/tmp/mobile/state.db' },
    ],
    read,
  })
  const hit = await readWorkerFeed('sess_1', { db: '/tmp/event/state.db' }, 30)
  assert.equal(hit.db, '/tmp/mobile/state.db', 'messages のある DB が選ばれていない')
  assert.equal(hit.profile, 'mobile')
  assert.equal(hit.feed.messages.length, 1)
  // info.db が最初に読まれる（優先）
  assert.equal(calls[0], '/tmp/event/state.db')
})

test('workerFeed は info.db が重複していても二度読まない', async () => {
  const calls = []
  const readWorkerFeed = createWorkerFeed({
    listStateDbs: async () => [{ profile: 'mobile', path: '/tmp/mobile/state.db' }],
    read: (sid, opts) => {
      calls.push(opts.dbPath)
      return { ok: true, sessionId: sid, messages: [] }
    },
  })
  const hit = await readWorkerFeed('sess_2', { db: '/tmp/mobile/state.db' })
  assert.deepEqual(calls, ['/tmp/mobile/state.db'])
  // どこも空でも DB は特定できている（UI は「まだ出力がありません」を出す）
  assert.equal(hit.db, '/tmp/mobile/state.db')
  assert.deepEqual(hit.feed.messages, [])
})

test('workerFeed は sessionId が無ければ DB を読まない', async () => {
  let called = 0
  const readWorkerFeed = createWorkerFeed({
    listStateDbs: async () => [{ profile: 'mobile', path: '/tmp/mobile/state.db' }],
    read: () => {
      called += 1
      return { ok: true, messages: [] }
    },
  })
  assert.deepEqual(await readWorkerFeed('', {}), { feed: null, db: null, profile: null })
  assert.equal(called, 0)
})

test('feedCandidates は info.db を先頭に置き、重複と空パスを落とす', () => {
  const out = feedCandidates(
    { db: '/tmp/a/state.db' },
    [
      { profile: 'default', path: '/tmp/b/state.db' },
      { profile: 'mobile', path: '/tmp/a/state.db' },
      { profile: 'broken', path: '' },
    ],
  )
  assert.deepEqual(out.map((c) => c.path), ['/tmp/a/state.db', '/tmp/b/state.db'])
  assert.equal(out[0].profile, 'event')
})

test('pickFeed は messages のある最初の結果を選び、無ければ先頭を返す', () => {
  const empty = { feed: { messages: [] }, db: '/tmp/a', profile: 'a' }
  const full = { feed: { messages: [{ id: 1 }] }, db: '/tmp/b', profile: 'b' }
  assert.equal(pickFeed([empty, full]), full)
  assert.equal(pickFeed([empty]), empty)
  assert.deepEqual(pickFeed([]), { feed: null, db: null, profile: null })
})

// --- SPEC-i18n-gen GEN-1: 生成 HTML を ?lang= に追従させる ---------------------

/** ASCII だけのシート（データの日本語と生成文の日本語を混ぜない）。 */
const I18N_FIXTURE = {
  title: 'Sheet title',
  topic: 'Topic text',
  questions: [
    {
      id: 'q1',
      text: 'Which option?',
      options: [
        { id: 'A', label: 'Option A', recommended: true },
        { id: 'B', label: 'Option B' },
      ],
    },
  ],
}

test('renderSheetHtmlFromData は lang で文言を切り替える（en=Recommended / ja=推奨）', () => {
  const en = renderSheetHtmlFromData(I18N_FIXTURE, { label: 'demo-01' }, 'en')
  assert.ok(en.includes('<html lang="en">'), 'en は <html lang="en">')
  assert.ok(en.includes('<span class="rec-badge">Recommended</span>'), 'en のバッジは Recommended')
  assert.equal(en.includes('<html lang="ja">'), false, 'en に ja の lang 属性を出さない')
  assert.equal(en.includes('推奨'), false, 'en に「推奨」を出さない')

  const ja = renderSheetHtmlFromData(I18N_FIXTURE, { label: 'demo-01' }, 'ja')
  assert.ok(ja.includes('<html lang="ja">'), 'ja は <html lang="ja">')
  assert.ok(ja.includes('<span class="rec-badge">推奨</span>'), 'ja のバッジは「推奨」')
  assert.equal(ja.includes('Recommended'), false, 'ja に Recommended を出さない')

  // 空状態・注記も言語に従う（データの設問が無いとき）
  const emptyEn = renderSheetHtmlFromData({ title: 'S', questions: [] }, {}, 'en')
  assert.ok(emptyEn.includes('No questions.'), 'en の空状態')
  assert.ok(emptyEn.includes('<title>S</title>'), 'title はデータのまま（訳さない）')
  const emptyJa = renderSheetHtmlFromData({ title: 'S', questions: [] }, {}, 'ja')
  assert.ok(emptyJa.includes('設問がありません。'), 'ja の空状態')
})

test('reviewViewHtml は lang で title / lang 属性 / 内側 iframe の言語を切り替える', () => {
  const en = reviewViewHtml('t_demo1', 'en')
  assert.ok(en.includes('<html lang="en">'))
  assert.ok(en.includes('<title>Review sheet t_demo1</title>'), 'en の title は英語')
  assert.ok(en.includes('title="Review sheet"'), 'iframe の title も英語')
  assert.ok(en.includes('/api/review/t_demo1/sheet?lang=en'), '内側 iframe へ言語を渡す')

  const ja = reviewViewHtml('t_demo1', 'ja')
  assert.ok(ja.includes('<html lang="ja">'))
  assert.ok(ja.includes('<title>レビューシート t_demo1</title>'))
  assert.ok(ja.includes('title="レビューシート"'))
  assert.ok(ja.includes('/api/review/t_demo1/sheet?lang=ja'))
})

test("injectReviewBridge の可視文言は lang で切り替わり、en に CJK が残らない", () => {
  const en = injectReviewBridge('<html><body><div id="akForm"></div></body></html>', 't_demo1', 'en')
  assert.ok(en.includes('Send answer'), 'en のボタン文言')
  assert.equal(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff60]/.test(en), false, 'en に CJK が残る')

  const ja = injectReviewBridge('<html><body><div id="akForm"></div></body></html>', 't_demo1', 'ja')
  assert.ok(ja.includes('回答を送信'))
  assert.ok(ja.includes('アプリに回答を送りました'), 'ja は従来の文言')
  // 受理マーカーは両表記を受ける（出力は ASCII エスケープでも実行時は CJK に一致する）
  assert.ok(ja.includes('u3010'), '旧【赤ペン回答】のマーカーはエスケープで埋める')
})

test('sheetHtml は lang を受けて .json から en / ja の HTML を返す', () => {
  const { root } = tempJsonOnlyBoard()
  const api = createReview({ kanbanRoot: path.join(root, 'kanban') })
  const en = api.sheetHtml('t_sheetjson', 'en')
  assert.equal(en.generated, true)
  assert.ok(en.html.includes('<html lang="en">'))
  assert.ok(en.html.includes('Recommended'))
  const ja = api.sheetHtml('t_sheetjson', 'ja')
  assert.ok(ja.html.includes('<html lang="ja">'))
  assert.ok(ja.html.includes('推奨'))
  // .html があるシートは従来どおり中身をそのまま返す（生成しない）
  const raw = api.sheetHtml('t_test1')
  assert.equal(raw.generated, undefined)
})
