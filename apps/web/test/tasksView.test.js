/**
 * タスク詳細シートのイベント折りたたみ（SPEC-PILOT-V8 §V8-B3）の検証。
 *
 * `kanban.task()` の `events` は**新しい順**（`ORDER BY id DESC`）。worker は 1 ターンで
 * 何度も heartbeat を打つので、そのまま並べるとタイムラインが heartbeat だけで埋まる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { collapseTaskEvents, eventKind } from '../src/lib/tasksView.js'

/** 新しい順のイベント列を作る（`at` は降順）。 */
const ev = (kind, at) => ({ kind, at, payload: {} })

test('collapseTaskEvents は連続する heartbeat を 1 件にまとめる', () => {
  const events = [
    ev('heartbeat', 5000),
    ev('heartbeat', 4000),
    ev('heartbeat', 3000),
    ev('claimed', 2000),
    ev('created', 1000),
  ]
  const out = collapseTaskEvents(events)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { kind: 'heartbeat', count: 3, at: 5000, firstAt: 3000 })
  assert.equal(out[1].kind, 'claimed')
  assert.equal(out[2].kind, 'created')
  // 元の配列は書き換えない
  assert.equal(events.length, 5)
  assert.equal(events[0].count, undefined)
})

test('collapseTaskEvents は別種イベントを跨いで合算しない', () => {
  const events = [
    ev('heartbeat', 9000),
    ev('heartbeat', 8000),
    ev('comment', 7000),
    ev('heartbeat', 6000),
    ev('heartbeat', 5000),
    ev('heartbeat', 4000),
  ]
  const out = collapseTaskEvents(events)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((e) => e.kind), ['heartbeat', 'comment', 'heartbeat'])
  assert.equal(out[0].count, 2)
  assert.equal(out[0].at, 9000)
  assert.equal(out[0].firstAt, 8000)
  assert.equal(out[2].count, 3)
  assert.equal(out[2].at, 6000)
  assert.equal(out[2].firstAt, 4000)
})

test('collapseTaskEvents は空配列・未指定で空配列を返す', () => {
  assert.deepEqual(collapseTaskEvents([]), [])
  assert.deepEqual(collapseTaskEvents(), [])
})

test('collapseTaskEvents は 1 件だけの heartbeat も count=1 で返す', () => {
  const out = collapseTaskEvents([ev('heartbeat', 1234)])
  assert.deepEqual(out, [{ kind: 'heartbeat', count: 1, at: 1234, firstAt: 1234 }])
})

test('collapseTaskEvents は heartbeat 以外をそのまま（同一参照で）通す', () => {
  const claimed = { kind: 'claimed', at: 10, payload: { run_id: 1 } }
  const out = collapseTaskEvents([claimed])
  assert.equal(out[0], claimed)
})

test('collapseTaskEvents は壊れた要素を落とす', () => {
  const out = collapseTaskEvents([null, ev('heartbeat', 5), undefined])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'heartbeat')
})

test('eventKind は kind が無ければ空文字を返す', () => {
  assert.equal(eventKind({ kind: 'claimed' }), 'claimed')
  assert.equal(eventKind({}), '')
  assert.equal(eventKind(null), '')
})
