import test from 'node:test'
import assert from 'node:assert/strict'
import { demoFetch, resetDemoState } from '../src/demo/mockApi.js'
import {
  AUTOPILOT_RECIPES,
  EDGE_DEAD_ZONE_PX,
  SWIPE_THRESHOLD_PX,
  buildAnswerPayload,
  buildDeckFromSheet,
  buildRemixPayload,
  classifySwipe,
  createRemixPending,
  createUndoEntry,
  currentOptionCard,
  extractDeliverable,
  isInEdgeDeadZone,
  isReachablePublicUrl,
  isSameOriginPreviewUrl,
  isUndoActive,
  projectStudioStage,
  resolveHoldOutcome,
  resolveOptionSwipe,
  translateActivity,
} from '../src/lib/autopilotDeck.js'

test('AP-3: isInEdgeDeadZone は左右端 24px をブロックし中央を許可する', () => {
  assert.equal(EDGE_DEAD_ZONE_PX, 24)
  assert.equal(isInEdgeDeadZone(10, 390), true)
  assert.equal(isInEdgeDeadZone(24, 390), true)
  assert.equal(isInEdgeDeadZone(370, 390), true)
  assert.equal(isInEdgeDeadZone(195, 390), false)
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
  assert.equal(classifySwipe(-92, 0).stamp, 'NEXT')
  assert.equal(classifySwipe(0, -96).stamp, 'ANNOTATE')
  assert.equal(classifySwipe(0, 91).stamp, 'HOLD')
})

test('AP-v2: 1選択肢=1カードの Option-Cycle (A → 左で B → 右で B 採用 / 最後なら REMIX)', () => {
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
            options: [
              { id: 'A', label: 'Ring Timer', recommended: true, visualMock: { shot: 'shots/a.png', layoutVariant: 'A', theme: 'cyan' } },
              { id: 'B', label: 'Compact Card', visualMock: { shot: 'shots/b.png', layoutVariant: 'B', theme: 'amber' } },
            ],
          },
        ],
      },
    },
  )
  const cardA = currentOptionCard(cards[0], 0)
  assert.equal(cardA.option.id, 'A')
  assert.equal(cardA.shot, 'shots/a.png')
  assert.equal(cardA.isLastOption, false)

  // A で左スワイプ -> B へ即切り替え
  const leftA = resolveOptionSwipe(cards[0], 0, 'left')
  assert.deepEqual(leftA, { type: 'next-option', nextOptionIndex: 1, advanceQuestion: false })

  const cardB = currentOptionCard(cards[0], 1)
  assert.equal(cardB.option.id, 'B')
  assert.equal(cardB.shot, 'shots/b.png')
  assert.equal(cardB.isLastOption, true)

  // B で右スワイプ -> B を確定採用
  const rightB = resolveOptionSwipe(cards[0], 1, 'right')
  assert.deepEqual(rightB, { type: 'adopt', choice: 'B', advanceQuestion: true })

  // 最後の選択肢で左スワイプ -> REMIX チップへ
  const leftB = resolveOptionSwipe(cards[0], 1, 'left')
  assert.deepEqual(leftB, { type: 'remix-chips', advanceQuestion: false })

  const payload = buildAnswerPayload(cards, {
    [cards[0].key]: { action: 'go', choice: 'B' },
  })
  assert.deepEqual(payload.answers, [{ id: 'q1', choice: 'B', note: '' }])
})

test('AP-v2: projectStudioStage は 4 幕 (deck / live / complete / start) を判定する', () => {
  assert.equal(AUTOPILOT_RECIPES.length, 4)
  assert.equal(projectStudioStage({}).act, 'start')
  assert.equal(projectStudioStage({ cards: [{ key: 'k1' }] }).act, 'deck')

  const liveStage = projectStudioStage({
    jobs: [{ id: 'j1', status: 'running', phase: 'round2_spec', seed: 'Timer' }],
    tasks: [{ id: 't1', status: 'done' }, { id: 't2', status: 'running', title: 'Write UI tests' }],
    live: { turns: [{ id: 'turn1', lastTool: { name: 'run_command' } }] },
  })
  assert.equal(liveStage.act, 'live')
  assert.equal(liveStage.doneCount, 1)
  assert.equal(liveStage.totalCount, 2)
  assert.equal(translateActivity('write_file'), 'autopilot.live.actWrite')

  const completeStage = projectStudioStage({
    tasks: [{
      id: 't_done',
      status: 'done',
      title: 'Finish app',
      result: 'Done\nPreview: https://example.com/demo\nLaunch: `npm run dev`',
    }],
  })
  assert.equal(completeStage.act, 'complete')
  assert.equal(completeStage.deliverable.previewUrl, 'https://example.com/demo')
  assert.equal(completeStage.deliverable.launchCmd, 'npm run dev')
})

test('AP-v2: extractDeliverable は安全でない URL (javascript:) を拒否する', () => {
  const d = extractDeliverable({
    tasks: [{
      id: 't_xss',
      status: 'done',
      title: 'Test',
      result: 'Preview: javascript:alert(1)\nLaunch: node app.js',
    }],
  })
  assert.equal(d.previewUrl, null)
  assert.equal(d.launchCmd, 'node app.js')
})

test('AP-v2: 127.0.0.1 や 192.168.x.x を除外し同一オリジンプレビューを優先する', () => {
  assert.equal(isReachablePublicUrl('http://127.0.0.1:4173'), false)
  assert.equal(isReachablePublicUrl('http://localhost:3000'), false)
  assert.equal(isReachablePublicUrl('http://192.168.100.148:4173'), false)
  assert.equal(isReachablePublicUrl('https://example.ts.net/app'), true)
  assert.equal(isSameOriginPreviewUrl('/api/boards/b-news/preview-files/'), true)

  const fromLocalOnly = extractDeliverable({
    tasks: [{
      id: 't_local',
      status: 'done',
      title: 'B News',
      result: 'Preview: http://192.168.100.148:4173/\nLaunch: npm run preview',
    }],
    preview: {
      ok: true,
      kind: 'static',
      board: 'b-news',
      url: '/api/boards/b-news/preview-files/',
      entry: 'dist/index.html',
      launchCmd: 'npm run dev',
    },
  })
  assert.equal(fromLocalOnly.previewUrl, '/api/boards/b-news/preview-files/')
  assert.equal(fromLocalOnly.launchCmd, 'npm run preview')

  const strippedNoStatic = extractDeliverable({
    tasks: [{
      id: 't_stripped',
      status: 'done',
      title: 'B News',
      result: 'Preview: http://127.0.0.1:4173/',
    }],
  })
  assert.equal(strippedNoStatic.previewUrl, null)
})

test('AP-3/4: createUndoEntry / resolveHoldOutcome / createRemixPending', () => {
  const entry = createUndoEntry({ key: 't1:q1', text: 'Layout' }, 'go', 1000)
  assert.equal(isUndoActive(entry, 2500), true)
  assert.equal(isUndoActive(entry, 4000), false)

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

  const card = { key: 't1:q1', taskId: 't1', questionId: 'q1' }
  assert.equal(createRemixPending(card, 1000).expiresAt, 3000)
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

test('DECK-SPLIT: バレルは 27 名の公開契約を維持する', async () => {
  const barrel = await import('../src/lib/autopilotDeck.js')
  assert.deepEqual(Object.keys(barrel).sort(), [
    'AUTOPILOT_RECIPES',
    'EDGE_DEAD_ZONE_PX',
    'MAX_STYLE_GACHA',
    'REMIX_CHIPS',
    'REMIX_CHIP_WINDOW_MS',
    'STYLE_GACHA_PRESETS',
    'SWIPE_STAMPS',
    'SWIPE_THRESHOLD_PX',
    'UNDO_WINDOW_MS',
    'buildAnswerPayload',
    'buildDeckFromSheet',
    'buildRemixPayload',
    'classifySwipe',
    'createRemixPending',
    'createUndoEntry',
    'currentOptionCard',
    'extractDeliverable',
    'isInEdgeDeadZone',
    'isReachablePublicUrl',
    'isSameOriginPreviewUrl',
    'isUndoActive',
    'nextOptionIndex',
    'projectStudioStage',
    'resolveHoldOutcome',
    'resolveOptionSwipe',
    'resolveStoryTapZone',
    'translateActivity',
  ])
})
