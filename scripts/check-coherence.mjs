#!/usr/bin/env node
/**
 * Layer 2 coherence checker for this repository (SPEC-COHERENCE 3.3 / D80).
 *
 * Layer 1 (`apps/bridge/src/coherence.js`) is language agnostic and runs with zero
 * configuration in any repository. This file is the repository specific half: it
 * verifies the cross-cutting contracts that only exist in hermes-pilot (API parity,
 * event / storage namespaces, i18n and docs command parity, removed legacy symbols)
 * and the line-count ratchet.
 *
 * Output contract consumed by `runRepoChecker()` without any change there:
 *   `node scripts/check-coherence.mjs --json`
 *   -> exactly one JSON object on stdout: { ok, hardFails, softSignals }
 *   -> exit 0 when ok is true, exit 1 when a hard fail exists (a non-zero exit makes
 *      Layer 1 record a `repo-checker` soft signal and keeps the bridge alive).
 *
 * Flags:
 *   --json              machine readable output on stdout (nothing else on stdout)
 *   --strict            pending rules and ratchet growth become hard fails
 *   --update-baseline   lower ratchet entries for files that shrank
 *   --allow-grow        allow --update-baseline to raise an entry (needs a reason in review)
 *   --root <dir>        repository root (default: the parent of this script)
 *   --help              usage
 *
 * Rule arming: `.hermes-coherence.json` may list `checkerPending` as `{ "<rule>": "<batch>" }`.
 * A pending rule reports the same findings as a soft signal carrying `pending` plus
 * `fatal: true` instead of a hard fail, so drift stays visible and `--strict` already
 * enforces it today. Remove the entry once the owning batch lands; no code change needed.
 *
 * All output and all source text of this file are ASCII (SPEC-EN-ZERO-LEAK).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = path.resolve(fileURLToPath(import.meta.url))
const HERE = path.dirname(SELF)
const DEFAULT_ROOT = path.resolve(HERE, '..')

/** Repository layout facts used by the rules. */
const LAYOUT = Object.freeze({
  config: '.hermes-coherence.json',
  packageJson: 'package.json',
  baseline: 'scripts/coherence-baseline.json',
  webSrc: 'apps/web/src',
  webContracts: 'apps/web/src/contracts',
  webI18n: 'apps/web/src/i18n',
  mockApi: 'apps/web/src/demo/mockApi.js',
  bridgeSrc: 'apps/bridge/src',
  serverFile: 'apps/bridge/src/server.js',
  opsFile: 'apps/bridge/src/ops.js',
  routesContract: 'apps/bridge/src/contracts/routes.js',
  eventsContract: 'apps/web/src/contracts/events.js',
  storageContract: 'apps/web/src/contracts/storage.js',
})

/** Directories that hold runtime code for the legacy-symbol rule. */
const RUNTIME_DIRS = ['apps/bridge/src', 'apps/web/src', 'apps/dashboard', 'bin', 'scripts']

const CODE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-demo',
  'dist.next',
  'dist.prev',
  'coverage',
  '__pycache__',
  '.git',
])

/** Rule ids in reporting order. */
export const RULES = Object.freeze([
  'api-parity',
  'event-contract',
  'storage-contract',
  'docs-scripts-parity',
  'legacy-reentry',
  'cli-invocation-guard',
  'silent-failure-guard',
  'create-route-parity',
])

/* ------------------------------------------------------------------ */
/* small file helpers                                                   */
/* ------------------------------------------------------------------ */

/** POSIX style relative path. */
function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/')
}

/** Read a file as UTF-8, or null when it is missing / unreadable. */
export function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** Read and parse a JSON file, or null. */
export function readJson(abs) {
  const text = readText(abs)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Recursively list code files below `root/relDir`.
 *
 * @returns {{rel: string, abs: string}[]} sorted by relative path
 */
export function walkCode(root, relDir, exts = CODE_EXTS) {
  const out = []
  const start = path.join(root, relDir)
  const stack = [start]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (!exts.has(path.extname(entry.name))) continue
      out.push({ rel: toRel(root, abs), abs })
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** Line number (1-based) of a character offset. */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/** Count lines the same way `wc -l` does for a trailing newline. */
export function countLines(abs) {
  const text = readText(abs)
  if (text === null) return null
  const parts = text.split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
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

/** Glob (only `**` and `*`) to RegExp. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 1
        if (glob[i + 1] === '/') i += 1
      } else {
        re += '[^/]*'
      }
      continue
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** True when the text contains CJK / full width characters (SPEC-EN-ZERO-LEAK). */
export function containsCJK(text) {
  return /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(String(text ?? ''))
}

/* ------------------------------------------------------------------ */
/* findings                                                             */
/* ------------------------------------------------------------------ */

/** Build one issue object (the shape `coherence.js` stores verbatim). */
function makeIssue(rule, severity, message, extra = {}) {
  return { rule, severity, message, ...extra }
}

/**
 * Collects findings and applies the arming policy.
 *
 * `pending[rule]` is a batch id: findings of that rule become soft signals marked
 * `fatal: true` so drift is still reported (and `--strict` fails on it) while the
 * upstream contract module does not exist yet.
 */
export class Findings {
  constructor(pending = {}) {
    this.pending = pending && typeof pending === 'object' ? pending : {}
    this.hardFails = []
    this.softSignals = []
  }

  /** A rule violation: hard by default, soft while the rule is pending. */
  violation(rule, message, extra = {}) {
    const pending = this.pending?.[rule]
    if (pending) {
      this.softSignals.push(
        makeIssue(rule, 'soft', `${message} [pending ${pending}]`, { ...extra, pending, fatal: true }),
      )
      return
    }
    this.hardFails.push(makeIssue(rule, 'hard', message, extra))
  }

  /** An informational signal that never fails the build by itself. */
  soft(rule, message, extra = {}) {
    this.softSignals.push(makeIssue(rule, 'soft', message, extra))
  }
}

/* ------------------------------------------------------------------ */
/* API parity                                                           */
/* ------------------------------------------------------------------ */

const API_LITERAL_RE = /(['"`])(\/api\/[A-Za-z0-9_./:${}[\]-]*)\1/g
const API_PREFIX_RE = /startsWith\(\s*(['"`])(\/api\/[A-Za-z0-9_./:${}[\]-]*)\1\s*\)/g

/** Normalise an API path so literals, templates and registry patterns compare. */
export function normalizeApiPath(raw) {
  let s = String(raw ?? '')
  s = s.split('?')[0].split('#')[0]
  // A whole interpolated segment is a parameter; an inline one is an optional
  // suffix such as `/api/architect/jobs${qs}` and disappears on its own.
  s = s.replace(/(^|\/)\$\{[^}]*\}(?=\/|$)/g, '$1:p')
  s = s.replace(/\$\{[^}]*\}/g, '')
  s = s.replace(/(^|\/):[A-Za-z_][A-Za-z0-9_]*/g, '$1:p')
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return s || '/'
}

function segmentsOf(p) {
  return normalizeApiPath(p).split('/').filter(Boolean)
}

function isWildcardSegment(seg) {
  return seg === ':p' || seg === '...' || seg === '*' || seg.startsWith(':')
}

/**
 * Segment-wise match. Both sides may be dynamic (`:p` / `:id`), the registry uses
 * `*` for "and everything below", and a trailing `...` means the same thing.
 */
export function pathMatches(pattern, candidate) {
  const a = segmentsOf(pattern)
  const b = segmentsOf(candidate)
  if (!a.length || !b.length) return false
  const restWildcard = a[a.length - 1] === '...' || a[a.length - 1] === '*'
  const limit = restWildcard ? a.length - 1 : Math.max(a.length, b.length)
  for (let i = 0; i < limit; i += 1) {
    if (i >= a.length) return restWildcard
    if (i >= b.length) return false
    if (a[i] === b[i]) continue
    if (isWildcardSegment(a[i]) || isWildcardSegment(b[i])) continue
    return false
  }
  if (!restWildcard && a.length !== b.length) return false
  return true
}

/** Collect `/api/...` literals from a set of files (comments are ignored). */
function collectApiPaths(files, includePrefixes = false) {
  const out = []
  for (const file of files) {
    const raw = readText(file.abs)
    if (raw === null) continue
    const text = stripComments(raw)
    for (const m of text.matchAll(API_LITERAL_RE)) {
      out.push({ file: file.rel, line: lineOf(text, m.index), path: normalizeApiPath(m[2]) })
    }
    if (includePrefixes) {
      for (const m of text.matchAll(API_PREFIX_RE)) {
        out.push({ file: file.rel, line: lineOf(text, m.index), path: `${normalizeApiPath(m[2])}/...` })
      }
    }
  }
  return out
}

/**
 * Derive registered routes from `apps/bridge/src/server.js`.
 *
 * The dispatcher uses `a` / `b` / `c` path segments (`if (a === 'repos') { ... }`),
 * so gates are collected with a brace-depth stack. A gate can be depth only
 * (`b && c === 'board'`), in which case the skipped levels become `:p`.
 * Literal `/api/...` strings are added as well; this is a heuristic signal.
 */
export function extractServerRoutes(text) {
  const routes = new Set()
  const src = stripComments(text)
  for (const m of src.matchAll(API_LITERAL_RE)) {
    routes.add(normalizeApiPath(m[2]))
  }
  const LEVEL = { a: 1, b: 2, c: 3 }
  const lines = src.split('\n')
  const stack = []
  let depth = 0
  for (const line of lines) {
    while (stack.length && stack[stack.length - 1].depth > depth) stack.pop()
    const gates = [...line.matchAll(/\b([abc])\s*===\s*'([^']+)'/g)]
    const parentSegs = stack.length ? stack[stack.length - 1].segs : ['api']
    if (gates.length) {
      const segs = [...parentSegs]
      for (const gate of gates) {
        const level = LEVEL[gate[1]]
        while (segs.length < level) segs.push(':p')
        segs[level] = gate[2]
      }
      routes.add(normalizeApiPath(`/${segs.join('/')}`))
      if (line.includes('{')) stack.push({ depth: depth + 1, segs })
    } else if (stack.length && /req\.method\s*===/.test(line)) {
      routes.add(normalizeApiPath(`/${parentSegs.join('/')}`))
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
  }
  return routes
}

/**
 * Namespace match: the first two path segments agree.
 *
 * `mockApi.js` resolves board / review sub-paths structurally (`parts[3] === 'data'`)
 * instead of with literals, and `server.js` gates some sub-routes on a dynamic
 * segment, so an exact pattern match alone would report false drift. Namespace
 * agreement still catches a whole missing surface.
 */
export function namespaceMatches(pattern, candidate) {
  const a = segmentsOf(pattern)
  const b = segmentsOf(candidate)
  if (a.length < 2 || b.length < 2) return false
  for (let i = 0; i < 2; i += 1) {
    if (a[i] === b[i]) continue
    if (isWildcardSegment(a[i]) || isWildcardSegment(b[i])) continue
    return false
  }
  return true
}

/** True when `candidates` covers `pattern` exactly or at namespace level. */
function coveredBy(pattern, candidates) {
  return candidates.some((candidate) => pathMatches(candidate, pattern) || namespaceMatches(candidate, pattern))
}

/**
 * Load the route registry (`API_ROUTES`) when COH-2 has landed.
 *
 * Tries a real import first (the registry is a plain ESM module), then falls back to
 * a literal scan so a partially written registry still yields patterns.
 */
export async function loadRouteRegistry(root) {
  const abs = path.join(root, LAYOUT.routesContract)
  const text = readText(abs)
  if (text === null) return { present: false, routes: [] }
  let entries = []
  try {
    const mod = await import(`${pathToFileURL(abs).href}?v=${fs.statSync(abs).mtimeMs}`)
    const raw = mod.API_ROUTES ?? mod.ROUTES ?? mod.default
    if (Array.isArray(raw)) {
      entries = raw
    } else if (raw && typeof raw === 'object') {
      entries = Object.entries(raw).map(([key, value]) => {
        const [method, pattern] = key.includes(' ') ? key.split(/\s+/, 2) : [null, key]
        return { method, pattern, ...(value && typeof value === 'object' ? value : {}) }
      })
    }
  } catch {
    entries = []
  }
  const routes = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const pattern = entry.pattern ?? entry.path ?? entry.route
    if (typeof pattern !== 'string' || !pattern.startsWith('/api/')) continue
    routes.push({
      method: typeof entry.method === 'string' ? entry.method.toUpperCase() : null,
      pattern: normalizeApiPath(pattern),
      demo: typeof entry.demo === 'string' ? entry.demo : null,
      deprecated: entry.deprecated === true || entry.demo === 'deprecated',
      deprecatedBy: typeof entry.deprecatedBy === 'string' ? entry.deprecatedBy : null,
    })
  }
  if (!routes.length) {
    // Fallback: plain literal scan of the registry file.
    for (const m of text.matchAll(API_LITERAL_RE)) {
      routes.push({ method: null, pattern: normalizeApiPath(m[2]), demo: null, deprecated: false, deprecatedBy: null })
    }
  }
  return { present: true, routes }
}

/** (1) API parity: web literals <-> API_ROUTES <-> server.js <-> mockApi.js. */
async function ruleApiParity(root, findings) {
  const rule = 'api-parity'
  const webFiles = walkCode(root, LAYOUT.webSrc).filter((file) => file.rel !== LAYOUT.mockApi)
  const webPaths = collectApiPaths(webFiles)
  const serverText = readText(path.join(root, LAYOUT.serverFile))
  if (serverText === null) {
    findings.soft(rule, `${LAYOUT.serverFile} not found; API parity skipped`)
    return
  }
  const serverRoutes = extractServerRoutes(serverText)
  const mockAbs = path.join(root, LAYOUT.mockApi)
  const mockPaths = readText(mockAbs) === null ? [] : collectApiPaths([{ rel: LAYOUT.mockApi, abs: mockAbs }], true)
  const registry = await loadRouteRegistry(root)

  const uniqueWeb = [...new Map(webPaths.map((p) => [p.path, p])).values()]

  if (!registry.present) {
    const unmatched = uniqueWeb.filter((entry) => ![...serverRoutes].some((route) => pathMatches(route, entry.path)))
    findings.violation(
      rule,
      `API route registry missing (${LAYOUT.routesContract}); ${uniqueWeb.length} web /api literal path(s), ${unmatched.length} without a server.js match`,
      {
        value: unmatched.length,
        files: unmatched.slice(0, 10).map((entry) => ({ file: entry.file, line: entry.line, path: entry.path })),
        serverRoutes: serverRoutes.size,
        mockRoutes: new Set(mockPaths.map((p) => p.path)).size,
      },
    )
    return
  }

  const routes = registry.routes

  // Deprecated routes must not be called from the web bundle any more.
  const deprecatedCalls = []
  for (const route of routes.filter((entry) => entry.deprecated)) {
    for (const entry of uniqueWeb) {
      if (pathMatches(route.pattern, entry.path)) {
        deprecatedCalls.push({ file: entry.file, line: entry.line, path: entry.path, deprecatedBy: route.deprecatedBy })
      }
    }
  }
  if (deprecatedCalls.length) {
    findings.violation(rule, `${deprecatedCalls.length} call(s) to deprecated API route(s)`, {
      value: deprecatedCalls.length,
      files: deprecatedCalls.slice(0, 10),
    })
  }

  // Every web literal must be registered.
  const unregistered = uniqueWeb.filter((entry) => !routes.some((route) => pathMatches(route.pattern, entry.path)))
  if (unregistered.length) {
    findings.violation(rule, `${unregistered.length} web /api path(s) not present in API_ROUTES`, {
      value: unregistered.length,
      files: unregistered.slice(0, 10).map((entry) => ({ file: entry.file, line: entry.line, path: entry.path })),
    })
  }

  // Demo parity: mocked routes need a mockApi handler, bridge-only routes need a server route.
  const demoMissing = []
  const serverMissing = []
  const serverList = [...serverRoutes]
  const mockList = mockPaths.map((entry) => entry.path)
  for (const route of routes) {
    if (route.demo === 'mocked') {
      if (!coveredBy(route.pattern, mockList)) demoMissing.push({ path: route.pattern, method: route.method })
    }
    if (route.demo === 'bridge-only') {
      if (!coveredBy(route.pattern, serverList)) serverMissing.push({ path: route.pattern, method: route.method })
    }
  }
  if (demoMissing.length) {
    findings.violation(rule, `${demoMissing.length} mocked route(s) without a mockApi.js handler`, {
      value: demoMissing.length,
      routes: demoMissing.slice(0, 10),
    })
  }
  if (serverMissing.length) {
    findings.violation(rule, `${serverMissing.length} bridge-only route(s) without a server.js route`, {
      value: serverMissing.length,
      routes: serverMissing.slice(0, 10),
    })
  }
}

/* ------------------------------------------------------------------ */
/* event / storage contracts                                            */
/* ------------------------------------------------------------------ */

const EVENT_LITERAL_RE = /(['"`])(hm:[A-Za-z0-9_:.-]+)\1/g
const STORAGE_LITERAL_RE = /(['"`])(hm\.[A-Za-z0-9_:.-]+)\1/g

/** Files of `apps/web/src` that are allowed to spell namespace literals. */
function namespaceSources(root) {
  return walkCode(root, LAYOUT.webSrc).filter((file) => !file.rel.startsWith(`${LAYOUT.webContracts}/`))
}

/** Collect declared values (strings starting with `prefix`) from a contract module. */
export async function loadContractNames(root, relPath, prefix) {
  const abs = path.join(root, relPath)
  if (readText(abs) === null) return { present: false, names: [] }
  const names = new Set()
  try {
    const mod = await import(`${pathToFileURL(abs).href}?v=${fs.statSync(abs).mtimeMs}`)
    const visit = (value) => {
      if (typeof value === 'string') {
        if (value.startsWith(prefix)) names.add(value)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) visit(item)
      }
    }
    for (const value of Object.values(mod)) visit(value)
  } catch {
    const text = readText(abs) ?? ''
    const re = new RegExp(`(['"\`])(${prefix.replace('.', '\\.')}[A-Za-z0-9_:.-]+)\\1`, 'g')
    for (const m of text.matchAll(re)) names.add(m[2])
  }
  return { present: true, names: [...names].sort() }
}

/** Classify how a namespace literal is used on its line. */
function classifyUse(line) {
  if (/addEventListener|removeEventListener|\.on\(|\.once\(/.test(line)) return 'listen'
  if (/dispatchEvent|CustomEvent|emitHmEvent|\.emit\(/.test(line)) return 'emit'
  return null
}

/**
 * Find `hm:open-*` literals that sit inside a `setTimeout(...)` /
 * `requestAnimationFrame(...)` call, i.e. a cross-pane event relayed by a timer
 * instead of a prop (the App.jsx fragility removed in D81).
 *
 * @returns {{index: number, name: string}[]} match offsets inside the timer call
 */
export function timerRelayHits(text) {
  const src = stripComments(text)
  const hits = []
  const opener = /(?:setTimeout|requestAnimationFrame)\s*\(/g
  for (const call of src.matchAll(opener)) {
    const start = call.index + call[0].length
    let depth = 1
    let i = start
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      i += 1
    }
    const body = src.slice(start, Math.max(start, i - 1))
    for (const m of body.matchAll(EVENT_LITERAL_RE)) {
      if (!m[2].startsWith('hm:open-')) continue
      hits.push({ index: start + m.index, name: m[2] })
    }
  }
  return hits
}

/** (2) Event contract: no raw `hm:*` outside contracts, no one sided events, no setTimeout relay. */
async function ruleEventContract(root, findings) {
  const rule = 'event-contract'
  const violations = []
  for (const file of namespaceSources(root)) {
    const raw = readText(file.abs)
    if (raw === null) continue
    const text = stripComments(raw)
    for (const m of text.matchAll(EVENT_LITERAL_RE)) {
      violations.push({ file: file.rel, line: lineOf(text, m.index), name: m[2] })
    }
  }
  if (violations.length) {
    findings.violation(rule, `${violations.length} raw 'hm:*' literal(s) outside ${LAYOUT.eventsContract}`, {
      value: violations.length,
      files: violations.slice(0, 10),
    })
  }

  const contract = await loadContractNames(root, LAYOUT.eventsContract, 'hm:')
  if (!contract.present) {
    findings.soft(rule, `${LAYOUT.eventsContract} not found; one-sided / setTimeout checks skipped`)
    return
  }

  // Declared names must be used on both sides (emitted and listened).
  const uses = new Map()
  for (const file of walkCode(root, LAYOUT.webSrc)) {
    const raw = readText(file.abs)
    if (raw === null) continue
    const lines = stripComments(raw).split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      for (const m of lines[i].matchAll(EVENT_LITERAL_RE)) {
        const kind = classifyUse(lines[i])
        if (!kind) continue
        const entry = uses.get(m[2]) ?? { emit: 0, listen: 0 }
        entry[kind] += 1
        uses.set(m[2], entry)
      }
    }
  }
  const oneSided = []
  for (const [name, counts] of uses) {
    const declared = contract.names.includes(name) || name.startsWith('hm:fx:')
    if (!declared) continue
    if (counts.emit > 0 && counts.listen === 0) oneSided.push({ name, kind: 'emit-only' })
    if (counts.listen > 0 && counts.emit === 0) oneSided.push({ name, kind: 'listen-only' })
  }
  if (oneSided.length) {
    findings.violation(rule, `${oneSided.length} one sided event(s) (no listener or no emitter)`, {
      value: oneSided.length,
      events: oneSided.slice(0, 10),
    })
  }

  // `hm:open-*` must never travel through a timer relay (App.jsx fragility).
  const relayed = []
  for (const file of walkCode(root, LAYOUT.webSrc)) {
    const rawFile = readText(file.abs)
    if (rawFile === null) continue
    const text = stripComments(rawFile)
    for (const hit of timerRelayHits(text)) {
      relayed.push({ file: file.rel, line: lineOf(text, hit.index), name: hit.name })
    }
  }
  if (relayed.length) {
    findings.violation(rule, `${relayed.length} 'hm:open-*' event(s) fired from a timer relay`, {
      value: relayed.length,
      files: relayed.slice(0, 10),
    })
  }
}

/** (3) Storage contract: no raw `hm.*` outside contracts. */
async function ruleStorageContract(root, findings) {
  const rule = 'storage-contract'
  const violations = []
  for (const file of namespaceSources(root)) {
    const raw = readText(file.abs)
    if (raw === null) continue
    const text = stripComments(raw)
    for (const m of text.matchAll(STORAGE_LITERAL_RE)) {
      violations.push({ file: file.rel, line: lineOf(text, m.index), key: m[2] })
    }
  }
  const contract = await loadContractNames(root, LAYOUT.storageContract, 'hm.')
  if (violations.length) {
    findings.violation(
      rule,
      `${violations.length} raw 'hm.*' storage literal(s) outside ${LAYOUT.storageContract} (contract declares ${contract.names.length})`,
      { value: violations.length, files: violations.slice(0, 10), declaredKeys: contract.names.length },
    )
    return
  }
  if (!contract.present) findings.soft(rule, `${LAYOUT.storageContract} not found; storage namespace is unclaimed`)
}

/* ------------------------------------------------------------------ */
/* docs / scripts parity                                                */
/* ------------------------------------------------------------------ */

/** Flatten a nested translation dictionary into dotted keys. */
export function flattenKeys(value, prefix = '') {
  const out = new Set()
  if (!value || typeof value !== 'object') return out
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const nested of flattenKeys(child, full)) out.add(nested)
    } else {
      out.add(full)
    }
  }
  return out
}

/** Docs that must only reference scripts that exist. */
export const DOC_FILES = ['README.md', 'README.ja.md', 'docs/PITFALLS.md', 'docs/OPERATIONS.md']

/** (4) i18n key parity + `npm run <name>` parity in the docs. */
async function ruleDocsScriptsParity(root, findings) {
  const rule = 'docs-scripts-parity'
  const en = readJson(path.join(root, LAYOUT.webI18n, 'en.json'))
  const ja = readJson(path.join(root, LAYOUT.webI18n, 'ja.json'))
  if (!en || !ja) {
    findings.soft(rule, `i18n dictionaries not found under ${LAYOUT.webI18n}; key parity skipped`)
  } else {
    const enKeys = flattenKeys(en)
    const jaKeys = flattenKeys(ja)
    const enOnly = [...enKeys].filter((key) => !jaKeys.has(key))
    const jaOnly = [...jaKeys].filter((key) => !enKeys.has(key))
    if (enOnly.length || jaOnly.length) {
      findings.violation(rule, `i18n key mismatch: ${enOnly.length} en-only, ${jaOnly.length} ja-only`, {
        value: enOnly.length + jaOnly.length,
        enOnly: enOnly.slice(0, 10),
        jaOnly: jaOnly.slice(0, 10),
      })
    }
  }

  const pkg = readJson(path.join(root, LAYOUT.packageJson))
  if (!pkg || typeof pkg.scripts !== 'object' || !pkg.scripts) {
    findings.soft(rule, `${LAYOUT.packageJson} has no scripts block; docs command parity skipped`)
    return
  }
  const scripts = new Set(Object.keys(pkg.scripts))
  const missing = []
  for (const rel of DOC_FILES) {
    const text = readText(path.join(root, rel))
    if (text === null) continue
    for (const m of text.matchAll(/npm run ([A-Za-z0-9:_.-]+)/g)) {
      if (!scripts.has(m[1])) missing.push({ file: rel, line: lineOf(text, m.index), script: m[1] })
    }
  }
  if (missing.length) {
    findings.violation(rule, `${missing.length} documented command(s) missing from package.json scripts`, {
      value: missing.length,
      files: missing.slice(0, 10),
    })
  }
}

/* ------------------------------------------------------------------ */
/* legacy re-entry                                                      */
/* ------------------------------------------------------------------ */

/**
 * Symbols that were removed on purpose and must not come back.
 *
 * Each entry lists the only places where the spelling may still appear (the module
 * that legitimately keeps the file-placement helper, the boundary checker that
 * asserts the removal, and the tests that pin it).
 */
export const LEGACY_SYMBOLS = Object.freeze([
  {
    name: 'optimizeAntigravitySkills',
    allow: ['apps/bridge/src/pipeline-optimizer.js'],
    note: 'file placement helper only; no process spawn',
  },
  {
    name: 'hasAgyCli',
    allow: ['scripts/check-oauth-boundary.mjs'],
    note: 'agy CLI detection was removed (SPEC-PILOT-V11 / D50)',
  },
  {
    name: 'agyCliDirs',
    allow: ['scripts/check-oauth-boundary.mjs'],
    note: 'agy CLI detection was removed (SPEC-PILOT-V11 / D50)',
  },
  {
    name: 'resolveAgyBin',
    allow: ['scripts/check-oauth-boundary.mjs'],
    note: 'agy CLI detection was removed (SPEC-PILOT-V11 / D50)',
  },
  {
    name: 'RUNNER_UNAVAILABLE',
    allow: [],
    note: 'the single-runner contract has no unavailable state',
  },
])

/** (5) Removed symbols must not re-enter runtime code. */
async function ruleLegacyReentry(root, findings) {
  const rule = 'legacy-reentry'
  const files = RUNTIME_DIRS.flatMap((dir) => walkCode(root, dir))
  const violations = []
  for (const symbol of LEGACY_SYMBOLS) {
    const allowed = symbol.allow.map(globToRegExp)
    for (const file of files) {
      if (file.rel === toRel(root, SELF)) continue
      if (allowed.some((re) => re.test(file.rel))) continue
      const raw = readText(file.abs)
      if (raw === null) continue
      const text = stripComments(raw)
      if (!text.includes(symbol.name)) continue
      const index = text.indexOf(symbol.name)
      violations.push({ file: file.rel, line: lineOf(text, index), symbol: symbol.name })
    }
  }
  if (violations.length) {
    findings.violation(rule, `${violations.length} removed symbol reference(s) re-entered runtime code`, {
      value: violations.length,
      files: violations.slice(0, 10),
    })
  }
}

/* ------------------------------------------------------------------ */
/* recurrence guards (D94)                                              */
/* ------------------------------------------------------------------ */

/**
 * Every child process edge in `apps/bridge/src` must reach the real CLI the same
 * way: resolve the binary once, and augment `PATH` for launchd's narrow default.
 * A hand written `execFile('hermes', ...)` reintroduces the 2026-11 outage.
 */
const CLI_SPAWN_NAMES = ['execFile', 'execFileSync', 'spawn', 'spawnSync']
const CLI_CONTEXT_CHARS = 2000

/**
 * Split a source string into top level call spans (`callee(...)`).
 *
 * Comments are blanked first, so offsets keep matching the raw text while a
 * commented out call is invisible.
 *
 * @param {string} text source
 * @param {string[]} [names] callee names to look for
 * @returns {{callee: string, index: number, close: number, body: string}[]} spans
 */
export function callSpans(text, names = CLI_SPAWN_NAMES) {
  const src = stripComments(text)
  const out = []
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

/** True when the argument list is a hermes CLI invocation. */
function isHermesInvocation(args, body) {
  const bin = (args[0] ?? '').trim()
  if (/^['"]hermes['"]$/.test(bin)) return true
  if (/resolveHermesBin|hermesBin/.test(bin)) return true
  return /['"]kanban['"]/.test(body) || /['"]--board['"]/.test(body)
}

/**
 * (6) `cli-invocation-guard`: every hermes CLI spawn in `apps/bridge/src` must use
 * `resolveHermesBin()` and `buildAugmentedPath()`, and must never put `'--board'`
 * before `'kanban'` (the CLI parses the subcommand first).
 *
 * @param {string} text source of one file
 * @returns {{line: number, reason: string, callee?: string}[]} problems
 */
export function cliInvocationProblems(text) {
  const src = stripComments(text)
  const problems = []
  for (const call of callSpans(src)) {
    const args = splitTopLevelArgs(call.body)
    if (!isHermesInvocation(args, call.body)) continue
    const line = lineOf(src, call.index)
    const before = src.slice(Math.max(0, call.index - CLI_CONTEXT_CHARS), call.close + 1)
    if (!/resolveHermesBin/.test(before)) {
      problems.push({ line, reason: 'hermes CLI spawn without resolveHermesBin()', callee: call.callee })
    }
    if (!/buildAugmentedPath/.test(call.body)) {
      problems.push({ line, reason: 'hermes CLI spawn without buildAugmentedPath() in the env PATH', callee: call.callee })
    }
    const kanbanAt = call.body.search(/['"]kanban['"]/)
    const boardAt = call.body.search(/['"]--board['"]/)
    if (kanbanAt >= 0 && boardAt >= 0 && boardAt < kanbanAt) {
      problems.push({ line, reason: "'--board' placed before 'kanban' in the CLI argument list", callee: call.callee })
    }
  }
  return problems
}

/** Write routes whose failures must never be reported as HTTP 200 (D90). */
export const WRITE_ROUTES = Object.freeze(['abort', 'stop-all', 'close', 'unblock', 'bulk-archive', 'gateway'])

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
 * (7a) `silent-failure-guard` (server side): a tracked write route must not answer
 * HTTP 200 with the bare result object of an awaited operation unless it consulted
 * `<result>.ok` or converted the failure with `sendFailure()`.
 *
 * Routes that throw `ApiError` on failure are unaffected: their 200 body cannot
 * carry `ok: false`.
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
      const consultsOk = new RegExp(`\\b${id}\\s*\\??\\.\\s*ok\\b`).test(block.text)
      if (consultsOk) continue
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
 * (7b) `silent-failure-guard` (ops side): an error detail captured from a failure
 * must reach the caller; a local that is never read again drops the cause.
 *
 * @param {string} text ops.js source
 * @returns {{line: number, name: string}[]} discarded locals
 */
export function unusedErrorDetails(text) {
  const src = stripComments(text)
  const out = []
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n]*\b(?:detail|details|errorMessage|errDetail|stderr)\b[^\n]*/g)) {
    const name = m[1]
    const rest = src.slice(m.index + m[0].length)
    if (new RegExp(`\\b${name}\\b`).test(rest)) continue
    out.push({ line: lineOf(src, m.index), name })
  }
  return out
}

/** Files that build a `hermes kanban create` argument list. */
export const CREATE_ARG_FILES = Object.freeze([
  'apps/bridge/src/specs.js',
  'apps/bridge/src/architect.js',
  'apps/bridge/src/review.js',
  'apps/bridge/src/capture.js',
])

/** Files whose in process quick create must wake the dispatcher. */
export const NUDGE_ROUTE_FILES = Object.freeze(['apps/bridge/src/server.js'])

/**
 * (8) `create-route-parity`: every filing path must assign an owner and the in
 * process quick create must nudge the watchers, otherwise a task lands unowned
 * (never dispatched) or sits until the next 60 s tick.
 *
 * @param {string} rel repository relative path
 * @param {string} text file source
 * @returns {{line: number, reason: string}[]} problems
 */
export function createParityProblems(rel, text) {
  const src = stripComments(text)
  const problems = []
  const filesTasks = /['"]create['"]/.test(src)
  if (CREATE_ARG_FILES.includes(rel)) {
    if (!filesTasks) return problems
    if (!/['"]--assignee['"]/.test(src)) {
      problems.push({ line: lineOf(src, src.search(/['"]create['"]/)), reason: 'kanban create argument list without --assignee' })
    }
    return problems
  }
  if (NUDGE_ROUTE_FILES.includes(rel)) {
    if (!/capture\.create\s*\(/.test(src)) return problems
    if (!/\bnudgeWatchers\s*\(\s*\)/.test(src)) {
      problems.push({ line: 1, reason: 'quick create route does not call nudgeWatchers()' })
    }
    if (!/\bassignee\b/.test(src)) {
      problems.push({ line: 1, reason: 'quick create route does not forward an assignee' })
    }
  }
  return problems
}

/** (6) Recurrence guard: hermes CLI spawn contract across `apps/bridge/src`. */
async function ruleCliInvocationGuard(root, findings) {
  const rule = 'cli-invocation-guard'
  const hits = []
  for (const file of walkCode(root, LAYOUT.bridgeSrc)) {
    const raw = readText(file.abs)
    if (raw === null) continue
    for (const problem of cliInvocationProblems(raw)) {
      hits.push({ file: file.rel, line: problem.line, reason: problem.reason, callee: problem.callee })
    }
  }
  if (hits.length) {
    findings.violation(rule, `${hits.length} hermes CLI spawn(s) break the binary resolution / argument order contract`, {
      value: hits.length,
      files: hits.slice(0, 10),
    })
  }
}

/** (7) Recurrence guard: failures must not be swallowed into HTTP 200 / dropped details. */
async function ruleSilentFailureGuard(root, findings) {
  const rule = 'silent-failure-guard'
  const hits = []
  const serverText = readText(path.join(root, LAYOUT.serverFile))
  if (serverText === null) {
    findings.soft(rule, `${LAYOUT.serverFile} not found; write route audit skipped`)
  } else {
    for (const problem of silentServerProblems(serverText)) {
      hits.push({ file: LAYOUT.serverFile, line: problem.line, route: problem.route, reason: problem.reason })
    }
  }
  const opsText = readText(path.join(root, LAYOUT.opsFile))
  if (opsText === null) {
    findings.soft(rule, `${LAYOUT.opsFile} not found; discarded error detail audit skipped`)
  } else {
    for (const problem of unusedErrorDetails(opsText)) {
      hits.push({ file: LAYOUT.opsFile, line: problem.line, name: problem.name, reason: `error detail '${problem.name}' is computed and never used` })
    }
  }
  if (hits.length) {
    findings.violation(rule, `${hits.length} silent failure risk(s): HTTP 200 on a failed result or a discarded error detail`, {
      value: hits.length,
      files: hits.slice(0, 10),
    })
  }
}

/** (8) Recurrence guard: filing routes stay at parity (assignee + watcher nudge). */
async function ruleCreateRouteParity(root, findings) {
  const rule = 'create-route-parity'
  const hits = []
  for (const rel of [...CREATE_ARG_FILES, ...NUDGE_ROUTE_FILES]) {
    const text = readText(path.join(root, rel))
    if (text === null) continue
    for (const problem of createParityProblems(rel, text)) {
      hits.push({ file: rel, line: problem.line, reason: problem.reason })
    }
  }
  if (hits.length) {
    findings.violation(rule, `${hits.length} kanban filing route(s) miss the assignee / watcher nudge contract`, {
      value: hits.length,
      files: hits.slice(0, 10),
    })
  }
}

/* ------------------------------------------------------------------ */
/* ratchet + akapen soft signals                                        */
/* ------------------------------------------------------------------ */

/** Resolve the baseline path from the coherence config. */
export function baselinePath(root, cfg = {}) {
  const rel = typeof cfg?.baselineFile === 'string' ? cfg.baselineFile : LAYOUT.baseline
  return path.join(root, rel)
}

/**
 * Compare every baselined file with its current line count.
 *
 * @returns {{entries: {file: string, base: number, current: number|null, delta: number}[], path: string, loaded: boolean}}
 */
export function baselineRatchet(root, cfg = {}) {
  const abs = baselinePath(root, cfg)
  const data = readJson(abs)
  const entries = []
  if (!data || typeof data.files !== 'object' || !data.files) return { entries, path: abs, loaded: false }
  for (const [file, base] of Object.entries(data.files)) {
    const current = countLines(path.join(root, file))
    entries.push({ file, base: Number(base), current, delta: current === null ? 0 : current - Number(base) })
  }
  return { entries, path: abs, loaded: true }
}

/** Report ratchet growth (fatal soft) and shrinkage (informational). */
function ratchetSignals(root, cfg, findings) {
  const { entries, loaded } = baselineRatchet(root, cfg)
  if (!loaded) {
    findings.soft('baseline-ratchet', `baseline file not found or invalid; ratchet skipped`)
    return
  }
  const grown = entries.filter((entry) => entry.current !== null && entry.delta > 0)
  const shrunk = entries.filter((entry) => entry.current !== null && entry.delta < 0)
  const missing = entries.filter((entry) => entry.current === null)
  if (grown.length) {
    findings.soft(
      'baseline-ratchet',
      `${grown.length} file(s) grew past the ratchet baseline`,
      {
        value: grown.length,
        fatal: true,
        files: grown.slice(0, 10).map((entry) => ({ file: entry.file, base: entry.base, current: entry.current })),
      },
    )
  }
  if (shrunk.length) {
    findings.soft('baseline-ratchet', `${shrunk.length} file(s) shrank; run --update-baseline to ratchet down`, {
      value: shrunk.length,
      files: shrunk.slice(0, 10).map((entry) => ({ file: entry.file, base: entry.base, current: entry.current })),
    })
  }
  if (missing.length) {
    findings.soft('baseline-ratchet', `${missing.length} baselined file(s) no longer exist; run --update-baseline to drop them`, {
      value: missing.length,
      files: missing.slice(0, 10).map((entry) => entry.file),
    })
  }
}

/** Where the legacy product name may still appear (migration compatibility). */
const AKAPEN_ALLOWED = [
  'bin/**',
  'scripts/migrate-to-hermes-pilot.mjs',
  'scripts/postinstall.mjs',
  'package.json',
  'plugin.yaml',
  'plugin.json',
  'docs/**',
  'README.md',
  'README.ja.md',
  'apps/bridge/test/**',
  'apps/web/test/**',
  'apps/dashboard/**/*.py',
  'demo/**',
]

/** Count remaining legacy product name references outside the migration allowlist. */
function akapenSignal(root, findings) {
  const allowed = AKAPEN_ALLOWED.map(globToRegExp)
  const hits = []
  for (const dir of ['apps/bridge/src', 'apps/web/src', 'apps/dashboard', 'scripts', 'bin']) {
    for (const file of walkCode(root, dir)) {
      if (file.rel === toRel(root, SELF)) continue
      if (allowed.some((re) => re.test(file.rel))) continue
      const text = readText(file.abs)
      if (text === null) continue
      const count = (text.match(/akapen/gi) ?? []).length
      if (count) hits.push({ file: file.rel, count })
    }
  }
  const total = hits.reduce((sum, hit) => sum + hit.count, 0)
  if (total) {
    findings.soft('akapen-residual', `${total} legacy 'akapen' reference(s) outside the migration allowlist`, {
      value: total,
      files: hits.slice(0, 10),
    })
  }
}

/* ------------------------------------------------------------------ */
/* assembly                                                             */
/* ------------------------------------------------------------------ */

/** Apply `--update-baseline` (shrink only unless `allowGrow`). */
export function updateBaseline(root, options = {}) {
  const cfg = options.cfg ?? readJson(path.join(root, LAYOUT.config)) ?? {}
  const abs = baselinePath(root, cfg)
  const data = readJson(abs)
  if (!data || typeof data.files !== 'object' || !data.files) {
    return { ok: false, changed: [], message: `baseline not found: ${path.relative(root, abs)}` }
  }
  const next = {}
  const changed = []
  for (const [file, base] of Object.entries(data.files)) {
    const current = countLines(path.join(root, file))
    if (current === null) {
      changed.push({ file, from: Number(base), to: null, action: 'dropped' })
      continue
    }
    if (current < Number(base)) {
      next[file] = current
      changed.push({ file, from: Number(base), to: current, action: 'lowered' })
      continue
    }
    if (current > Number(base) && options.allowGrow) {
      next[file] = current
      changed.push({ file, from: Number(base), to: current, action: 'raised' })
      continue
    }
    next[file] = Number(base)
  }
  const blocked = changed.filter((entry) => entry.action === 'raised').length
  const payload = { ...data, files: next }
  fs.writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`)
  return { ok: true, changed, blocked, message: `baseline updated: ${changed.length} entry change(s)` }
}

/** Run every rule and return the Layer 2 contract. */
export async function analyzeRepo(root = DEFAULT_ROOT, options = {}) {
  const absRoot = path.resolve(String(root ?? DEFAULT_ROOT))
  const cfg = options.cfg ?? readJson(path.join(absRoot, LAYOUT.config)) ?? {}
  const pending =
    options.pending ??
    (cfg && typeof cfg.checkerPending === 'object' && cfg.checkerPending ? cfg.checkerPending : {})
  const findings = new Findings(pending)

  for (const rule of [
    ruleApiParity,
    ruleEventContract,
    ruleStorageContract,
    ruleDocsScriptsParity,
    ruleLegacyReentry,
    ruleCliInvocationGuard,
    ruleSilentFailureGuard,
    ruleCreateRouteParity,
  ]) {
    try {
      await rule(absRoot, findings)
    } catch (error) {
      findings.soft('repo-checker', `rule crashed: ${String(error?.message ?? error).slice(0, 200)}`)
    }
  }
  ratchetSignals(absRoot, cfg, findings)
  akapenSignal(absRoot, findings)

  let hardFails = findings.hardFails
  let softSignals = findings.softSignals
  if (options.strict) {
    const promoted = softSignals.filter((signal) => signal.fatal)
    hardFails = [...hardFails, ...promoted.map(({ fatal, ...rest }) => ({ ...rest, severity: 'hard', promoted: true }))]
    softSignals = softSignals.filter((signal) => !signal.fatal)
  }
  return {
    ok: hardFails.length === 0,
    ruleCount: RULES.length,
    pending: Object.keys(pending).length,
    hardFails,
    softSignals,
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

const USAGE = [
  'check-coherence — Layer 2 repository checker (SPEC-COHERENCE 3.3)',
  '',
  'Usage: node scripts/check-coherence.mjs [--json] [--strict] [--update-baseline] [--allow-grow] [--root <dir>]',
  '',
  '  --json              print { ok, hardFails, softSignals } as the only stdout output',
  '  --strict            promote pending rules and ratchet growth to hard fails',
  '  --update-baseline   lower ratchet entries for files that shrank',
  '  --allow-grow        allow --update-baseline to raise an entry',
  '  --root <dir>        repository root (default: parent of this script)',
  '  --help              show this text',
].join('\n')

/** Parse CLI arguments. */
export function parseArgs(argv = []) {
  const options = { json: false, strict: false, updateBaseline: false, allowGrow: false, help: false, root: DEFAULT_ROOT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--allow-grow') options.allowGrow = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root') {
      options.root = argv[i + 1] ? path.resolve(argv[i + 1]) : DEFAULT_ROOT
      i += 1
    } else if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length))
    } else {
      process.stderr.write(`check-coherence: ignoring unknown argument ${arg}\n`)
    }
  }
  return options
}

/** Human readable report (stderr free, ASCII only). */
export function formatReport(result) {
  const lines = [
    `check-coherence: ${result.ruleCount} rules, ${result.hardFails.length} hard fail(s), ${result.softSignals.length} soft signal(s)` +
      (result.pending ? `, ${result.pending} pending rule(s)` : ''),
  ]
  for (const issue of result.hardFails) {
    lines.push(`  FAIL [${issue.rule}] ${issue.message}`)
    for (const file of issue.files ?? []) {
      if (file.file) lines.push(`    ${file.file}${file.line ? `:${file.line}` : ''}`)
    }
  }
  for (const issue of result.softSignals) {
    lines.push(`  soft [${issue.rule}] ${issue.message}`)
  }
  lines.push(result.ok ? 'check-coherence: OK' : 'check-coherence: FAILED')
  return lines.join('\n')
}

/** CLI entry point. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const result = await analyzeRepo(options.root, { strict: options.strict })
  if (options.updateBaseline) {
    const update = updateBaseline(options.root, { allowGrow: options.allowGrow })
    process.stderr.write(`check-coherence: ${update.message}\n`)
    for (const change of update.changed) {
      process.stderr.write(`  ${change.action}: ${change.file} ${change.from} -> ${change.to ?? 'removed'}\n`)
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    process.stdout.write(`${formatReport(result)}\n`)
    for (const issue of result.hardFails) {
      for (const file of issue.files ?? []) {
        if (file.file) process.stdout.write(`    at ${file.file}${file.line ? `:${file.line}` : ''}\n`)
      }
    }
  }
  return result.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === SELF : false
if (invokedDirectly) {
  const code = await main()
  process.exit(code)
}
