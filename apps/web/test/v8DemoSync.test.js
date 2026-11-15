/**
 * V8 統合検証（SPEC-PILOT-V8 §V8-B4）: デモと本番の結線が崩れていないことを固定する。
 *
 * B1〜B3 は個別モジュールの単体テストを持つが、「デモのモック API が本番のブリッジと
 * 同じパス・同じ形を返す」ことと「デモで V8-B3 の見た目（連続 heartbeat の畳み込み）が
 * 実際に成立する」ことは、どれか 1 つのモジュールだけを見ても分からない。ここで
 * ルーティング → 応答 → 折りたたみ → i18n を通しで確認する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  demoFetch,
  demoRoute,
  demoTaskDetail,
  demoWorkerFeed,
  resetDemoState,
} from '../src/demo/mockApi.js'
import { collapseTaskEvents } from '../src/lib/tasksView.js'
import ja from '../src/i18n/ja.json' with { type: 'json' }
import en from '../src/i18n/en.json' with { type: 'json' }

test('V8-B3: デモは任意ボードのタスク worker パスを本番と同じ形で分類する', () => {
  const r = demoRoute('/api/boards/hermes-pilot/tasks/t_abc123/worker?limit=30')
  assert.equal(r.name, 'board.taskWorker')
  assert.equal(r.id, 'hermes-pilot')
  assert.equal(r.taskId, 't_abc123')
  // 詳細（/worker なし）と取り違えないこと
  assert.equal(demoRoute('/api/boards/hermes-pilot/tasks/t_abc123').name, 'board.task')
  // 既存のレビュー側 worker も残っていること
  assert.equal(demoRoute('/api/review/t_abc123/worker').name, 'review.worker')
})

test('V8-B3: デモの worker フィードは sessionId と実行ステップを返す', async () => {
  resetDemoState()
  const res = await demoFetch('/api/boards/mobile/tasks/t_demo_done/worker?limit=30')
  assert.equal(res.sessionId, res.feed.sessionId)
  assert.ok(res.sessionId, 'sessionId が無いと TasksPane は WorkerFeed を出さない')
  assert.ok(Array.isArray(res.feed.messages) && res.feed.messages.length > 0)
  assert.ok(res.feed.messages.some((m) => m.role === 'tool'))
  assert.ok(res.feed.messages.some((m) => m.role === 'assistant'))
})

test('V8-B3: デモに無いタスクは TASK_NOT_FOUND を返す（空フィードで偽装しない）', async () => {
  resetDemoState()
  const res = await demoFetch('/api/boards/mobile/tasks/t_nope/worker')
  assert.equal(res.ok, false)
  assert.equal(res.code, 'TASK_NOT_FOUND')
})

test('V8-B3: 実行中タスクの詳細は連続 heartbeat を持ち、1 行に畳める', () => {
  const detail = demoTaskDetail({
    id: 't_demo_demo-1',
    title: '[DEMO-1] approve the design decisions in one tap',
    status: 'running',
    createdAt: Date.now() - 120_000,
  })
  assert.ok(detail.sessionId, '詳細に sessionId が載る（無いと WorkerFeed が出ない）')
  const beats = detail.events.filter((e) => e.kind === 'heartbeat')
  assert.equal(beats.length, 3, 'デモは 3 連続 heartbeat を持つ')

  const merged = collapseTaskEvents(detail.events)
  const hb = merged.filter((e) => e.kind === 'heartbeat')
  assert.equal(hb.length, 1, '連続 heartbeat は 1 行に畳まれる')
  assert.equal(hb[0].count, 3)
  // 最新が先頭（本物の task_events は id DESC）
  assert.equal(hb[0].at, Math.max(...beats.map((b) => b.at)))
  assert.equal(hb[0].firstAt, Math.min(...beats.map((b) => b.at)))
})

test('V8-B3: 完了タスクは heartbeat ではなく completed を持つ', () => {
  const detail = demoTaskDetail({
    id: 't_demo_done',
    title: '[DEMO-0] static demo shell builds',
    status: 'done',
    createdAt: Date.now() - 600_000,
    updatedAt: Date.now() - 300_000,
  })
  assert.equal(detail.events.some((e) => e.kind === 'heartbeat'), false)
  assert.equal(detail.events[0].kind, 'completed')
})

test('V8-B3: heartbeat の畳み込みラベルが JA / EN 両方にある', () => {
  for (const dict of [ja, en]) {
    assert.equal(typeof dict['tasks.heartbeatCount'], 'string')
    assert.equal(typeof dict['tasks.heartbeatRange'], 'string')
  }
  assert.ok(ja['tasks.heartbeatCount'].includes('{n}'))
  assert.ok(en['tasks.heartbeatCount'].includes('{n}'))
  assert.ok(ja['tasks.heartbeatRange'].includes('{first}'))
  assert.ok(en['tasks.heartbeatRange'].includes('{first}'))
  assert.ok(en['tasks.heartbeatRange'].includes('{last}'))
})

test('V8-B3: demoWorkerFeed はタスク ID をタイトルに載せ、単体でも同じ形を返す', () => {
  const feed = demoWorkerFeed('t_x1')
  assert.equal(feed.ok, true)
  assert.ok(feed.title.includes('t_x1'))
  assert.equal(feed.hasMore, false)
})
