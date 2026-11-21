/**
 * Generic coherence sweeps (SPEC-COHERENCE §3.6 / D82).
 *
 * `🛠 Refactor & audit` used to file three lines of self-repository vocabulary
 * (`SOUL.md`, `OAuth boundary`, `i18n`, `390px responsive`). Any other repository — Python, Go,
 * Rust, a docs tree — got nonsense injected into its task body. This module holds the generic
 * replacement: five presets that read the live `GET /api/coherence/report` result and turn it into
 * a task body / spec seed that only ever names the *target* repository's own facts.
 *
 * Rules kept here on purpose:
 * - No repository-specific literal (commands, paths, viewport sizes, check names). The verification
 *   instruction stays abstract and is delegated to the target repo's memory / rule docs / SPEC
 *   `Verify` section (D85).
 * - No prose: every sentence comes from the i18n dictionaries (`coherence.*`) so the EN build stays
 *   CJK-free (`noHardcodedJapanese.test.js` walks `src/`).
 * - Pure: no DOM, no fetch. `features/TaskToolSheets.jsx` owns the network.
 */

import { getLocale } from './format.js'
import { translate } from '../i18n/lang.js'
import { SEED_MAX } from './specSeed.js'

/** Preset ids in display order. Any repo/language can use all five. */
export const SWEEP_PRESETS = Object.freeze(['state-flow', 'contracts', 'hotspots', 'docs-specs', 'custom'])

/** Fallback when the report recommends nothing (or is unavailable). */
export const DEFAULT_SWEEP = 'state-flow'

/** How many detected files a payload names before summarising the rest. */
export const MAX_LISTED_FILES = 12

/** Longest single-line issue detail copied into a payload. */
const DETAIL_MAX = 160

/**
 * Universal Layer-1 rule → preset. These rule ids are emitted by the analyzer for every
 * repository (no config), so they are safe to hardcode as *machine* tokens.
 * @type {Record<string, string>}
 */
const RULE_PRESET = Object.freeze({
  'git-hotspot': 'hotspots',
  'file-bloat': 'hotspots',
  'debt-spike': 'hotspots',
  'spec-sprawl': 'docs-specs',
})

/**
 * Keyword fallback for rules a repository declares itself (Layer 2 checkers). Ordered: the first
 * match wins. Contracts come first so a rule named `event-contract` lands in contracts, not
 * state-flow; a rule named `state-relay` still reaches state-flow because it matches no earlier
 * pattern.
 * @type {Array<[RegExp, string]>}
 */
const RULE_KEYWORDS = [
  [/contract|parity|schema|api|route|mock|locale|translation|i18n|test/, 'contracts'],
  [/doc|readme|spec|runbook|archive/, 'docs-specs'],
  [/state|flow|relay|async|race|event|sync/, 'state-flow'],
  [/bloat|hotspot|duplicat|dead|split|module/, 'hotspots'],
]

/** Recommendation priority when the report does not name a preset (narrowest, most actionable first). */
const RECOMMEND_ORDER = ['hotspots', 'contracts', 'state-flow', 'docs-specs']

/** Trim + collapse whitespace + clip. */
function clip(value, max = DETAIL_MAX) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Array-or-nothing. */
function toList(value) {
  return Array.isArray(value) ? value : []
}

/** Positive integer or fallback. */
function count(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Normalise one analyzer issue (`hardFails` / `softSignals` entry). The exact field names differ
 * between Layer-1 rules and repository checkers, so accept the common spellings.
 * @param {unknown} raw issue
 * @returns {{rule: string, detail: string, file: string}|null} normalised issue
 */
function issueOf(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const detail = clip(raw)
    return detail ? { rule: '', detail, file: '' } : null
  }
  if (typeof raw !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (raw)
  const rule = clip(o.rule ?? o.kind ?? o.code ?? o.id, 60)
  const file = clip(o.file ?? o.path, 200)
  const detail = clip(o.message ?? o.detail ?? o.title ?? o.summary)
  if (!rule && !file && !detail) return null
  return { rule, detail, file }
}

/**
 * Normalise one hotspot entry.
 * @param {unknown} raw hotspot
 * @returns {{file: string, touches: number, lines: number}|null} normalised hotspot
 */
function hotspotOf(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') return { file: clip(raw, 200), touches: 0, lines: 0 }
  if (typeof raw !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (raw)
  const file = clip(o.file ?? o.path, 200)
  if (!file) return null
  return {
    file,
    touches: count(o.touches ?? o.count ?? o.commits ?? o.changes, 0),
    lines: count(o.lines ?? o.loc ?? o.lineCount, 0),
  }
}

/**
 * Normalise a `GET /api/coherence/report` body into the shape this module works on.
 *
 * Defensive on purpose: the endpoint may be absent (older bridge), return an error object, or
 * omit `summary`. Everything degrades to zeros with `available: false` instead of throwing, so the
 * sheet still opens and can file a sweep.
 *
 * @param {unknown} raw report body (or null)
 * @returns {{available: boolean, generatedAt: string, repoRoot: string, layers: any,
 *   hardFails: Array<{rule: string, detail: string, file: string}>,
 *   softSignals: Array<{rule: string, detail: string, file: string}>,
 *   hotspots: Array<{file: string, touches: number, lines: number}>,
 *   counts: {hardFailCount: number, softSignalCount: number, hotspotCount: number,
 *            activeSpecCount: number, archivedSpecCount: number, deprecatedRoutes: number},
 *   recommendedSweep: string}} normalised report
 */
export function normalizeReport(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null
  const hardFails = toList(src?.hardFails).map(issueOf).filter(Boolean)
  const softSignals = toList(src?.softSignals).map(issueOf).filter(Boolean)
  const hotspots = toList(src?.hotspots).map(hotspotOf).filter(Boolean)
  const summary = src?.summary && typeof src.summary === 'object' ? src.summary : {}
  const recommended = SWEEP_PRESETS.includes(src?.recommendedSweep) ? String(src.recommendedSweep) : ''
  return {
    available: Boolean(src),
    generatedAt: clip(src?.generatedAt, 40),
    repoRoot: clip(src?.repoRoot, 300),
    layers: src?.layers ?? null,
    hardFails,
    softSignals,
    hotspots,
    counts: {
      hardFailCount: count(summary.hardFailCount, hardFails.length),
      softSignalCount: count(summary.softSignalCount, softSignals.length),
      hotspotCount: count(summary.hotspotCount, hotspots.length),
      activeSpecCount: count(summary.activeSpecCount, 0),
      archivedSpecCount: count(summary.archivedSpecCount, 0),
      deprecatedRoutes: count(summary.deprecatedRoutes, 0),
    },
    recommendedSweep: recommended,
  }
}

/**
 * Any value → preset id.
 * @param {unknown} value candidate
 * @returns {string} preset id (`DEFAULT_SWEEP` when unknown)
 */
export function normalizePreset(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return SWEEP_PRESETS.includes(v) ? v : DEFAULT_SWEEP
}

/**
 * Rule id → preset that would fix it.
 * @param {unknown} rule rule id / issue kind
 * @returns {string} preset id
 */
export function presetForRule(rule) {
  const r = String(rule ?? '').trim().toLowerCase()
  if (!r) return 'custom'
  if (RULE_PRESET[r]) return RULE_PRESET[r]
  for (const [pattern, preset] of RULE_KEYWORDS) {
    if (pattern.test(r)) return preset
  }
  return 'custom'
}

/**
 * Per-preset signal counts for the sheet's badges.
 * @param {unknown} report raw or normalised report
 * @returns {Record<string, number>} count per preset (`custom` = signals no preset owns)
 */
export function sweepCounts(report) {
  const r = normalizeReport(report)
  const counts = { 'state-flow': 0, contracts: 0, hotspots: r.hotspots.length, 'docs-specs': 0, custom: 0 }
  for (const issue of [...r.hardFails, ...r.softSignals]) {
    counts[presetForRule(issue.rule)] += 1
  }
  return counts
}

/**
 * Preset to preselect in the sheet.
 * @param {unknown} report raw or normalised report
 * @returns {string} preset id
 */
export function recommendSweep(report) {
  const r = normalizeReport(report)
  if (r.recommendedSweep) return r.recommendedSweep
  const counts = sweepCounts(r)
  let best = DEFAULT_SWEEP
  let bestCount = 0
  for (const id of RECOMMEND_ORDER) {
    if (counts[id] > bestCount) {
      best = id
      bestCount = counts[id]
    }
  }
  return best
}

/**
 * Files a preset should name, most urgent first (hard fails → soft signals → hotspots), deduped.
 * @param {unknown} report raw or normalised report
 * @param {'en'|'ja'} lang language for the parenthetical note
 * @returns {string[]} `path (note)` lines
 */
export function sweepFiles(report, lang = getLocale()) {
  const r = normalizeReport(report)
  const out = []
  const seen = new Set()
  const push = (file, note) => {
    if (!file || seen.has(file)) return
    seen.add(file)
    out.push(note ? `${file} (${note})` : file)
  }
  for (const issue of r.hardFails) push(issue.file, issue.rule)
  for (const issue of r.softSignals) push(issue.file, issue.rule)
  for (const hotspot of r.hotspots) {
    push(hotspot.file, hotspot.touches ? translate(lang, 'coherence.file.hotspot', { touches: hotspot.touches }) : '')
  }
  return out
}

/**
 * Build the payload for one sweep.
 *
 * Returns the single-task body (`Execution Mode` / `Objective` / `Files` / `Verify` labels stay
 * ASCII so the same shape is machine-readable in any language) and, for the multi-batch route, the
 * seed text handed to the Spec Architect. Both are clipped to `SEED_MAX`.
 *
 * @param {{preset?: string, report?: unknown, target?: string, mode?: 'single'|'spec',
 *   board?: string, lang?: string}} [input] sweep input
 * @returns {{preset: string, mode: 'single'|'spec', lang: 'en'|'ja', board: string,
 *   title: string, body: string, seedText: string}} payload
 */
export function buildSweepPayload({
  preset,
  report,
  target = '',
  mode = 'single',
  board = '',
  lang = getLocale(),
} = {}) {
  const id = normalizePreset(preset)
  const l = lang === 'ja' ? 'ja' : 'en'
  const t = (key, vars) => translate(l, key, vars)
  const r = normalizeReport(report)
  const targetText = clip(target, 200)
  const scope = targetText || t('coherence.scopeWholeRepo')

  const title = `[COHERENCE/${id.toUpperCase()}] ${t(`coherence.preset.${id}`)}${
    targetText ? ` - ${targetText}` : ''
  }`

  const detected = r.available
    ? t('coherence.body.detectedLine', {
        hard: r.counts.hardFailCount,
        soft: r.counts.softSignalCount,
        hotspots: r.counts.hotspotCount,
      })
    : t('coherence.body.detectedNone')

  const lines = [
    'Execution Mode: [Mode: Zero-Stop]',
    `Objective: ${t(`coherence.preset.${id}.objective`)}`,
    `Target: ${scope}`,
    `Detected: ${detected}`,
  ]

  const files = sweepFiles(r, l)
  if (files.length) {
    lines.push('Files:')
    for (const file of files.slice(0, MAX_LISTED_FILES)) lines.push(`- ${file}`)
    if (files.length > MAX_LISTED_FILES) {
      lines.push(`- ${t('coherence.body.moreFiles', { n: files.length - MAX_LISTED_FILES })}`)
    }
  }

  if (mode === 'spec') lines.push(`Plan: ${t('coherence.body.plan')}`)

  lines.push(`Verify: ${t('coherence.body.verify')}`)

  const body = lines.join('\n').slice(0, SEED_MAX)
  const seedText = [t('coherence.seedLead'), '', body].join('\n').slice(0, SEED_MAX)

  return {
    preset: id,
    mode: mode === 'spec' ? 'spec' : 'single',
    lang: l,
    board: String(board ?? ''),
    title,
    body,
    seedText,
  }
}
