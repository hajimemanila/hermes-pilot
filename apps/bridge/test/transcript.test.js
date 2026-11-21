import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTranscript, parseToolCalls } from '../src/transcript.js'

/** 旧スキーマ（tool_name / tool_call_id / tool_calls 列なし）。 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tr-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER
  );`)
  const now = Date.now() / 1000
  const rows = [
    [1, 's1', 'user', '最初の質問', now - 300, 1],
    [2, 's1', 'assistant', '回答1', now - 290, 1],
    [3, 's1', 'tool', 'ツール出力は出さない', now - 280, 1],
    [4, 's1', 'assistant', '', now - 270, 1], // 空は出さない
    [5, 's1', 'assistant', '古い圧縮済み', now - 200, 0], // active=0 は出さない
    [6, 's1', 'assistant', '最後の回答', now - 100, 1],
    [7, 's2', 'user', '別セッション', now - 90, 1],
  ]
  const ins = db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, active) VALUES (?,?,?,?,?,?)')
  for (const r of rows) ins.run(...r)
  db.close()
  return dbPath
}

const LONG_PATH = `/${'a'.repeat(800)}`

/** 新スキーマ（tool_name / tool_call_id / tool_calls 列あり）。 */
function fixtureModern() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tr3-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER,
    tool_name TEXT, tool_call_id TEXT, tool_calls TEXT
  );`)
  const now = Date.now() / 1000
  const ins = db.prepare(
    'INSERT INTO messages (id, session_id, role, content, timestamp, active, tool_name, tool_call_id, tool_calls) VALUES (?,?,?,?,?,?,?,?,?)',
  )
  const rows = [
    [1, 's1', 'user', 'ビルドを確認して', now - 300, 1, null, null, null],
    // 本文が空でも tool_calls を持つ assistant 行（content 空なので messages には出ない）
    [
      2,
      's1',
      'assistant',
      '',
      now - 290,
      1,
      null,
      null,
      JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"command":"npm run verify"}' } }]),
    ],
    [3, 's1', 'tool', '{"output":"ok","exit_code":0}', now - 280, 1, null, 'c1', null],
    [
      4,
      's1',
      'assistant',
      '読んでみます',
      now - 270,
      1,
      null,
      null,
      JSON.stringify([{ id: 'c2', function: { name: 'read_file', arguments: JSON.stringify({ path: LONG_PATH }) } }]),
    ],
    [5, 's1', 'tool', 'done', now - 260, 1, 'patch', 'c2', null],
    [6, 's1', 'assistant', '完了しました', now - 100, 1, null, null, null],
  ]
  for (const r of rows) ins.run(...r)
  db.close()
  return dbPath
}

/** `{ <callId>: { name, args } }` 形式の tool_calls。 */
function fixtureObjectForm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tr4-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER,
    tool_name TEXT, tool_call_id TEXT, tool_calls TEXT
  );`)
  const now = Date.now() / 1000
  const ins = db.prepare(
    'INSERT INTO messages (id, session_id, role, content, timestamp, active, tool_name, tool_call_id, tool_calls) VALUES (?,?,?,?,?,?,?,?,?)',
  )
  ins.run(1, 's1', 'user', '調べて', now - 30, 1, null, null, null)
  ins.run(2, 's1', 'assistant', '', now - 20, 1, null, null, JSON.stringify({ c9: { name: 'web_search', args: { query: 'pwa pagination' } } }))
  ins.run(3, 's1', 'tool', '結果', now - 10, 1, null, 'c9', null)
  db.close()
  return dbPath
}

test('user/assistant のみ、active=1・非空だけを古い順で返す', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixture() })
  const r = s.read('s1')
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.messages.map((m) => m.text),
    ['最初の質問', '回答1', '最後の回答'],
  )
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'assistant'],
  )
})

test('limit は新しい側から切り、古い順に直して返す', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixture() })
  const r = s.read('s1', { limit: 2 })
  assert.deepEqual(
    r.messages.map((m) => m.text),
    ['回答1', '最後の回答'],
  )
  assert.equal(r.hasMore, true)
})

test('before で過去に遡れる', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixture() })
  const r = s.read('s1', { before: 6 })
  assert.deepEqual(
    r.messages.map((m) => m.text),
    ['最初の質問', '回答1'],
  )
})

test('別セッションは混ざらない', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixture() })
  const r = s.read('s2')
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].text, '別セッション')
})

test('session_id 無し・DBなしは ok:false', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixture() })
  assert.equal(s.read('').ok, false)
  const s2 = createTranscript({ home: '/nonexistent', stateDb: '/nonexistent/state.db' })
  const r = s2.read('s1')
  assert.equal(r.ok, false)
  assert.match(r.reason, /state\.db/)
  assert.equal(/[\u3040-\u30ff\u4e00-\u9fff]/.test(r.reason), false, `reason が英語になっていません: ${r.reason}`)
})

test('旧スキーマ（tool_* 列なし）でも後方互換で読める', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixture() })
  const r = s.read('s1', { includeTools: true })
  assert.equal(r.ok, true)
  const tool = r.messages.find((m) => m.role === 'tool')
  assert.equal(tool.text, 'ツール出力は出さない')
  assert.equal(tool.toolName, null)
  assert.equal(tool.toolArgs, null)
  assert.equal(typeof r.oldestId, 'number')
  assert.equal(r.oldestId, 1)
  assert.equal(r.hasMore, false)
})

test('tool_calls から toolName / toolArgs を復元する', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixtureModern() })
  const r = s.read('s1', { includeTools: true })
  assert.equal(r.ok, true)
  const byId = new Map(r.messages.map((m) => [m.id, m]))
  // 本文が空の assistant 行（id=2）は出ないが、その tool_calls は復元に使える
  assert.equal(byId.has(2), false)
  const tool1 = byId.get(3)
  assert.equal(tool1.toolName, 'terminal')
  assert.deepEqual(tool1.toolArgs, { command: 'npm run verify' })
  // tool_name 列がある場合はそちらが優先（引数は tool_calls から）
  const tool2 = byId.get(5)
  assert.equal(tool2.toolName, 'patch')
  assert.equal(tool2.toolArgs.path.length, 500)
  assert.equal(byId.get(1).toolName, null)
  assert.equal(byId.get(1).toolArgs, null)
})

test('oldestId と hasMore がページングで正確', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixtureModern() })
  const page1 = s.read('s1', { limit: 2, includeTools: true })
  assert.deepEqual(page1.messages.map((m) => m.id), [5, 6])
  assert.equal(page1.oldestId, 5)
  assert.equal(page1.hasMore, true)

  const page2 = s.read('s1', { limit: 2, before: page1.oldestId, includeTools: true })
  assert.deepEqual(page2.messages.map((m) => m.id), [3, 4])
  assert.equal(page2.oldestId, 3)
  // まだ id=1 が残っているので hasMore は true
  assert.equal(page2.hasMore, true)

  const page3 = s.read('s1', { limit: 2, before: page2.oldestId, includeTools: true })
  assert.deepEqual(page3.messages.map((m) => m.id), [1])
  assert.equal(page3.oldestId, 1)
  assert.equal(page3.hasMore, false)
})

test('hasMore は件数ちょうどのとき false（厳密判定）', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixtureModern() })
  // s1 の user/assistant(/tool) 行は 5 件（id 1,3,4,5,6）
  const r = s.read('s1', { limit: 5, includeTools: true })
  assert.equal(r.messages.length, 5)
  assert.equal(r.hasMore, false)
  const r2 = s.read('s1', { limit: 4, includeTools: true })
  assert.equal(r2.messages.length, 4)
  assert.equal(r2.hasMore, true)
})

test('limit は 1000 で頭打ち・既定は 200', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixtureModern() })
  const big = s.read('s1', { limit: 99999, includeTools: true })
  assert.equal(big.ok, true)
  assert.equal(big.messages.length, 5)
  const def = s.read('s1', { limit: Number.NaN, includeTools: true })
  assert.equal(def.messages.length, 5)
})

test('object 形式の tool_calls も引数復元できる', () => {
  const s = createTranscript({ home: '/nonexistent', stateDb: fixtureObjectForm() })
  const r = s.read('s1', { includeTools: true })
  const tool = r.messages.find((m) => m.role === 'tool')
  assert.equal(tool.toolName, 'web_search')
  assert.deepEqual(tool.toolArgs, { query: 'pwa pagination' })
})

test('parseToolCalls は配列・単体・マップ・壊れた JSON を扱う', () => {
  assert.deepEqual(parseToolCalls([{ id: 'a', function: { name: 'n', arguments: '{"x":1}' } }]), [
    { id: 'a', name: 'n', args: { x: 1 } },
  ])
  assert.deepEqual(parseToolCalls({ id: 'b', name: 'm', args: { y: 2 } }), [{ id: 'b', name: 'm', args: { y: 2 } }])
  assert.deepEqual(parseToolCalls({ c: { tool_name: 't', arguments: { z: 3 } } }), [{ id: 'c', name: 't', args: { z: 3 } }])
  assert.deepEqual(parseToolCalls('not json'), [])
  assert.deepEqual(parseToolCalls(null), [])
})
