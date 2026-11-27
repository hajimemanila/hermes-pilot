/**
 * AP2-6 demo sequence tests for LiveRadar telemetry, Style Gacha remix echo,
 * and Q1/Q2 visualMock flick options in Demo mode.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { demoFetch } from '../src/demo/fetch.js'
import { demoQuestions } from '../src/demo/fixtures.js'
import { buildRadarSummary, projectRadarBlips } from '../src/lib/liveRadar.js'

test('AP2-6 demo: /api/live telemetry feeds LiveRadarCard blips and summary', async () => {
  await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { seedText: 'Demo Radar Build', board: 'mobile', autoStart: true, autopilot: true },
  })
  const live = await demoFetch('/api/live')
  const usage = await demoFetch('/api/usage?hours=24')
  const review = await demoFetch('/api/review')

  assert.equal(live.ok, true)
  assert.ok(Array.isArray(live.telemetry?.recentTools))
  assert.ok(live.telemetry.recentTools.length >= 4)
  assert.ok(live.telemetry.toolCount > 0)

  const blips = projectRadarBlips(live)
  assert.ok(blips.length >= 4)
  const summary = buildRadarSummary({ live, usage, reviewItems: review?.items || [] })
  assert.ok(summary.toolCount > 0)
  assert.ok(summary.feed.length >= 4)
})

test('AP2-6 demo: /api/review/:id/remix echoes stylePreset and demoQuestions includes Q1/Q2 visualMocks', async () => {
  const remixRes = await demoFetch('/api/review/t_demo_review/remix', {
    method: 'POST',
    body: { questionId: 'q1', reason: 'style_gacha', stylePreset: 'neon' },
  })
  assert.equal(remixRes.ok, true)
  assert.equal(remixRes.record.stylePreset, 'neon')

  const qs = demoQuestions()
  assert.ok(qs[0].options.every((o) => o.visualMock?.shot))
  assert.ok(qs[1].options.every((o) => o.visualMock?.shot))
})
