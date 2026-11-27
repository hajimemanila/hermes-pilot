/**
 * Autopilot v2 スワイプデッキ & 4 幕スタジオ投影の純関数群。
 * 1 選択肢 = 1 カード（A → 左スワイプで B → C → REMIX）、ライブ実況翻訳、成果物抽出を担う。
 */

export const EDGE_DEAD_ZONE_PX = 24
export const SWIPE_THRESHOLD_PX = 90
export const UNDO_WINDOW_MS = 3000
export const REMIX_CHIP_WINDOW_MS = 2000
export const MAX_STYLE_GACHA = 3

export const STYLE_GACHA_PRESETS = [
  { id: 'minimal', icon: '◻', labelKey: 'autopilot.gacha.minimal' },
  { id: 'neon', icon: '⚡', labelKey: 'autopilot.gacha.neon' },
  { id: 'retro', icon: '📼', labelKey: 'autopilot.gacha.retro' },
  { id: 'editorial', icon: '📰', labelKey: 'autopilot.gacha.editorial' },
  { id: 'bento', icon: '🍱', labelKey: 'autopilot.gacha.bento' },
]

/** Instagram ストーリー風フリック比較のタップ領域判定（左45%: 前案 / 右45%: 次案）。 */
export function resolveStoryTapZone(clientX, rect) {
  const x = Number(clientX)
  const left = Number(rect?.left)
  const width = Number(rect?.width)
  if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) {
    return 'center'
  }
  const ratio = (x - left) / width
  if (ratio <= 0.45) return 'prev'
  if (ratio >= 0.55) return 'next'
  return 'center'
}

/** 選択肢添字の循環移動（`0 .. totalCount - 1`）。 */
export function nextOptionIndex(currentIdx, totalCount, delta = 1) {
  const total = Number(totalCount) || 0
  if (total <= 1) return 0
  const cur = (((Number(currentIdx) || 0) % total) + total) % total
  const step = Number(delta) || 0
  return (((cur + step) % total) + total) % total
}

export const SWIPE_STAMPS = {
  right: 'GO',
  left: 'NEXT',
  up: 'ANNOTATE',
  down: 'HOLD',
}

export const REMIX_CHIPS = [
  { id: 'theme', icon: '🎨', labelKey: 'autopilot.remix.theme' },
  { id: 'simpler', icon: '📐', labelKey: 'autopilot.remix.simpler' },
  { id: 'denser', icon: '📊', labelKey: 'autopilot.remix.denser' },
  { id: 'note', icon: '💬', labelKey: 'autopilot.remix.note' },
]

/** 第1幕: ライト層向けのビジュアル・スターターカード（i18n キー参照、日本語直書き禁止）。 */
export const AUTOPILOT_RECIPES = [
  {
    id: 'timer',
    icon: '⏱',
    accent: 'cyan',
    titleKey: 'autopilot.recipe.timerTitle',
    subKey: 'autopilot.recipe.timerSub',
    seedKey: 'autopilot.recipe.timerSeed',
  },
  {
    id: 'habit',
    icon: '✅',
    accent: 'emerald',
    titleKey: 'autopilot.recipe.habitTitle',
    subKey: 'autopilot.recipe.habitSub',
    seedKey: 'autopilot.recipe.habitSeed',
  },
  {
    id: 'polish',
    icon: '🎨',
    accent: 'amber',
    titleKey: 'autopilot.recipe.polishTitle',
    subKey: 'autopilot.recipe.polishSub',
    seedKey: 'autopilot.recipe.polishSeed',
  },
  {
    id: 'tracker',
    icon: '📊',
    accent: 'violet',
    titleKey: 'autopilot.recipe.trackerTitle',
    subKey: 'autopilot.recipe.trackerSub',
    seedKey: 'autopilot.recipe.trackerSeed',
  },
]

export function isInEdgeDeadZone(startX, viewportWidth, edgePx = EDGE_DEAD_ZONE_PX) {
  const x = Number(startX)
  const w = Number(viewportWidth)
  if (!Number.isFinite(x)) return false
  if (x <= edgePx) return true
  if (Number.isFinite(w) && w > 0 && x >= w - edgePx) return true
  return false
}

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

/** 生ツール名を初心者向けの親しみやすい実況 i18n キーへ変換する。 */
export function translateActivity(toolName, fallbackTitle = '') {
  const s = `${toolName || ''} ${fallbackTitle || ''}`.toLowerCase()
  if (/test|assert|verify|check|vitest|playwright|pytest/.test(s)) return 'autopilot.live.actTest'
  if (/build|vite|bundle|compile|deploy/.test(s)) return 'autopilot.live.actBuild'
  if (/shot|preview|browser|visual|png|html/.test(s)) return 'autopilot.live.actPreview'
  if (/write|edit|patch|create|style|css|jsx|tsx/.test(s)) return 'autopilot.live.actWrite'
  if (/read|grep|rg|search|inspect|list/.test(s)) return 'autopilot.live.actInspect'
  return 'autopilot.live.actWorking'
}

const PREVIEW_URL_RE = /(?:Preview|URL|Open|App):\s*(https?:\/\/[^\s)>"'`]+)/i
const FALLBACK_HTTP_RE = /\b(https?:\/\/(?:localhost|127\.0\.0\.1|[^\s/]+\.[^\s/]+)[^\s)>"'`]*)/i
const LAUNCH_CMD_RE = /(?:Launch|Start|Run|Command):\s*`?([^\n`]+)`?/i
const ENTRY_HTML_RE = /(?:Preview|Entry):\s*`?([A-Za-z0-9._/-]+\.html?)`?/i

export function isSameOriginPreviewUrl(raw) {
  const s = String(raw || '').trim()
  return /^\/api\/boards\/[^/]+\/preview-files\//.test(s) || s === './'
}

export function isReachablePublicUrl(raw) {
  const s = String(raw || '').trim()
  if (!/^https?:\/\//i.test(s)) return false
  try {
    const u = new URL(s)
    const host = String(u.hostname || '').toLowerCase()
    if (!host) return false
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') return false
    if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    if (host.endsWith('.local')) return false
    return true
  } catch {
    return false
  }
}

/**
 * 完了レポート・完了タスク・ボード静的プレビューから成果物の確認導線を抽出する。
 * 母艦ローカル (`127.0.0.1` / `localhost`) や一時 LAN IP (`192.168.x.x`) は除外し、
 * 同一オリジン `/api/boards/:board/preview-files/` を最優先する。
 */
export function extractDeliverable({ report = null, tasks = [], reviewItems = [], preview = null } = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const doneTasks = list
    .filter((t) => String(t?.status || '').toLowerCase() === 'done')
    .sort((a, b) => Number(b.completed_at ?? b.created_at ?? 0) - Number(a.completed_at ?? a.created_at ?? 0))
  const hasStaticPreview = preview?.kind === 'static' && isSameOriginPreviewUrl(preview?.url)
  if (!report && doneTasks.length === 0 && !hasStaticPreview) return null

  const blobs = [
    String(report?.text ?? ''),
    ...doneTasks.slice(0, 5).map((t) => `${t.title || ''}\n${t.result || ''}\n${t.body || ''}`),
  ].filter(Boolean)
  const merged = blobs.join('\n')

  const urlMatch = PREVIEW_URL_RE.exec(merged) || FALLBACK_HTTP_RE.exec(merged)
  const scrapedUrl = urlMatch && isReachablePublicUrl(urlMatch[1]) ? urlMatch[1].trim() : null
  const previewUrl =
    hasStaticPreview
      ? preview.url
      : isReachablePublicUrl(preview?.url)
        ? preview.url
        : scrapedUrl
  const entryMatch = ENTRY_HTML_RE.exec(merged)
  const entryPath = (entryMatch && entryMatch[1]) || preview?.entry || null
  const launchMatch = LAUNCH_CMD_RE.exec(merged)
  const launchCmd = (launchMatch ? launchMatch[1].trim().slice(0, 160) : null) || preview?.launchCmd || null

  const latestVisual = (Array.isArray(reviewItems) ? reviewItems : []).find((r) => r?.review?.image)
  const shotUrl = latestVisual ? `/api/review/${encodeURIComponent(latestVisual.id)}/image` : null
  const topTask = doneTasks[0] || null
  const id = String(report?.taskId || report?.at || topTask?.id || preview?.updatedAt || 'done')
  return {
    id,
    title: String(topTask?.title || report?.label || report?.spec || preview?.board || 'Completed'),
    summary: String(topTask?.result || report?.text || '').split('\n')[0].slice(0, 180),
    previewUrl,
    entryPath,
    launchCmd,
    shotUrl,
    completedAt: Number(report?.at || (topTask?.completed_at ? topTask.completed_at * 1000 : 0)) || null,
    board: report?.board || preview?.board || null,
    spec: report?.spec || topTask?.spec || null,
  }
}

const OPEN_STATUSES = new Set(['running', 'ready', 'blocked', 'review', 'in_progress', 'claimed'])

/**
 * 現在のボード／ジョブ状態から Autopilot の 4 幕ステージを判定する純関数。
 */
export function projectStudioStage({
  cards = [],
  jobs = [],
  live = null,
  tasks = [],
  specReports = [],
  reviewItems = [],
  preview = null,
  dismissedCompleteId = null,
} = {}) {
  if (Array.isArray(cards) && cards.length > 0) {
    return { act: 'deck', cards }
  }

  const jobList = (Array.isArray(jobs) ? jobs : []).filter((j) => j && !j.dismissed)
  const activeJob =
    jobList.find((j) => ['running', 'awaiting_spec', 'awaiting_review', 'spec_ready'].includes(String(j.status))) || null
  const taskList = Array.isArray(tasks) ? tasks : []
  const openTasks = taskList.filter((t) => OPEN_STATUSES.has(String(t?.status || '').toLowerCase()))
  const runningTask = openTasks.find((t) => ['running', 'in_progress', 'claimed'].includes(String(t?.status || '').toLowerCase())) || openTasks[0] || null
  const turns = Array.isArray(live?.turns) ? live.turns : []
  const liveTurn = turns[0] || null

  if (activeJob || openTasks.length > 0 || liveTurn) {
    const doneCount = taskList.filter((t) => String(t?.status || '').toLowerCase() === 'done').length
    const totalCount = taskList.length
    const phase = String(activeJob?.phase || '')
    const rawTool = liveTurn?.lastTool?.name || liveTurn?.lastActivity || ''
    const activityKey = translateActivity(rawTool, runningTask?.title || activeJob?.seed || '')
    let stepIndex = 1
    if (['spawning', 'round1_sheet', 'awaiting_review'].includes(phase) || totalCount === 0) {
      stepIndex = 0
    } else if (activityKey === 'autopilot.live.actTest' || activityKey === 'autopilot.live.actPreview') {
      stepIndex = 2
    } else if (phase === 'spec_ready' || (totalCount > 0 && doneCount >= totalCount)) {
      stepIndex = 3
    }
    const compareItem = (Array.isArray(reviewItems) ? reviewItems : []).find((r) => r?.review?.image) || null
    return {
      act: 'live',
      activeJob,
      activeTask: runningTask,
      liveTurn,
      stepIndex,
      doneCount,
      totalCount,
      activityKey,
      toolLabel: rawTool || runningTask?.title || activeJob?.seed || '',
      elapsedSec: activeJob?.elapsedSec ?? null,
      compareItem,
    }
  }

  const report = Array.isArray(specReports) ? specReports[0] || null : specReports
  const deliverable = extractDeliverable({ report, tasks: taskList, reviewItems, preview })
  if (deliverable && deliverable.id !== dismissedCompleteId) {
    return { act: 'complete', deliverable }
  }

  return { act: 'start' }
}
