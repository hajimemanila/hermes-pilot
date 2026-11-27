/**
 * Autopilot-only Wave parallel batch planner (`SPEC-AUTOPILOT-V3` AP3-1).
 *
 * Cockpit (`parallelMode !== 'wave'`) remains strictly 1-by-1 serial via `--parent`.
 * In Wave mode (`autopilot: true`), consecutive batches with disjoint non-hotspot `Files:`
 * may run up to `MAX_AUTOPILOT_PARALLEL` (3) in parallel; shared hotspots or file overlaps
 * automatically fall back to serial barriers.
 */

export const MAX_AUTOPILOT_PARALLEL = 3

export const SHARED_HOTSPOT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'scripts/coherence-baseline.json',
  'scripts/audit-responsive.baseline.json',
  'apps/bridge/src/contracts/routes.js',
  'apps/web/src/i18n/en.json',
  'apps/web/src/i18n/ja.json',
  'apps/web/src/styles.css',
  'apps/web/src/App.jsx',
  'apps/bridge/src/server.js',
  'apps/bridge/src/review.js',
  'apps/bridge/src/specs.js',
  'apps/bridge/src/architect.js',
  'apps/web/src/lib/autopilotDeck.js',
  'apps/web/src/styles/autopilot.css',
])

const FILES_HEADING_RE = /^[-*]?\s*\*\*\s*(?:Files|ファイル)\s*\*\*\s*[:：]?\s*(.*)$/i
const DEPENDS_ON_RE = /^[-*]?\s*\*\*\s*(?:Depends\s*On|依存)\s*\*\*\s*[:：]\s*(.+)$/i
const ANY_FIELD_RE = /^[-*]?\s*\*\*\s*[A-Za-zぁ-んァ-ヶ一-龥\s]+\s*\*\*\s*[:：]/

function normalizeFileToken(raw) {
  let s = String(raw ?? '').trim()
  s = s.replace(/^[`"'*]+|[`"']*$/g, '')
  s = s.replace(/^(?:New|Changed|Edit|Create|Delete|新規|変更|編集)\s*[:：]\s*/i, '')
  s = s.replace(/^[`"'*]+|[`"']*$/g, '')
  s = s.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
  s = s.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!s || /\s/.test(s) || !/[/.]/.test(s)) return null
  return s
}

/**
 * Extract declared relative file paths from a SPEC batch section.
 * @param {string[]|string} section
 * @returns {string[]}
 */
export function extractBatchFiles(section) {
  const lines = Array.isArray(section) ? section : String(section ?? '').split(/\r?\n/)
  const out = []
  let inFiles = false
  for (const rawLine of lines) {
    const line = String(rawLine ?? '')
    const head = FILES_HEADING_RE.exec(line.trim())
    if (head) {
      inFiles = true
      if (head[1]) {
        for (const piece of head[1].split(/[,\s]+/)) {
          const tok = normalizeFileToken(piece)
          if (tok && !out.includes(tok)) out.push(tok)
        }
      }
      continue
    }
    if (!inFiles) continue
    const trimmed = line.trim()
    if (!trimmed) {
      inFiles = false
      continue
    }
    if (/^#{1,4}\s/.test(trimmed) || ANY_FIELD_RE.test(trimmed)) {
      inFiles = false
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    const candidate = bullet ? bullet[1] : trimmed
    const backtickMatch = /`([^`]+)`/.exec(candidate)
    const tok = normalizeFileToken(backtickMatch ? backtickMatch[1] : candidate.split(/\s+/)[0])
    if (tok && !out.includes(tok)) out.push(tok)
  }
  return out
}

/**
 * Parse `- **Depends On**: none | ID1, ID2` metadata from a batch section.
 * @param {string[]|string} section
 * @returns {{explicit: boolean, none: boolean, ids: string[]}}
 */
export function extractBatchDependsOn(section) {
  const text = Array.isArray(section) ? section.join('\n') : String(section ?? '')
  const m = DEPENDS_ON_RE.exec(text)
  if (!m) return { explicit: false, none: false, ids: [] }
  const val = String(m[1] ?? '').trim()
  if (!val || /^(?:none|なし|-)$/i.test(val)) {
    return { explicit: true, none: true, ids: [] }
  }
  const ids = val
    .split(/[,\s、]+/)
    .map((x) => x.replace(/[`'"]/g, '').trim())
    .filter((x) => /^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(x))
  return { explicit: true, none: ids.length === 0, ids }
}

/**
 * Return true if a file path touches shared/global config, i18n, or baseline hotspots.
 * @param {unknown} relPath
 * @returns {boolean}
 */
export function isSharedHotspot(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!p) return false
  if (SHARED_HOTSPOT_FILES.has(p)) return true
  if (/(?:^|\/)(?:package\.json|coherence-baseline\.json|en\.json|ja\.json)$/.test(p)) return true
  return false
}

/**
 * Plan serial or Autopilot-only Wave-DAG execution order for parsed batches.
 * @param {Array<{id: string, title?: string, section: string[]|string}>} batches
 * @param {{parallelMode?: 'serial'|'wave', maxParallel?: number}} [opts]
 */
export function planBatchWaves(batches = [], { parallelMode = 'serial', maxParallel = MAX_AUTOPILOT_PARALLEL } = {}) {
  const list = Array.isArray(batches) ? batches : []
  const cap = Math.min(MAX_AUTOPILOT_PARALLEL, Math.max(1, Number(maxParallel) || MAX_AUTOPILOT_PARALLEL))

  if (parallelMode !== 'wave' || cap <= 1) {
    const waves = list.map((b) => [b])
    const entries = list.map((batch, idx) => ({
      batch,
      waveIndex: idx,
      parentBatchId: idx > 0 ? list[idx - 1].id : null,
      waitBatchIds: idx > 0 ? [list[idx - 1].id] : [],
      files: extractBatchFiles(batch.section),
      reason: 'serial_mode',
    }))
    return { mode: 'serial', maxParallel: 1, waves, entries }
  }

  /** @type {Array<Array<object>>} */
  const waves = []
  /** @type {Array<object>} */
  const entries = []
  let curWave = []
  let curFiles = new Set()

  const flushWave = () => {
    if (curWave.length === 0) return
    waves.push(curWave)
    curWave = []
    curFiles = new Set()
  }

  const pushEntry = (batch, waveIdx, files, reason, deps) => {
    const prevWave = waveIdx > 0 ? waves[waveIdx - 1] : []
    const prevIds = prevWave.map((b) => b.id)
    let parentBatchId = prevIds.length ? prevIds[prevIds.length - 1] : null
    if (deps?.ids?.length === 1 && prevIds.includes(deps.ids[0])) {
      parentBatchId = deps.ids[0]
    }
    entries.push({
      batch,
      waveIndex: waveIdx,
      parentBatchId,
      waitBatchIds: prevIds,
      files,
      reason,
    })
  }

  for (const batch of list) {
    const files = extractBatchFiles(batch.section)
    const deps = extractBatchDependsOn(batch.section)
    const hasUnknownFiles = files.length === 0
    const touchesHotspot = files.some((f) => isSharedHotspot(f))

    if (hasUnknownFiles || touchesHotspot) {
      flushWave()
      const waveIdx = waves.length
      waves.push([batch])
      pushEntry(batch, waveIdx, files, touchesHotspot ? 'shared_hotspot_fallback' : 'unknown_files_fallback', deps)
      continue
    }

    const curIds = new Set(curWave.map((b) => b.id))
    const depInCurWave = deps.ids.some((id) => curIds.has(id))
    const fileOverlap = files.some((f) => curFiles.has(f))

    if (curWave.length >= cap || depInCurWave || fileOverlap) {
      flushWave()
    }

    const waveIdx = waves.length
    const reason =
      curWave.length > 0
        ? 'parallel_wave'
        : fileOverlap
          ? 'file_overlap_fallback'
          : depInCurWave
            ? 'explicit_dependency'
            : 'parallel_wave'
    curWave.push(batch)
    for (const f of files) curFiles.add(f)
    pushEntry(batch, waveIdx, files, reason, deps)
  }

  flushWave()
  return { mode: 'wave', maxParallel: cap, waves, entries }
}

/**
 * Append sibling coordination note to a wave task body when preceded by a multi-batch wave.
 * @param {string} body
 * @param {{waitBatchIds?: string[]}|null} entry
 * @returns {string}
 */
export function decorateWaveTaskBody(body, entry) {
  if (!entry?.waitBatchIds || entry.waitBatchIds.length <= 1) return body
  return `${body}\nWait-Siblings: ${entry.waitBatchIds.join(', ')}`
}
