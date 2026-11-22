/**
 * 接続状態の正本（`apps/web/src/lib/transport.js`）。SPEC-EXECUTION-MODE-INTEGRITY / D96・§3.1
 *
 * 丸・赤帯・`gwState`・チャット帯・端末状態が同じ 1 つの集約状態を見ることを、
 * 「猶予（grace）」「優先順（severity）」「auth の固定」「回復」の 6 点で固定する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRACE_MS,
  RECONNECT_MAX_MS,
  TRANSPORT_SOURCES,
  TRANSPORT_STATES,
  aggregate,
  blankSources,
  createTransportHub,
  reconnectDelay,
  severity,
  shouldShowBanner,
} from '../src/lib/transport.js'

/** タイマーを張らないハブ（`now` を進めて状態を確かめる）。 */
function makeHub(startAt = 1_000) {
  let clock = startAt
  const timers = []
  const hub = createTransportHub({
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
  })
  return {
    hub,
    timers,
    at(ms) {
      clock = ms
    },
    advance(ms) {
      clock += ms
    },
  }
}

test('語彙: 系統は http / chat / term、状態は 5 語（報告イベント名は含めない）', () => {
  assert.deepEqual(TRANSPORT_SOURCES, ['http', 'chat', 'term'])
  assert.deepEqual(TRANSPORT_STATES, ['ready', 'connecting', 'recovering', 'offline', 'auth'])
  for (const reportName of ['open', 'closed', 'ok', 'error']) {
    assert.equal(TRANSPORT_STATES.includes(reportName), false, `${reportName} は報告イベント名`)
  }
  assert.deepEqual(GRACE_MS, { http: 12000, chat: 4000, term: 4000 })
})

test('① reconnectDelay の刻み: 1→1000, 2→2000, 4→8000, 6→上限 15000', () => {
  assert.equal(reconnectDelay(1), 1000)
  assert.equal(reconnectDelay(2), 2000)
  assert.equal(reconnectDelay(3), 4000)
  assert.equal(reconnectDelay(4), 8000)
  assert.equal(reconnectDelay(6), RECONNECT_MAX_MS, '6 → 16000 は上限で頭打ち')
  assert.equal(reconnectDelay(99), RECONNECT_MAX_MS)
  // 0 / 負 / 非数でも base から始める（即時連打しない）
  for (const bad of [0, -3, undefined, null, 'x', Number.NaN]) {
    assert.equal(reconnectDelay(bad), 1000, `attempt=${String(bad)}`)
  }
  assert.equal(reconnectDelay(3, { base: 500, max: 1000 }), 1000)
})

test('② chat の close: 2000ms 未満は recovering、超えたら offline', () => {
  const { hub, at } = makeHub()
  hub.report('http', 'ok')
  hub.report('term', 'open')
  hub.report('chat', 'ready')
  assert.equal(hub.state(), 'ready')

  hub.report('chat', 'closed')
  at(1_000 + GRACE_MS.chat - 1)
  assert.equal(hub.sourceState('chat'), 'recovering')
  assert.equal(hub.state(), 'recovering', '帯を出す側は recovering を見る')

  at(1_000 + GRACE_MS.chat)
  assert.equal(hub.sourceState('chat'), 'offline')
  assert.equal(hub.state(), 'offline', '猶予を超えたら赤帯（offline）')

  // 回復すると ready に戻る
  hub.report('chat', 'ready')
  assert.equal(hub.state(), 'ready')
})

test('②-補: chat が一度も ready していない間は connecting（帯は出さない）', () => {
  const { hub, at } = makeHub()
  hub.report('http', 'ok')
  hub.report('chat', 'connecting')
  at(1_000 + 500)
  assert.equal(hub.sourceState('chat'), 'connecting')
  assert.equal(hub.state(), 'connecting')
  at(1_000 + GRACE_MS.chat + 1)
  assert.equal(hub.sourceState('chat'), 'offline', '繋がらないまま猶予を超えたら offline')
})

test('③ http の 1 回の失敗（8 秒以内）では offline にしない', () => {
  const { hub, at } = makeHub()
  hub.report('chat', 'ready')
  hub.report('term', 'open')
  hub.report('http', 'ok')
  assert.equal(hub.state(), 'ready')

  hub.report('http', 'timeout')
  at(1_000 + GRACE_MS.http - 1)
  assert.equal(hub.sourceState('http'), 'recovering')
  assert.notEqual(hub.state(), 'offline', '5 秒ポーリングの 1 回失敗で赤帯を出さない')
  assert.notEqual(hub.state(), 'auth')

  at(1_000 + GRACE_MS.http)
  assert.equal(hub.sourceState('http'), 'offline')

  // 途中で成功すれば秒数に関係なく ready
  hub.report('http', 'ok')
  assert.equal(hub.state(), 'ready')
})

test('④ http の auth は他系統が ready でも集約 auth（ok が来るまで固定）', () => {
  const { hub } = makeHub()
  hub.report('chat', 'ready')
  hub.report('term', 'open')
  hub.report('http', 'auth')
  assert.equal(hub.sourceState('http'), 'auth')
  assert.equal(hub.state(), 'auth', '他の 2 系統が ready でも auth が勝つ')

  // auth 中の失敗報告では状態を動かさない
  hub.report('http', 'error')
  assert.equal(hub.state(), 'auth')

  hub.report('http', 'ok')
  assert.equal(hub.state(), 'ready')
})

test('⑤ 全系統 ready で ready、1 系統の回復で ready に戻る', () => {
  const { hub } = makeHub()
  hub.report('http', 'ok')
  hub.report('chat', 'ready')
  hub.report('term', 'open')
  assert.equal(hub.state(), 'ready')

  hub.report('term', 'closed')
  assert.equal(hub.state(), 'recovering')
  hub.report('term', 'open')
  assert.equal(hub.state(), 'ready')

  hub.report('http', 'error')
  hub.report('chat', 'closed')
  assert.equal(hub.state(), 'recovering', '複数系統が同時に落ちても recovering')

  hub.report('http', 'ok')
  hub.report('chat', 'ready')
  assert.equal(hub.state(), 'ready')
})

test('⑥ severity の順序: auth > offline > recovering > connecting > ready', () => {
  assert.ok(severity('auth') > severity('offline'))
  assert.ok(severity('offline') > severity('recovering'))
  assert.ok(severity('recovering') > severity('connecting'))
  assert.ok(severity('connecting') > severity('ready'))
  assert.equal(severity('ready'), 0)
  assert.equal(severity('auth'), 4)
})

test('未報告の系統は集約で無視する（開いていないタブで丸を赤くしない）', () => {
  const { hub } = makeHub()
  hub.report('http', 'ok')
  assert.equal(hub.state(), 'ready', 'chat / term が未報告でも ready')
  assert.equal(hub.sourceState('chat'), 'connecting', '系統単体は connecting から始まる')
  assert.equal(hub.sourceState('term'), 'connecting')

  // 全系統が未報告でも「非接続」とは言わない（起動直後に赤帯を出さない）
  assert.equal(aggregate(blankSources(), 0), 'ready')
  assert.equal(aggregate(null, 0), 'ready')

  // 純関数版: 状態語彙の文字列を直接渡しても優先順で 1 語に畳む
  assert.equal(aggregate({ http: 'ready', chat: 'connecting', term: 'ready' }, 0), 'connecting')
  assert.equal(aggregate({ http: 'offline', chat: 'auth', term: 'recovering' }, 0), 'auth')
})

test('猶予が切れる瞬間にタイマーで offline へ切り替わり、購読者へ通知する', () => {
  let clock = 0
  const pending = []
  const hub = createTransportHub({
    now: () => clock,
    setTimer: (fn, ms) => {
      pending.push({ fn, ms })
      return pending.length
    },
    clearTimer: () => {},
  })
  const seen = []
  const off = hub.subscribe(() => seen.push(hub.state()))
  hub.report('chat', 'ready')
  hub.report('chat', 'closed')
  assert.equal(pending.length, 1, '猶予の期限にタイマーを 1 本だけ張る')
  assert.equal(pending[0].ms, GRACE_MS.chat + 1)

  clock = GRACE_MS.chat
  pending[0].fn()
  assert.equal(hub.state(), 'offline')
  assert.equal(seen.at(-1), 'offline', 'タイマー発火で購読者（画面）が再描画できる')
  assert.equal(pending.length, 1, '期限を過ぎたら次のタイマーは張らない')

  off()
  hub.report('chat', 'ready')
  assert.equal(seen.at(-1), 'offline', '解除後の購読者は呼ばれない')
})

test('端末（term）: open で ready、close は猶予つき（recovering → offline）', () => {
  const { hub, at } = makeHub()
  hub.report('http', 'ok')
  hub.report('term', 'connecting')
  assert.equal(hub.state(), 'connecting')
  hub.report('term', 'open')
  assert.equal(hub.sourceState('term'), 'ready')

  hub.report('term', 'closed')
  at(1_000 + GRACE_MS.term - 1)
  assert.equal(hub.sourceState('term'), 'recovering')
  at(1_000 + GRACE_MS.term)
  assert.equal(hub.sourceState('term'), 'offline')

  hub.report('term', 'error')
  assert.equal(hub.sourceState('term'), 'offline', 'error も closed と同じ扱い')
})

test('reset() で全系統が未報告に戻る（ログアウト・再起動相当）', () => {
  const { hub } = makeHub()
  hub.report('http', 'auth')
  assert.equal(hub.state(), 'auth')
  hub.reset()
  assert.equal(hub.sourceState('http'), 'connecting')
  assert.equal(hub.state(), 'ready')
})

test('未知の系統・未知の報告名は状態を動かさない', () => {
  const { hub } = makeHub()
  hub.report('http', 'ok')
  assert.equal(hub.report('nope', 'closed'), 'connecting')
  assert.equal(hub.report('http', 'nope'), 'ready')
  assert.equal(hub.state(), 'ready')
})

test('shouldShowBanner: recovering / connecting では非表示、offline / auth のみ赤帯を出す', () => {
  assert.equal(shouldShowBanner('ready'), false)
  assert.equal(shouldShowBanner('connecting'), false)
  assert.equal(shouldShowBanner('recovering'), false)
  assert.equal(shouldShowBanner('offline'), true)
  assert.equal(shouldShowBanner('auth'), true)
})

test('裏タブ WS（chat / term）が猶予超過しても http 正常中は http 系統へ赤帯を出さない', () => {
  const { hub, at } = makeHub()
  hub.report('http', 'ok')
  hub.report('chat', 'ready')
  hub.report('term', 'open')

  hub.report('chat', 'closed')
  hub.report('term', 'closed')
  at(1_000 + GRACE_MS.chat - 1)
  assert.equal(shouldShowBanner(hub.sourceState('chat')), false, 'chat 猶予中はチャット帯も出さない')
  assert.equal(shouldShowBanner(hub.sourceState('http')), false)

  at(1_000 + GRACE_MS.chat)
  assert.equal(hub.sourceState('chat'), 'offline')
  assert.equal(shouldShowBanner(hub.sourceState('chat')), true, 'chat 側は猶予後にチャット帯を出す')
  assert.equal(hub.sourceState('http'), 'ready', 'http は裏タブ WS 断で offline にならない')
  assert.equal(shouldShowBanner(hub.sourceState('http')), false, '他タブのグローバル赤帯は出さない')
})
