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
import { computeStudioProgress } from '../src/lib/autopilot/studio.js'

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

test('AP3-2: buildRadarSummary aggregates usage.totals.input+output and prioritizes runTokens', () => {
  const fromUsage = buildRadarSummary({
    usage: { totals: { input: 12000, output: 3000, cacheRead: 5000 } },
  })
  assert.equal(fromUsage.tokenMode, '24h')
  assert.equal(fromUsage.tokenTotal, 15000)
  assert.equal(fromUsage.tokenLabel, '15.0k')

  const fromRun = buildRadarSummary({
    live: {
      counts: { turns: 1, tasks: 1 },
      telemetry: { runTokens: 18400, cacheHitPct: 37, recentTools: [{ name: 'edit_file', at: 1000 }] },
    },
    usage: { totals: { input: 12000, output: 3000 } },
    now: 5000,
  })
  assert.equal(fromRun.tokenMode, 'run')
  assert.equal(fromRun.runTokens, 18400)
  assert.equal(fromRun.tokenLabel, '18.4k')
  assert.equal(fromRun.cacheHitPct, 37)
})

test('AP3-2: computeStudioProgress progresses monotonically from Design to Finish', () => {
  const p0 = computeStudioProgress({ phase: 'spawning', totalCount: 0 })
  const p1 = computeStudioProgress({ phase: 'round1_sheet', totalCount: 0 })
  const p2 = computeStudioProgress({ phase: 'round2_spec', totalCount: 0 })
  const p3 = computeStudioProgress({ phase: 'launched', doneCount: 0, runningCount: 1, totalCount: 4 })
  const p4 = computeStudioProgress({ phase: 'launched', doneCount: 2, runningCount: 1, totalCount: 4 })
  const p5 = computeStudioProgress({ phase: 'launched', doneCount: 3, runningCount: 1, totalCount: 4 })
  const p6 = computeStudioProgress({ phase: 'launched', doneCount: 4, runningCount: 0, totalCount: 4 })

  const seq = [p0.progressPct, p1.progressPct, p2.progressPct, p3.progressPct, p4.progressPct, p5.progressPct, p6.progressPct]
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] >= seq[i - 1], `Progress dropped from ${seq[i - 1]} to ${seq[i]} at index ${i}`)
  }
  assert.equal(p0.stepIndex, 0)
  assert.equal(p3.stepIndex, 1)
  assert.equal(p5.stepIndex, 2)
  assert.equal(p6.stepIndex, 3)
  assert.equal(p6.progressPct, 92)
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
