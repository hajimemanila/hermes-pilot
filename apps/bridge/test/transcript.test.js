import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTranscript } from '../src/transcript.js'

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
})
