/**
 * AP2-6 demo sequence tests for LiveRadar telemetry, Style Gacha remix echo,
 * and Q1/Q2 visualMock flick options in Demo mode.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { demoFetch, resetDemoState, setDemoTick, snapshot } from '../src/demo/mockApi.js'
import { demoQuestions } from '../src/demo/fixtures.js'
import { projectStudioStage } from '../src/lib/autopilotDeck.js'
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

test('DEMO-FIX-1: answering t_demo_review immediately activates Architect & Live telemetry', async () => {
  resetDemoState()
  setDemoTick(25)
  const ans = await demoFetch('/api/review/t_demo_review/answer', {
    method: 'POST',
    body: { answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', choice: 'A' }, { id: 'q3', choice: 'A' }] },
  })
  assert.equal(ans.ok, true)
  const [live, jobsRes, boardRes] = await Promise.all([
    demoFetch('/api/live'),
    demoFetch('/api/architect/jobs?board=mobile'),
    demoFetch('/api/boards/mobile/tasks?limit=60'),
  ])
  const j0 = jobsRes.jobs.find((j) => j.id === 'j_demo_0')
  assert.equal(j0.status, 'awaiting_spec')
  assert.equal(j0.phase, 'round2_spec')
  assert.ok(live.turns.length >= 1)
  assert.ok(live.tasks.some((t) => t.id === 't_demo_arch_0'))
  assert.ok(live.telemetry.recentTools.length >= 4)

  const stage = projectStudioStage({
    cards: [],
    jobs: jobsRes.jobs,
    live,
    tasks: boardRes.tasks,
    reviewItems: [],
  })
  assert.equal(stage.act, 'live')
  await new Promise((r) => setTimeout(r, 120))
})

test('DEMO-FIX-2: completing Autopilot deck answers launches parallel workers immediately into act=live', async () => {
  resetDemoState()
  setDemoTick(50)
  await demoFetch('/api/review/t_demo_review/answer', {
    method: 'POST',
    body: { answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', choice: 'A' }, { id: 'q3', choice: 'A' }] },
  })
  await demoFetch('/api/review/t_demo_visual/answer', {
    method: 'POST',
    body: { answers: [{ id: 'visual', choice: 'A' }] },
  })
  assert.equal(snapshot().progress.review, true)
  assert.equal(snapshot().progress.visual, true)
  assert.equal(snapshot().progress.batches, true)

  const [live, jobsRes, boardRes, reviewRes] = await Promise.all([
    demoFetch('/api/live'),
    demoFetch('/api/architect/jobs?board=mobile'),
    demoFetch('/api/boards/mobile/tasks?limit=60'),
    demoFetch('/api/review'),
  ])
  assert.equal(reviewRes.items.filter((x) => x.status === 'blocked').length, 0)
  assert.equal(live.tasks.filter((t) => t.assignee !== 'architect').length, 2)
  assert.ok(live.tasks.length >= 2)
  assert.equal(live.turns.length, 2)

  const stage = projectStudioStage({
    cards: [],
    jobs: jobsRes.jobs,
    live,
    tasks: boardRes.tasks,
    reviewItems: reviewRes.items,
  })
  assert.equal(stage.act, 'live')
  assert.ok(stage.runningCount >= 2)
  assert.equal(stage.totalCount, 3)
  await new Promise((r) => setTimeout(r, 400))
})

test('DEMO-FIX-3: Cockpit launching a spec_ready seeded SPEC marks job launched & queues interview review', async () => {
  resetDemoState()
  setDemoTick(5)
  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Cockpit batch interview test', runner: 'hermes', autoStart: false, lang: 'en' },
  })
  await new Promise((r) => setTimeout(r, 60))
  const jobsBefore = await demoFetch('/api/architect/jobs?board=mobile')
  const job = jobsBefore.jobs.find((j) => j.id === seed.jobId)
  assert.equal(job.status, 'spec_ready')

  const launch = await demoFetch('/api/specs/launch', {
    method: 'POST',
    body: {
      board: 'mobile',
      specRelPath: job.completedSpec.path,
      batchIds: job.completedSpec.batches.map((b) => b.id),
    },
  })
  assert.equal(launch.ok, true)
  assert.equal(launch.created.length, 2)

  const [jobsAfter, reviewAfter, boardAfter] = await Promise.all([
    demoFetch('/api/architect/jobs?board=mobile'),
    demoFetch('/api/review'),
    demoFetch('/api/boards/mobile/tasks?limit=60'),
  ])
  assert.equal(jobsAfter.jobs.find((j) => j.id === seed.jobId).status, 'launched')
  assert.ok(boardAfter.tasks.every((t) => !t.title.startsWith('[SEED') || t.spec === job.completedSpec.path))
  const reviewItem = reviewAfter.items.find((x) => x.id.startsWith('t_demo_review_seed') && x.status === 'blocked')
  assert.ok(reviewItem, 'Cockpit launch should file blocked interview sheet into Review')
  assert.equal(reviewItem.review.mode, 'standard')
  await new Promise((r) => setTimeout(r, 60))
})

test('DEMO-FIX-4: Autopilot seed pauses at awaiting_review and launches batches once answered', async () => {
  resetDemoState()
  setDemoTick(15)
  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Autopilot seed cycle', runner: 'hermes', autoStart: true, autopilot: true, lang: 'en' },
  })
  await new Promise((r) => setTimeout(r, 50))
  const jobs1 = await demoFetch('/api/architect/jobs?board=mobile')
  const job1 = jobs1.jobs.find((j) => j.id === seed.jobId)
  assert.equal(job1.status, 'awaiting_review')
  assert.ok(job1.reviewTaskId)

  const review1 = await demoFetch('/api/review')
  assert.ok(review1.items.some((x) => x.id === job1.reviewTaskId && x.status === 'blocked'))

  await demoFetch(`/api/review/${job1.reviewTaskId}/answer`, {
    method: 'POST',
    body: { answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', choice: 'A' }, { id: 'q3', choice: 'A' }] },
  })
  const liveImmediately = await demoFetch('/api/live')
  assert.ok(liveImmediately.turns.length >= 1)

  await new Promise((r) => setTimeout(r, 120))
  const jobs2 = await demoFetch('/api/architect/jobs?board=mobile')
  const job2 = jobs2.jobs.find((j) => j.id === seed.jobId)
  assert.equal(job2.status, 'launched')
})
