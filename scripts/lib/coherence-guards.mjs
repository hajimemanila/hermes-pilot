/**
 * Shared guard helpers for Layer 2 repository coherence checks (D90 / D99 / D103 / D104).
 *
 * Extracted from `scripts/check-coherence.mjs` so adding strengthened guards keeps
 * the main checker compact while preserving all public exports from `check-coherence.mjs`.
 *
 * All comments and strings in this module are strictly ASCII (SPEC-EN-ZERO-LEAK).
 */

/** Write routes whose failures must never be reported as HTTP 200 (D90). */
export const WRITE_ROUTES = Object.freeze(['abort', 'stop-all', 'close', 'unblock', 'bulk-archive', 'gateway'])

/** Only module allowed to swallow list-read errors via a warning wrapper (D103). */
export const SAFE_OWNER_FILE = 'apps/bridge/src/lib/safe.js'

/** Modules that must route status transitions through `review/transitions.js` (D99 / D104). */
export const TRANSITION_OWNER_FILES = Object.freeze([
  'apps/bridge/src/review.js',
  'apps/bridge/src/review/media.js',
  'apps/bridge/src/inbox.js',
])

/** Kanban verbs that only `apps/bridge/src/review/transitions.js` may run. */
const TRANSITION_VERBS = Object.freeze(['unblock', 'complete', 'request-changes', 'archive'])

/** The only `setInterval` period a component may keep for a wall clock (D107). */
export const CLOCK_INTERVAL_MS = 1000

/** Line number (1-based) of a character offset. */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * Blank out comments while keeping offsets and line numbers intact.
 *
 * Contract literals are only meaningful in code; a doc comment that mentions
 * `'hm:*'` or `/api/review/...` must not count as a call site.
 */
export function stripComments(text) {
  const src = String(text ?? '')
  const out = src.split('')
  let quote = null
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    i += 1
  }
  return out.join('')
}

/**
 * Split a source string into top level call spans (`callee(...)`).
 *
 * Comments are blanked first, so offsets keep matching the raw text while a
 * commented out call is invisible.
 *
 * @param {string} text source
 * @param {string[]} names callee names to look for
 * @returns {{callee: string, index: number, close: number, body: string}[]} spans
 */
export function callSpans(text, names) {
  const src = stripComments(String(text ?? ''))
  const out = []
  if (!Array.isArray(names) || names.length === 0) return out
  const re = new RegExp(`\\b(${names.map((n) => n.replace(/[$]/g, '\\$&')).join('|')})\\s*\\(`, 'g')
  for (const m of src.matchAll(re)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let close = src.length - 1
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    out.push({ callee: m[1], index: m.index, close, body: src.slice(open + 1, close) })
  }
  return out
}

/**
 * Split a call body at top level commas (strings and nested brackets are kept).
 *
 * @param {string} body call argument text
 * @returns {string[]} trimmed arguments
 */
export function splitTopLevelArgs(body) {
  const parts = []
  let depth = 0
  let start = 0
  let quote = null
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = body.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

/**
 * Numeric milliseconds of a `setInterval` delay argument, or null.
 *
 * Only a plain numeric literal counts (`1000` / `1_000`); a computed delay such as
 * `5 * 1000` stays null so it cannot silently look like a clock.
 *
 * @param {string} arg delay argument text
 * @returns {number|null} milliseconds
 */
export function intervalMsOf(arg) {
  let token = String(arg ?? '').trim()
  while (token.startsWith('(') && token.endsWith(')')) token = token.slice(1, -1).trim()
  const digits = token.replace(/_/g, '')
  return /^[0-9]+$/.test(digits) ? Number(digits) : null
}

/**
 * (9) Periodic `setInterval(` outside the sync scheduler (D97 / D107).
 *
 * The periodic sync is declared once in `lib/syncScheduler.js`; a timer written in
 * any other web module is the drift this rule exists for. The only exception is a
 * common rule, not a file allow list: a `CLOCK_INTERVAL_MS` timer whose callback
 * reads `Date.now()` is a wall clock. Comments do not count.
 *
 * @param {string} rel repository relative path (used in the reason only)
 * @param {string} text file source
 * @returns {{line: number, reason: string}[]} problems
 */
export function syncScopeProblems(rel, text) {
  const src = stripComments(String(text ?? ''))
  const problems = []
  for (const call of callSpans(src, ['setInterval'])) {
    const args = splitTopLevelArgs(call.body)
    const callback = args[0] ?? ''
    const everyMs = intervalMsOf(args[1] ?? '')
    if (everyMs === CLOCK_INTERVAL_MS && /Date\.now\s*\(/.test(callback)) continue
    problems.push({
      line: lineOf(src, call.index),
      reason: `periodic setInterval in ${rel}; declare the topic in lib/syncScheduler.js`,
    })
  }
  return problems
}

/**
 * Cut `server.js` into balanced `{...}` blocks, one per tracked write route.
 *
 * @param {string} text server.js source
 * @param {string[]} [tokens] route names to track
 * @returns {{route: string, line: number, text: string}[]} blocks
 */
export function routeBlocks(text, tokens = WRITE_ROUTES) {
  const src = stripComments(text)
  const lines = src.split('\n')
  const offsets = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/req\.method\s*===\s*'POST'/.test(line)) continue
    const route = tokens.find((token) => line.includes(`'${token}'`))
    if (!route) continue
    let depth = 0
    let started = false
    let close = src.length - 1
    for (let j = offsets[i]; j < src.length; j += 1) {
      const ch = src[j]
      if (ch === '{') {
        depth += 1
        started = true
      } else if (ch === '}') {
        depth -= 1
        if (started && depth === 0) {
          close = j
          break
        }
      }
    }
    blocks.push({ route, line: i + 1, text: src.slice(offsets[i], close + 1) })
  }
  return blocks
}

/** `sendJson(res, <status>, <payload>)` occurrences inside one block. */
function sendJsonCalls(blockText) {
  const out = []
  const re = /sendJson\s*\(\s*res\s*,\s*([0-9]{3})\s*,/g
  for (const m of blockText.matchAll(re)) {
    const from = m.index + m[0].length
    let depth = 1
    let i = from
    for (; i < blockText.length && depth > 0; i += 1) {
      const ch = blockText[i]
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
    }
    out.push({ status: Number(m[1]), index: m.index, payload: blockText.slice(from, Math.max(from, i - 1)).trim() })
  }
  return out
}

/**
 * (7a) `silent-failure-guard` (server side, strengthened by D103): a tracked write
 * route must not answer HTTP 200 with the bare result object of an awaited operation
 * unless it branches on `<result>.ok` before `sendJson(res, 200, <result>)` or
 * uses `sendOutcome()` / `sendFailure()`.
 *
 * Non-branching references such as `auth.audit({ ok: out.ok })` no longer bypass
 * this check.
 *
 * @param {string} text server.js source
 * @returns {{route: string, line: number, reason: string}[]} problems
 */
export function silentServerProblems(text) {
  const src = stripComments(text)
  const problems = []
  for (const block of routeBlocks(src)) {
    const assigned = [...block.text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\b/g)].map((m) => m[1])
    if (!assigned.length) continue
    for (const call of sendJsonCalls(block.text)) {
      if (call.status !== 200) continue
      const id = /^[A-Za-z_$][\w$]*$/.exec(call.payload)?.[0]
      if (!id || !assigned.includes(id)) continue
      const before = block.text.slice(0, call.index)
      const hasIfGuard = new RegExp(`\\bif\\s*\\([^)]*\\b${id}\\s*\\??\\.\\s*ok\\b`).test(before)
      const hasTernaryGuard = new RegExp(`\\b${id}\\s*\\??\\.\\s*ok\\b[^;{}]*\\?`).test(before)
      if (hasIfGuard || hasTernaryGuard) continue
      problems.push({
        route: block.route,
        line: block.line + block.text.slice(0, call.index).split('\n').length - 1,
        reason: `write route '${block.route}' answers HTTP 200 with '${id}' without consulting '${id}.ok'`,
      })
    }
  }
  return problems
}

/**
 * (11) Direct kanban status transition calls bypassing `review/transitions.js` (D99 / D104 / D109).
 *
 * Checks `runKanban(['unblock' | 'complete' | 'request-changes' | 'archive', ...])` as well as raw
 * `['kanban', ..., 'unblock' | 'complete' | 'request-changes' | 'archive', ...]` argument lists.
 * The verb list lives in one place (`TRANSITION_VERBS`), so adding a transition to the table and
 * forgetting the guard cannot happen silently.
 *
 * @param {string} rel repository relative path (used in the reason only)
 * @param {string} text file source
 * @returns {{line: number, reason: string}[]} problems
 */
export function transitionOwnerProblems(rel, text) {
  const src = stripComments(String(text ?? ''))
  const problems = []
  for (const verb of TRANSITION_VERBS) {
    const re = new RegExp(`runKanban\\(\\s*\\[\\s*['"\`]${verb}['"\`]`, 'g')
    for (const m of src.matchAll(re)) {
      problems.push({
        line: lineOf(src, m.index),
        reason: `runKanban(['${verb}'] in ${rel}; call transitions.apply() instead`,
      })
    }
  }
  const directRe = new RegExp(`\\[\\s*['"\`]kanban['"\`][^\\]]*['"\`](${TRANSITION_VERBS.join('|')})['"\`]`, 'g')
  for (const m of src.matchAll(directRe)) {
    problems.push({
      line: lineOf(src, m.index),
      reason: `direct kanban '${m[1]}' CLI array in ${rel}; call transitions.apply() instead`,
    })
  }
  return problems
}

/**
 * (14) Silent `catch { return [] }` blocks outside `lib/safe.js` (D103).
 *
 * Returning an empty array without logging turns unreadable files, corrupt JSON,
 * or SQLite errors into an indistinguishable "0 items" state. Use `safeList()`.
 *
 * @param {string} rel repository relative path
 * @param {string} text file source
 * @returns {{line: number, reason: string}[]} problems
 */
export function swallowOwnerProblems(rel, text) {
  if (rel === SAFE_OWNER_FILE) return []
  const src = stripComments(String(text ?? ''))
  const problems = []
  for (const m of src.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{\s*return\s*\[\s*\]\s*;?\s*\}/g)) {
    problems.push({
      line: lineOf(src, m.index),
      reason: `catch { return [] } outside ${SAFE_OWNER_FILE}; use safeList() so failures leave a warn log`,
    })
  }
  return problems
}
