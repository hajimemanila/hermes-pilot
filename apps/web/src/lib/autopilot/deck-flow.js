import { REMIX_CHIP_WINDOW_MS, UNDO_WINDOW_MS } from './deck-core.js'
function normalizeQuestionOptions(q, fallbackTitle) {
  const rawOpts = Array.isArray(q?.options) ? q.options : []
  if (rawOpts.length > 0) {
    return rawOpts.map((o, idx) => ({
      id: String(o?.id ?? String.fromCharCode(65 + idx)),
      label: String(o?.label ?? ''),
      detail: String(o?.detail ?? ''),
      recommended: Boolean(o?.recommended),
      thumb: o?.thumb || null,
      visualMock: o?.visualMock || null,
    }))
  }
  return [
    {
      id: 'A',
      label: String(fallbackTitle || q?.text || 'Option A'),
      detail: '',
      recommended: true,
      thumb: null,
      visualMock: q?.visualMock || null,
    },
  ]
}

export function buildDeckFromSheet(task, sheetData) {
  const taskId = String(task?.id ?? '')
  const data = sheetData?.data ?? sheetData ?? {}
  const qs = Array.isArray(data?.questions) ? data.questions : []
  if (qs.length === 0) {
    const vm = data?.visualMock || (task?.review?.image ? { shot: task.review.image } : null)
    return [
      {
        key: `${taskId}:visual`,
        taskId,
        questionId: 'visual',
        index: 0,
        total: 1,
        kind: 'visual',
        title: String(task?.title || data?.title || 'Visual Review'),
        text: String(task?.review?.note || ''),
        options: normalizeQuestionOptions({ visualMock: vm }, task?.title || data?.title),
        recommendedId: 'A',
        visualMock: vm,
        templateKind: vm?.template || 'layout-card',
      },
    ]
  }
  return qs.map((q, idx) => {
    const opts = normalizeQuestionOptions(q, q.text)
    const rec = opts.find((o) => o.recommended) || opts[0]
    const vm = q.visualMock || (idx === 0 ? data?.visualMock : null) || null
    return {
      key: `${taskId}:${q.id || `q${idx + 1}`}`,
      taskId,
      questionId: String(q.id || `q${idx + 1}`),
      index: idx,
      total: qs.length,
      kind: q.kind === 'brainstorm' ? 'brainstorm' : 'question',
      title: String(data?.title || task?.title || ''),
      text: String(q.text || ''),
      options: opts,
      recommendedId: rec ? String(rec.id) : 'A',
      visualMock: vm,
      templateKind: vm?.template || (idx === 0 ? 'layout-card' : idx === 1 ? 'flow-card' : 'policy-card'),
    }
  })
}

/**
 * 1 選択肢 = 1 カードの表示モデルを返す（オプション切替で即座に差し替わる）。
 * @param {object|null} card デッキ内の設問ノード
 * @param {number} [optionIndex] 現在表示中の選択肢添字
 */
export function currentOptionCard(card, optionIndex = 0) {
  if (!card) return null
  const opts = Array.isArray(card.options) && card.options.length > 0 ? card.options : normalizeQuestionOptions(card, card.text)
  const safeIdx = Math.max(0, Math.min(opts.length - 1, Number(optionIndex) || 0))
  const option = opts[safeIdx]
  const vm = option?.visualMock || card.visualMock || null
  const shot = vm?.shot || option?.thumb || null
  const mockHtml = vm?.html ? String(vm.html) : null
  const mockUrl =
    mockHtml && card.taskId
      ? `/api/review/${encodeURIComponent(card.taskId)}/mock?file=${encodeURIComponent(mockHtml)}`
      : null
  return {
    question: card,
    option,
    optionIndex: safeIdx,
    optionCount: opts.length,
    isLastOption: safeIdx >= opts.length - 1,
    shot,
    mockHtml,
    mockUrl,
    layoutVariant: vm?.layoutVariant || String(option?.id || 'A'),
    theme: vm?.theme || (safeIdx === 0 ? 'cyan' : safeIdx === 1 ? 'amber' : 'violet'),
    templateKind: vm?.template || card.templateKind || 'layout-card',
  }
}

/**
 * 選択肢カードでのスワイプ結果を決定する（A → 左スワイプで B → C → 最後に REMIX チップ）。
 * @param {object} card
 * @param {number} optionIndex
 * @param {'right'|'left'|'up'|'down'} direction
 */
export function resolveOptionSwipe(card, optionIndex, direction) {
  const view = currentOptionCard(card, optionIndex)
  if (!view) return null
  if (direction === 'right') {
    return { type: 'adopt', choice: view.option.id, advanceQuestion: true }
  }
  if (direction === 'left') {
    if (!view.isLastOption) {
      return { type: 'next-option', nextOptionIndex: view.optionIndex + 1, advanceQuestion: false }
    }
    return { type: 'remix-chips', advanceQuestion: false }
  }
  if (direction === 'up') {
    return { type: 'annotate', choice: view.option.id, advanceQuestion: false }
  }
  return { type: 'hold', outcome: resolveHoldOutcome(card), advanceQuestion: true }
}

export function buildAnswerPayload(cards, decisions = {}) {
  const answers = []
  const annotations = []
  for (const card of cards) {
    const dec = decisions[card.key]
    if (!dec) continue
    const choice = dec.action === 'hold' ? null : (dec.choice ?? card.recommendedId ?? null)
    answers.push({
      id: card.questionId,
      choice,
      note: String(dec.note ?? ''),
    })
    if (dec.action === 'annotate' && dec.annotation) {
      annotations.push({
        questionId: card.questionId,
        shot: dec.shot ?? card.visualMock?.shot ?? null,
        marks: Array.isArray(dec.annotation.marks) ? dec.annotation.marks : [],
        note: String(dec.annotation.note ?? ''),
      })
    }
  }
  return { answers, global: '', annotations }
}

export function createUndoEntry(card, action, now = Date.now(), windowMs = UNDO_WINDOW_MS, prevOptionIndex = 0) {
  return {
    cardKey: String(card?.key ?? ''),
    title: String(card?.text || card?.title || ''),
    action,
    prevOptionIndex,
    createdAt: now,
    expiresAt: now + windowMs,
  }
}

export function isUndoActive(entry, now = Date.now()) {
  return Boolean(entry && Number.isFinite(entry.expiresAt) && now < entry.expiresAt)
}

export function resolveHoldOutcome(card) {
  if (card?.kind === 'brainstorm') {
    return {
      kind: 'memo',
      action: 'hold',
      choice: null,
      memoText: String(card.text || card.title || '').trim(),
    }
  }
  return {
    kind: 'delegate',
    action: 'hold',
    choice: null,
  }
}

export function createRemixPending(card, now = Date.now(), windowMs = REMIX_CHIP_WINDOW_MS, autoFire = true) {
  return {
    card,
    cardKey: String(card?.key ?? ''),
    taskId: String(card?.taskId ?? ''),
    questionId: String(card?.questionId ?? ''),
    expiresAt: now + windowMs,
    autoFire: Boolean(autoFire),
  }
}

export function buildRemixPayload(card, reason = 'alternative', hint = '', stylePreset = null) {
  const payload = {
    questionId: String(card?.questionId ?? ''),
    reason: String(reason || 'alternative'),
    hint: String(hint || '').trim(),
  }
  if (stylePreset) payload.stylePreset = String(stylePreset)
  return payload
}
