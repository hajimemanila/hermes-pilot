/**
 * 定期同期の宣言表 + 1 本のスケジューラ（SPEC D97 / Batch `SEMM-2`）の検証。
 *
 * 「何秒で・どのタブで止めるか」が表 1 つで決まり、呼び出し側（`App.jsx`）が
 * 自前のタイマーと停止規則を持たないことをここで固定する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SYNC_TOPICS, createSyncScheduler, shouldRun } from '../src/lib/syncScheduler.js'

/** 表どおりに購読したスケジューラと、トピックごとの呼び出し回数。 */
function harness({ tab = 'chat', visible = true, topics = SYNC_TOPICS } = {}) {
  const state = { tab, visible }
  const calls = []
  const scheduler = createSyncScheduler({
    topics,
    isVisible: () => state.visible,
    currentTab: () => state.tab,
  })
  for (const topic of topics) {
    scheduler.subscribe(topic.id, () => {
      calls.push(topic.id)
    })
  }
  return { scheduler, state, calls, count: (id) => calls.filter((c) => c === id).length }
}

test('① 表どおりの間隔で呼ばれる（mock timers）', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness()
  h.scheduler.start()

  t.mock.timers.tick(4_999)
  assert.equal(h.calls.length, 0, '5 秒未満では 1 本も走らない')

  t.mock.timers.tick(1) // 5 秒
  assert.equal(h.count('overview'), 1)
  assert.equal(h.count('reports'), 0)

  t.mock.timers.tick(10_000) // 15 秒
  assert.equal(h.count('overview'), 3, 'overview だけ 5 秒ごと')
  for (const id of ['reports', 'reviewWaiting', 'reviewFeed', 'inbox', 'live']) {
    assert.equal(h.count(id), 1, `${id} は 15 秒で 1 回`)
  }
  assert.equal(h.count('usage'), 0, 'usage は 60 秒まで走らない')

  t.mock.timers.tick(45_000) // 60 秒
  assert.equal(h.count('overview'), 12)
  assert.equal(h.count('usage'), 1, 'usage は 60 秒で 1 回')

  // 間隔は表の値そのもの（トピックごとに独立して回る）
  for (const topic of SYNC_TOPICS) {
    assert.equal(h.count(topic.id), Math.floor(60_000 / topic.everyMs), `${topic.id} の回数`)
  }

  h.scheduler.stop()
  t.mock.timers.tick(60_000)
  assert.equal(h.count('overview'), 12, 'stop 後は増えない')
})

test('② 表示中タブでは該当トピックが呼ばれない', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness({ tab: 'review' })
  h.scheduler.start()
  t.mock.timers.tick(30_000)

  assert.equal(h.count('reviewWaiting'), 0, 'review タブ表示中は判断待ちを取りに行かない')
  assert.equal(h.count('reviewFeed'), 0, 'review タブ表示中はフィードを取りに行かない')
  assert.equal(h.count('inbox'), 2, 'tasks 以外のタブでは inbox は止めない')
  assert.equal(h.count('overview'), 6)

  // タブを移ると再開する（間隔は止めていないので位相もそのまま）
  h.state.tab = 'tasks'
  t.mock.timers.tick(15_000)
  assert.equal(h.count('reviewWaiting'), 1, 'review から離れたら再開する')
  assert.equal(h.count('inbox'), 2, 'tasks タブでは inbox を止める')

  h.state.tab = 'chat'
  t.mock.timers.tick(15_000)
  assert.equal(h.count('inbox'), 3, 'tasks から離れたら再開する')
  h.scheduler.stop()
})

test('③ 画面が見えていない間（isVisible() === false）は呼ばれない', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness({ visible: false })
  h.scheduler.start()
  t.mock.timers.tick(120_000)
  assert.equal(h.calls.length, 0, 'document.hidden 相当では 1 本も走らない')

  h.state.visible = true
  t.mock.timers.tick(5_000)
  assert.equal(h.count('overview'), 1, '戻ったら次の位相から走る')
  assert.equal(h.count('usage'), 0, '隠れていた 60 秒ぶんをまとめて走らせない（位相は 120 秒のまま）')
  t.mock.timers.tick(55_000) // 180 秒
  assert.equal(h.count('usage'), 1, '位相が来たら 1 回だけ走る')
  h.scheduler.stop()
})

test('④ forceAll は可視・タブ・スロットルを無視して全トピック 1 回、skip を尊重する', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness({ tab: 'review', visible: false })
  h.scheduler.start()
  t.mock.timers.tick(30_000)
  assert.equal(h.calls.length, 0)

  const ran = h.scheduler.forceAll({ skip: 'overview' })
  assert.deepEqual([...ran].sort(), ['inbox', 'live', 'reports', 'reviewFeed', 'reviewWaiting', 'usage'].sort())
  for (const topic of SYNC_TOPICS) {
    if (topic.id === 'overview') assert.equal(h.count('overview'), 0, 'skip した トピックは走らない')
    else assert.equal(h.count(topic.id), 1, `${topic.id} は 1 回`)
  }

  // 2 回目も 1 回ずつ（スロットルは無い）
  h.scheduler.forceAll()
  assert.equal(h.count('overview'), 1)
  assert.equal(h.count('usage'), 2)

  // skip は配列でもよい
  h.scheduler.forceAll({ skip: ['overview', 'usage'] })
  assert.equal(h.count('overview'), 1)
  assert.equal(h.count('usage'), 2)
  assert.equal(h.count('live'), 3)
  h.scheduler.stop()
})

test('⑤ subscribe の解除後は呼ばれない（解除したトピックのタイマーも止まる）', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls = []
  const scheduler = createSyncScheduler({ isVisible: () => true, currentTab: () => 'chat' })
  const offLive = scheduler.subscribe('live', () => calls.push('live'))
  const offUsage = scheduler.subscribe('usage', () => calls.push('usage'))
  scheduler.start()
  t.mock.timers.tick(30_000)
  assert.equal(calls.filter((c) => c === 'live').length, 2)

  offLive()
  t.mock.timers.tick(30_000)
  assert.equal(calls.filter((c) => c === 'live').length, 2, '解除後は走らない')
  assert.equal(calls.filter((c) => c === 'usage').length, 1, '他の購読は影響を受けない')

  offUsage()
  scheduler.stop()

  // 未知のトピック・関数でない購読は無害
  assert.equal(typeof scheduler.subscribe('nope', () => {}), 'function')
  assert.doesNotThrow(() => scheduler.subscribe('live', null))
  scheduler.tick('nope')
})

test('⑥ 表の everyMs が 7 トピックぶん重複なく揃っている', () => {
  assert.equal(SYNC_TOPICS.length, 7, 'トピックは 7 本（App.jsx の 7 タイマーと同数）')
  const ids = SYNC_TOPICS.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, 'id が重複しない')
  for (const topic of SYNC_TOPICS) {
    assert.ok(Number.isFinite(topic.everyMs) && topic.everyMs > 0, `${topic.id} の everyMs`)
    assert.ok(Array.isArray(topic.pauseOnTabs), `${topic.id} の pauseOnTabs は配列`)
  }
  assert.deepEqual(
    SYNC_TOPICS.map((t) => [t.id, t.everyMs]),
    [
      ['overview', 5_000],
      ['reports', 15_000],
      ['reviewWaiting', 15_000],
      ['reviewFeed', 15_000],
      ['inbox', 15_000],
      ['live', 15_000],
      ['usage', 60_000],
    ],
    '秒数は現行のタイマー（5 / 15 / 15 / 15 / 15 / 15 / 60 秒）と同じ',
  )
  assert.deepEqual(
    SYNC_TOPICS.filter((t) => t.pauseOnTabs.length > 0).map((t) => [t.id, t.pauseOnTabs]),
    [
      ['reviewWaiting', ['review']],
      ['reviewFeed', ['review']],
      ['inbox', ['tasks']],
      // `live` は SEMM-2 では []（既存の無条件 15 秒と同じ）。同じツリーで走る SEMM-3 が
      // `['tasks']` に変えるので、どちらの段でも壊れないよう両方を許容する。
      ...(SYNC_TOPICS.find((t) => t.id === 'live').pauseOnTabs.length > 0
        ? [['live', SYNC_TOPICS.find((t) => t.id === 'live').pauseOnTabs]]
        : []),
    ],
    '止めるタブは review と tasks だけ（停止規則の不揃いを無くす）',
  )
  for (const topic of SYNC_TOPICS) {
    for (const tabId of topic.pauseOnTabs) {
      assert.ok(
        ['tasks', 'review', 'chat', 'notes', 'term', 'settings'].includes(tabId),
        `${topic.id} の pauseOnTabs は実在のタブ id（${tabId}）`,
      )
    }
  }
  assert.deepEqual(
    SYNC_TOPICS.find((t) => t.id === 'live').pauseOnTabs.filter((tabId) => tabId !== 'tasks'),
    [],
    'live が止めるのは tasks だけ（SEMM-3 の予定地）',
  )
})

test('shouldRun は表の停止規則だけを見る', () => {
  const reviewWaiting = SYNC_TOPICS.find((t) => t.id === 'reviewWaiting')
  assert.equal(shouldRun(reviewWaiting, { tab: 'review', visible: true }), false)
  assert.equal(shouldRun(reviewWaiting, { tab: 'chat', visible: true }), true)
  assert.equal(shouldRun(reviewWaiting, { tab: null, visible: true }), true)
  assert.equal(shouldRun(reviewWaiting, { tab: 'chat', visible: false }), false)
  assert.equal(shouldRun(null, { tab: 'chat', visible: true }), false)
})
