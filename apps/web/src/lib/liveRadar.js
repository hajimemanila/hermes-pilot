/**
 * Pure projection helpers for LiveRadarCard (AP2-5 / SPEC-AUTOPILOT-V2).
 *
 * Clean-room React + SVG radar layout inspired by the telemetry concepts in
 * `huwhitememes/panoptes` (MIT License) with zero external chart dependencies.
 */

export const RADAR_SIZE = 220
export const RADAR_CENTER = 110

export const RING_RADII = Object.freeze({
  core: 34,
  verify: 62,
  explore: 86,
})

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
 * Classify a tool name onto one of three radar rings.
 * @param {unknown} toolName
 * @returns {'core'|'verify'|'explore'}
 */
export function classifyToolRing(toolName) {
  const s = String(toolName ?? '').toLowerCase()
  if (/edit|write|patch|create|build|vite|bundle|style|css/.test(s)) return 'core'
  if (/test|verify|render|mock|browser|vision|check|audit|assert/.test(s)) return 'verify'
  return 'explore'
}

/**
 * Extract recent tool invocations from `/api/live` snapshot and place them on concentric radar coordinates.
 * @param {object|null} liveSnapshot
 * @param {{now?: number, maxBlips?: number}} [opts]
 */
export function projectRadarBlips(liveSnapshot, { now = Date.now(), maxBlips = 6 } = {}) {
  const limit = Math.max(1, Math.min(12, Number(maxBlips) || 6))
  let sourceTools = []

  if (Array.isArray(liveSnapshot?.telemetry?.recentTools) && liveSnapshot.telemetry.recentTools.length > 0) {
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

  return sourceTools
    .filter((t) => t && t.name)
    .slice(0, limit)
    .map((tool, idx) => {
      const name = String(tool.name)
      const ring = classifyToolRing(name)
      const radius = RING_RADII[ring]
      const angleDeg = idx * 60 + (hashString(name) % 28) - 90
      const rad = (angleDeg * Math.PI) / 180
      const cx = Math.round(RADAR_CENTER + Math.cos(rad) * radius)
      const cy = Math.round(RADAR_CENTER + Math.sin(rad) * radius)
      const ageSec = tool.at ? Math.max(0, Math.round((now - Number(tool.at)) / 1000)) : idx * 6
      const freshness = Math.max(0.35, Math.min(1, 1 - idx * 0.12))
      return {
        id: `${name}-${idx}`,
        name,
        ring,
        cx,
        cy,
        ageSec,
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
 * @param {{live?: object|null, usage?: object|null, reviewItems?: Array<object>, now?: number}} [opts]
 */
export function buildRadarSummary({ live = null, usage = null, reviewItems = [], now = Date.now() } = {}) {
  const blips = projectRadarBlips(live, { now, maxBlips: 6 })
  const feed = blips.slice(0, 4).map((b) => ({
    id: b.id,
    name: b.name,
    ring: b.ring,
    ageSec: b.ageSec,
  }))
  const activeWorkers = (Number(live?.counts?.turns) || 0) + (Number(live?.counts?.tasks) || 0)
  const toolCount = Number(live?.telemetry?.toolCount ?? blips.length) || blips.length
  const waitingCount = Array.isArray(reviewItems)
    ? reviewItems.filter((r) => String(r?.status || '').toLowerCase() === 'blocked').length
    : 0
  const tokenTotal =
    Number(usage?.totals?.totalTokens ?? usage?.totals?.tokens ?? usage?.totals?.inputTokens ?? 0) || 0
  const phaseLabel = String(live?.telemetry?.phaseLabel || (activeWorkers > 0 ? 'running' : 'idle'))

  return {
    blips,
    feed,
    activeWorkers,
    toolCount,
    waitingCount,
    tokenTotal,
    tokenLabel: formatCompactTokens(tokenTotal),
    phaseLabel,
  }
}
