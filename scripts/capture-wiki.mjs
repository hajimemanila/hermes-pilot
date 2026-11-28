#!/usr/bin/env node
/**
 * Wiki screenshot capture & progress helper (`docs/WIKI-SHOTLIST.md` / `docs/SPEC-WIKI-SHOTS.md`).
 *
 * Stores every screenshot in the canonical bilingual layout:
 *   `docs/wiki/assets/<lang>/<ID>_<slug>_<390|1180>.png`
 *
 * Supports:
 * - `--status [--lang ja|en]`
 * - `--assert-complete [--lang ja|en]` (verifies all 60 PNGs for `<lang>` exist and have valid PNG headers)
 * - `--update-checklist [--lang ja|en] [--dry-run]` (rewrites the `JA 390` / `JA 1180` (or `EN *`) tick boxes in `docs/WIKI-SHOTLIST.md` from the real PNG state)
 * - `--preset manual|showcase|autopilot|all [--lang ja|en]` (captures baseline tabs, showcase, autopilot, or all shots)
 * - `--id <ID>[,<ID>...] [--lang ja|en] [--tab <tab>] [--click <selector>] [--eval <js>] [--unauth] [--theme dark|light] [--vibe dopamine|serotonin]`
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AP_STATE } from './lib/wiki-autopilot.mjs'
import { SC_STATE, SHOWCASE_SEEDS } from './lib/wiki-showcase.mjs'

export { AP_STATE, SC_STATE, SHOWCASE_SEEDS }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_ROOT = path.join(ROOT, 'docs', 'wiki', 'assets')
const DEFAULT_URL = 'http://127.0.0.1:4097'
const TABS = ['tasks', 'review', 'chat', 'notes', 'term', 'settings']
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export const VIEWPORT_MAP = Object.freeze({
  390: { width: 390, height: 844 },
  1180: { width: 1180, height: 820 },
})

export const WIKI_SHOTS = Object.freeze([
  { id: 'MN01', slug: 'login-pairing', tab: 'settings', auto: false, unauth: true, label: 'Auth / pairing screen' },
  { id: 'MN02', slug: 'settings-overview', tab: 'settings', auto: true, label: 'Settings overview & Optimise button' },
  { id: 'MN03', slug: 'tasks-overview', tab: 'tasks', auto: true, label: 'Tasks board & Seed/Brainstorm/Refactor bar' },
  { id: 'MN04', slug: 'task-detail-diff', tab: 'tasks', auto: false, click: '.task-card', label: 'Task detail sheet with events & git diff' },
  { id: 'MN05', slug: 'review-inbox', tab: 'review', auto: true, label: 'Review inbox & relative-time activity feed' },
  { id: 'MN06', slug: 'annotation-toolbar', tab: 'review', auto: false, label: 'Annotation editor & collapsible toolbar' },
  { id: 'MN07', slug: 'chat-overview', tab: 'chat', auto: true, session: 'auto', label: 'Chat timeline, tool log & snippet band' },
  { id: 'MN08', slug: 'chat-bubble-menu', tab: 'chat', auto: false, label: 'Chat bubble context menu (Save to Memos, etc.)' },
  { id: 'MN09', slug: 'chat-session-drawer', tab: 'chat', auto: false, label: 'Chat session drawer with Reply/RO badges' },
  { id: 'MN10', slug: 'memos-grid', tab: 'notes', auto: true, label: 'Memos card grid (1-col at 390, 2-col at 1180)' },
  { id: 'MN11', slug: 'memo-handoff', tab: 'notes', auto: false, label: 'Memo card handoff to Brainstorm / Spec Seed' },
  { id: 'MN12', slug: 'terminal-pty', tab: 'term', auto: true, label: 'Terminal live PTY & OS snippet chips' },
  { id: 'MN13', slug: 'theme-vibe-compare', tab: 'settings', auto: false, theme: 'light', vibe: 'serotonin', label: 'Dark/Light x Dopamine/Serotonin comparison' },
  { id: 'MN14', slug: 'pwa-diagnostics', tab: 'settings', auto: false, label: 'PWA diagnostics all-green check' },
  { id: 'MN15', slug: 'hermes-dashboard-tab', tab: 'settings', auto: false, label: 'Standard Hermes Dashboard (:9119) Pilot tab' },
  { id: 'SC01', slug: 'seed-sheet', tab: 'tasks', auto: false, label: 'Showcase 1: Spec Seed input & execution policy' },
  { id: 'SC02', slug: 'quick-review-interview', tab: 'review', auto: false, label: 'Showcase 2: Round 1 Quick Review interview sheet' },
  { id: 'SC03', slug: 'spec-launchpad', tab: 'tasks', auto: false, label: 'Showcase 3: Spec Launchpad batch accordion' },
  { id: 'SC04', slug: 'live-worker-feed', tab: 'tasks', auto: false, label: 'Showcase 4: Live run ArchitectJobBar & WorkerFeed' },
  { id: 'SC05', slug: 'annotation-redpen', tab: 'review', auto: false, label: 'Showcase 5: Visual-Gate screenshot red-pen annotation' },
  { id: 'SC06', slug: 'before-after-compare', tab: 'review', auto: false, label: 'Showcase 6: Before/After comparison toggle' },
  { id: 'SC07', slug: 'mission-receipt', tab: 'tasks', auto: false, label: 'Showcase 7: Mission Receipt 1200x630 PNG & 280-char share' },
  { id: 'SC08', slug: 'memos-to-brainstorm', tab: 'notes', auto: false, label: 'Showcase 8: Memos idea handoff to Brainstorm sheet' },
  { id: 'SC09', slug: 'coherence-refactor-sheet', tab: 'tasks', auto: false, label: 'Showcase 9: Coherence live band & Refactor sheet' },
  { id: 'AP01', slug: 'autopilot-starter', tab: 'tasks', auto: false, label: 'Autopilot 1: Visual Starter Stage & 1-line launcher' },
  { id: 'AP02', slug: 'autopilot-swipe-deck', tab: 'tasks', auto: false, label: 'Autopilot 2: Option-Cycle swipe deck & visual mock' },
  { id: 'AP03', slug: 'autopilot-gacha-remix', tab: 'tasks', auto: false, label: 'Autopilot 3: Style Gacha & Remix chips over deck' },
  { id: 'AP04', slug: 'autopilot-live-radar', tab: 'tasks', auto: false, label: 'Autopilot 4: Live Studio & 2-worker Panoptes Radar' },
  { id: 'AP05', slug: 'autopilot-xray-nudge', tab: 'tasks', auto: false, label: 'Autopilot 5: X-Ray preview, step drawer & Live Nudge' },
  { id: 'AP06', slug: 'autopilot-complete-card', tab: 'tasks', auto: false, label: 'Autopilot 6: Completion card & Before/After timelapse' },
])

export function shotPath(lang, entry, sizeKey) {
  return path.join(ASSETS_ROOT, lang, `${entry.id}_${entry.slug}_${sizeKey}.png`)
}

export function isValidPng(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size < 1024) return false
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(8)
    fs.readSync(fd, buf, 0, 8, 0)
    fs.closeSync(fd)
    return buf.equals(PNG_MAGIC)
  } catch {
    return false
  }
}

function findChrome() {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? ''
}

function readTokenFile(home, rel) {
  try {
    return fs.readFileSync(path.join(home, rel), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Candidate tokens, most-specific last. `HERMES_HOME` points at the *worker* profile
 * (`~/.hermes/profiles/<name>`) while the resident bridge serves with `~/.hermes`,
 * so the worker token is not the one the bridge accepts. Every candidate is probed
 * against the bridge and only a token that answers 200 is used.
 */
export function tokenCandidates() {
  const homes = []
  if (process.env.HERMES_HOME) homes.push(process.env.HERMES_HOME)
  homes.push(path.join(os.homedir(), '.hermes'))
  homes.push(path.join(os.homedir(), '.hermes', 'profiles', 'mobile'))
  const seen = new Set()
  const out = []
  for (const home of homes) {
    for (const rel of ['plugin-data/hermes-pilot/token', 'mobile-pwa/token']) {
      const v = readTokenFile(home, rel)
      if (v && !seen.has(v)) { seen.add(v); out.push(v) }
    }
  }
  return out
}

async function probeToken(base, token) {
  try {
    const res = await fetch(`${base}/api/boards?t=${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: { 'x-client': 'mobile' },
    })
    return res.status === 200
  } catch {
    return false
  }
}

export async function resolveToken(base, explicit) {
  const given = String(explicit || process.env.HERMES_PILOT_TOKEN || '').trim()
  if (given) return given
  const candidates = tokenCandidates()
  if (!candidates.length) return ''
  if (candidates.length === 1) return candidates[0]
  for (const token of candidates) {
    if (await probeToken(base, token)) return token
  }
  return ''
}

/**
 * `--session auto`: pick the newest *finished* session. Resuming the active one is
 * refused by the gateway and leaves the pane on the empty state (measured), so a
 * chat shot must not grab whatever session happens to be newest.
 */
export async function pickSession(base, token, wanted) {
  const want = String(wanted || '').trim()
  if (!want) return ''
  if (want !== 'auto') return want
  try {
    const res = await fetch(`${base}/api/sessions?t=${encodeURIComponent(token)}`, { headers: { 'x-client': 'mobile' } })
    if (!res.ok) return ''
    const data = await res.json()
    const list = Array.isArray(data?.sessions) ? data.sessions : []
    const idle = list.find((s) => s && s.id && !s.active && !String(s.id).startsWith('local-'))
    return idle?.id ? String(idle.id) : ''
  } catch {
    return ''
  }
}

export function parseArgs(argv) {
  const out = {
    status: false,
    assertComplete: false,
    updateChecklist: false,
    dryRun: false,
    preset: '',
    ids: [],
    lang: 'ja',
    url: DEFAULT_URL,
    external: '',
    token: '',
    tab: '',
    click: '',
    evalJs: '',
    session: '',
    unauth: false,
    theme: '',
    vibe: '',
    sizes: ['390', '1180'],
  }
  const take = (i, inline) => {
    if (inline !== undefined) return [inline, i]
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${argv[i]}`)
    return [argv[i + 1], i + 1]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    if (name === '--status') out.status = true
    else if (name === '--assert-complete') out.assertComplete = true
    else if (name === '--update-checklist') out.updateChecklist = true
    else if (name === '--dry-run') out.dryRun = true
    else if (name === '--unauth') out.unauth = true
    else if (name === '--preset') {
      const [val, next] = take(i, inline); out.preset = val; i = next
    } else if (name === '--id') {
      const [val, next] = take(i, inline)
      for (const p of val.split(',')) { const c = p.trim().toUpperCase(); if (c) out.ids.push(c) }
      i = next
    } else if (name === '--lang') {
      const [val, next] = take(i, inline)
      if (val !== 'ja' && val !== 'en') throw new Error(`--lang must be ja or en (got "${val}")`)
      out.lang = val; i = next
    } else if (name === '--url' || name === '--token' || name === '--tab' || name === '--click' || name === '--theme' || name === '--vibe' || name === '--external') {
      const [val, next] = take(i, inline); out[name.slice(2)] = val; i = next
    } else if (name === '--eval') {
      const [val, next] = take(i, inline); out.evalJs = val; i = next
    } else if (name === '--session') {
      const [val, next] = take(i, inline); out.session = val.trim(); i = next
    } else if (name === '--size') {
      const [val, next] = take(i, inline)
      if (!VIEWPORT_MAP[val]) throw new Error(`--size must be 390 or 1180 (got "${val}")`)
      out.sizes = [val]; i = next
    } else if (name === '--help' || name === '-h') {
      console.log([
        'Usage:',
        '  node scripts/capture-wiki.mjs --status [--lang ja|en]',
        '  node scripts/capture-wiki.mjs --assert-complete [--lang ja|en]',
        '  node scripts/capture-wiki.mjs --update-checklist [--lang ja|en] [--dry-run]',
        '  node scripts/capture-wiki.mjs --preset manual [--lang ja|en] [--url http://127.0.0.1:4097]',
        '  node scripts/capture-wiki.mjs --id MN15 --external http://127.0.0.1:9119/hermes-pilot [--eval "<js>"]',
        '  node scripts/capture-wiki.mjs --id SC01[,SC02] [--lang ja|en] [--tab tasks] [--click ".sel"] [--eval "<js>"] [--session <id>|auto] [--unauth] [--theme dark|light] [--vibe dopamine|serotonin]',
      ].join('\n'))
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

export function inspectProgress(lang = 'ja') {
  const missing = []
  let validCount = 0
  for (const entry of WIKI_SHOTS) {
    for (const sizeKey of ['390', '1180']) {
      const p = shotPath(lang, entry, sizeKey)
      if (isValidPng(p)) validCount += 1
      else missing.push({ id: entry.id, size: sizeKey, path: p })
    }
  }
  return { total: WIKI_SHOTS.length * 2, validCount, missing }
}

export const CHECKLIST_PATH = path.join(ROOT, 'docs', 'WIKI-SHOTLIST.md')

/** `| ID | slug | tab | mode | check | JA390 | JA1180 | EN390 | EN1180 |` → cell indexes. */
export const CHECKLIST_COLUMNS = Object.freeze({ ja: [6, 7], en: [8, 9] })

/**
 * Rewrites the per-language tick boxes in `docs/WIKI-SHOTLIST.md` from the real PNG state,
 * so the checklist can never drift from `docs/wiki/assets/<lang>/`.
 * Idempotent: a second run reports 0 changes.
 */
export function updateChecklist({ lang = 'ja', dryRun = false } = {}) {
  const cols = CHECKLIST_COLUMNS[lang]
  if (!cols) throw new Error(`--lang must be ja or en (got "${lang}")`)
  if (!fs.existsSync(CHECKLIST_PATH)) {
    throw new Error(`Checklist not found: ${path.relative(ROOT, CHECKLIST_PATH)}`)
  }
  const before = fs.readFileSync(CHECKLIST_PATH, 'utf8')
  const lines = before.split('\n')
  const changed = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('|')) continue
    const cells = lines[i].split('|')
    const m = /\*\*(MN\d{2}|SC\d{2}|AP\d{2})\*\*/.exec(cells[1] ?? '')
    if (!m) continue
    const entry = WIKI_SHOTS.find((s) => s.id === m[1])
    if (!entry) continue
    const valid = ['390', '1180'].map((sizeKey) => isValidPng(shotPath(lang, entry, sizeKey)))
    let touched = false
    valid.forEach((ok, n) => {
      const idx = cols[n]
      if (cells[idx] === undefined) return
      const want = ok ? ' [x] ' : ' [ ] '
      if (cells[idx] !== want) {
        cells[idx] = want
        touched = true
      }
    })
    if (touched) {
      lines[i] = cells.join('|')
      changed.push(entry.id)
    }
  }
  const after = lines.join('\n')
  if (!dryRun && after !== before) fs.writeFileSync(CHECKLIST_PATH, after)
  return { lang, changed, dryRun, file: path.relative(ROOT, CHECKLIST_PATH) }
}

function printStatus(args) {
  let total = 0
  const counts = { ja: 0, en: 0 }
  console.log('ID    Slug                       Auto  JA-390  JA-1180  EN-390  EN-1180  Description')
  console.log('----  -------------------------  ----  ------  -------  ------  -------  -------------------------------------------')
  for (const entry of WIKI_SHOTS) {
    const ja390 = isValidPng(shotPath('ja', entry, '390'))
    const ja1180 = isValidPng(shotPath('ja', entry, '1180'))
    const en390 = isValidPng(shotPath('en', entry, '390'))
    const en1180 = isValidPng(shotPath('en', entry, '1180'))
    total += 2
    if (ja390) counts.ja += 1
    if (ja1180) counts.ja += 1
    if (en390) counts.en += 1
    if (en1180) counts.en += 1
    const mark = (ok) => (ok ? '  [x] ' : '  [ ] ')
    console.log(
      `${entry.id.padEnd(4)}  ${entry.slug.padEnd(25)}  ${entry.auto ? '⚡  ' : '    '}  ${mark(ja390)}  ${mark(ja1180)}   ${mark(en390)}  ${mark(en1180)}   ${entry.label}`,
    )
  }
  console.log('----  -------------------------  ----  ------  -------  ------  -------  -------------------------------------------')
  console.log(`Progress: JA ${counts.ja}/${total} shots | EN ${counts.en}/${total} shots (dir: docs/wiki/assets/<lang>/)`)
  if (args.assertComplete) {
    const report = inspectProgress(args.lang)
    if (report.missing.length > 0) {
      console.error(`capture-wiki: FAIL — ${report.missing.length} missing/invalid shot(s) for lang=${args.lang}:`)
      for (const m of report.missing) console.error(`  - ${m.id} (${m.size}): ${path.relative(ROOT, m.path)}`)
      process.exit(1)
    }
    console.log(`capture-wiki: OK — all ${report.total} shots for lang=${args.lang} are valid PNGs`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withCdp(chrome, fn) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-wiki-shot-'))
  const child = spawn(
    chrome,
    [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-sync', '--disable-background-networking', '--mute-audio', 'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cleanup = () => {
    try { child.kill('SIGKILL') } catch { /* exited */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  process.on('exit', cleanup)
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome DevTools endpoint timed out (10s)')), 10000)
      child.stderr.on('data', (chunk) => {
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk))
        if (m) { clearTimeout(timer); resolve(m[1]) }
      })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)) })
    })
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('WebSocket connect failed')), { once: true })
    })
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    const send = (method, params = {}, sessionId) => {
      const id = nextId++
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify(payload))
      })
    }
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    await fn(send, sessionId)
    try { await send('Target.closeTarget', { targetId }); socket.close() } catch { /* ignore */ }
  } finally {
    cleanup()
  }
}

async function runCapture(args) {
  const targets = []
  if (args.preset === 'manual') targets.push(...WIKI_SHOTS.filter((s) => s.auto))
  else if (args.preset === 'showcase') targets.push(...WIKI_SHOTS.filter((s) => Boolean(SC_STATE[s.id])))
  else if (args.preset === 'autopilot') targets.push(...WIKI_SHOTS.filter((s) => Boolean(AP_STATE[s.id])))
  else if (args.preset === 'all') targets.push(...WIKI_SHOTS)
  else if (args.preset) throw new Error(`Unknown --preset "${args.preset}" (supported: manual, showcase, autopilot, all)`)

  for (const id of args.ids) {
    const found = WIKI_SHOTS.find((s) => s.id === id)
    if (!found) throw new Error(`Unknown shot ID "${id}". Run with --status to see valid IDs.`)
    if (!targets.includes(found)) targets.push(found)
  }
  if (!targets.length) {
    printStatus(args)
    return
  }

  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome/Chromium binary not found (set CHROME_PATH)')
  const base = args.url.replace(/\/+$/, '')
  const token = await resolveToken(base, args.token)

  await withCdp(chrome, async (send, sessionId) => {
    const evalInPage = async (expression, awaitPromise = false) => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
      return res?.result?.value
    }
    const waitReady = async (predExpr, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if ((await evalInPage(predExpr)) === true) return true
        await sleep(150)
      }
      return false
    }

    for (const entry of targets) {
      const isUnauth = args.unauth || Boolean(entry.unauth)
      const tab = args.tab || entry.tab
      const clickSel = args.click || entry.click || ''
      const theme = args.theme || entry.theme || ''
      const vibe = args.vibe || entry.vibe || ''
      const resumeSid = await pickSession(base, token, args.session || entry.session || '')

      for (const sizeKey of args.sizes) {
        const { width, height } = VIEWPORT_MAP[sizeKey]
        await send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 2, mobile: width < 1000, screenWidth: width, screenHeight: height },
          sessionId,
        )
        if (args.external) {
          await send('Page.navigate', { url: args.external }, sessionId)
          await waitReady(`document.readyState === 'complete'`)
          // 標準ダッシュボードのタブは言語を「このブラウザの localStorage」で決める
          // （`apps/dashboard/index.js` の `hp.dashboard.lang`）。何も無いとブラウザ言語
          // ＝英語で描画されるため、撮影前に明示してから読み直す。
          await evalInPage(`localStorage.setItem('hp.dashboard.lang', ${JSON.stringify(args.lang)})`)
          await send('Page.navigate', { url: args.external }, sessionId)
          await waitReady(`document.readyState === 'complete'`)
          const externalReady = await waitReady(`Boolean(document.querySelector('main h1, main h2'))`, 15000)
          if (!externalReady) throw new Error(`External page never rendered for ${entry.id} (${sizeKey}): ${args.external}`)
          await sleep(1400)
        } else if (isUnauth) {
          await send('Network.clearBrowserCookies', {}, sessionId)
          await send('Page.navigate', { url: `${base}/auth?lang=${args.lang}` }, sessionId)
          await waitReady(`document.readyState === 'complete'`)
          await evalInPage(`localStorage.setItem('hm.lang', ${JSON.stringify(args.lang)})`)
          await send('Page.navigate', { url: `${base}/auth?lang=${args.lang}` }, sessionId)
          await waitReady(`document.readyState === 'complete'`)
          await sleep(600)
        } else {
          if (!token) throw new Error('App token not found; required for authenticated shots')
          await send('Page.navigate', { url: `${base}/auth?t=${encodeURIComponent(token)}` }, sessionId)
          await waitReady(`document.readyState === 'complete'`)
          await evalInPage([
            `localStorage.setItem('hm.lang', ${JSON.stringify(args.lang)})`,
            entry.id === 'MN10' ? `localStorage.setItem('hm.memosView', ${JSON.stringify(sizeKey === '390' ? 'one' : 'two')})` : '',
            theme ? `localStorage.setItem('hm.theme', ${JSON.stringify(theme)}); document.documentElement.dataset.theme = ${JSON.stringify(theme)}` : '',
            vibe ? `localStorage.setItem('hm.vibe', ${JSON.stringify(vibe)}); document.documentElement.dataset.vibe = ${JSON.stringify(vibe)}` : '',
            resumeSid
              ? [
                `localStorage.setItem('hm.defaultProfile', 'mobile')`,
                `localStorage.setItem('hm.storedProfile', 'mobile')`,
                `localStorage.setItem('hm.storedSid', ${JSON.stringify(resumeSid)})`,
              ].join('; ')
              : '',
          ].filter(Boolean).join(';'))
          await send('Page.navigate', { url: `${base}/?shot=${entry.id}-${sizeKey}` }, sessionId)
          const shellReady = await waitReady(`document.querySelectorAll('nav .nav-item').length === ${TABS.length} && document.readyState === 'complete'`)
          if (!shellReady) {
            const landed = await evalInPage('location.pathname + location.search')
            throw new Error(
              `Landing page never rendered the ${TABS.length}-tab shell for ${entry.id} (${sizeKey}); landed on ${landed}. `
              + 'The bridge rejected the token — run with --token or check HERMES_HOME vs the bridge home.',
            )
          }
          await sleep(800)
          const idx = TABS.indexOf(tab)
          if (idx > 0) {
            await evalInPage(`(() => { const b = document.querySelectorAll('nav .nav-item')[${idx}]; if (b) b.click(); return true })()`)
            await sleep(850)
          }
          if (clickSel) {
            await evalInPage(`(() => { const el = document.querySelector(${JSON.stringify(clickSel)}); if (el) el.click(); return true })()`)
            await sleep(850)
          }
          if (resumeSid && tab === 'chat') {
            const resumed = await waitReady(`document.querySelectorAll('.msg').length > 2`, 20000)
            if (!resumed) {
              const toast = await evalInPage(`document.querySelector('.toast, .banner')?.textContent || ''`)
              throw new Error(`Chat session ${resumeSid} did not render messages for ${entry.id} (${sizeKey}). ${toast}`)
            }
            await sleep(700)
          }
        }
        const recipeFn = SC_STATE[entry.id] || AP_STATE[entry.id]
        const entryEval = !args.evalJs && recipeFn ? recipeFn(args.lang) : ''
        const shotEval = args.evalJs || entryEval
        if (shotEval) {
          // 1 回目はレンダリング途中で空振りすることがある（実測: 1180 の 1 枚目）。
          // 状態づくりは冪等に書いてあるので、`true` が返るまで 2 回まで試す。
          let ran = null
          for (let attempt = 0; attempt < 2; attempt += 1) {
            ran = await evalInPage(`(async () => { try { return await (${shotEval}) } catch (e) { return { error: String(e?.message || e) } } })()`, true)
            if (ran === true || !entryEval) break
            await sleep(700)
          }
          if (entryEval && ran !== true) {
            throw new Error(`State script for ${entry.id} (${sizeKey}) did not finish (${JSON.stringify(ran)})`)
          }
          await sleep(900)
        }
        await evalInPage('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true', true)
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
        if (!shot?.data) throw new Error(`Empty screenshot data for ${entry.id} (${sizeKey})`)
        const outFile = shotPath(args.lang, entry, sizeKey)
        fs.mkdirSync(path.dirname(outFile), { recursive: true })
        fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
        console.log(`shot ${entry.id} (${sizeKey}, ${args.lang}) -> ${path.relative(ROOT, outFile)}`)
      }
    }
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.status || args.assertComplete) {
    printStatus(args)
    if (args.assertComplete && args.updateChecklist) {
      const report = updateChecklist({ lang: args.lang, dryRun: args.dryRun })
      console.log(
        `capture-wiki: checklist ${report.dryRun ? '(dry-run) ' : ''}updated ${report.changed.length} row(s) for ${report.lang} in ${report.file}`
          + (report.changed.length ? ` — ${report.changed.join(' ')}` : ''),
      )
    }
  } else if (args.updateChecklist) {
    const report = updateChecklist({ lang: args.lang, dryRun: args.dryRun })
    const progress = inspectProgress(args.lang)
    console.log(
      `capture-wiki: checklist ${report.dryRun ? '(dry-run) ' : ''}updated ${report.changed.length} row(s) for ${report.lang} in ${report.file}`
        + (report.changed.length ? ` — ${report.changed.join(' ')}` : ''),
    )
    console.log(`capture-wiki: ${progress.validCount}/${progress.total} valid PNGs for lang=${args.lang}`)
    if (!report.dryRun && progress.missing.length) {
      console.error(`capture-wiki: still incomplete — ${progress.missing.length} shot(s) not captured yet`)
      process.exit(1)
    }
  } else {
    runCapture(args).catch((err) => {
      console.error(`capture-wiki: ${err?.message ?? err}`)
      process.exit(1)
    })
  }
}
