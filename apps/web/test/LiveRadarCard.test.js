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
  DEMO_RADAR_SEQUENCE,
  RADAR_SIZE,
  RADAR_STATIONS,
  WORKER_PALETTE,
  buildRadarSummary,
  classifyToolRing,
  computePupilOffset,
  contextHealthTone,
  formatCompactTokens,
  formatCostUsd,
  formatDurationMs,
  projectRadarBlips,
  summarizeCommandIntent,
  toolToStation,
} from '../src/lib/liveRadar.js'
import { computeStudioProgress, formatElapsedClock, projectStudioStage } from '../src/lib/autopilot/studio.js'

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

test('runTracked summary starts at 0 without 24h fallback, keeps minRunTokens across gaps, and scopes stage progress to current run', () => {
  const atStart = buildRadarSummary({
    live: { counts: { turns: 0, tasks: 0 }, telemetry: { runTokens: 0 } },
    usage: { totals: { input: 900_000, output: 300_000 } },
    runTracked: true,
    minRunTokens: 0,
  })
  assert.equal(atStart.tokenMode, 'run')
  assert.equal(atStart.runTokens, 0)
  assert.equal(atStart.tokenLabel, '0')

  const afterInterviewGap = buildRadarSummary({
    live: { counts: { turns: 0, tasks: 0 }, telemetry: { runTokens: 0 } },
    usage: { totals: { input: 900_000, output: 300_000 } },
    runTracked: true,
    minRunTokens: 18400,
  })
  assert.equal(afterInterviewGap.tokenMode, 'run')
  assert.equal(afterInterviewGap.runTokens, 18400)
  assert.equal(afterInterviewGap.tokenLabel, '18.4k')

  assert.equal(formatElapsedClock(0), '00:00')
  assert.equal(formatElapsedClock(261_000), '04:21')
  assert.equal(formatElapsedClock(3_735_000), '1:02:15')

  const runStart = 1_700_000_000_000
  const stage = projectStudioStage({
    runStartedAt: runStart,
    jobs: [{ id: 'j1', status: 'running', phase: 'spawning', createdAt: runStart }],
    tasks: [
      { id: 'old1', title: 'Old done 1', status: 'done', createdAt: runStart - 3_600_000 },
      { id: 'old2', title: 'Old done 2', status: 'done', createdAt: runStart - 1_800_000 },
      { id: 'arch1', title: '[ARCH] New app', status: 'running', assignee: 'architect', createdAt: runStart },
    ],
  })
  assert.equal(stage.act, 'live')
  assert.equal(stage.doneCount, 0)
  assert.equal(stage.totalCount, 0)
  assert.equal(stage.runStartedAt, runStart)
  assert.ok(stage.progressPct < 20)
})

test('PN-2: toolToStation maps all 8 orbital stations, health ring tones, durations, pupil offset, errors, and Demo sequence', () => {
  assert.equal(RADAR_STATIONS.length, 8)
  assert.equal(toolToStation('quick_review'), 'you')
  assert.equal(toolToStation('edit_file'), 'files')
  assert.equal(toolToStation('terminal'), 'shell')
  assert.equal(toolToStation('web_search'), 'web')
  assert.equal(toolToStation('render_mocks'), 'browser')
  assert.equal(toolToStation('kanban_create'), 'agents')
  assert.equal(toolToStation('memory_recall'), 'memory')
  assert.equal(toolToStation('custom_tool'), 'tools')

  assert.equal(contextHealthTone(42), 'ok')
  assert.equal(contextHealthTone(70), 'warn')
  assert.equal(contextHealthTone(91), 'danger')

  assert.equal(formatDurationMs(420), '420 ms')
  assert.equal(formatDurationMs(1820), '1.8 s')
  assert.equal(formatCostUsd(0.08), '$0.08')

  const top = RADAR_STATIONS.find((s) => s.id === 'you')
  const p = computePupilOffset(top, 7)
  assert.equal(p.dx, 0)
  assert.equal(p.dy, -7)

  const errSummary = buildRadarSummary({
    now: 50_000,
    live: {
      counts: { turns: 1, tasks: 1 },
      telemetry: {
        contextPct: 75,
        cacheHitPct: 99,
        runCostUsd: 0.08,
        toolHistory: [
          { name: 'terminal', at: 49_000, durationMs: 1800, failed: true, errorTail: 'exit code 1' },
          { name: 'edit_file', at: 45_000, durationMs: 320, failed: false },
          { name: 'read_file', at: 41_000, durationMs: 140, failed: false },
        ],
      },
    },
  })
  assert.equal(errSummary.eye.tone, 'warn')
  assert.equal(errSummary.eye.costLabel, '$0.08')
  const shellSt = errSummary.stations.find((s) => s.id === 'shell')
  const filesSt = errSummary.stations.find((s) => s.id === 'files')
  assert.equal(shellSt.hasError, true)
  assert.equal(shellSt.latestError.errorTail, 'exit code 1')
  assert.ok(filesSt.strokeWidth > shellSt.strokeWidth)

  assert.equal(DEMO_RADAR_SEQUENCE.length, 4)
  const step0 = buildRadarSummary({ now: 0, live: { demo: true, telemetry: { demoSequence: true } } })
  const step1 = buildRadarSummary({ now: 1500, live: { demo: true, telemetry: { demoSequence: true } } })
  const step2 = buildRadarSummary({ now: 3000, live: { demo: true, telemetry: { demoSequence: true } } })
  const step3 = buildRadarSummary({ now: 4500, live: { demo: true, telemetry: { demoSequence: true } } })
  assert.equal(step0.eye.activeStationId, 'files')
  assert.equal(step1.eye.activeStationId, 'shell')
  assert.equal(step2.eye.activeStationId, 'browser')
  assert.equal(step3.eye.activeStationId, 'you')
})

test('XR-2: summarizeCommandIntent, multi-worker separation, fileChanges, and queuedNudges light up YOU pin', () => {
  assert.equal(WORKER_PALETTE.length, 3)
  assert.equal(summarizeCommandIntent('npm run build --styles'), 'autopilot.radar.cmdIntentStyle')
  assert.equal(summarizeCommandIntent('node --test apps/web/test/*.test.js'), 'autopilot.radar.cmdIntentTest')
  assert.equal(summarizeCommandIntent('npx vite build'), 'autopilot.radar.cmdIntentBuild')

  const summary = buildRadarSummary({
    now: 20_000,
    live: {
      counts: { turns: 2, tasks: 2 },
      turns: [
        { sessionId: 's1', title: 'UI', lastTool: { name: 'edit_file' } },
        { sessionId: 's2', title: 'Check', lastTool: { name: 'render_mocks' } },
      ],
      telemetry: {
        activeWorkers: 2,
        fileChanges: { items: [{ file: 'detail.css', added: 18, removed: 4 }], fileCount: 1, totalAdded: 18, totalRemoved: 4 },
        toolHistory: [
          { name: 'edit_file', at: 19_000, filePath: 'detail.css', addedLines: 18, removedLines: 4 },
          { name: 'terminal', at: 17_000, command: 'npm run build --styles' },
        ],
      },
    },
    nudges: [
      { id: 'n1', text: 'Make header bigger', status: 'queued', at: 18_000 },
      { id: 'n2', text: 'Old nudge', status: 'applied', at: 10_000 },
    ],
  })

  assert.equal(summary.workers.length, 2)
  assert.equal(summary.workers[0].colorKey, 'w1')
  assert.equal(summary.workers[0].stationId, 'files')
  assert.equal(summary.workers[1].colorKey, 'w2')
  assert.equal(summary.workers[1].stationId, 'browser')

  const youSt = summary.stations.find((s) => s.id === 'you')
  assert.equal(youSt.hasNudgePin, true)
  assert.equal(youSt.nudgeCount, 1)
  assert.equal(youSt.attention, true)

  const filesSt = summary.stations.find((s) => s.id === 'files')
  assert.equal(filesSt.workerBadge, 'W1')
  assert.equal(filesSt.latestTool.filePath, 'detail.css')
  assert.equal(summary.fileChanges.totalAdded, 18)

  const shellSt = summary.stations.find((s) => s.id === 'shell')
  assert.equal(shellSt.latestTool.commandIntentKey, 'autopilot.radar.cmdIntentStyle')
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
