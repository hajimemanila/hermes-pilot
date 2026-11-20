/**
 * GEN-2 の受入条件（SPEC-i18n-gen §3.3 / §3.6）。
 *
 * - `toReplyText(..., 'en')` は CJK を 1 文字も含まず、`parseReplyText` が同じ answers / global に戻す
 * - `ja` 形は従来どおり（`【レビュー回答】` / `補足:` / `(未選択 = お任せ)`）で往復が壊れない
 * - `answer(..., 'en')` が呼ぶ `runKanban(['comment', …])` の 1 行が英語サマリ
 * - `answer.txt` も同じ言語で書かれ、既定は en
 *
 * `review.test.js`（GEN-1 も触る）とは分けて置く。往復の契約はこのファイルが正。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createReview, parseReplyText, toReplyText } from '../src/review.js'

/** ひらがな・カタカナ・漢字・全角記号（`・` と長音 `ー` は除外）。 */
const CJK = /[\u3040-\u309f\u30a0-\u30fa\u30fd-\u30ff\u4e00-\u9fff\uff01-\uff60]/

/** 一時ボード（kanban.db + board.json + sheet.json）を作る。 */
function tempBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-lang-'))
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
    'HUD width',
    'body\n[review] label=hud-02 round=1 mode=standard sheet=sheets/hud-02-1.html\n',
    'blocked',
    'mobile',
    Math.floor(Date.now() / 1000),
  )
  db.close()
  fs.writeFileSync(path.join(workdir, 'sheets', 'hud-02-1.html'), '<html><body>sheet</body></html>')
  fs.writeFileSync(
    path.join(workdir, 'sheets', 'hud-02-1.json'),
    JSON.stringify({
      label: 'hud-02',
      round: 1,
      mode: 'standard',
      title: 'HUD width',
      // 設問文も ASCII（CJK 0 判定を設問文の混入で壊さないため）
      questions: [
        { id: 'q1', text: 'Which side?', options: [{ id: 'A', recommended: true }, { id: 'B' }] },
        { id: 'q2', text: 'Keep color?', options: [{ id: 'A' }, { id: 'B' }] },
      ],
    }),
  )
  return { root, workdir }
}

/** runKanban を差し替えた API。unblock で status を ready に戻す。 */
function apiWithCalls(root, calls) {
  const dbPath = path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db')
  return createReview(
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
}

test('toReplyText の EN 形は CJK 0 文字で、parseReplyText が同じ回答に戻す（往復）', () => {
  const answers = [
    { id: 'q1', choice: 'A', note: 'keep it small' },
    { id: 'q2', choice: null },
  ]
  const questions = [
    { id: 'q1', text: 'Which side?' },
    { id: 'q2', text: 'Keep color?' },
  ]
  const txt = toReplyText('hud-02', answers, 'ship it', questions, 'en')

  assert.equal(CJK.test(txt), false, `EN 出力に CJK が残っている: ${txt}`)
  assert.match(txt, /^\[Review Answer\] hud-02\n/)
  assert.match(txt, /Q1\. Which side\?: A \/ note: keep it small/)
  assert.match(txt, /Q2\. Keep color\?: \(unselected = take recommended\)/)
  assert.match(txt, /Overall Note: ship it/)
  assert.match(txt, /Apply the answers above and continue\./)

  const back = parseReplyText(txt)
  assert.deepEqual(back.answers, [
    { id: 'q1', choice: 'A', note: 'keep it small' },
    { id: 'q2', choice: null, note: '' },
  ])
  assert.equal(back.global, 'ship it')
})

test('既定は en（ja を明示しない限り英語で出る）', () => {
  const txt = toReplyText('hud-02', [{ id: 'q1', choice: 'A' }], 'ok', [{ id: 'q1', text: 'Which?' }])
  assert.match(txt, /^\[Review Answer\] hud-02\n/)
  assert.equal(CJK.test(txt), false)
})

test('ja 形は従来どおりで、往復が壊れない', () => {
  const txt = toReplyText(
    'hud-02',
    [
      { id: 'q1', choice: 'A', note: '小さく' },
      { id: 'q2', choice: null },
    ],
    'これで',
    [{ id: 'q1', text: '左右どちら？' }, { id: 'q2', text: '色は？' }],
    'ja',
  )
  assert.match(txt, /^【レビュー回答】hud-02\n/)
  assert.match(txt, /Q1\. 左右どちら？: A \/ 補足: 小さく/)
  assert.match(txt, /Q2\. 色は？: \(未選択 = お任せ\)/)
  assert.match(txt, /全体へのレビュー: これで/)

  const back = parseReplyText(txt)
  assert.deepEqual(back.answers, [
    { id: 'q1', choice: 'A', note: '小さく' },
    { id: 'q2', choice: null, note: '' },
  ])
  assert.equal(back.global, 'これで')
})

test('parseReplyText は en / ja の混在履歴を両方受ける（note: と (unselected）', () => {
  const en = parseReplyText('[Review Answer] hud-02\nQ1. Which?: B / note: tight\nQ2. Color?: (unselected = take recommended)\nOverall Note: go\n---\n')
  assert.deepEqual(en.answers, [
    { id: 'q1', choice: 'B', note: 'tight' },
    { id: 'q2', choice: null, note: '' },
  ])
  assert.equal(en.global, 'go')

  const ja = parseReplyText('【レビュー回答】hud-02\nQ1. どちら: B / 補足: 狭く\nQ2. 色: (未選択 = お任せ)\n全体へのレビュー: 進める\n---\n')
  assert.deepEqual(ja.answers, [
    { id: 'q1', choice: 'B', note: '狭く' },
    { id: 'q2', choice: null, note: '' },
  ])
  assert.equal(ja.global, '進める')
})

test("answer(..., 'en') は英語サマリの comment と英語の answer.txt を出す", async () => {
  const { root, workdir } = tempBoard()
  const calls = []
  const api = apiWithCalls(root, calls)

  const r = await api.answer(
    't_test1',
    { answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', choice: null }], global: 'ship it', by: 'alice' },
    'en',
  )
  assert.equal(r.ok, true)

  const comment = calls.find((a) => a[0] === 'comment')
  assert.ok(comment, 'comment が呼ばれる')
  assert.equal(CJK.test(comment[2]), false, `サマリが英語でない: ${comment[2]}`)
  assert.match(comment[2], /^Review answers: 2 \(chosen 1 \/ defaulted 1\) — sheets\/hud-02-1\.answer\.json$/)
  assert.ok(comment.includes('--author'), '--author は機械トークンとして残る')

  const unblock = calls.find((a) => a[0] === 'unblock')
  assert.equal(CJK.test(unblock[3]), false, `unblock 理由が英語でない: ${unblock[3]}`)
  assert.equal(unblock[3], 'Review answers received')

  const txt = fs.readFileSync(path.join(workdir, 'sheets', 'hud-02-1.answer.txt'), 'utf8')
  assert.equal(CJK.test(txt), false, 'answer.txt も英語')
  assert.match(txt, /^\[Review Answer\] hud-02\n/)
  assert.match(txt, /Q2\. Keep color\?: \(unselected = take recommended\)/)
})

test("answer(..., 'ja') は従来どおりの日本語サマリを出す（既定を en に倒しても壊さない）", async () => {
  const { root } = tempBoard()
  const calls = []
  const api = apiWithCalls(root, calls)

  await api.answer('t_test1', { answers: [{ id: 'q1', choice: 'A' }], global: 'これで' }, 'ja')
  const comment = calls.find((a) => a[0] === 'comment')
  assert.match(comment[2], /^レビュー回答: 2問 \(選択 1 \/ お任せ 0\) — sheets\/hud-02-1\.answer\.json$/)
  const unblock = calls.find((a) => a[0] === 'unblock')
  assert.equal(unblock[3], 'レビュー回答を受領')
})

test('saveAnnotation / createFromImage の運用 1 行も英語になり、ja は従来どおり', async () => {
  const { root, workdir } = tempBoard()
  const repoA = path.join(root, 'repo-a')
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
  fs.mkdirSync(path.join(workdir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(workdir, 'shots', 'anno.png'), 'PNGDATA')
  const db = new DatabaseSync(path.join(root, 'kanban', 'boards', 'mobile', 'kanban.db'))
  db.prepare("UPDATE tasks SET body=? WHERE id='t_test1'").run(
    '[review] label=anno round=1 mode=annotation image=shots/anno.png',
  )
  db.close()

  const calls = []
  const api = createReview(
    { kanbanRoot: path.join(root, 'kanban') },
    {
      targets: () => [{ id: 'hermes-mobile-pwa', label: 'Mobile', path: repoA }],
      runKanban: async (a) => {
        calls.push(a)
        return a[0] === 'create' ? { code: 0, out: 'Created t_abcdef12 (ready)' } : { code: 0, out: 'ok' }
      },
    },
  )
  const png = 'data:image/png;base64,' + Buffer.from('annotated').toString('base64')

  await api.saveAnnotation('t_test1', { annotated_image: png, note: 'tighten', marks: [{ tool: 'pen' }] }, 'en')
  const sum = calls.find((a) => a[0] === 'comment')[2]
  assert.equal(CJK.test(sum), false, `注釈サマリが英語でない: ${sum}`)
  assert.match(sum, /^Annotation: 1 strokes \/ note: tighten — shots\/anno\.annotated\.png$/)
  assert.equal(calls.find((a) => a[0] === 'unblock')[3], 'Annotation received')

  const created = await api.createFromImage({ source: 'upload', image: png, target: repoA })
  assert.equal(created.ok, true)
  const block = calls.find((a) => a[0] === 'block')
  assert.equal(CJK.test(block[2]), false, `block 理由が英語でない: ${block[2]}`)
  assert.equal(block[2], 'Awaiting annotation (from image)')

  const createdJa = await api.createFromImage({ source: 'upload', image: png, target: repoA }, 'ja')
  assert.equal(createdJa.ok, true)
  const blocks = calls.filter((a) => a[0] === 'block')
  assert.equal(blocks[blocks.length - 1][2], '注釈待ち（画像から作成）')
})
