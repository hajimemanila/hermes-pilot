/**
 * Pure orbital telemetry projection helpers for LiveRadarCard (SPEC-PANOPTES-RADAR / PN-2).
 *
 * Clean-room React + SVG radar layout inspired by the telemetry concepts in
 * `huwhitememes/panoptes` (MIT License) with zero external chart dependencies.
 */

export const RADAR_SIZE = 220
export const RADAR_CENTER = 110
export const ORBIT_RADIUS = 78

export const RING_RADII = Object.freeze({
  core: 34,
  verify: 62,
  explore: 86,
})

const RAW_STATIONS = [
  { id: 'you', code: 'YOU', stageKey: 'autopilot.radar.stageYou', angleDeg: -90 },
  { id: 'files', code: 'FILES', stageKey: 'autopilot.radar.stageFiles', angleDeg: -45 },
  { id: 'shell', code: 'SHELL', stageKey: 'autopilot.radar.stageShell', angleDeg: 0 },
  { id: 'web', code: 'WEB', stageKey: 'autopilot.radar.stageWeb', angleDeg: 45 },
  { id: 'browser', code: 'BROWSER', stageKey: 'autopilot.radar.stageBrowser', angleDeg: 90 },
  { id: 'agents', code: 'AGENTS', stageKey: 'autopilot.radar.stageAgents', angleDeg: 135 },
  { id: 'memory', code: 'MEMORY', stageKey: 'autopilot.radar.stageMemory', angleDeg: 180 },
  { id: 'tools', code: 'TOOLS', stageKey: 'autopilot.radar.stageTools', angleDeg: 225 },
]

export const RADAR_STATIONS = Object.freeze(
  RAW_STATIONS.map((s) => {
    const angleRad = (s.angleDeg * Math.PI) / 180
    return Object.freeze({
      ...s,
      angleRad,
      cx: Math.round((RADAR_CENTER + Math.cos(angleRad) * ORBIT_RADIUS) * 10) / 10,
      cy: Math.round((RADAR_CENTER + Math.sin(angleRad) * ORBIT_RADIUS) * 10) / 10,
    })
  }),
)

const STATION_BY_ID = Object.freeze(Object.fromEntries(RADAR_STATIONS.map((s) => [s.id, s])))

export const DEMO_RADAR_SEQUENCE = Object.freeze([
  { stationId: 'files', tool: 'edit_file', durationMs: 320 },
  { stationId: 'shell', tool: 'npm run build', durationMs: 1450 },
  { stationId: 'browser', tool: 'render_mocks', durationMs: 1820 },
  { stationId: 'you', tool: 'quick_review', durationMs: 420 },
])

function hashString(input) {
  let h = 2166136261
  const s = String(input ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * Map a raw tool / activity name to one of the 8 Panoptes orbital stations.
 * @param {unknown} toolName
 * @returns {'you'|'files'|'shell'|'web'|'browser'|'agents'|'memory'|'tools'}
 */
export function toolToStation(toolName) {
  const s = String(toolName ?? '').toLowerCase()
  if (/review|question|ask_user|clarify|confirm|approve|user_input/.test(s)) return 'you'
  if (/browser|render_mocks|render-mocks|vision|screenshot|cdp|playwright|mock|preview|dom/.test(s)) return 'browser'
  if (/read_file|write_file|edit_file|patch|grep|rg\b|search_files|find_by_name|glob|\bls\b|list_dir|view_file|\bfile\b/.test(s)) return 'files'
  if (/terminal|bash|shell|exec|run_command|npm|node\b|test|vitest|pytest|vite|build|git\b|deploy|lint/.test(s)) return 'shell'
  if (/web_search|search_web|web_extract|fetch|http|curl|\burl\b|docs|context7/.test(s)) return 'web'
  if (/delegate|subagent|kanban|architect|worker|spawn|swarm|pipeline|\bspec\b/.test(s)) return 'agents'
  if (/memory|memo|session_search|skill|recall|note|journal/.test(s)) return 'memory'
  return 'tools'
}

/**
 * Classify a tool name onto one of three legacy concentric radar rings.
 * @param {unknown} toolName
 * @returns {'core'|'verify'|'explore'}
 */
export function classifyToolRing(toolName) {
  const s = String(toolName ?? '').toLowerCase()
  if (/edit|write|patch|create|build|vite|bundle|style|css/.test(s)) return 'core'
  if (/test|verify|render|mock|browser|vision|check|audit|assert/.test(s)) return 'verify'
  return 'explore'
}

/** Format tool duration cleanly (`420 ms`, `1.8 s`, `12 s`). */
export function formatDurationMs(ms) {
  if (ms === null || ms === undefined || ms === '') return ''
  const v = Number(ms)
  if (!Number.isFinite(v) || v < 0) return ''
  if (v < 1000) return `${Math.round(v)} ms`
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`
  return `${Math.round(v / 1000)} s`
}

/** Format USD cost (`$0.04`, `$1.25`). */
export function formatCostUsd(usd) {
  const v = Math.max(0, Number(usd) || 0)
  return `$${v.toFixed(2)}`
}

/** Determine context-window health ring tone (`<70 ok`, `70..89 warn`, `>=90 danger`). */
export function contextHealthTone(pct) {
  const v = Math.max(0, Number(pct) || 0)
  if (v >= 90) return 'danger'
  if (v >= 70) return 'warn'
  return 'ok'
}

/** Compute pupil `(dx, dy)` displacement pointing toward the active station. */
export function computePupilOffset(station, maxOffset = 7) {
  if (!station || !Number.isFinite(station.angleRad)) return { dx: 0, dy: 0 }
  return {
    dx: Math.round(Math.cos(station.angleRad) * maxOffset * 10) / 10,
    dy: Math.round(Math.sin(station.angleRad) * maxOffset * 10) / 10,
  }
}

function collectSourceTools(liveSnapshot, tasks, activeJob, now) {
  const atMs = now === null || now === undefined ? Date.now() : Number(now)
  const fallbackTaskTitle =
    (Array.isArray(tasks) && tasks[0]?.title) ||
    liveSnapshot?.tasks?.[0]?.title ||
    activeJob?.seed ||
    liveSnapshot?.architect?.[0]?.seed ||
    null

  if (liveSnapshot?.demo && liveSnapshot?.telemetry?.demoSequence) {
    const stepIdx = Math.floor(Math.max(0, atMs) / 1500) % DEMO_RADAR_SEQUENCE.length
    const rotated = []
    for (let i = 0; i < DEMO_RADAR_SEQUENCE.length; i += 1) {
      const entry = DEMO_RADAR_SEQUENCE[(stepIdx - i + DEMO_RADAR_SEQUENCE.length) % DEMO_RADAR_SEQUENCE.length]
      rotated.push({
        name: entry.tool,
        stationId: entry.stationId,
        durationMs: entry.durationMs,
        failed: false,
        errorTail: null,
        taskTitle: fallbackTaskTitle || 'Autopilot Demo Build',
        at: atMs - (i === 0 ? 800 : i * 3200),
      })
    }
    return rotated
  }

  let sourceTools = []
  if (Array.isArray(liveSnapshot?.telemetry?.toolHistory) && liveSnapshot.telemetry.toolHistory.length > 0) {
    sourceTools = liveSnapshot.telemetry.toolHistory
  } else if (Array.isArray(liveSnapshot?.telemetry?.recentTools) && liveSnapshot.telemetry.recentTools.length > 0) {
    sourceTools = liveSnapshot.telemetry.recentTools
  } else if (Array.isArray(liveSnapshot?.turns)) {
    const flattened = []
    for (const turn of liveSnapshot.turns) {
      if (Array.isArray(turn?.recentTools) && turn.recentTools.length > 0) {
        flattened.push(...turn.recentTools)
      } else if (turn?.lastTool?.name) {
        flattened.push(turn.lastTool)
      }
    }
    flattened.sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
    sourceTools = flattened
  }

  if (sourceTools.length === 0 && Array.isArray(tasks) && tasks.length > 0) {
    sourceTools = tasks.map((tk) => ({
      name: tk?.title ? String(tk.title).slice(0, 24) : 'worker',
      taskTitle: tk?.title || null,
      at: tk?.startedAt || now,
    }))
  }

  return sourceTools.filter((t) => t && t.name).map((tool) => ({
    ...tool,
    taskTitle: tool.taskTitle || fallbackTaskTitle,
  }))
}

/**
 * Extract recent tool invocations from `/api/live` snapshot and place them on concentric coordinates.
 * @param {object|null} liveSnapshot
 * @param {{tasks?: Array<object>, activeJob?: object|null, now?: number, maxBlips?: number}} [opts]
 */
export function projectRadarBlips(liveSnapshot, { tasks = [], activeJob = null, now = Date.now(), maxBlips = 6 } = {}) {
  const limit = Math.max(1, Math.min(12, Number(maxBlips) || 6))
  const sourceTools = collectSourceTools(liveSnapshot, tasks, activeJob, now)

  return sourceTools.slice(0, limit).map((tool, idx) => {
    const name = String(tool.name)
    const ring = classifyToolRing(name)
    const stationId = tool.stationId || toolToStation(name)
    const station = STATION_BY_ID[stationId] || STATION_BY_ID.tools
    const radius = RING_RADII[ring]
    const angleDeg = idx * 60 + (hashString(name) % 28) - 90
    const rad = (angleDeg * Math.PI) / 180
    const cx = Math.round(RADAR_CENTER + Math.cos(rad) * radius)
    const cy = Math.round(RADAR_CENTER + Math.sin(rad) * radius)
    const ageSec = tool.at ? Math.max(0, Math.round((now - Number(tool.at)) / 1000)) : idx * 6
    const durationMs = Number.isFinite(Number(tool.durationMs)) ? Number(tool.durationMs) : null
    const freshness = Math.max(0.35, Math.min(1, 1 - idx * 0.12))
    return {
      id: `${name}-${idx}`,
      name,
      ring,
      stationId,
      stationCode: station.code,
      stageKey: station.stageKey,
      taskTitle: tool.taskTitle || null,
      sessionId: tool.sessionId || null,
      profile: tool.profile || 'default',
      cx,
      cy,
      ageSec,
      durationMs,
      durationLabel: formatDurationMs(durationMs),
      failed: Boolean(tool.failed),
      errorTail: tool.errorTail ?? null,
      freshness,
      isLatest: idx === 0,
    }
  })
}

/**
 * Format compact token totals (`950`, `1.5k`, `1.3M`).
 * @param {unknown} n
 * @returns {string}
 */
export function formatCompactTokens(n) {
  const val = Math.max(0, Number(n) || 0)
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`
  return String(Math.round(val))
}

/**
 * Combine `live`, `usage`, and `reviewWaiting` snapshots for LiveRadarCard.
 * Includes orbital 8-station metrics, central Context Eye telemetry, and monotonic 0-based `runTracked` mode.
 */
export function buildRadarSummary({
  live = null,
  usage = null,
  reviewItems = [],
  tasks = [],
  activeJob = null,
  now = Date.now(),
  runTracked = false,
  minRunTokens = 0,
} = {}) {
  const allTools = collectSourceTools(live, tasks, activeJob, now)
  const blips = projectRadarBlips(live, { tasks, activeJob, now, maxBlips: 6 })
  const feed = blips.slice(0, 4).map((b) => ({
    id: b.id,
    name: b.name,
    ring: b.ring,
    stationId: b.stationId,
    stationCode: b.stationCode,
    stageKey: b.stageKey,
    taskTitle: b.taskTitle,
    ageSec: b.ageSec,
    durationMs: b.durationMs,
    durationLabel: b.durationLabel,
    failed: b.failed,
    errorTail: b.errorTail,
  }))
  const activeWorkers =
    Number(live?.telemetry?.activeWorkers ?? (Number(live?.counts?.turns) || 0) + (Number(live?.counts?.tasks) || 0)) || 0
  const toolCount = Number(live?.telemetry?.toolCount ?? blips.length) || blips.length
  const waitingCount = Array.isArray(reviewItems)
    ? reviewItems.filter((r) => String(r?.status || '').toLowerCase() === 'blocked').length
    : 0

  const turnTokenSum = Array.isArray(live?.turns)
    ? live.turns.reduce((acc, t) => acc + (Number(t?.tokens?.total ?? 0) || 0), 0)
    : 0
  const rawRunTokens = Number(live?.telemetry?.runTokens ?? turnTokenSum) || 0
  const floorTokens = Math.max(0, Number(minRunTokens) || 0)
  const runTokens = runTracked ? Math.max(floorTokens, rawRunTokens) : rawRunTokens
  const usageTotals = usage?.totals || {}
  const usageSum = (Number(usageTotals.input ?? 0) || 0) + (Number(usageTotals.output ?? 0) || 0)
  const tokenTotal =
    Number(usageTotals.totalTokens ?? usageTotals.tokens ?? (usageSum > 0 ? usageSum : usageTotals.inputTokens) ?? 0) || 0
  const tokenMode = runTracked || runTokens > 0 ? 'run' : '24h'
  const effectiveTokens = runTracked ? runTokens : runTokens > 0 ? runTokens : tokenTotal
  const phaseLabel = String(live?.telemetry?.phaseLabel || (activeWorkers > 0 ? 'running' : 'idle'))
  const cacheHitPct = Number(live?.telemetry?.cacheHitPct ?? 0) || 0
  const costUsd = Number(live?.telemetry?.runCostUsd ?? usageTotals.cost ?? 0) || 0
  const contextPct = Math.max(0, Math.min(100, Number(live?.telemetry?.contextPct ?? 0) || 0))

  // Build 8-station aggregation
  const stationStats = Object.fromEntries(
    RADAR_STATIONS.map((s) => [
      s.id,
      { count: 0, hasError: false, latestError: null, latestTool: null, lastAt: 0 },
    ]),
  )
  for (const t of allTools) {
    const sid = t.stationId || toolToStation(t.name)
    const entry = stationStats[sid] || stationStats.tools
    entry.count += 1
    if (!entry.latestTool || (Number(t.at) || 0) >= entry.lastAt) {
      entry.latestTool = {
        name: String(t.name),
        durationMs: Number.isFinite(Number(t.durationMs)) ? Number(t.durationMs) : null,
        durationLabel: formatDurationMs(t.durationMs),
        ageSec: t.at ? Math.max(0, Math.round((now - Number(t.at)) / 1000)) : 0,
        taskTitle: t.taskTitle || null,
        failed: Boolean(t.failed),
        errorTail: t.errorTail ?? null,
      }
      entry.lastAt = Number(t.at) || 0
    }
    if (t.failed && !entry.hasError) {
      entry.hasError = true
      entry.latestError = { name: String(t.name), errorTail: t.errorTail ?? null, at: Number(t.at) || 0 }
    }
  }
  const bridgeFailed = Array.isArray(live?.telemetry?.failedTools) ? live.telemetry.failedTools : []
  for (const ft of bridgeFailed) {
    if (!ft?.name) continue
    const sid = toolToStation(ft.name)
    const entry = stationStats[sid] || stationStats.tools
    if (!entry.hasError) {
      entry.hasError = true
      entry.latestError = { name: String(ft.name), errorTail: ft.errorTail ?? null, at: Number(ft.at) || 0 }
    }
  }

  const demoActiveStep = live?.demo && live?.telemetry?.demoSequence
    ? DEMO_RADAR_SEQUENCE[Math.floor(Math.max(0, now === null || now === undefined ? Date.now() : Number(now)) / 1500) % DEMO_RADAR_SEQUENCE.length]
    : null
  const activeStationId =
    demoActiveStep?.stationId ||
    feed[0]?.stationId ||
    (waitingCount > 0 || activeJob?.phase === 'awaiting_review' ? 'you' : null)

  const stations = RADAR_STATIONS.map((s) => {
    const stat = stationStats[s.id]
    const attention = s.id === 'you' && (waitingCount > 0 || demoActiveStep?.stationId === 'you')
    const active = activeStationId === s.id || attention
    const strokeWidth = stat.count > 0 ? Math.min(4, Math.round((1.2 + stat.count * 0.55) * 10) / 10) : 1
    return {
      ...s,
      count: stat.count,
      strokeWidth,
      active,
      attention,
      hasError: stat.hasError,
      latestError: stat.latestError,
      latestTool: stat.latestTool,
    }
  })

  const activeStation = activeStationId ? stations.find((s) => s.id === activeStationId) || null : null
  const pupil = computePupilOffset(activeStation)
  const eye = {
    contextPct,
    tone: contextHealthTone(contextPct),
    pupilDx: pupil.dx,
    pupilDy: pupil.dy,
    activeStationId,
    blinkCount: toolCount,
    cacheHitPct,
    costUsd,
    costLabel: formatCostUsd(costUsd),
  }

  const latestError = bridgeFailed[0] || stations.find((s) => s.latestError)?.latestError || null

  return {
    blips,
    feed,
    stations,
    eye,
    latestError,
    activeWorkers,
    toolCount,
    waitingCount,
    runTokens,
    runTokenLabel: formatCompactTokens(runTokens),
    tokenTotal,
    tokenMode,
    tokenLabel: formatCompactTokens(effectiveTokens),
    cacheHitPct,
    phaseLabel,
  }
}
