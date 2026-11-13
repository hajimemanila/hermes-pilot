import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSearch, buildMatch, makeSnippet } from '../src/search.js'

test('buildMatch は全体をフレーズ引用し、二重引用符を無害化する', () => {
  assert.equal(buildMatch('ドレイン'), '"ドレイン"')
  assert.equal(buildMatch('a "b" c'), '"a ""b"" c"')
  assert.equal(buildMatch('  '), '')
  assert.equal(buildMatch(null), '')
  // 演算子を語として扱う（AND で分割されない）
  assert.equal(buildMatch('foo AND bar'), '"foo AND bar"')
})

test('makeSnippet はヒット位置の前後を切り出し、端に … を付ける', () => {
  const body = `${'あ'.repeat(100)}ドレイン解除${'い'.repeat(100)}`
  const s = makeSnippet(body, 'ドレイン解除', 10)
  assert.match(s, /^…/)
  assert.match(s, /…$/)
  assert.ok(s.includes('ドレイン解除'))
  assert.ok(s.length < 40)
})

test('makeSnippet はヒットが無ければ先頭を返し、空なら空', () => {
  assert.equal(makeSnippet('', 'x'), '')
  const s = makeSnippet('短い本文', 'zzz', 4)
  assert.ok(s.startsWith('短い本文'))
})

test('makeSnippet は改行と連続空白を1つに畳む', () => {
  assert.equal(makeSnippet('a\n\n  b\tc', 'b', 10), 'a b c')
})

/** 本物と同じ形（messages + trigram FTS）の一時DBを作る。 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-search-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, source TEXT, chat_type TEXT, display_name TEXT
    );
    CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
      content, content='messages', content_rowid='id', tokenize='trigram'
    );
    INSERT INTO sessions (id, title, source, chat_type) VALUES
      ('s1', 'ドレイン調査', 'discord', 'thread'),
      ('s2', 'PWA 実装', 'tui', '');
  `)
  const now = Date.now() / 1000
  const rows = [
    [1, 's1', 'user', 'メンテナンスでドレイン解除が必要になった', now - 100],
    [2, 's1', 'assistant', 'ドレイン解除は rm -f で行います', now - 90],
    [3, 's2', 'user', 'PWA の検索を実装したい', now - 80],
    [4, 's2', 'assistant', '検索は FTS で引きます', now - 70],
  ]
  const ins = db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)')
  for (const r of rows) ins.run(...r)
  db.exec("INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES ('rebuild')")
  db.close()
  return dbPath
}

test('trigram 検索で日本語の部分一致が引ける', () => {
  const dbPath = fixture()
  const s = createSearch({ home: '/nonexistent', stateDb: dbPath })
  const r = s.search({ q: 'ドレイン' })
  assert.equal(r.ok, true)
  assert.equal(r.total, 2)
  assert.equal(r.hits[0].sessionTitle, 'ドレイン調査')
  assert.equal(r.hits[0].source, 'discord')
  assert.ok(r.hits[0].snippet.includes('ドレイン'))
  assert.equal(typeof r.tookMs, 'number')
})

test('3文字未満は LIKE に落ちて検索できる', () => {
  const dbPath = fixture()
  const s = createSearch({ home: '/nonexistent', stateDb: dbPath })
  const r = s.search({ q: 'PWA' }) // 3文字 → trigram
  assert.equal(r.ok, true)
  assert.ok(r.total >= 1)
  const r2 = s.search({ q: '検索' }) // 2文字 → LIKE
  assert.equal(r2.ok, true)
  assert.ok(r2.total >= 1)
})

test('limit と hours が効く', () => {
  const dbPath = fixture()
  const s = createSearch({ home: '/nonexistent', stateDb: dbPath })
  const r = s.search({ q: 'ドレイン', limit: 1 })
  assert.equal(r.hits.length, 1)
  // 直近1時間 → フィクスチャは約100秒前なので両方入る
  const r2 = s.search({ q: 'ドレイン', hours: 1 })
  assert.equal(r2.total, 2)
  // ごく狭い窓（0.36秒）→ 何も入らない
  const r3 = s.search({ q: 'ドレイン', hours: 0.0001 })
  assert.equal(r3.total, 0)
})

test('空クエリ・DBなしは ok:false で理由を返す', () => {
  const s = createSearch({ home: '/nonexistent', stateDb: fixture() })
  assert.equal(s.search({ q: '  ' }).ok, false)
  const s2 = createSearch({ home: '/nonexistent', stateDb: '/nonexistent/state.db' })
  const r = s2.search({ q: 'テスト' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /state\.db/)
})

test('FTS の構文エラーになる入力でも落ちない', () => {
  const s = createSearch({ home: '/nonexistent', stateDb: fixture() })
  for (const q of ['"', 'AND', 'a OR b', 'NEAR(', '-foo', '*']) {
    const r = s.search({ q })
    assert.equal(typeof r.ok, 'boolean', q)
  }
})

test('複数プロファイルの state.db を横断検索して profile を付与する', () => {
  const dbDefault = fixture()
  const dbMobile = fixture()
  const s = createSearch({ home: '/nonexistent', stateDb: dbDefault })
  const r = s.search({
    q: 'ドレイン',
    dbs: [
      { profile: 'default', path: dbDefault },
      { profile: 'mobile', path: dbMobile },
      { profile: 'sample-app', path: '/nonexistent/state.db' },
    ],
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 4)
  assert.deepEqual(
    r.hits.map((h) => h.profile).sort(),
    ['default', 'default', 'mobile', 'mobile'],
  )
})
