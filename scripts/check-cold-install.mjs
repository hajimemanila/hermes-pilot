#!/usr/bin/env node
/**
 * Cold-install acceptance check (check:cold-install).
 *
 * `hermes plugins validate` only inspects the working tree; it does NOT prove a user can
 * install the plugin. On 2026-11-23 `validate` reported "✓ loadable" while
 * `hermes plugins install` refused the very same commit with
 *   "plugin.json declares an unsupported or missing Agent Plugins schema"
 * (hermes_cli/agent_plugins.py requires `$schema`), so the catalog entry pinned at v0.2.0 was
 * uninstallable. This script walks the same path a user walks, in a throwaway HERMES_HOME:
 *
 *   git clone (file://, --ref <sha>) -> hermes plugins enable -> npm ci -> init ->
 *   start bridge -> GET /api/capabilities authed 200 / unauth 401 -> skills on disk
 *
 * Skips (exit 0) when the `hermes` CLI is missing or too old to know `plugins install --ref`,
 * so the check stays useful on machines without a Hermes install.
 *
 * Usage: node scripts/check-cold-install.mjs [--ref <40-char sha>] [--keep] [--port <n>]
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const KEEP = args.includes('--keep')
const SKILLS = ['quick-review', 'annotation', 'spec-architect']

function log(msg) {
  process.stdout.write(`check:cold-install: ${msg}\n`)
}
function skip(reason) {
  log(`skipped — ${reason}`)
  process.exit(0)
}
function fail(msg, detail = '') {
  process.stderr.write(`check:cold-install: FAIL — ${msg}\n`)
  if (detail) process.stderr.write(`${detail.trimEnd()}\n`)
  process.exit(1)
}

function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  })
}

const hermesBin = process.env.HERMES_BIN || 'hermes'
try {
  run(hermesBin, ['--version'])
} catch {
  skip('no `hermes` CLI on PATH (set HERMES_BIN to point at one)')
}
try {
  const help = run(hermesBin, ['plugins', 'install', '--help'])
  if (!help.includes('--ref')) skip('this `hermes` CLI predates `plugins install --ref`')
} catch {
  skip('`hermes plugins install` is unavailable on this host')
}

let ref = argValue('--ref')
if (!ref) {
  try {
    ref = run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim()
  } catch {
    skip('not a git checkout, so there is no commit to install')
  }
}
if (!/^[0-9a-f]{40}$/.test(ref)) fail(`--ref must be a full 40-char commit sha, got "${ref}"`)

const dirty = (() => {
  try { return run('git', ['-C', ROOT, 'status', '--porcelain']).trim() } catch { return '' }
})()

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cold-install-'))
const home = path.join(base, 'home')
fs.mkdirSync(home, { recursive: true })
const env = { ...process.env, HERMES_HOME: home }
const repoUrl = pathToFileURL(ROOT).href

function freePort() {
  const requested = argValue('--port')
  if (requested) return Number(requested)
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

let bridge = null
let bridgePort = 0
function portClosed(ms) {
  const deadline = Date.now() + ms
  return new Promise((resolve) => {
    const retry = () => {
      if (Date.now() > deadline) resolve(false)
      else setTimeout(attempt, 150)
    }
    const attempt = () => {
      const sock = net.connect({ port: bridgePort, host: '127.0.0.1' })
      sock.setTimeout(400)
      sock.once('connect', () => { sock.destroy(); retry() })
      sock.once('error', () => { sock.destroy(); resolve(true) })
      sock.once('timeout', () => { sock.destroy(); retry() })
    }
    attempt()
  })
}
async function stopBridge() {
  if (!bridge) return
  const pid = bridge.pid
  try { process.kill(-pid, 'SIGTERM') } catch { try { bridge.kill('SIGTERM') } catch { /* already gone */ } }
  if (!(await portClosed(4000))) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    if (!(await portClosed(2000))) log(`warning — port ${bridgePort} still listening after SIGKILL`)
  }
  bridge = null
}
function cleanupSync() {
  if (!bridge) return
  try { process.kill(-bridge.pid, 'SIGKILL') } catch { /* already gone */ }
  bridge = null
}
function cleanup() {
  cleanupSync()
  if (!KEEP) {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
  } else {
    log(`kept ${base}`)
  }
}
process.on('exit', () => {
  cleanupSync()   // a fail() before stopBridge() would otherwise leave the bridge running
  if (KEEP) log(`kept ${base}`)
})
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

const started = Date.now()
const step = (label) => log(`${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`)

if (dirty) log(`note — working tree is dirty, installing the committed tree at ${ref.slice(0, 7)}`)

// 1. install exactly like a user does (local clone so no network / no push is needed).
// A file:// checkout counts as a custom (unreviewed) source, so the install scanner always blocks
// it; --force bypasses that verdict only — manifest validation still runs, which is what we test.
let installOut = ''
try {
  installOut = run(hermesBin, ['plugins', 'install', repoUrl, '--ref', ref, '--no-enable', '--yes-deps', '--force'], { env })
} catch (err) {
  fail('`hermes plugins install` refused the committed plugin.json',
    `${err.stdout ?? ''}${err.stderr ?? ''}`)
}
if (/is unavailable|ignored unknown top-level field/.test(installOut)) {
  fail('install emitted manifest diagnostics (plugin.json is not a clean Agent Plugins v1 manifest)', installOut)
}
step('install')

// 2. enable + confirm the loader sees it
try {
  run(hermesBin, ['plugins', 'enable', 'hermes-pilot'], { env })
} catch (err) {
  fail('`hermes plugins enable hermes-pilot` failed', `${err.stdout ?? ''}${err.stderr ?? ''}`)
}
let listed = ''
try {
  listed = run(hermesBin, ['plugins', 'list'], { env })
} catch (err) {
  fail('`hermes plugins list` failed', `${err.stdout ?? ''}${err.stderr ?? ''}`)
}
if (!/hermes-pilot/.test(listed) || !/enabled/.test(listed)) fail('plugin not listed as enabled', listed)
step('enable + list')

const pluginDir = path.join(home, 'plugins', 'hermes-pilot')
if (!fs.existsSync(path.join(pluginDir, 'plugin.yaml'))) fail(`native manifest missing in ${pluginDir}`)

// 3. npm ci — the step the catalog disclosure tells users to run (native node-pty)
try {
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: pluginDir, env })
} catch (err) {
  fail('`npm ci` failed inside the installed plugin', `${err.stdout ?? ''}${err.stderr ?? ''}`)
}
step('npm ci')

// 4. init — token (0600), bundled skills, pairing QR
try {
  run('node', ['bin/hermes-pilot.mjs', 'init', '--yes'], { cwd: pluginDir, env })
} catch (err) {
  fail('`node bin/hermes-pilot.mjs init --yes` failed', `${err.stdout ?? ''}${err.stderr ?? ''}`)
}
const tokenPath = path.join(home, 'plugin-data', 'hermes-pilot', 'token')
if (!fs.existsSync(tokenPath)) fail(`init did not write a token at ${tokenPath}`)
const mode = (fs.statSync(tokenPath).mode & 0o777).toString(8)
if (mode !== '600') fail(`token file mode is ${mode}, expected 600`)
const profileSoul = path.join(home, 'profiles', 'mobile', 'SOUL.md')
if (!fs.existsSync(profileSoul)) fail(`init did not create pilot profile SOUL at ${profileSoul}`)
for (const name of SKILLS) {
  const md = path.join(home, 'skills', name, 'SKILL.md')
  if (!fs.existsSync(md)) fail(`bundled skill ${name} was not installed at ${md}`)
  const profileMd = path.join(home, 'profiles', 'mobile', 'skills', name, 'SKILL.md')
  if (!fs.existsSync(profileMd)) fail(`bundled skill ${name} was not installed in pilot profile at ${profileMd}`)
}
step('init + skills')

// 5. bridge up, auth boundary holds
bridgePort = await freePort()
bridge = spawn('node', ['bin/hermes-pilot.mjs', 'start', '--port', String(bridgePort), '--host', '127.0.0.1'], {
  cwd: pluginDir, env, detached: true, stdio: 'ignore',
})
bridge.unref()   // detached + ignored stdio, but the handle still holds the event loop open until unref()
const baseUrl = `http://127.0.0.1:${bridgePort}`
const token = fs.readFileSync(tokenPath, 'utf8').trim()
try {
  await waitFor(async () => {
    const res = await fetch(`${baseUrl}/auth`, { redirect: 'manual' })
    return res.status >= 200 && res.status < 500
  }, 45_000, 'the bridge to listen')
} catch (err) {
  fail(String(err.message))
}
const authed = await fetch(`${baseUrl}/api/capabilities?t=${encodeURIComponent(token)}`)
if (authed.status !== 200) fail(`/api/capabilities with the token returned ${authed.status}, expected 200`)
const anonymous = await fetch(`${baseUrl}/api/capabilities`)
if (anonymous.status !== 401) fail(`/api/capabilities without the token returned ${anonymous.status}, expected 401`)
step('bridge + auth')

await stopBridge()
if (!KEEP) {
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
}
log(`ok — install/enable/npm ci/init/bridge verified at ${ref.slice(0, 7)} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
process.exit(0)
