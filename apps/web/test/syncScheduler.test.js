/**
 * 定期同期の宣言表 + 1 本のスケジューラ（D106 / Batch `DRF-1`）の検証。
 *
 * ここで固定するのは 4 点:
 * 1. 間隔・停止規則・状況依存の間隔が**表 1 つ**で決まる
 * 2. **1 トピック 1 取得** — 購読が 2 本でも取得関数は 1 回だけ
 * 3. `enabledWhen`（状況で走らせない）と `everyMsOf`（状況で間隔を変える）が効く
 * 4. 取得が落ちても購読者全員へ error が届き、他のトピックは止まらない
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SYNC_TOPICS, createSyncScheduler, everyMsOf, isEnabled, shouldRun } from '../src/lib/syncScheduler.js'

/** async の配布（microtask）を待つ。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * mock timers を少しずつ進める。まとめて進めると、前 tick の取得がまだ in-flight のまま
 * 次の tick が来てしまい（実機では起きない）、回数がずれる。
 */
async function advance(t, ms, step = 1_000) {
  let left = ms
  while (left > 0) {
    const delta = Math.min(step, left)
    t.mock.timers.tick(delta)
    left -= delta
    await flush()
  }
}

/** 全トピックを購読したスケジューラと、取得回数・配布回数の記録。 */
function harness({ tab = 'chat', visible = true, topics = SYNC_TOPICS } = {}) {
  const state = { tab, visible }
  const delivered = []
  const fetched = []
  const sources = {}
  for (const topic of topics) {
    sources[topic.id] = async () => {
      fetched.push(topic.id)
      return { topic: topic.id }
    }
  }
  const scheduler = createSyncScheduler({
    topics,
    sources,
    isVisible: () => state.visible,
    currentTab: () => state.tab,
  })
  for (const topic of topics) {
    scheduler.subscribe(topic.id, (value, meta) => delivered.push({ id: topic.id, value, error: meta?.error ?? null }))
  }
  const count = (id) => delivered.filter((d) => d.id === id).length
  const fetchCount = (id) => fetched.filter((f) => f === id).length
  return { scheduler, state, delivered, fetched, count, fetchCount }
}

test('① 表どおりの間隔で 1 回ずつ取得し、購読者へ配る', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness()
  h.scheduler.start()

  await advance(t, 4_999)
  assert.equal(h.count('overview'), 0, '5 秒未満では overview は走らない')
  assert.equal(h.count('tasks'), 0, 'tasks は 5 秒')
  assert.equal(h.count('reports'), 0, 'reports は 15 秒')

  await advance(t, 1) // 5 秒
  assert.equal(h.count('overview'), 1)
  assert.equal(h.count('tasks'), 1, 'tasks は 5 秒')

  await advance(t, 10_000) // 15 秒
  assert.equal(h.count('overview'), 3, 'overview は 5 秒ごと')
  for (const id of ['reports', 'reviewWaiting', 'reviewFeed', 'inbox']) {
    assert.equal(h.count(id), 1, `${id} は 15 秒で 1 回`)
  }

  await advance(t, 45_000) // 60 秒
  for (const topic of SYNC_TOPICS) {
    if (typeof topic.everyMsOf === 'function' || typeof topic.enabledWhen === 'function') continue
    assert.equal(h.count(topic.id), Math.floor(60_000 / topic.everyMs), `${topic.id} の回数`)
  }

  h.scheduler.stop()
  await advance(t, 60_000)
  assert.equal(h.count('overview'), 12, 'stop 後は増えない')
})

test('② 購読が 2 本でも取得関数の呼び出しは 1 回（1 トピック 1 取得）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  const scheduler = createSyncScheduler({
    topics: [{ id: 'inbox', everyMs: 1_000 }],
    sources: {
      inbox: async () => {
        calls += 1
        return { items: [calls] }
      },
    },
    isVisible: () => true,
    currentTab: () => 'tasks',
  })
  const first = []
  const second = []
  scheduler.subscribe('inbox', (value) => first.push(value))
  scheduler.subscribe('inbox', (value) => second.push(value))
  assert.equal(scheduler.subscriberCount('inbox'), 2)

  scheduler.start()
  t.mock.timers.tick(1_000)
  await flush()
  assert.equal(calls, 1, '購読 2 本でも fetch は 1 回')
  assert.deepEqual(first, [{ items: [1] }], '1 本目の購読者へ同じ値')
  assert.deepEqual(second, [{ items: [1] }], '2 本目の購読者へも同じ値')

  // 手元の操作後の取り直しも 1 回で、両方へ届く
  const out = await scheduler.refresh('inbox')
  assert.equal(out.ok, true)
  assert.equal(calls, 2)
  assert.equal(first.length, 2)
  assert.equal(second.length, 2)
  scheduler.stop()
})

test('③ enabledWhen: 状況が整うまで走らせず、整った瞬間から走る（破棄はしない）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness()
  h.scheduler.start()

  await advance(t, 20_000)
  assert.equal(h.count('boards'), 0, 'boardsFailed=false の間は走らない')

  h.scheduler.setState({ boardsFailed: true, workActive: true })
  await advance(t, 5_000)
  assert.equal(h.count('boards'), 1, 'boardsFailed になったら再試行する')

  const before = h.count('coherence')
  await advance(t, 240_000)
  assert.equal(h.count('coherence'), before, 'workActive の間は 120 秒きても走らない')

  h.scheduler.setState({ workActive: false })
  await advance(t, 120_000)
  assert.ok(h.count('coherence') > before, '作業が終われば再開する')
  h.scheduler.stop()
})

test('④ everyMsOf: 状況で間隔を変え、変わったときだけ張り直す', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness()
  h.scheduler.start()

  assert.equal(h.scheduler.intervalOf('architectJobs'), 20_000, '既定は人待ち 20 秒')
  await advance(t, 40_000)
  assert.equal(h.count('architectJobs'), 2)

  h.scheduler.setState({ architectBusy: true })
  assert.equal(h.scheduler.intervalOf('architectJobs'), 4_000, '進行中は 4 秒へ張り直す')
  await advance(t, 12_000)
  assert.equal(h.count('architectJobs'), 5, '張り直した位相で 4 秒ごと')

  // 同じ状態をもう一度入れても張り直さない（位相を保つ）
  h.scheduler.setState({ architectBusy: true })
  assert.equal(h.scheduler.intervalOf('architectJobs'), 4_000)
  await advance(t, 4_000)
  assert.equal(h.count('architectJobs'), 6)
  h.scheduler.stop()
})

test('⑤ 画面が見えていない間は呼ばれない（戻ったら次の位相から）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness({ visible: false })
  h.scheduler.start()
  await advance(t, 120_000)
  assert.equal(h.delivered.length, 0, 'document.hidden 相当では 1 本も走らない')

  h.state.visible = true
  await advance(t, 5_000)
  assert.equal(h.count('overview'), 1, '戻ったら次の位相から走る')
  assert.equal(h.count('usage'), 0, '隠れていた 60 秒ぶんをまとめて走らせない')
  h.scheduler.stop()
})

test('⑥ forceAll は可視・タブを無視して 1 回ずつ、skip と enabledWhen を尊重する', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness({ tab: 'review', visible: false })
  h.scheduler.start()
  await advance(t, 30_000)
  assert.equal(h.delivered.length, 0)

  const ran = h.scheduler.forceAll({ skip: 'overview' })
  await flush()
  assert.equal(ran.includes('overview'), false, 'skip したトピックは走らない')
  assert.equal(ran.includes('boards'), false, 'enabledWhen を満たさないトピックは走らない')
  for (const topic of SYNC_TOPICS) {
    // `boards` / `taskDetail` / `taskDetailWorker` は状況が整っていないので走らない
    const blocked = ['overview', 'boards', 'taskDetail', 'taskDetailWorker'].includes(topic.id)
    if (blocked) assert.equal(h.count(topic.id), 0, `${topic.id} は走らない`)
    else assert.equal(h.count(topic.id), 1, `${topic.id} は 1 回`)
  }

  h.scheduler.forceAll({ skip: ['usage'] })
  await flush()
  assert.equal(h.count('usage'), 1, 'skip は配列でもよい')
  assert.equal(h.count('live'), 2)
  h.scheduler.stop()
})

test('⑦ 解除したら走らない・購読 0 でタイマーも止まる', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls = []
  const scheduler = createSyncScheduler({
    sources: { live: async () => ({}), usage: async () => ({}) },
  })
  const offLive = scheduler.subscribe('live', () => calls.push('live'))
  scheduler.subscribe('usage', () => calls.push('usage'))
  scheduler.start()
  await advance(t, 30_000)
  assert.equal(calls.filter((c) => c === 'live').length, 6)

  offLive()
  assert.equal(scheduler.intervalOf('live'), 0, '購読 0 になったタイマーは止まる')
  await advance(t, 30_000)
  assert.equal(calls.filter((c) => c === 'live').length, 6, '解除後は走らない')
  assert.equal(calls.filter((c) => c === 'usage').length, 1, '他の購読は影響を受けない')

  // 未知のトピック・関数でない購読は無害
  assert.equal(typeof scheduler.subscribe('nope', () => {}), 'function')
  assert.doesNotThrow(() => scheduler.subscribe('live', null))
  assert.equal(scheduler.tick('nope'), null)
  scheduler.stop()
})

test('⑧ 表の整合: トピックは重複せず、間隔はすべて正の値を持つ', () => {
  const ids = SYNC_TOPICS.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, 'id が重複しない')
  assert.equal(ids.length, 17, 'トピックは 17 本（ペインの取得タイマー 16 本 + worker 進捗の 1 本）')
  for (const topic of SYNC_TOPICS) {
    const ms = everyMsOf(topic, {})
    assert.ok(Number.isFinite(ms) && ms > 0, `${topic.id} の間隔`)
    if (typeof topic.everyMsOf === 'function') {
      assert.ok(Number.isFinite(topic.everyMsOf({ architectBusy: true })), `${topic.id} の状況依存間隔`)
    }
  }
  // 代表的な間隔（旧タイマーの値をそのまま表へ移したもの）
  const every = (id) => everyMsOf(SYNC_TOPICS.find((t) => t.id === id), {})
  assert.equal(every('tasks'), 5_000)
  assert.equal(every('inbox'), 15_000)
  assert.equal(every('live'), 5_000)
  assert.equal(every('specReports'), 30_000)
  assert.equal(every('usage'), 60_000)
  assert.equal(every('coherence'), 120_000)
  assert.equal(every('taskDetail'), 5_000)
  assert.equal(every('reviewDetail'), 5_000)
  assert.equal(every('workerFeed'), 4_000)
  // 状況で止まるトピックはこの 4 本だけ
  const gated = SYNC_TOPICS.filter((t) => typeof t.enabledWhen === 'function').map((t) => t.id)
  assert.deepEqual(gated.sort(), ['boards', 'coherence', 'taskDetail', 'taskDetailWorker'].sort())
  assert.equal(isEnabled(SYNC_TOPICS.find((t) => t.id === 'boards'), { boardsFailed: false }), false)
  assert.equal(isEnabled(SYNC_TOPICS.find((t) => t.id === 'tasks'), {}), true)
})

test('shouldRun は見えているか・タブ・enabledWhen だけを見る', () => {
  const taskDetail = SYNC_TOPICS.find((t) => t.id === 'taskDetail')
  assert.equal(shouldRun(taskDetail, { visible: true, state: { detailActive: true } }), true)
  assert.equal(shouldRun(taskDetail, { visible: true, state: { detailActive: false } }), false)
  assert.equal(shouldRun(taskDetail, { visible: false, state: { detailActive: true } }), false)
  assert.equal(shouldRun(null), false)
  // `pauseOnTabs` は規則としては残っている（タブで止めたいトピックを足したときに使う）
  assert.equal(shouldRun({ id: 'x', everyMs: 1000, pauseOnTabs: ['review'] }, { tab: 'review' }), false)
  assert.equal(shouldRun({ id: 'x', everyMs: 1000, pauseOnTabs: ['review'] }, { tab: 'chat' }), true)
})

test('⑨ wake(): 短時間の復帰連打を minGapMs で束ね、skip を尊重する', async () => {
  let clock = 10_000
  const sources = {}
  for (const topic of SYNC_TOPICS) sources[topic.id] = async () => null
  const scheduler = createSyncScheduler({ sources, now: () => clock })
  for (const topic of SYNC_TOPICS) scheduler.subscribe(topic.id, () => {})

  const first = scheduler.wake({ minGapMs: 2_500 })
  await flush()
  assert.ok(first.includes('overview'), '復帰シグナルでは overview も走る')
  assert.equal(first.includes('boards'), false, 'enabledWhen を満たさないものは走らない')

  clock += 1_000
  assert.deepEqual(scheduler.wake({ minGapMs: 2_500 }), [], 'スロットル窓内の連続イベントは無視する')

  clock += 1_500
  const third = scheduler.wake({ skip: 'overview', minGapMs: 2_500 })
  assert.equal(third.includes('overview'), false, '復帰時も skip を尊重する')
})

test('⑩ 取得が落ちても購読者全員へ error が届き、他のトピックは止まらない', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const errors = []
  const others = []
  const scheduler = createSyncScheduler({
    topics: [
      { id: 'tasks', everyMs: 1_000 },
      { id: 'inbox', everyMs: 1_000 },
    ],
    sources: {
      tasks: async () => {
        throw new Error('boom')
      },
      inbox: async () => ({ items: [] }),
    },
  })
  scheduler.subscribe('tasks', (value, meta) => errors.push({ value, error: meta.error }))
  scheduler.subscribe('tasks', (value, meta) => errors.push({ value, error: meta.error }))
  scheduler.subscribe('inbox', () => others.push('inbox'))
  scheduler.start()
  t.mock.timers.tick(1_000)
  await flush()

  assert.equal(errors.length, 2, '落ちても購読者全員に配る（バッジを固めない）')
  assert.equal(errors[0].error?.message, 'boom')
  assert.equal(errors[0].value, undefined)
  assert.equal(others.length, 1, '別トピックは影響を受けない')
  scheduler.stop()
})
