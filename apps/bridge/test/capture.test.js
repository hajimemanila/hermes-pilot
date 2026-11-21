import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCapture, buildCreateArgs, dedupeKey, createCapture } from '../src/capture.js'

test('normalizeCapture はタイトルの空白を畳み、既定値を埋める', () => {
  const c = normalizeCapture({ board: 'hermes-mobile-pwa', title: '  音声で  起票する  ' })
  assert.equal(c.title, '音声で 起票する')
  assert.equal(c.board, 'hermes-mobile-pwa')
  assert.equal(c.body, '')
  assert.equal(c.priority, 0)
  assert.equal(c.assignee, null)
})

test('タイトル必須・長さ上限・ボード名の検証', () => {
  // 表示文はコード＋辞書で自言語化する（SPEC-i18n-resp B2）。テストはコードで固定する。
  assert.throws(() => normalizeCapture({ board: 'b', title: '  ' }), (e) => e.code === 'TASK_TITLE_REQUIRED')
  assert.throws(
    () => normalizeCapture({ board: 'b', title: 'x'.repeat(201) }),
    (e) => e.code === 'TASK_TITLE_TOO_LONG' && e.params.max === 200,
  )
  assert.throws(() => normalizeCapture({ board: '../etc', title: 'x' }), (e) => e.code === 'BOARD_NAME_INVALID')
  assert.throws(() => normalizeCapture({ board: '', title: 'x' }), (e) => e.code === 'BOARD_NAME_INVALID')
})

test('priority は 0..9 に丸め、不正なら0', () => {
  assert.equal(normalizeCapture({ board: 'b', title: 'x', priority: 99 }).priority, 9)
  assert.equal(normalizeCapture({ board: 'b', title: 'x', priority: -5 }).priority, 0)
  assert.equal(normalizeCapture({ board: 'b', title: 'x', priority: 'abc' }).priority, 0)
})

test('assignee は安全な文字だけ通す', () => {
  assert.equal(normalizeCapture({ board: 'b', title: 'x', assignee: 'default' }).assignee, 'default')
  assert.equal(normalizeCapture({ board: 'b', title: 'x', assignee: 'a b;rm' }).assignee, null)
})

test('buildCreateArgs は CLI の順序どおりに組む', () => {
  const c = normalizeCapture({ board: 'bd', title: 'T', body: 'B', priority: 5, assignee: 'default' })
  assert.deepEqual(buildCreateArgs(c), [
    'kanban',
    '--board',
    'bd',
    'create',
    'T',
    '--json',
    '--body',
    'B',
    '--priority',
    '5',
    '--assignee',
    'default',
  ])
  const minimal = normalizeCapture({ board: 'bd', title: 'T' })
  assert.deepEqual(buildCreateArgs(minimal), ['kanban', '--board', 'bd', 'create', 'T', '--json'])
})

test('dedupeKey は明示キー優先、無ければ内容から安定に導く', () => {
  const c = normalizeCapture({ board: 'b', title: 'x' })
  const a1 = dedupeKey(c, 'abc')
  assert.equal(a1, 'k:abc')
  const auto1 = dedupeKey(c, null)
  const auto2 = dedupeKey(c, null)
  assert.equal(auto1, auto2)
  assert.equal(auto1.length, 40)
})

test('create: 同じ idempotencyKey の2回目は CLI を呼ばず既存を返す', async () => {
  let calls = 0
  const cap = createCapture({
    runner: async (args) => {
      calls += 1
      assert.ok(args.includes('create'))
      return {
        code: 0,
        stdout: '{\n  "id": "t_test0001",\n  "title": "x",\n  "status": "ready",\n  "priority": 0\n}\n',
        stderr: '',
      }
    },
  })
  const r1 = await cap.create({ board: 'b', title: 'x', idempotencyKey: 'same' })
  assert.equal(r1.ok, true)
  assert.equal(r1.created, true)
  assert.equal(r1.task.id, 't_test0001')
  const r2 = await cap.create({ board: 'b', title: 'x', idempotencyKey: 'same' })
  assert.equal(r2.created, false)
  assert.equal(r2.task.id, 't_test0001')
  assert.equal(calls, 1)
})

test('create: CLI 失敗は stderr をそのまま理由にする', async () => {
  const cap = createCapture({
    runner: async () => ({ code: 1, stdout: '', stderr: 'no such board: nope' }),
  })
  const r = await cap.create({ board: 'nope', title: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /no such board/)
})

test('create: 入力エラーは ok:false で返し、例外にしない', async () => {
  const cap = createCapture({ hermesBin: '/nonexistent/hermes' })
  const r = await cap.create({ board: 'b', title: '' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TASK_TITLE_REQUIRED', 'コードで返し、PWA が自言語化する')
  assert.equal(r.error, 'A title is required', '文言は英語既定（応答 JSON に日本語を残さない）')
})

test('server.js の POST /api/boards/:slug/tasks は assignee 省略時に getPilotProfile() を補う', () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const match = /if\s*\(b && c === 'tasks' && !d && req\.method === 'POST'\)[\s\S]*?return r\.ok \? sendJson/.exec(src)
  assert.ok(match, 'POST /api/boards/:slug/tasks ハンドラが見つからない')
  assert.match(match[0], /getPilotProfile\(\)/, 'assignee 未指定時の既定パイロットプロファイル補完が欠けている')
  assert.match(match[0], /capture\.create\(\{ \.\.\.body, board: b, assignee \}\)/, 'assignee が capture.create に渡っていない')
})
