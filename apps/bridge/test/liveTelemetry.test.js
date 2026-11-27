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
