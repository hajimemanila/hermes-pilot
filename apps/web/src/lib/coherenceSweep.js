/**
 * Generic coherence sweeps (SPEC-COHERENCE §3.6 / D82).
 *
 * `🛠 Refactor & audit` used to file three lines of self-repository vocabulary
 * (`SOUL.md`, `OAuth boundary`, `i18n`, `390px responsive`). Any other repository — Python, Go,
 * Rust, a docs tree — got nonsense injected into its task body. This module holds the generic
 * replacement: six presets that read the live `GET /api/coherence/report` result and turn it into
 * a task body / spec seed that only ever names the *target* repository's own facts.
 *
 * The sixth preset `bug-hunt` (SPEC-RELIABILITY-GUARD D93) is the one for defects that unit tests
 * miss. It carries the five blind spots every repository has — external boundaries, silent
 * failures, sibling-path contract gaps, state x action dead ends, id/cache collisions — and picks
 * one of three contracts: report only (default), reproduce-first (`autoFix`), or a spec seed.
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

/** Preset ids in display order. Any repo/language can use all six. */
export const SWEEP_PRESETS = Object.freeze([
  'state-flow',
  'contracts',
  'hotspots',
  'docs-specs',
  'bug-hunt',
  'custom',
])

/** Blind-spot checklist ids carried by the `bug-hunt` preset, in reporting order. */
export const BUG_HUNT_CHECKS = Object.freeze(['check1', 'check2', 'check3', 'check4', 'check5'])

/** Fallback when the report recommends nothing (or is unavailable). */
export const DEFAULT_SWEEP = 'state-flow'

/** How many detected files a payload names before summarising the rest. */
export const MAX_LISTED_FILES = 12

/** Longest single-line issue detail copied into a payload. */
const DETAIL_MAX = 160

/** Maximum task title length accepted by `capture.js` (`TITLE_MAX = 200`). */
export const SWEEP_TITLE_MAX = 200

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
 * match wins.
 *
 * `bug-hunt` comes first because its tokens would otherwise be swallowed by a broader pattern
 * below (`parity` belongs to contracts, `duplicat` to hotspots). A rule named `api-parity` or
 * `docs-scripts-parity` therefore lands in bug-hunt — that is the *point* of D93: a parity gap
 * between sibling paths is a real defect class, not a coverage/style one. A rule named
 * `event-contract` still reaches contracts because it matches no bug-hunt token, and a rule named
 * `state-relay` still reaches state-flow for the same reason.
 * @type {Array<[RegExp, string]>}
 */
const RULE_KEYWORDS = [
  [/cli|silent|parity|guard|bug|deadend|collision|duplicate-batch/, 'bug-hunt'],
  [/contract|schema|api|route|mock|locale|translation|i18n|test/, 'contracts'],
  [/doc|readme|spec|runbook|archive/, 'docs-specs'],
  [/state|flow|relay|async|race|event|sync/, 'state-flow'],
  [/bloat|hotspot|duplicat|dead|split|module/, 'hotspots'],
]

/** Recommendation priority when the report does not name a preset (narrowest, most actionable first). */
const RECOMMEND_ORDER = ['hotspots', 'contracts', 'state-flow', 'docs-specs', 'bug-hunt']

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

/** Max archived soft-signal entries kept per repository. */
const ACK_LIMIT = 100

/**
 * Universal rule -> 1-line remediation advice dictionary key (`coherence.advice.*`).
 * Rules without an explicit entry fall back to `coherence.advice.preset`.
 * @type {Record<string, string>}
 */
const ADVICE_KEYS = Object.freeze({
  'file-bloat': 'coherence.advice.fileBloat',
  'git-hotspot': 'coherence.advice.gitHotspot',
  'spec-sprawl': 'coherence.advice.specSprawl',
  'duplicate-batch-id': 'coherence.advice.duplicateBatchId',
  'debt-spike': 'coherence.advice.debtSpike',
  'baseline-ratchet': 'coherence.advice.baselineRatchet',
})

/** Normalise a numeric field when explicitly supplied, else null. */
function optionalNum(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Normalise one analyzer issue (`hardFails` / `softSignals` entry). The exact field names differ
 * between Layer-1 rules and repository checkers, so accept the common spellings.
 * @param {unknown} raw issue
 * @returns {{rule: string, detail: string, file: string, value?: number, limit?: number}|null} normalised issue
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
  const val = optionalNum(o.value)
  const lim = optionalNum(o.limit)
  return {
    rule,
    detail,
    file,
    ...(val !== null ? { value: val } : {}),
    ...(lim !== null ? { limit: lim } : {}),
  }
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
    checkerApproval: src?.checkerApproval ?? null,
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
 * Stable per-signal key (`rule::target`) used for ratchet-based archiving of soft signals.
 * Numbers inside a file-less detail string are collapsed (`#`) so an increase in count still matches
 * the same entry and cleanly auto-resurfaces when the count exceeds the archived value.
 * @param {unknown} issue normalised or raw issue
 * @returns {string} signal key
 */
export function signalKeyOf(issue) {
  const rule = clip(issue?.rule, 60) || 'signal'
  const file = clip(issue?.file, 200)
  if (file) return `${rule}::${file}`
  const detail = clip(issue?.detail ?? issue?.message, 80).replace(/\d+/g, '#')
  return `${rule}::${detail || '_'}`
}

/**
 * Parse stored soft-signal acknowledgements (`HM_STORAGE.COHERENCE_ACK`).
 * @param {unknown} raw JSON string or plain object
 * @returns {Record<string, Record<string, {value: number|null, at: number}>>} sanitised store
 */
export function parseCoherenceAck(raw) {
  let src = raw
  if (typeof raw === 'string') {
    try {
      src = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {}
  /** @type {Record<string, Record<string, {value: number|null, at: number}>>} */
  const out = {}
  for (const [repoKey, repoVal] of Object.entries(src)) {
    const rk = String(repoKey ?? '').trim()
    if (!rk || !repoVal || typeof repoVal !== 'object' || Array.isArray(repoVal)) continue
    /** @type {Record<string, {value: number|null, at: number}>} */
    const clean = {}
    for (const [sigKey, entry] of Object.entries(repoVal)) {
      const sk = String(sigKey ?? '').trim()
      if (!sk || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const val = optionalNum(entry.value)
      const atNum = Number(entry.at)
      clean[sk] = { value: val, at: Number.isFinite(atNum) ? atNum : 0 }
    }
    if (Object.keys(clean).length) out[rk] = clean
  }
  return out
}

/** Look up one repository's ack map (safe empty map fallback). */
export function ackForRepo(ackStore, repoKey) {
  const rk = String(repoKey ?? '').trim() || '_default'
  const map = ackStore && typeof ackStore === 'object' ? ackStore[rk] : null
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
}

/**
 * Whether a soft signal is currently suppressed by the repo's archive map.
 * Auto-resurfaces (`false`) whenever both current and archived numeric `value` exist and the
 * signal has grown (`issue.value > entry.value`).
 * @param {unknown} issue signal object
 * @param {Record<string, {value?: number|null}>|null} repoAckMap per-repo ack map
 * @returns {boolean} true if suppressed
 */
export function isSignalAcknowledged(issue, repoAckMap) {
  if (!repoAckMap || typeof repoAckMap !== 'object') return false
  const entry = repoAckMap[signalKeyOf(issue)]
  if (!entry || typeof entry !== 'object') return false
  const curVal = optionalNum(issue?.value)
  const ackVal = optionalNum(entry.value)
  if (curVal !== null && ackVal !== null) return curVal <= ackVal
  return true
}

/**
 * Split soft signals into active vs archived according to `repoAckMap`.
 * Hard fails are never filtered here (only soft signals can be archived).
 * @param {unknown} softSignals soft signal list
 * @param {Record<string, {value?: number|null}>|null} repoAckMap per-repo ack map
 * @returns {{active: Array<any>, archived: Array<any>}} split lists
 */
export function partitionSoftSignals(softSignals, repoAckMap) {
  const active = []
  const archived = []
  for (const item of toList(softSignals)) {
    if (!item) continue
    if (isSignalAcknowledged(item, repoAckMap)) archived.push(item)
    else active.push(item)
  }
  return { active, archived }
}

/** Immutably archive one soft signal under `repoKey` with its current numeric ratchet value. */
export function acknowledgeSignal(ackStore, repoKey, issue, now = Date.now()) {
  const base = parseCoherenceAck(ackStore)
  const rk = String(repoKey ?? '').trim() || '_default'
  const nextRepo = {
    ...ackForRepo(base, rk),
    [signalKeyOf(issue)]: { value: optionalNum(issue?.value), at: Number(now) || 0 },
  }
  const entries = Object.entries(nextRepo)
  if (entries.length > ACK_LIMIT) {
    entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
  }
  return { ...base, [rk]: Object.fromEntries(entries.slice(0, ACK_LIMIT)) }
}

/** Immutably restore (un-archive) one soft signal under `repoKey`. */
export function restoreSignal(ackStore, repoKey, issue) {
  const base = parseCoherenceAck(ackStore)
  const rk = String(repoKey ?? '').trim() || '_default'
  const curRepo = { ...ackForRepo(base, rk) }
  const key = signalKeyOf(issue)
  if (!(key in curRepo)) return base
  delete curRepo[key]
  const next = { ...base }
  if (Object.keys(curRepo).length) next[rk] = curRepo
  else delete next[rk]
  return next
}

/** i18n advice key for one rule id (`coherence.advice.preset` fallback uses `{ preset }`). */
export function adviceKeyForRule(rule) {
  const r = String(rule ?? '').trim().toLowerCase()
  return ADVICE_KEYS[r] ?? 'coherence.advice.preset'
}

/** Layer-1 rule detail keys carrying numeric `{ value, limit }`. */
const DETAIL_KEYS = Object.freeze({
  'file-bloat': 'coherence.detail.fileBloat',
  'git-hotspot': 'coherence.detail.gitHotspot',
  'spec-sprawl': 'coherence.detail.specSprawl',
  'debt-spike': 'coherence.detail.debtSpike',
})

/** Localise a Layer-1 signal detail when structured numbers exist, else clip raw detail. */
export function formatSignalDetail(item, lang = getLocale()) {
  const rule = String(item?.rule ?? '').trim().toLowerCase()
  const key = DETAIL_KEYS[rule]
  const value = optionalNum(item?.value)
  const limit = optionalNum(item?.limit)
  if (key && value !== null && limit !== null) {
    const l = lang === 'ja' ? 'ja' : 'en'
    return translate(l, key, { value, limit })
  }
  return clip(item?.detail ?? item?.message)
}

/**
 * Per-preset signal counts for the sheet's badges.
 * When `repoAckMap` is supplied, archived soft signals are excluded from the badges.
 * @param {unknown} report raw or normalised report
 * @param {Record<string, {value?: number|null}>|null} [repoAckMap] optional per-repo ack map
 * @returns {Record<string, number>} count per preset (`custom` = signals no preset owns)
 */
export function sweepCounts(report, repoAckMap = null) {
  const r = normalizeReport(report)
  const counts = {
    'state-flow': 0,
    contracts: 0,
    hotspots: r.hotspots.length,
    'docs-specs': 0,
    'bug-hunt': 0,
    custom: 0,
  }
  const soft = repoAckMap ? partitionSoftSignals(r.softSignals, repoAckMap).active : r.softSignals
  for (const issue of [...r.hardFails, ...soft]) {
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
 * @param {'en'|'ja'} [lang] language for the parenthetical note
 * @param {Record<string, {value?: number|null}>|null} [repoAckMap] optional per-repo ack map
 * @returns {string[]} `path (note)` lines
 */
export function sweepFiles(report, lang = getLocale(), repoAckMap = null) {
  const r = normalizeReport(report)
  const out = []
  const seen = new Set()
  const push = (file, note) => {
    if (!file || seen.has(file)) return
    seen.add(file)
    out.push(note ? `${file} (${note})` : file)
  }
  const soft = repoAckMap ? partitionSoftSignals(r.softSignals, repoAckMap).active : r.softSignals
  for (const issue of r.hardFails) push(issue.file, issue.rule)
  for (const issue of soft) push(issue.file, issue.rule)
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
 * `bug-hunt` (D93) adds the five blind spots plus exactly one contract:
 * - `autoFix: false` (default) — report only, no code changes
 * - `autoFix: true` — reproduce first, fix only what the reproduction proves
 * - `mode: 'spec'` — the same checklist, contract and severity policy become the Spec Architect
 *   seed instead of a single task body
 *
 * @param {{preset?: string, report?: unknown, target?: string, mode?: 'single'|'spec',
 *   board?: string, lang?: string, autoFix?: boolean, ackMap?: Record<string, any>|null}} [input] sweep input
 * @returns {{preset: string, mode: 'single'|'spec', lang: 'en'|'ja', board: string,
 *   title: string, body: string, seedText: string, autoFix: boolean}} payload
 */
export function buildSweepPayload({
  preset,
  report,
  target = '',
  mode = 'single',
  board = '',
  lang = getLocale(),
  autoFix = false,
  ackMap = null,
} = {}) {
  const id = normalizePreset(preset)
  const l = lang === 'ja' ? 'ja' : 'en'
  const t = (key, vars) => translate(l, key, vars)
  const r = normalizeReport(report)
  const activeSoft = ackMap ? partitionSoftSignals(r.softSignals, ackMap).active : r.softSignals
  const targetText = clip(target, 200)
  const scope = targetText || t('coherence.scopeWholeRepo')
  const hunt = id === 'bug-hunt'
  // 再現先行は spec ルートでも種に載せる（チェックを黙って無視しない）
  const fix = hunt && Boolean(autoFix)

  const title = clip(
    `[COHERENCE/${id.toUpperCase()}] ${t(`coherence.preset.${id}`)}${targetText ? ` - ${targetText}` : ''}`,
    SWEEP_TITLE_MAX,
  )

  const detected = r.available
    ? t('coherence.body.detectedLine', {
        hard: r.counts.hardFailCount,
        soft: ackMap ? activeSoft.length : r.counts.softSignalCount,
        hotspots: r.counts.hotspotCount,
      })
    : t('coherence.body.detectedNone')

  const lines = [
    'Execution Mode: [Mode: Zero-Stop]',
    `Objective: ${t(`coherence.preset.${id}.objective`)}`,
    `Target: ${scope}`,
    `Detected: ${detected}`,
  ]

  if (hunt) {
    const contract = fix ? 'reproduceFirst' : 'reportOnly'
    lines.push(`${t('coherence.preset.bug-hunt.contract')}: ${t(`coherence.preset.bug-hunt.${contract}`)}`)
    lines.push(`${t('coherence.preset.bug-hunt.blindSpots')}:`)
    for (const key of BUG_HUNT_CHECKS) lines.push(`- ${t(`coherence.preset.bug-hunt.${key}`)}`)
    if (mode === 'spec') lines.push(t('coherence.preset.bug-hunt.orderPolicy'))
  }

  const files = sweepFiles(r, l, ackMap)
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
    autoFix: fix,
  }
}
