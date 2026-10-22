import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createUsage } from '../src/usage.js'
import { fmtCost, fmtTokens, fmtPct } from '../../web/src/lib/format.js'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-usage-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, source TEXT, last_activity_at REAL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL,
      api_call_count INTEGER, message_count INTEGER, tool_call_count INTEGER
    );
    CREATE TABLE session_model_usage (
      session_id TEXT, model TEXT, last_seen REAL, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL, api_call_count INTEGER
    );
  `)
  const now = Date.now() / 1000
  const s = db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  s.run('s1', 'A', 'discord', now - 60, 1000, 500, 9000, 0, 0, 0.5, 10, 20, 3)
  s.run('s2', 'B', 'tui', now - 120, 2000, 800, 1000, 0, 0, 1.5, 20, 40, 6)
  s.run('s3', 'C', 'tui', now - 3600 * 48, 9999, 9999, 9999, 0, 0, 9.9, 99, 99, 9) // 期間外
  const m = db.prepare('INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?)')
  m.run('s1', 'deepseek-flash', now - 60, 1000, 500, 9000, 0.5, 10)
  m.run('s2', 'deepseek-flash', now - 120, 2000, 800, 1000, 1.5, 20)
  m.run('s2', 'other-model', now - 120, 100, 50, 0, 0.2, 2)
  m.run('s3', 'deepseek-flash', now - 3600 * 48, 9999, 9999, 9999, 9.9, 99) // 期間外
  db.close()
  return dbPath
}

test('24h の合計は期間外を除く', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: fixture() })
  const d = u.summary({ hours: 24 })
  assert.equal(d.ok, true)
  assert.equal(d.totals.sessions, 2)
  assert.equal(d.totals.input, 3000)
  assert.equal(d.totals.output, 1300)
  assert.equal(d.totals.cacheRead, 10000)
  assert.equal(d.totals.cost, 2)
  assert.equal(d.totals.calls, 30)
})

test('キャッシュ率は cacheRead/(input+cacheRead)', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: fixture() })
  const d = u.summary({ hours: 24 })
  assert.ok(Math.abs(d.cacheHitRate - 10000 / 13000) < 1e-9)
})

test('モデル別はコスト降順、期間外は入らない', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: fixture() })
  const d = u.summary({ hours: 24 })
  assert.equal(d.models.length, 2)
  assert.equal(d.models[0].model, 'deepseek-flash')
  assert.equal(d.models[0].cost, 2)
  assert.equal(d.models[1].model, 'other-model')
})

test('コスト上位セッションは5件まで・降順', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: fixture() })
  const d = u.summary({ hours: 24 })
  assert.equal(d.topSessions[0].id, 's2')
  assert.equal(d.topSessions[0].cost, 1.5)
  assert.ok(d.topSessions.length <= 5)
})

test('30秒キャッシュが効く（同じ結果を返す）', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: fixture() })
  const a = u.summary({ hours: 24 })
  const b = u.summary({ hours: 24 })
  assert.equal(a, b)
})

test('DBなしは ok:false', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: '/nonexistent/state.db' })
  const d = u.summary({ hours: 24 })
  assert.equal(d.ok, false)
  assert.match(d.reason, /state\.db/)
})

test('表示フォーマット', () => {
  assert.equal(fmtCost(0), '$0')
  assert.equal(fmtCost(1.6123), '$1.61')
  assert.equal(fmtCost(0.1234), '$0.123')
  assert.equal(fmtCost(0.0042), '$0.0042')
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(842), '842')
  assert.equal(fmtTokens(12345), '12.3k')
  assert.equal(fmtTokens(1970181), '1.97M')
  assert.equal(fmtTokens(257902208), '257.90M')
  assert.equal(fmtPct(0.992), '99.2%')
  assert.equal(fmtPct(0.99999), '100%')
  assert.equal(fmtPct(null), '—')
})

test('モデル別はセッションと同じ窓で数える（合計は別会計なので一致を強制しない）', () => {
  const u = createUsage({ home: '/nonexistent', stateDb: fixture() })
  const d = u.summary({ hours: 24 })
  // 期間外セッション(s3)のモデル行は入らない
  const models = d.models.map((m) => m.model)
  assert.deepEqual(models.sort(), ['deepseek-flash', 'other-model'])
  // モデル別は API 呼び出し記録の集計で、セッションの見積りとは一致しないことがある
  assert.ok(d.models.every((m) => m.cost > 0))
})
