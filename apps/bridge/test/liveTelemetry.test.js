/**
 * AP2-3 tests for `/api/live` tool history telemetry (`recentTools`, `toolCount`, `telemetry`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RECENT_TOOLS_LIMIT, createLive } from '../src/live.js'

function makeTelemetryFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-live-telemetry-'))
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, chat_type TEXT,
      last_activity_description TEXT, last_activity_at REAL);
    CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      tool_name TEXT, timestamp REAL);
  `)
  const now = Date.now() / 1000
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
    's_tel',
    'Autopilot Telemetry',
    'cli',
    '',
    'render-mocks',
    now,
  )
  db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
    's_tel',
    'pid=10:turn=t1:platform=local',
    now - 120,
    now + 240,
  )
  const ins = db.prepare(
    'INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)',
  )
  const tools = ['read_file', 'grep_search', 'write_file', 'terminal', 'render_mocks', 'vision_analyze', 'edit_file', 'kanban_create']
  tools.forEach((tool, idx) => {
    ins.run('s_tel', 'assistant', `step ${idx + 1}`, tool, now - (tools.length - idx) * 5)
  })
  ins.run('s_tel', 'user', 'go', null, now - 1)
  db.close()
  return { dir, dbPath }
}

test('AP2-3: live snapshot includes recentTools (limit 6), toolCount (8), and top-level telemetry', () => {
  const { dir, dbPath } = makeTelemetryFixture()
  try {
    const live = createLive(
      { home: '/nonexistent', stateDb: dbPath },
      { boards: () => [], tasks: () => [] },
    )
    const snap = live.snapshot({
      architect: [{ id: 'arch-1', status: 'running', phase: 'round1_sheet', startedAt: Date.now() - 5000 }],
    })

    assert.equal(RECENT_TOOLS_LIMIT, 6)
    assert.equal(snap.ok, true)
    assert.equal(snap.turns.length, 1)
    const turn = snap.turns[0]
    assert.equal(turn.recentTools.length, 6)
    assert.equal(turn.toolCount, 8)
    assert.equal(turn.lastTool.name, 'kanban_create')
    assert.equal(turn.recentTools[0].name, 'kanban_create')
    assert.equal(turn.recentTools[5].name, 'write_file')

    assert.equal(snap.telemetry.toolCount, 8)
    assert.equal(snap.telemetry.activeTurns, 1)
    assert.equal(snap.telemetry.activeTasks, 0)
    assert.equal(snap.telemetry.phaseLabel, 'round1_sheet')
    assert.equal(snap.telemetry.recentTools.length, 6)
    assert.equal(snap.telemetry.recentTools[0].name, 'kanban_create')
    assert.equal(snap.telemetry.recentTools[0].sessionId, 's_tel')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AP3-1: live snapshot computes runTokens and cacheHitPct when sessions token columns exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-live-runtokens-'))
  try {
    const dbPath = path.join(dir, 'state.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, chat_type TEXT,
        last_activity_description TEXT, last_activity_at REAL,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL);
      CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
        tool_name TEXT, timestamp REAL);
    `)
    const now = Date.now() / 1000
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      's_tok',
      'Autopilot Run',
      'cli',
      '',
      'editing UI',
      now,
      14200,
      4200,
      11600,
      0.042,
    )
    db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
      's_tok',
      'pid=11:turn=t2:platform=local',
      now - 45,
      now + 255,
    )
    db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)').run(
      's_tok',
      'assistant',
      'edit',
      'edit_file',
      now - 4,
    )
    db.close()

    const live = createLive(
      { home: '/nonexistent', stateDb: dbPath },
      { boards: () => [], tasks: () => [] },
    )
    const snap = live.snapshot()
    assert.equal(snap.ok, true)
    assert.equal(snap.turns[0].tokens.total, 18400)
    assert.equal(snap.telemetry.runTokens, 18400)
    assert.equal(snap.telemetry.runCacheRead, 11600)
    assert.equal(snap.telemetry.cacheHitPct, 39)
    assert.equal(snap.telemetry.activeWorkers, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('live snapshot with since accumulates finished and active sessions since Autopilot start and starts at 0 before sessions exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-live-since-'))
  try {
    const dbPath = path.join(dir, 'state.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, chat_type TEXT,
        last_activity_description TEXT, started_at REAL, last_activity_at REAL,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL);
      CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
        tool_name TEXT, timestamp REAL);
    `)
    const nowSec = Date.now() / 1000
    const runStartMs = Math.round((nowSec - 120) * 1000)

    // Pre-run historical session (must be excluded)
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      's_old',
      'Old Run',
      'cli',
      '',
      'old',
      nowSec - 3600,
      nowSec - 3500,
      50000,
      10000,
      20000,
      0.5,
    )
    // Finished Round 1 session after run start (no lease anymore)
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      's_r1',
      'Round 1',
      'cli',
      '',
      'done',
      nowSec - 110,
      nowSec - 80,
      6000,
      2000,
      4000,
      0.02,
    )
    // Active worker session with lease
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      's_w1',
      'Worker 1',
      'cli',
      '',
      'building',
      nowSec - 40,
      nowSec - 2,
      8000,
      2500,
      5000,
      0.03,
    )
    db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(
      's_w1',
      'pid=12:turn=t3:platform=local',
      nowSec - 40,
      nowSec + 260,
    )
    db.close()

    const live = createLive(
      { home: '/nonexistent', stateDb: dbPath },
      { boards: () => [], tasks: () => [] },
    )
    const snap = live.snapshot({ since: runStartMs })
    assert.equal(snap.telemetry.runTokenScope, 'since')
    assert.equal(snap.telemetry.runTokens, 18500)
    assert.equal(snap.telemetry.runCacheRead, 9000)

    // Future `since` before any post-start session yields strictly 0 (pre-start sessions excluded)
    const futureSnap = live.snapshot({ since: Date.now() + 60_000 })
    assert.equal(futureSnap.telemetry.runTokenScope, 'since')
    assert.equal(futureSnap.telemetry.runTokens, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
