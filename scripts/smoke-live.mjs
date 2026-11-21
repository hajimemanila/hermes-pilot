#!/usr/bin/env node
/**
 * Non destructive live smoke test (SPEC-RELIABILITY-GUARD / D94, Batch RG-5).
 *
 * Unit tests mock the two boundaries that actually broke in production: the real
 * `hermes` binary and the running bridge. This script touches both, read only.
 *
 * What it checks, in order:
 *   1. the real CLI answers `hermes --help` and `hermes kanban --help` and still
 *      lists the subcommands the bridge drives,
 *   2. the running bridge serves the read only surface
 *      (`/api/overview`, `/api/coherence/report`, `/api/specs`, `/api/snippets/term`),
 *   3. the destructive endpoints reject a wrong `confirm` with HTTP 400, which proves
 *      the validation gate is in front of the side effect.
 *
 * What it never does: it never sends a valid `confirm`, never POSTs without one, and
 * never writes to the kanban or to the Hermes state. A check that cannot run (no CLI,
 * no bridge, route not registered yet) is reported as SKIP, not as a pass.
 *
 * Flags:
 *   --base <url>     bridge base URL (default: http://<cfg.host>:<cfg.port>)
 *   --token <value>  app token (default: HP_TOKEN, else the bridge token file)
 *   --timeout <ms>   per request timeout (default 5000)
 *   --json           one JSON object on stdout
 *   --strict         SKIP also fails (use it in a deployment gate)
 *   --help           usage
 *
 * Exit: 0 when nothing failed, 1 when a check failed.
 * All output and all source text of this file are ASCII (SPEC-EN-ZERO-LEAK).
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { buildAugmentedPath, resolveHermesBin } from '../apps/bridge/src/capabilities.js'
import { loadConfig } from '../apps/bridge/src/config.js'

const USAGE = [
  'smoke-live - non destructive live smoke test for the running bridge and the real CLI',
  '',
  'Usage: node scripts/smoke-live.mjs [--base <url>] [--token <value>] [--timeout <ms>] [--json] [--strict]',
  '',
  '  --base <url>     bridge base URL (default: http://127.0.0.1:4097)',
  '  --token <value>  app token (default: HP_TOKEN, else the bridge token file)',
  '  --timeout <ms>   per request timeout (default 5000)',
  '  --json           print one JSON object on stdout',
  '  --strict         a skipped check also fails',
  '  --help           show this text',
].join('\n')

/** Read only API surface that must answer 200 with JSON. */
export const READ_ONLY_ROUTES = Object.freeze([
  '/api/overview',
  '/api/coherence/report',
  '/api/specs',
  '/api/snippets/term',
])

/**
 * Destructive routes and the confirm word they expect.
 *
 * The probe deliberately sends a value that cannot match, so the request stops at
 * the validation gate and no side effect happens.
 */
export const GUARDED_ROUTES = Object.freeze([
  { path: '/api/emergency/stop-all', confirm: 'STOP_ALL' },
  { path: '/api/gateway/stop', confirm: 'STOP' },
  { path: '/api/gateway/restart', confirm: 'RESTART' },
])

/** The value sent instead of a valid confirm (never the real one). */
export const WRONG_CONFIRM = 'SMOKE_PROBE'

/** Subcommands the bridge drives and that must stay in `hermes kanban --help`. */
export const CLI_SUBCOMMANDS = Object.freeze(['create', 'archive', 'complete', 'block', 'unblock'])

/** Parse CLI arguments. */
export function parseArgs(argv = []) {
  const options = { base: '', token: '', timeout: 5000, json: false, strict: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base') {
      options.base = String(argv[i + 1] ?? '')
      i += 1
    } else if (arg.startsWith('--base=')) {
      options.base = arg.slice('--base='.length)
    } else if (arg === '--token') {
      options.token = String(argv[i + 1] ?? '')
      i += 1
    } else if (arg.startsWith('--token=')) {
      options.token = arg.slice('--token='.length)
    } else if (arg === '--timeout') {
      const n = Number(argv[i + 1])
      if (Number.isFinite(n) && n > 0) options.timeout = n
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--strict') {
      options.strict = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

/** Mask a secret before it reaches stdout / stderr. */
export function redact(text, secret) {
  const value = String(text ?? '')
  const s = String(secret ?? '')
  if (!s) return value
  return value.split(s).join('<redacted>')
}

/** Run one child process without a shell. */
function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: 2_000_000, env: { ...process.env, PATH: buildAugmentedPath() } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` })
      },
    )
  })
}

/**
 * Candidate app tokens, most specific first.
 *
 * A worker session runs with `HERMES_HOME` pointing at its own profile, while the
 * resident bridge is started with the default Hermes home. Trying the candidates in
 * order (and retrying on 401) keeps the smoke usable from both shells without ever
 * printing a token.
 *
 * @param {object} options CLI options
 * @param {object} cfg bridge config
 * @returns {string[]} unique candidate tokens
 */
export function resolveTokens(options = {}, cfg = {}) {
  const candidates = [String(options.token ?? '').trim(), String(process.env.HP_TOKEN ?? '').trim()]
  if (process.env.HP_DATA_DIR) candidates.push(readToken(path.join(process.env.HP_DATA_DIR, 'token')))
  if (process.env.HM_DATA) candidates.push(readToken(path.join(process.env.HM_DATA, 'token')))
  if (cfg.tokenPath) candidates.push(readToken(cfg.tokenPath))
  candidates.push(readToken(path.join(process.env.HOME ?? '', '.hermes', 'plugin-data', 'hermes-pilot', 'token')))
  const seen = new Set()
  const out = []
  for (const value of candidates) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Read a token file, or empty string. */
function readToken(abs) {
  if (!abs) return ''
  try {
    return fs.readFileSync(abs, 'utf8').trim()
  } catch {
    return ''
  }
}

/** First usable token (kept for callers that only need one). */
export function resolveToken(options = {}, cfg = {}) {
  return resolveTokens(options, cfg)[0] ?? ''
}

/** One HTTP probe; never throws. */
async function probeHttp(base, route, { method = 'GET', body = null, token = '', timeout = 5000 } = {}) {
  const url = `${base.replace(/\/+$/, '')}${route}${route.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`
  const headers = { 'x-client': 'mobile' }
  if (body) headers['content-type'] = 'application/json'
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: response.status, json, text }
  } catch (error) {
    return { status: 0, json: null, text: String(error?.code ?? error?.name ?? error?.message ?? 'error') }
  }
}

/** Build the result list (pure enough to unit test). */
function push(results, name, status, detail) {
  results.push({ name, status, detail })
}

/**
 * Check the real CLI surface.
 *
 * @param {{bin: string, timeout: number}} deps
 * @returns {Promise<object[]>} results
 */
export async function checkCli({ bin, timeout }) {
  const results = []
  const help = await run(bin, ['--help'], timeout)
  if (help.code !== 0 && !help.out.trim()) {
    push(results, 'cli:hermes-help', 'skip', 'hermes CLI not found on PATH')
    return results
  }
  const helpOk = help.code === 0 && /\bkanban\b/.test(help.out)
  push(results, 'cli:hermes-help', helpOk ? 'ok' : 'fail', helpOk ? 'exit 0, kanban listed' : `exit ${help.code}, 'kanban' not listed`)

  if (!helpOk) return results
  const kanbanHelp = await run(bin, ['kanban', '--help'], timeout)
  const missing = CLI_SUBCOMMANDS.filter((sub) => !new RegExp(`\\b${sub}\\b`).test(kanbanHelp.out))
  push(
    results,
    'cli:kanban-help',
    kanbanHelp.code === 0 && !missing.length ? 'ok' : 'fail',
    kanbanHelp.code === 0 && !missing.length
      ? `${CLI_SUBCOMMANDS.length} subcommands listed`
      : `exit ${kanbanHelp.code}, missing: ${missing.join(', ') || 'none'}`,
  )
  return results
}

/**
 * Probe one route with the first token that is not rejected.
 *
 * @param {string} base bridge base URL
 * @param {string} route API path
 * @param {object} options method / body / timeout
 * @param {string[]} tokens candidate tokens
 * @returns {Promise<{status: number, json: any, text: string, token: string}>} response
 */
async function probeAuthed(base, route, options, tokens) {
  let last = { status: 0, json: null, text: 'no token', token: '' }
  for (const token of tokens) {
    const res = await probeHttp(base, route, { ...options, token })
    last = { ...res, token }
    if (res.status !== 401 && res.status !== 403) return last
  }
  return last
}

/**
 * Check the bridge read only surface and the destructive validation gates.
 *
 * @param {{base: string, tokens: string[], timeout: number}} options
 * @returns {Promise<object[]>} results
 */
export async function checkBridge({ base, tokens = [], timeout }) {
  const results = []
  if (!tokens.length) {
    push(results, 'api:token', 'skip', 'no app token (pass --token or HP_TOKEN); API checks skipped')
    return results
  }

  let reachable = false
  let active = tokens
  for (const route of READ_ONLY_ROUTES) {
    const res = await probeAuthed(base, route, { timeout }, active)
    if (res.status === 0 && !reachable) {
      push(results, `api:${route}`, 'skip', `bridge not reachable (${redact(res.text, res.token)})`)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      push(results, `api:${route}`, 'fail', `HTTP ${res.status}; every candidate token was rejected`)
      continue
    }
    reachable = true
    // Once a token works, keep using it for the rest of the run.
    active = [res.token]
    const ok = res.status === 200 && res.json && typeof res.json === 'object'
    push(results, `api:${route}`, ok ? 'ok' : 'fail', ok ? 'HTTP 200 JSON' : `HTTP ${res.status}`)
  }
  if (!reachable) return results

  for (const guard of GUARDED_ROUTES) {
    const res = await probeAuthed(
      base,
      guard.path,
      { method: 'POST', body: { confirm: WRONG_CONFIRM }, timeout },
      active,
    )
    if (res.status === 404) {
      push(results, `guard:${guard.path}`, 'skip', 'route not registered on the running bridge (restart it?)')
      continue
    }
    if (res.status === 400) {
      push(results, `guard:${guard.path}`, 'ok', `HTTP 400 rejected a wrong confirm (expects ${guard.confirm})`)
      continue
    }
    push(results, `guard:${guard.path}`, 'fail', `HTTP ${res.status} for a wrong confirm (expected 400)`)
  }
  return results
}

/** Human readable report (ASCII only). */
export function formatReport(result) {
  const lines = []
  for (const check of result.checks) {
    const tag = check.status === 'ok' ? 'ok  ' : check.status === 'skip' ? 'skip' : 'FAIL'
    lines.push(`${tag} ${check.name}  ${check.detail}`)
  }
  const counts = result.counts
  lines.push(
    `smoke-live: ${result.checks.length} checks, ${counts.ok} ok, ${counts.skip} skipped, ${counts.fail} failed`,
  )
  lines.push(result.ok ? 'smoke-live: OK' : 'smoke-live: FAILED')
  return lines.join('\n')
}

/** Entry point. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  let cfg = {}
  try {
    cfg = loadConfig()
  } catch {
    cfg = {}
  }
  const base = options.base || `http://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 4097}`
  const tokens = resolveTokens(options, cfg)
  const bin = resolveHermesBin()

  const checks = [...(await checkCli({ bin, timeout: options.timeout })), ...(await checkBridge({ base, tokens, timeout: options.timeout }))]
  const counts = {
    ok: checks.filter((c) => c.status === 'ok').length,
    skip: checks.filter((c) => c.status === 'skip').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  }
  const ok = counts.fail === 0 && (!options.strict || counts.skip === 0)
  const result = { ok, base, counts, checks, at: new Date().toISOString() }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    process.stdout.write(`${formatReport(result)}\n`)
  }
  return ok ? 0 : 1
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) : false
if (invokedDirectly) {
  const code = await main()
  process.exit(code)
}
