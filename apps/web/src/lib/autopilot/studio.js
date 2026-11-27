/**
 * Autopilot v2 の 4 幕スタジオ投影・成果物抽出（純関数・自己完結。deck-core の定数は参照しない）。
 * 旧 `lib/autopilotDeck.js` の :330-492 を移動したもの。公開契約は `lib/autopilotDeck.js`（バレル）が固定する。
 */
import { HM_STORAGE } from '../../contracts/storage.js'

const RUN_ANCHOR_KEY = HM_STORAGE.AUTOPILOT_RUN

function toMs(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * Format elapsed milliseconds as `MM:SS` (or `H:MM:SS` when >= 1 hour).
 * @param {unknown} elapsedMs
 * @returns {string}
 */
export function formatElapsedClock(elapsedMs) {
  const totalSec = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000))
  const hours = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  const pad = (v) => String(v).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`
}

function loadAnchorMap() {
  try {
    const raw = globalThis.localStorage?.getItem(RUN_ANCHOR_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveAnchorMap(map) {
  try {
    globalThis.localStorage?.setItem(RUN_ANCHOR_KEY, JSON.stringify(map))
  } catch {
    /* ignore storage quota/privacy restrictions */
  }
}

/** Read persisted Autopilot run anchor (`{ runId, startedAt, maxTokens }`) for a board. */
export function readAutopilotRunAnchor(boardKey) {
  const key = String(boardKey || 'default')
  const map = loadAnchorMap()
  const entry = map[key]
  if (!entry || !Number(entry.startedAt)) return null
  return {
    runId: String(entry.runId || key),
    startedAt: Number(entry.startedAt),
    maxTokens: Math.max(0, Number(entry.maxTokens) || 0),
  }
}

/** Persist Autopilot run anchor (`{ runId, startedAt, maxTokens }`) for a board. */
export function writeAutopilotRunAnchor(boardKey, anchor) {
  const key = String(boardKey || 'default')
  const map = loadAnchorMap()
  if (!anchor || !Number(anchor.startedAt)) {
    delete map[key]
  } else {
    map[key] = {
      runId: String(anchor.runId || key),
      startedAt: Number(anchor.startedAt),
      maxTokens: Math.max(0, Number(anchor.maxTokens) || 0),
    }
  }
  saveAnchorMap(map)
}

/** Clear persisted Autopilot run anchor for a board. */
export function clearAutopilotRunAnchor(boardKey) {
  writeAutopilotRunAnchor(boardKey, null)
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

  const reviewList = Array.isArray(reviewItems) ? reviewItems : []
  const latestVisual = reviewList.find((r) => r?.review?.image) || null
  const shotUrl = latestVisual ? `/api/review/${encodeURIComponent(latestVisual.id)}/image` : null
  const earlierVisual = reviewList.find((r) => r?.review?.image && r.id !== latestVisual?.id) || null
  const beforeShotUrl = latestVisual?.review?.hasCompare
    ? `${shotUrl}?compare=1`
    : earlierVisual
      ? `/api/review/${encodeURIComponent(earlierVisual.id)}/image`
      : null
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
    beforeShotUrl,
    completedAt: Number(report?.at || (topTask?.completed_at ? topTask.completed_at * 1000 : 0)) || null,
    board: report?.board || preview?.board || null,
    spec: report?.spec || topTask?.spec || null,
  }
}

const OPEN_STATUSES = new Set(['running', 'ready', 'blocked', 'review', 'in_progress', 'claimed'])
const RUNNING_STATUSES = new Set(['running', 'in_progress', 'claimed'])

/**
 * Phase-weighted monotonic progress (0..100) that never drops when SPEC batches are filed
 * or when a test failure loops back to an edit tool.
 * @param {{phase?: string, doneCount?: number, runningCount?: number, totalCount?: number}} [opts]
 * @returns {{stepIndex: number, progressPct: number}}
 */
export function computeStudioProgress({
  phase = '',
  doneCount = 0,
  runningCount = 0,
  totalCount = 0,
} = {}) {
  const done = Math.max(0, Number(doneCount) || 0)
  const total = Math.max(0, Number(totalCount) || 0)
  const running = Math.max(0, Number(runningCount) || 0)

  if (total === 0) {
    let progressPct = 12
    if (phase === 'spawning') progressPct = 8
    else if (phase === 'round1_sheet') progressPct = 14
    else if (phase === 'awaiting_review') progressPct = 18
    else if (phase === 'round2_spec') progressPct = 20
    else if (phase === 'spec_ready' || phase === 'launched') progressPct = 20
    return { stepIndex: 0, progressPct }
  }

  if (done >= total || phase === 'spec_ready') {
    return { stepIndex: 3, progressPct: 92 }
  }

  const partial = Math.min(running, Math.max(0, total - done)) * 0.35
  const progressPct = Math.min(85, Math.max(20, 20 + Math.round(((done + partial) / total) * 65)))
  const stepIndex = progressPct >= 60 || done >= Math.ceil(total / 2) ? 2 : 1
  return { stepIndex, progressPct }
}

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
  runStartedAt = null,
} = {}) {
  if (Array.isArray(cards) && cards.length > 0) {
    return { act: 'deck', cards }
  }

  const jobList = (Array.isArray(jobs) ? jobs : []).filter((j) => j && !j.dismissed)
  const activeJob =
    jobList.find((j) => ['running', 'awaiting_spec', 'awaiting_review', 'spec_ready'].includes(String(j.status))) || null
  const taskList = Array.isArray(tasks) ? tasks : []
  const openTasks = taskList.filter((t) => OPEN_STATUSES.has(String(t?.status || '').toLowerCase()))
  const activeTasks = openTasks.filter((t) => RUNNING_STATUSES.has(String(t?.status || '').toLowerCase()))
  const runningTask = activeTasks[0] || openTasks[0] || null
  const turns = Array.isArray(live?.turns) ? live.turns : []
  const liveTurn = turns[0] || null

  if (activeJob || openTasks.length > 0 || liveTurn) {
    const openStarts = openTasks
      .map((t) => toMs(t?.startedAt ?? t?.createdAt ?? t?.created_at ?? t?.started_at))
      .filter((ms) => ms > 0)
    const effectiveRunStart =
      toMs(runStartedAt) ||
      toMs(activeJob?.startedAt ?? activeJob?.createdAt) ||
      (openStarts.length ? Math.min(...openStarts) : 0) ||
      toMs(liveTurn?.startedAt) ||
      null

    const runTasks = effectiveRunStart
      ? taskList.filter((t) => {
          const st = String(t?.status || '').toLowerCase()
          if (OPEN_STATUSES.has(st)) return true
          const ts = toMs(t?.createdAt ?? t?.created_at ?? t?.startedAt ?? t?.started_at)
          return ts > 0 && ts >= effectiveRunStart - 10_000
        })
      : taskList
    const batchTasks = runTasks.filter((t) => {
      const title = String(t?.title || '').trim()
      const assignee = String(t?.assignee || '').toLowerCase()
      return !/^\[(arch|review)\]/i.test(title) && assignee !== 'architect'
    })
    const doneCount = batchTasks.filter((t) => String(t?.status || '').toLowerCase() === 'done').length
    const totalCount = batchTasks.length
    const runningCount = Math.max(activeTasks.length, liveTurn ? 1 : 0)
    const phase = String(activeJob?.phase || '')
    const rawTool = liveTurn?.lastTool?.name || liveTurn?.lastActivity || ''
    const activityKey = translateActivity(rawTool, runningTask?.title || activeJob?.seed || '')
    const { stepIndex, progressPct } = computeStudioProgress({
      phase,
      doneCount,
      runningCount,
      totalCount,
    })
    const runKey = String(activeJob?.id || activeTaskSpec(runningTask) || runningTask?.id || liveTurn?.sessionId || 'live')
    const compareItem = (Array.isArray(reviewItems) ? reviewItems : []).find((r) => r?.review?.image) || null
    return {
      act: 'live',
      activeJob,
      activeTask: runningTask,
      activeTasks,
      liveTurn,
      live,
      stepIndex,
      progressPct,
      runKey,
      runStartedAt: effectiveRunStart,
      doneCount,
      runningCount,
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

function activeTaskSpec(task) {
  return task?.spec || null
}
