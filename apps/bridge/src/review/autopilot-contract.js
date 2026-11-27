/**
 * Autopilot Fast-Lane protocol contract (SPEC-AUTOPILOT-V2 AP2-2).
 *
 * Defines:
 * - Style Gacha presets (`STYLE_PRESETS`, `MAX_STYLE_GACHA_PER_CARD`)
 * - Safe Auto-Resolve classification (`classifyAutoResolve`)
 * - Sandbox -> Cockpit Promote payload normalization & path validation
 */

export const MAX_STYLE_GACHA_PER_CARD = 3

export const STYLE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'minimal',
    labelEn: 'Minimal',
    labelJa: 'ミニマル',
    promptHint: 'Clean whitespace, subtle 1px hairlines, restrained monochrome palette with one crisp accent.',
  }),
  Object.freeze({
    id: 'neon',
    labelEn: 'Neon',
    labelJa: 'ネオン',
    promptHint: 'Dark canvas, glowing cyan/magenta edge accents, high-contrast telemetry badges.',
  }),
  Object.freeze({
    id: 'retro',
    labelEn: 'Retro',
    labelJa: 'レトロ',
    promptHint: 'Warm paper tint, tactile 2px borders, crisp offset shadows, classic tabular typography.',
  }),
  Object.freeze({
    id: 'editorial',
    labelEn: 'Editorial',
    labelJa: 'エディトリアル',
    promptHint: 'Expressive serif headings, strong typographic hierarchy, magazine-like column rhythm.',
  }),
  Object.freeze({
    id: 'bento',
    labelEn: 'Bento',
    labelJa: 'ベントー',
    promptHint: 'Modular rounded tile grid with distinct visual weight per metric/action card.',
  }),
])

const STYLE_BY_ID = new Map(STYLE_PRESETS.map((p) => [p.id, p]))

/**
 * Look up a Style Gacha preset by id.
 * @param {unknown} id
 */
export function getStylePreset(id) {
  return STYLE_BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null
}

/**
 * Check whether a style preset id is one of the supported presets.
 * @param {unknown} id
 */
export function isValidStylePreset(id) {
  return getStylePreset(id) !== null
}

export const AUTO_RESOLVE_ALLOW_CATEGORIES = Object.freeze([
  'file_layout',
  'temp_flag_cleanup',
  'component_split',
  'i18n_key_naming',
  'css_token_naming',
  'internal_helper',
])

export const AUTO_RESOLVE_DENY_CATEGORIES = Object.freeze([
  'visual_layout',
  'palette_theme',
  'navigation_placement',
  'info_hierarchy',
  'destructive_data',
  'public_publish',
  'billing_cost',
])

const ALLOW_SET = new Set(AUTO_RESOLVE_ALLOW_CATEGORIES)
const DENY_SET = new Set(AUTO_RESOLVE_DENY_CATEGORIES)

/**
 * Determine whether a technical fork may be silently auto-resolved during Autopilot.
 * Fails safe to human review whenever visual UX, irreversible actions, or unknown categories are involved.
 *
 * @param {{category?: string, affectsVisual?: boolean, irreversible?: boolean}} [opts]
 * @returns {{autoResolve: boolean, reason: string}}
 */
export function classifyAutoResolve({ category, affectsVisual = false, irreversible = false } = {}) {
  if (irreversible) {
    return { autoResolve: false, reason: 'irreversible_action' }
  }
  if (affectsVisual) {
    return { autoResolve: false, reason: 'affects_visual_experience' }
  }
  const cat = String(category ?? '').trim()
  if (DENY_SET.has(cat)) {
    return { autoResolve: false, reason: 'denied_category' }
  }
  if (ALLOW_SET.has(cat)) {
    return { autoResolve: true, reason: 'safe_technical_default' }
  }
  return { autoResolve: false, reason: 'unknown_category' }
}

/**
 * Validate a relative file path referencing sandboxed mock HTML or screenshots.
 * Rejects empty strings, null bytes, backslashes, absolute paths, home paths, Windows drives, and `..`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeSandboxRelPath(value) {
  if (typeof value !== 'string') return false
  const s = value.trim()
  if (!s || s.includes('\0') || s.includes('\\')) return false
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s)) return false
  const segments = s.split('/')
  if (segments.some((seg) => seg === '..' || seg === '')) return false
  return true
}

const VARIANT_ID_RE = /^[A-Za-z0-9._-]{1,32}$/

/**
 * Validate and normalize a Sandbox -> Cockpit Promote payload.
 *
 * @param {unknown} input
 * @returns {{ok: boolean, errors: string[], payload: object|null}}
 */
export function normalizePromotePayload(input) {
  const errors = []
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['payload_must_be_object'], payload: null }
  }

  const raw = /** @type {Record<string, unknown>} */ (input)
  const chosenVariantId = String(raw.chosenVariantId ?? '').trim()
  if (!VARIANT_ID_RE.test(chosenVariantId)) {
    errors.push('invalid_chosenVariantId')
  }

  const taskId = raw.taskId === undefined || raw.taskId === null ? null : String(raw.taskId).trim().slice(0, 64) || null

  let mockHtmlPath = null
  if (raw.mockHtmlPath !== undefined && raw.mockHtmlPath !== null && String(raw.mockHtmlPath).trim() !== '') {
    const candidate = String(raw.mockHtmlPath).trim()
    if (!isSafeSandboxRelPath(candidate)) {
      errors.push('unsafe_mockHtmlPath')
    } else {
      mockHtmlPath = candidate
    }
  }

  let screenshotPath = null
  if (raw.screenshotPath !== undefined && raw.screenshotPath !== null && String(raw.screenshotPath).trim() !== '') {
    const candidate = String(raw.screenshotPath).trim()
    if (!isSafeSandboxRelPath(candidate)) {
      errors.push('unsafe_screenshotPath')
    } else {
      screenshotPath = candidate
    }
  }

  let styleTag = null
  if (raw.styleTag !== undefined && raw.styleTag !== null && String(raw.styleTag).trim() !== '') {
    const candidate = String(raw.styleTag).trim().toLowerCase()
    if (!isValidStylePreset(candidate)) {
      errors.push('invalid_styleTag')
    } else {
      styleTag = candidate
    }
  }

  const clampCoord = (n) => Math.max(0, Math.min(1, Number.isFinite(Number(n)) ? Number(n) : 0))
  const annotations = Array.isArray(raw.annotations)
    ? raw.annotations
        .filter((a) => a && typeof a === 'object')
        .map((a, idx) => ({
          id: String(a.id ?? `ann-${idx + 1}`).trim().slice(0, 40) || `ann-${idx + 1}`,
          x: clampCoord(a.x),
          y: clampCoord(a.y),
          text: String(a.text ?? '').trim().slice(0, 300),
        }))
    : []

  const autoResolved = Array.isArray(raw.autoResolved)
    ? raw.autoResolved
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          topic: String(r.topic ?? '').trim().slice(0, 120),
          decision: String(r.decision ?? '').trim().slice(0, 160),
          category: String(r.category ?? '').trim().slice(0, 48),
        }))
        .filter((r) => r.topic && r.decision)
    : []

  if (errors.length > 0) {
    return { ok: false, errors, payload: null }
  }

  return {
    ok: true,
    errors: [],
    payload: {
      chosenVariantId,
      taskId,
      mockHtmlPath,
      screenshotPath,
      styleTag,
      annotations,
      autoResolved,
    },
  }
}
