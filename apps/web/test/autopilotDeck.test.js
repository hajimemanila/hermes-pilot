import test from 'node:test'
import assert from 'node:assert/strict'
import { demoFetch, resetDemoState } from '../src/demo/mockApi.js'
import {
  EDGE_DEAD_ZONE_PX,
  SWIPE_THRESHOLD_PX,
  buildAnswerPayload,
  buildDeckFromSheet,
  buildRemixPayload,
  classifySwipe,
  createRemixPending,
  createUndoEntry,
  isInEdgeDeadZone,
  isUndoActive,
  resolveHoldOutcome,
} from '../src/lib/autopilotDeck.js'

test('AP-3: isInEdgeDeadZone は左右端 24px をブロックし中央を許可する', () => {
  assert.equal(EDGE_DEAD_ZONE_PX, 24)
  assert.equal(isInEdgeDeadZone(10, 390), true)
  assert.equal(isInEdgeDeadZone(24, 390), true)
  assert.equal(isInEdgeDeadZone(370, 390), true)
  assert.equal(isInEdgeDeadZone(366, 390), true)
  assert.equal(isInEdgeDeadZone(195, 390), false)
  assert.equal(isInEdgeDeadZone(25, 390), false)
})

test('AP-3: classifySwipe は 90px 閾値と 4 方向ゴーストスタンプを判定する', () => {
  assert.equal(SWIPE_THRESHOLD_PX, 90)
  assert.deepEqual(classifySwipe(5, 3), { direction: null, stamp: null, progress: 0, committed: false })

  const partialRight = classifySwipe(45, 5)
  assert.equal(partialRight.direction, 'right')
  assert.equal(partialRight.stamp, 'GO')
  assert.equal(partialRight.progress, 0.5)
  assert.equal(partialRight.committed, false)

  assert.equal(classifySwipe(95, 10).committed, true)
  assert.equal(classifySwipe(-92, 0).stamp, 'REMIX')
  assert.equal(classifySwipe(0, -96).stamp, 'ANNOTATE')
  assert.equal(classifySwipe(0, 91).stamp, 'HOLD')
})

test('AP-3: buildDeckFromSheet は 3 枚デッキを構築し、buildAnswerPayload が GO/HOLD/ANNOTATE を束ねる', () => {
  const cards = buildDeckFromSheet(
    { id: 't_ap1', title: 'FocusFlow' },
    {
      data: {
        title: 'FocusFlow Deck',
        deck: true,
        questions: [
          {
            id: 'q1',
            text: 'Main layout',
            visualMock: { shot: 'shots/q1.png', template: 'timer-card' },
            options: [{ id: 'A', label: 'Ring', recommended: true }, { id: 'B', label: 'Bar' }],
          },
          {
            id: 'q2',
            text: 'Flow',
            options: [{ id: 'A', label: 'Sheet', recommended: true }],
          },
          {
            id: 'q3',
            text: 'Storage',
            options: [{ id: 'A', label: 'Local', recommended: true }],
          },
        ],
      },
    },
  )
  assert.equal(cards.length, 3)
  assert.equal(cards[0].recommendedId, 'A')
  assert.equal(cards[0].visualMock.shot, 'shots/q1.png')

  const payload = buildAnswerPayload(cards, {
    [cards[0].key]: {
      action: 'annotate',
      choice: 'A',
      annotation: { marks: [{ type: 'rect' }], note: 'Larger CTA' },
    },
    [cards[1].key]: { action: 'go', choice: 'A' },
    [cards[2].key]: { action: 'hold' },
  })
  assert.deepEqual(payload.answers, [
    { id: 'q1', choice: 'A', note: '' },
    { id: 'q2', choice: 'A', note: '' },
    { id: 'q3', choice: null, note: '' },
  ])
  assert.deepEqual(payload.annotations, [
    { questionId: 'q1', shot: 'shots/q1.png', marks: [{ type: 'rect' }], note: 'Larger CTA' },
  ])
})

test('AP-3: createUndoEntry / isUndoActive は 3 秒ウィンドウを管理する', () => {
  const entry = createUndoEntry({ key: 't1:q1', text: 'Layout' }, 'go', 1000)
  assert.equal(isUndoActive(entry, 2500), true)
  assert.equal(isUndoActive(entry, 4000), false)
})

test('AP-4: resolveHoldOutcome は設問を recommended 委譲、brainstorm をメモ保存に分岐する', () => {
  assert.deepEqual(resolveHoldOutcome({ kind: 'question', text: 'Layout' }), {
    kind: 'delegate',
    action: 'hold',
    choice: null,
  })
  assert.deepEqual(resolveHoldOutcome({ kind: 'brainstorm', text: 'Try dark glass card' }), {
    kind: 'memo',
    action: 'hold',
    choice: null,
    memoText: 'Try dark glass card',
  })
})

test('AP-4: createRemixPending / buildRemixPayload は 2 秒チップウィンドウとペイロードを作る', () => {
  const card = { key: 't1:q1', taskId: 't1', questionId: 'q1' }
  const pending = createRemixPending(card, 1000)
  assert.equal(pending.expiresAt, 3000)
  assert.deepEqual(buildRemixPayload(card, 'simpler', '  Less text '), {
    questionId: 'q1',
    reason: 'simpler',
    hint: 'Less text',
  })
})

test('AP-6: デモモードで Autopilot デッキ（visualMock / remix / annotations 付き answer）が完結する', async () => {
  resetDemoState()
  const sheet = await demoFetch('/api/review/t_demo_review/data')
  assert.equal(sheet.data.deck, true)
  assert.equal(sheet.data.questions.length, 3)
  assert.equal(sheet.data.questions[0].visualMock.shot, 'shots/demo-q1.png')

  const remix = await demoFetch('/api/review/t_demo_review/remix', {
    method: 'POST',
    body: { questionId: 'q1', reason: 'simpler', hint: 'Larger CTA' },
  })
  assert.equal(remix.ok, true)
  assert.equal(remix.record.questionId, 'q1')
  assert.equal(remix.record.reason, 'simpler')

  const answered = await demoFetch('/api/review/t_demo_review/answer', {
    method: 'POST',
    body: {
      answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', choice: 'A' }, { id: 'q3', choice: null }],
      annotations: [{ questionId: 'q1', shot: 'shots/demo-q1.png', marks: [{ type: 'rect' }], note: 'Keep bold' }],
    },
  })
  assert.equal(answered.ok, true)
})
