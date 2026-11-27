/**
 * AP2-5 unit & architectural guard tests for LiveRadarCard, liveRadar projection,
 * BeforeAfterTimelapse, sync-owner isolation, and i18n parity.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RADAR_SIZE,
  buildRadarSummary,
  classifyToolRing,
  formatCompactTokens,
  projectRadarBlips,
} from '../src/lib/liveRadar.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('classifyToolRing assigns core, verify, and explore rings accurately', () => {
  assert.equal(classifyToolRing('edit_file'), 'core')
  assert.equal(classifyToolRing('write_file'), 'core')
  assert.equal(classifyToolRing('vite_build'), 'core')
  assert.equal(classifyToolRing('render_mocks'), 'verify')
  assert.equal(classifyToolRing('vision_analyze'), 'verify')
  assert.equal(classifyToolRing('run_tests'), 'verify')
  assert.equal(classifyToolRing('read_file'), 'explore')
  assert.equal(classifyToolRing('grep_search'), 'explore')
})

test('projectRadarBlips caps at 6 deterministic blips inside 0..220', () => {
  const now = 1_000_000
  const recentTools = [
    'kanban_create',
    'edit_file',
    'render_mocks',
    'vision_analyze',
    'read_file',
    'grep_search',
    'terminal',
  ].map((name, idx) => ({ name, at: now - idx * 5000 }))

  const blips = projectRadarBlips({ telemetry: { recentTools } }, { now })
  assert.equal(blips.length, 6)
  assert.equal(blips[0].isLatest, true)
  assert.equal(blips[1].isLatest, false)
  for (const b of blips) {
    assert.ok(b.cx >= 0 && b.cx <= RADAR_SIZE, `cx out of bounds: ${b.cx}`)
    assert.ok(b.cy >= 0 && b.cy <= RADAR_SIZE, `cy out of bounds: ${b.cy}`)
  }
})

test('formatCompactTokens formats counts concisely', () => {
  assert.equal(formatCompactTokens(0), '0')
  assert.equal(formatCompactTokens(950), '950')
  assert.equal(formatCompactTokens(1480), '1.5k')
  assert.equal(formatCompactTokens(1_250_000), '1.3M')
})

test('buildRadarSummary aggregates live, usage, and reviewWaiting snapshots', () => {
  const now = 2_000_000
  const summary = buildRadarSummary({
    now,
    live: {
      counts: { turns: 1, tasks: 2, architect: 1 },
      telemetry: {
        phaseLabel: 'running',
        toolCount: 14,
        recentTools: [
          { name: 'render_mocks', at: now - 2000 },
          { name: 'edit_file', at: now - 7000 },
          { name: 'vision_analyze', at: now - 12000 },
          { name: 'read_file', at: now - 18000 },
          { name: 'terminal', at: now - 25000 },
        ],
      },
    },
    usage: { totals: { totalTokens: 42_500 } },
    reviewItems: [
      { id: 'r1', status: 'blocked' },
      { id: 'r2', status: 'done' },
      { id: 'r3', status: 'blocked' },
    ],
  })

  assert.equal(summary.activeWorkers, 3)
  assert.equal(summary.toolCount, 14)
  assert.equal(summary.waitingCount, 2)
  assert.equal(summary.tokenLabel, '42.5k')
  assert.equal(summary.phaseLabel, 'running')
  assert.equal(summary.blips.length, 5)
  assert.equal(summary.feed.length, 4)
})

test('LiveRadarCard & BeforeAfterTimelapse obey sync-owner and zero-chart-lib guards', () => {
  const radarSrc = fs.readFileSync(
    path.join(ROOT, 'apps', 'web', 'src', 'features', 'autopilot', 'LiveRadarCard.jsx'),
    'utf8',
  )
  const tlSrc = fs.readFileSync(
    path.join(ROOT, 'apps', 'web', 'src', 'features', 'autopilot', 'BeforeAfterTimelapse.jsx'),
    'utf8',
  )

  assert.match(radarSrc, /subscribeSync\(['"]live['"]/)
  assert.match(radarSrc, /subscribeSync\(['"]usage['"]/)
  assert.match(radarSrc, /subscribeSync\(['"]reviewWaiting['"]/)
  assert.match(radarSrc, /viewBox=\{`0 0 \$\{RADAR_SIZE\} \$\{RADAR_SIZE\}`\}/)

  for (const src of [radarSrc, tlSrc]) {
    assert.doesNotMatch(src, /setInterval/)
    assert.doesNotMatch(src, /\bfetch\s*\(/)
    assert.doesNotMatch(src, /\bapi\s*\(\s*['"]\/api\//)
    assert.doesNotMatch(src, /chart\.js|recharts|\bd3\b|echarts/i)
  }
})

test('AP2-5 i18n keys exist in both en.json and ja.json', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'i18n', 'en.json'), 'utf8'))
  const ja = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'i18n', 'ja.json'), 'utf8'))
  const keys = [
    'autopilot.radar.aria',
    'autopilot.radar.workers',
    'autopilot.radar.tools',
    'autopilot.radar.tokens',
    'autopilot.radar.waiting',
    'autopilot.radar.scanning',
    'autopilot.radar.ago',
    'autopilot.timelapse.aria',
    'autopilot.timelapse.before',
    'autopilot.timelapse.after',
    'autopilot.timelapse.play',
    'autopilot.timelapse.pause',
  ]
  for (const k of keys) {
    assert.ok(typeof en[k] === 'string' && en[k].length > 0, `Missing en.json key: ${k}`)
    assert.ok(typeof ja[k] === 'string' && ja[k].length > 0, `Missing ja.json key: ${k}`)
  }
})
