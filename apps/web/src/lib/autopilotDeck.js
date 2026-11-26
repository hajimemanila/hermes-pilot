/**
 * Autopilot スワイプデッキの純関数群（AP-3 / AP-4）。
 * デッドゾーン判定・90px 閾値・4 方向スタンプ・デッキ構築・Undo 状態・回答組み立てを担う。
 */

export const EDGE_DEAD_ZONE_PX = 24
export const SWIPE_THRESHOLD_PX = 90
export const UNDO_WINDOW_MS = 3000
export const REMIX_CHIP_WINDOW_MS = 2000

export const SWIPE_STAMPS = {
  right: 'GO',
  left: 'REMIX',
  up: 'ANNOTATE',
  down: 'HOLD',
}

export const REMIX_CHIPS = [
  { id: 'theme', icon: '🎨', labelKey: 'autopilot.remix.theme' },
  { id: 'simpler', icon: '📐', labelKey: 'autopilot.remix.simpler' },
  { id: 'denser', icon: '📊', labelKey: 'autopilot.remix.denser' },
  { id: 'note', icon: '💬', labelKey: 'autopilot.remix.note' },
]

/**
 * 左右端のブラウザ戻るジェスチャー用デッドゾーン内か判定する。
 * @param {number} startX ポインタ開始 X 座標
 * @param {number} viewportWidth 画面幅
 * @param {number} [edgePx]
 * @returns {boolean}
 */
export function isInEdgeDeadZone(startX, viewportWidth, edgePx = EDGE_DEAD_ZONE_PX) {
  const x = Number(startX)
  const w = Number(viewportWidth)
  if (!Number.isFinite(x)) return false
  if (x <= edgePx) return true
  if (Number.isFinite(w) && w > 0 && x >= w - edgePx) return true
  return false
}

/**
 * ドラッグ変位 (dx, dy) からスワイプ方向・ゴーストスタンプ・進捗・確定有無を返す。
 * @param {number} dx
 * @param {number} dy
 * @param {number} [thresholdPx]
 * @returns {{direction: 'right'|'left'|'up'|'down'|null, stamp: string|null, progress: number, committed: boolean}}
 */
export function classifySwipe(dx, dy, thresholdPx = SWIPE_THRESHOLD_PX) {
  const x = Number(dx) || 0
  const y = Number(dy) || 0
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  if (ax < 12 && ay < 12) {
    return { direction: null, stamp: null, progress: 0, committed: false }
  }
  let direction = null
  let dominant = 0
  if (ax >= ay * 1.1) {
    direction = x > 0 ? 'right' : 'left'
    dominant = ax
  } else if (ay >= ax * 1.1) {
    direction = y < 0 ? 'up' : 'down'
    dominant = ay
  } else {
    return { direction: null, stamp: null, progress: 0, committed: false }
  }
  const progress = Math.min(1, dominant / Math.max(1, thresholdPx))
  return {
    direction,
    stamp: SWIPE_STAMPS[direction] || null,
    progress,
    committed: dominant >= thresholdPx,
  }
}

/**
 * レビュータスクとシート JSON から Autopilot カードデッキを組み立てる。
 * @param {object} task
 * @param {object|null} sheetData
 * @returns {Array<object>}
 */
export function buildDeckFromSheet(task, sheetData) {
  const taskId = String(task?.id ?? '')
  const data = sheetData?.data ?? sheetData ?? {}
  const qs = Array.isArray(data?.questions) ? data.questions : []
  if (qs.length === 0) {
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
        options: [],
        recommendedId: 'A',
        visualMock: data?.visualMock || (task?.review?.image ? { shot: task.review.image } : null),
        templateKind: data?.visualMock?.template || 'layout-card',
      },
    ]
  }
  return qs.map((q, idx) => {
    const opts = Array.isArray(q?.options) ? q.options : []
    const rec = opts.find((o) => o?.recommended) || opts[0]
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
      recommendedId: rec ? String(rec.id) : null,
      visualMock: q.visualMock || (idx === 0 ? data?.visualMock : null) || null,
      templateKind: q.visualMock?.template || (idx === 0 ? 'layout-card' : idx === 1 ? 'flow-card' : 'policy-card'),
    }
  })
}

/**
 * デッキの各カード決定から `POST /api/review/:id/answer` 用ペイロードを組み立てる。
 * @param {Array<object>} cards
 * @param {Record<string, {action: 'go'|'hold'|'annotate', choice?: string|null, note?: string, annotation?: object}>} decisions
 * @returns {{answers: Array<{id: string, choice: string|null, note: string}>, global: string, annotations: Array<object>}}
 */
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
        shot: card.visualMock?.shot ?? null,
        marks: Array.isArray(dec.annotation.marks) ? dec.annotation.marks : [],
        note: String(dec.annotation.note ?? ''),
      })
    }
  }
  return { answers, global: '', annotations }
}

/**
 * 3 秒 Undo ピル用のエントリを作る。
 * @param {object} card
 * @param {string} action
 * @param {number} [now]
 * @param {number} [windowMs]
 */
export function createUndoEntry(card, action, now = Date.now(), windowMs = UNDO_WINDOW_MS) {
  return {
    cardKey: String(card?.key ?? ''),
    title: String(card?.text || card?.title || ''),
    action,
    createdAt: now,
    expiresAt: now + windowMs,
  }
}

/**
 * Undo エントリがまだ有効期限内か判定する。
 * @param {object|null} entry
 * @param {number} [now]
 */
export function isUndoActive(entry, now = Date.now()) {
  return Boolean(entry && Number.isFinite(entry.expiresAt) && now < entry.expiresAt)
}

/**
 * 下スワイプ（HOLD）の文脈別分岐（AP-4）。
 * 設問カードは recommended 委譲、Brainstorm カードは MemosPane 保存。
 * @param {object} card
 * @returns {{kind: 'memo'|'delegate', action: 'hold', choice: null, memoText?: string}}
 */
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

/**
 * 左スワイプ直後の 2 秒ワンタップ REMIX チップ待機状態を作る。
 * @param {object} card
 * @param {number} [now]
 * @param {number} [windowMs]
 */
export function createRemixPending(card, now = Date.now(), windowMs = REMIX_CHIP_WINDOW_MS) {
  return {
    card,
    cardKey: String(card?.key ?? ''),
    taskId: String(card?.taskId ?? ''),
    questionId: String(card?.questionId ?? ''),
    expiresAt: now + windowMs,
  }
}

/**
 * `POST /api/review/:id/remix` 用のペイロードを組み立てる。
 * @param {object} card
 * @param {string} [reason]
 * @param {string} [hint]
 */
export function buildRemixPayload(card, reason = 'alternative', hint = '') {
  return {
    questionId: String(card?.questionId ?? ''),
    reason: String(reason || 'alternative'),
    hint: String(hint || '').trim(),
  }
}
