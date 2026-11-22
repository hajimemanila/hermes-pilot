/**
 * Layer 2 ルール（`scripts/check-coherence.mjs`）の単体テスト。SPEC-COHERENCE §5 / D94。
 *
 * **要点**: Layer 1 は設定ゼロ・言語非依存（このテストは Python / Markdown だけの擬似リポジトリで
 * 検証する＝ Node/npm を仮定していない証明）。Layer 2 は `.hermes-coherence.json` がある時だけ効き、
 * 境界外の `checker` は実行しない。
 *
 * 一時ディレクトリだけを使い、実リポジトリもカンバンも汚さない。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG_MAX_BYTES,
  analyzeCoherence,
  coherenceAlertFrom,
  duplicateBatchIds,
  gitHotspots,
  isArchivedSpecText,
  listSourceFiles,
  readRepoConfig,
  resolveInsideRepo,
  runRepoChecker,
} from '../src/coherence.js'
import {
  RULES,
  analyzeRepo,
  baselineRatchet,
  cliInvocationProblems,
  containsCJK,
  createParityProblems,
  namespaceMatches,
  normalizeApiPath,
  pathMatches,
  silentServerProblems,
  stripComments,
  syncOwnerProblems,
  transitionOwnerProblems,
  transportOwnerProblems,
  unusedErrorDetails,
  updateBaseline,
  writeOwnerProblems,
} from '../../../scripts/check-coherence.mjs'

/** 一時ディレクトリを作る。 */
function tempDir(prefix = 'hm-coherence-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** ファイルを書く（親ディレクトリは作る）。 */
function write(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

/** N 行のダミーソース。 */
function lines(n, prefix = '# line') {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
}

/** git を呼ばない Layer 1 単体用（ホットスポット無し）。 */
const noGit = async () => []

/* -------------------------------------------------------------------------- *
 * Layer 2 repository checker (`scripts/check-coherence.mjs`, Batch COH-3)
 *
 * The checker prints English only, so the assertions below stay ASCII.
 * -------------------------------------------------------------------------- */

/** Repository root of this checkout (apps/bridge/test -> ../../..). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CHECKER = new URL('../../../scripts/check-coherence.mjs', import.meta.url).pathname

/**
 * Build a throw-away repository that only contains what a single rule needs.
 *
 * Every rule reads the same layout as the real repository, so the fixtures below
 * can target one rule each without pulling in the others.
 */
function ruleFixture(files) {
  const root = tempDir('hm-checker-')
  for (const [rel, body] of Object.entries(files)) write(root, rel, body)
  return root
}

/** Rule ids present in the hard fail list. */
function hardRules(report) {
  return report.hardFails.map((issue) => issue.rule)
}

/** Rule ids present in the soft signal list. */
function softRules(report) {
  return report.softSignals.map((issue) => issue.rule)
}

/** Minimal server.js that serves one namespace (`a === 'new'`). */
const MINI_SERVER = [
  'const url = new URL(req.url, "http://x")',
  'const a = url.pathname',
  "if (a === 'new') {",
  "  if (req.method === 'GET') return sendJson(res, 200, {})",
  '}',
  '',
].join('\n')

test('api-parity: deprecated call sites and unregistered web paths are hard fails', async () => {
  const root = ruleFixture({
    'apps/bridge/src/contracts/routes.js': [
      'export const API_ROUTES = [',
      "  { method: 'GET', pattern: '/api/old', demo: 'deprecated', deprecatedBy: '/api/new' },",
      "  { method: 'GET', pattern: '/api/new', demo: 'mocked' },",
      ']',
      '',
    ].join('\n'),
    'apps/bridge/src/server.js': MINI_SERVER,
    'apps/web/src/demo/mockApi.js': "export const paths = ['/api/new']\n",
    'apps/web/src/caller.js': [
      "export const legacy = () => fetch('/api/old')",
      "export const ghost = () => fetch('/api/ghost')",
      '',
    ].join('\n'),
  })
  const report = await analyzeRepo(root)
  assert.equal(report.ok, false)
  assert.ok(hardRules(report).includes('api-parity'))
  const issues = report.hardFails.filter((issue) => issue.rule === 'api-parity')
  assert.ok(issues.some((issue) => /deprecated/.test(issue.message)))
  assert.ok(issues.some((issue) => /not present in API_ROUTES/.test(issue.message)))
  // The deprecated route must never be reported as a legitimate call.
  const unregistered = issues.find((issue) => /not present in API_ROUTES/.test(issue.message))
  assert.deepEqual(unregistered.files.map((file) => file.path), ['/api/ghost'])
})

test('api-parity: a missing route registry is itself a hard fail (deleting the contract is drift)', async () => {
  const root = ruleFixture({
    'apps/bridge/src/server.js': MINI_SERVER,
    'apps/web/src/caller.js': "export const ok = () => fetch('/api/new')\n",
  })
  const report = await analyzeRepo(root)
  const issue = report.hardFails.find((entry) => entry.rule === 'api-parity')
  assert.ok(issue)
  assert.match(issue.message, /registry missing/)

  // While the registry is pending, the same finding is only a fatal soft signal.
  const pendingRoot = ruleFixture({
    'apps/bridge/src/server.js': MINI_SERVER,
    'apps/web/src/caller.js': "export const ok = () => fetch('/api/new')\n",
    '.hermes-coherence.json': JSON.stringify({ checkerPending: { 'api-parity': 'COH-2' } }),
  })
  const pending = await analyzeRepo(pendingRoot)
  assert.equal(hardRules(pending).includes('api-parity'), false)
  assert.equal(pending.softSignals.find((entry) => entry.rule === 'api-parity').pending, 'COH-2')
})

test('event-contract: raw literals outside contracts and one sided events are hard fails', async () => {
  const root = ruleFixture({
    'apps/web/src/contracts/events.js': "export const HM_EVENTS = { A: 'hm:a', B: 'hm:b' }\n",
    'apps/web/src/App.jsx': [
      "window.dispatchEvent(new CustomEvent('hm:a'))",
      "window.addEventListener('hm:unknown', () => {})",
      '',
    ].join('\n'),
  })
  const report = await analyzeRepo(root)
  assert.ok(hardRules(report).includes('event-contract'))
  const issues = report.hardFails.filter((issue) => issue.rule === 'event-contract')
  assert.ok(issues.some((issue) => /raw 'hm:\*' literal/.test(issue.message)))
  assert.ok(issues.some((issue) => /one sided event/.test(issue.message)))
})

test('event-contract: a timer relayed hm:open-* event is a hard fail', async () => {
  const root = ruleFixture({
    'apps/web/src/contracts/events.js': "export const HM_EVENTS = { OPEN_INBOX: 'hm:open-inbox' }\n",
    'apps/web/src/App.jsx': [
      "window.addEventListener('hm:open-inbox', () => {})",
      "setTimeout(() => window.dispatchEvent(new CustomEvent('hm:open-inbox')), 0)",
      '',
    ].join('\n'),
  })
  const report = await analyzeRepo(root)
  const issues = report.hardFails.filter((issue) => issue.rule === 'event-contract')
  assert.ok(issues.some((issue) => /timer relay/.test(issue.message)))
})

test('storage-contract: raw hm.* literals outside contracts are hard fails', async () => {
  const root = ruleFixture({
    'apps/web/src/contracts/storage.js': "export const HM_STORAGE = Object.freeze({ BOARD: 'hm.board' })\n",
    'apps/web/src/lib/thing.js': "export const read = () => localStorage.getItem('hm.board')\n",
  })
  const report = await analyzeRepo(root)
  assert.ok(hardRules(report).includes('storage-contract'))
  const issue = report.hardFails.find((entry) => entry.rule === 'storage-contract')
  assert.equal(issue.files[0].file, 'apps/web/src/lib/thing.js')
  // Contract-only spellings are fine.
  const clean = ruleFixture({
    'apps/web/src/contracts/storage.js': "export const HM_STORAGE = Object.freeze({ BOARD: 'hm.board' })\n",
    'apps/web/src/lib/thing.js': "import { HM_STORAGE } from '../contracts/storage.js'\nexport const read = () => localStorage.getItem(HM_STORAGE.BOARD)\n",
  })
  const cleanReport = await analyzeRepo(clean)
  assert.equal(hardRules(cleanReport).includes('storage-contract'), false)
})

test('docs-scripts-parity: i18n key drift and missing npm scripts are hard fails', async () => {
  const root = ruleFixture({
    'apps/web/src/i18n/en.json': JSON.stringify({ nav: { tasks: 'Tasks' } }),
    'apps/web/src/i18n/ja.json': JSON.stringify({ nav: { tasks: 'Tasks', extra: 'Extra' } }),
    'package.json': JSON.stringify({ scripts: { verify: 'echo ok' } }),
    'README.md': 'Run `npm run ghost` before shipping.\n',
    'docs/OPERATIONS.md': 'Run `npm run verify` after every change.\n',
  })
  const report = await analyzeRepo(root)
  const issues = report.hardFails.filter((issue) => issue.rule === 'docs-scripts-parity')
  assert.equal(issues.length, 2)
  assert.ok(issues.some((issue) => /i18n key mismatch/.test(issue.message)))
  const missing = issues.find((issue) => /documented command/.test(issue.message))
  assert.equal(missing.files[0].script, 'ghost')
})

test('legacy-reentry: removed symbols are hard fails unless the file is an allowed owner', async () => {
  const root = ruleFixture({
    'apps/bridge/src/runner.js': 'export const ok = hasAgyCli()\n',
    'apps/bridge/src/pipeline-optimizer.js': 'export const keep = optimizeAntigravitySkills\n',
    'scripts/check-oauth-boundary.mjs': "export const banned = ['hasAgyCli']\n",
  })
  const report = await analyzeRepo(root)
  const issues = report.hardFails.filter((issue) => issue.rule === 'legacy-reentry')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].files[0].file, 'apps/bridge/src/runner.js')
  assert.equal(issues[0].files[0].symbol, 'hasAgyCli')
})

test('pending rules degrade to fatal soft signals, and --strict promotes them again', async () => {
  const root = ruleFixture({
    'apps/web/src/contracts/storage.js': "export const HM_STORAGE = Object.freeze({ BOARD: 'hm.board' })\n",
    'apps/web/src/lib/thing.js': "export const read = () => localStorage.getItem('hm.board')\n",
    '.hermes-coherence.json': JSON.stringify({ checkerPending: { 'storage-contract': 'COH-1' } }),
  })
  const relaxed = await analyzeRepo(root)
  assert.equal(hardRules(relaxed).includes('storage-contract'), false)
  const signal = relaxed.softSignals.find((entry) => entry.rule === 'storage-contract')
  assert.equal(signal.pending, 'COH-1')
  assert.equal(signal.fatal, true)

  const strict = await analyzeRepo(root, { strict: true })
  const promoted = strict.hardFails.find((entry) => entry.rule === 'storage-contract')
  assert.ok(promoted)
  assert.equal(promoted.promoted, true)
  assert.equal(strict.ok, false)
})

test('helpers: comment stripping keeps line numbers, template paths normalise, wildcards match', () => {
  const source = ["const a = 'hm.board' // 'hm.commented'", '/* hm.block */', "const b = '/api/x/${id}/y'"].join('\n')
  const stripped = stripComments(source)
  assert.equal(stripped.split('\n').length, 3)
  assert.equal(stripped.includes("hm.commented"), false)
  assert.equal(stripped.includes('hm.block'), false)
  assert.ok(stripped.includes("'hm.board'"))

  assert.equal(normalizeApiPath('/api/architect/jobs${qs}'), '/api/architect/jobs')
  assert.equal(normalizeApiPath('/api/review/${item.id}/answer'), '/api/review/:p/answer')
  assert.equal(normalizeApiPath('/api/review/:id/thumb/*'), '/api/review/:p/thumb/*')
  assert.equal(pathMatches('/api/review/:id/thumb/*', '/api/review/abc/thumb/1'), true)
  assert.equal(pathMatches('/api/boards/:board/tasks', '/api/boards/x/tasks'), true)
  assert.equal(pathMatches('/api/repos', '/api/repos/scan'), false)
  assert.equal(namespaceMatches('/api/boards/:board/tasks', '/api/boards'), true)
  assert.equal(containsCJK('ok'), false)
  assert.equal(containsCJK('\u4e2d\u6587'), true)
})

/* -------------------------------------------------------------------------- *
 * Recurrence guards (SPEC-RELIABILITY-GUARD / D94, Batch RG-5)
 *
 * Three more Layer 2 rules pin the failure modes that unit tests with mocks
 * cannot see: the real CLI boundary, swallowed failures, and filing parity.
 * -------------------------------------------------------------------------- */

/** A hermes CLI spawn that follows the contract (binary resolution + PATH). */
const CLEAN_CLI_RUNNER = [
  "import { execFile } from 'node:child_process'",
  "import { buildAugmentedPath, resolveHermesBin } from './capabilities.js'",
  'export function run(args) {',
  "  return execFile(resolveHermesBin(), ['kanban', '--board', 'mobile', ...args], {",
  '    env: { ...process.env, PATH: buildAugmentedPath() },',
  '  })',
  '}',
  '',
].join('\n')

test('cli-invocation-guard: a bare `execFile("hermes")` without binary resolution is a hard fail', async () => {
  const root = ruleFixture({
    'apps/bridge/src/review.js': [
      "import { execFile } from 'node:child_process'",
      'export function run(args) {',
      "  return execFile('hermes', ['kanban', '--board', 'mobile', ...args], { env: { ...process.env } })",
      '}',
      '',
    ].join('\n'),
  })
  const report = await analyzeRepo(root)
  const issue = report.hardFails.find((entry) => entry.rule === 'cli-invocation-guard')
  assert.ok(issue, 'the hardcoded binary must be reported')
  const reasons = issue.files.map((file) => file.reason)
  assert.ok(reasons.includes('hermes CLI spawn without resolveHermesBin()'))
  assert.ok(reasons.includes('hermes CLI spawn without buildAugmentedPath() in the env PATH'))
  assert.equal(issue.files[0].file, 'apps/bridge/src/review.js')
})

test('cli-invocation-guard: `--board` before `kanban` and a clean runner', () => {
  const wrongOrder = [
    "import { execFile } from 'node:child_process'",
    "import { buildAugmentedPath, resolveHermesBin } from './capabilities.js'",
    'export const run = (args) =>',
    "  execFile(resolveHermesBin(), ['--board', 'mobile', 'kanban', ...args], {",
    '    env: { ...process.env, PATH: buildAugmentedPath() },',
    '  })',
    '',
  ].join('\n')
  const problems = cliInvocationProblems(wrongOrder)
  assert.equal(problems.length, 1)
  assert.match(problems[0].reason, /'--board' placed before 'kanban'/)

  assert.deepEqual(cliInvocationProblems(CLEAN_CLI_RUNNER), [])
  // Non hermes children (node, tailscale, pty) are out of scope.
  assert.deepEqual(cliInvocationProblems("execFile(process.execPath, ['--json'], { cwd })"), [])
})

test('cli-invocation-guard: the whole apps/bridge/src tree is clean', async () => {
  const report = await analyzeRepo(REPO_ROOT)
  const hits = report.hardFails.filter((entry) => entry.rule === 'cli-invocation-guard')
  assert.deepEqual(hits, [])
})

/** server.js where `close` answers HTTP 200 with the bare result object. */
const SILENT_SERVER = [
  'const b = url.pathname',
  "if (b && c === 'tasks' && d && e === 'close' && req.method === 'POST') {",
  '  const out = await inbox.close(b, d, body?.action)',
  '  return sendJson(res, 200, out)',
  '}',
  '',
].join('\n')

test('silent-failure-guard: HTTP 200 on an unchecked write result is a hard fail, a guarded route is not', async () => {
  const silent = silentServerProblems(SILENT_SERVER)
  assert.equal(silent.length, 1)
  assert.equal(silent[0].route, 'close')
  assert.match(silent[0].reason, /without consulting 'out\.ok'/)

  const guarded = SILENT_SERVER.replace(
    '  return sendJson(res, 200, out)',
    '  if (out?.ok === false) return sendFailure(res, 502, out)\n  return sendJson(res, 200, out)',
  )
  assert.deepEqual(silentServerProblems(guarded), [])

  // A non tracked route (e.g. comment) is out of scope on purpose.
  const comment = SILENT_SERVER.replace("e === 'close'", "e === 'comment'")
  assert.deepEqual(silentServerProblems(comment), [])

  const report = await analyzeRepo(ruleFixture({ 'apps/bridge/src/server.js': SILENT_SERVER }))
  assert.ok(hardRules(report).includes('silent-failure-guard'))
})

test('silent-failure-guard: an error detail that is computed and dropped is a hard fail', async () => {
  const dropped = [
    'export function gateway(res) {',
    '  const detail = res.data?.detail ?? `HTTP ${res.status}`',
    "  throw new ApiError('HERMES_REJECTED', { status: res.status }, 502)",
    '}',
    '',
  ].join('\n')
  const problems = unusedErrorDetails(dropped)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].name, 'detail')

  const kept = dropped.replace('{ status: res.status }', '{ status: res.status, detail }')
  assert.deepEqual(unusedErrorDetails(kept), [])

  const report = await analyzeRepo(ruleFixture({ 'apps/bridge/src/ops.js': dropped }))
  const issue = report.hardFails.find((entry) => entry.rule === 'silent-failure-guard')
  assert.ok(issue)
  assert.equal(issue.files[0].file, 'apps/bridge/src/ops.js')
})

test('create-route-parity: a filing route without --assignee or a watcher nudge is a hard fail', async () => {
  const noAssignee = [
    'export function buildCreateArgs(c) {',
    "  const args = ['kanban', '--board', c.board, 'create', c.title, '--json']",
    '  return args',
    '}',
    '',
  ].join('\n')
  const problems = createParityProblems('apps/bridge/src/capture.js', noAssignee)
  assert.equal(problems.length, 1)
  assert.match(problems[0].reason, /--assignee/)

  const withAssignee = noAssignee.replace("  return args", "  if (c.assignee) args.push('--assignee', c.assignee)\n  return args")
  assert.deepEqual(createParityProblems('apps/bridge/src/capture.js', withAssignee), [])

  const noNudge = [
    'const assignee = body?.assignee ?? "mobile"',
    'const r = await capture.create({ ...body, board, assignee })',
    'return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)',
    '',
  ].join('\n')
  const nudgeProblems = createParityProblems('apps/bridge/src/server.js', noNudge)
  assert.equal(nudgeProblems.length, 1)
  assert.match(nudgeProblems[0].reason, /nudgeWatchers/)

  const report = await analyzeRepo(
    ruleFixture({
      'apps/bridge/src/capture.js': noAssignee,
      'apps/bridge/src/server.js': noNudge,
    }),
  )
  assert.ok(hardRules(report).includes('create-route-parity'))
})

test('sync-owner: a raw setInterval in App.jsx is a hard fail, a scheduler subscription is not', async () => {
  const APP_WITH_TIMER = [
    'export function App() {',
    '  useEffect(() => {',
    '    const t = setInterval(() => sync(), 5000)',
    '    return () => clearInterval(t)',
    '  }, [])',
    '}',
    '',
  ].join('\n')
  const APP_WITH_SCHEDULER = [
    "import { createSyncScheduler } from './lib/syncScheduler.js'",
    'const scheduler = createSyncScheduler({ isVisible: () => !document.hidden, currentTab: () => tab })',
    "useEffect(() => scheduler.subscribe('overview', sync), [])",
    '',
  ].join('\n')

  const problems = syncOwnerProblems(APP_WITH_TIMER)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].line, 3)
  assert.match(problems[0].reason, /syncScheduler/)
  assert.deepEqual(syncOwnerProblems(APP_WITH_SCHEDULER), [])
  // A comment that remembers the old timer is not a call site.
  assert.deepEqual(syncOwnerProblems('// setInterval( used to live here\n'), [])

  const bad = await analyzeRepo(ruleFixture({ 'apps/web/src/App.jsx': APP_WITH_TIMER }))
  const issue = bad.hardFails.find((entry) => entry.rule === 'sync-owner')
  assert.ok(issue, 'the shell timer must be reported')
  assert.equal(issue.files[0].file, 'apps/web/src/App.jsx')
  assert.equal(issue.files[0].line, 3)

  const good = await analyzeRepo(ruleFixture({ 'apps/web/src/App.jsx': APP_WITH_SCHEDULER }))
  assert.deepEqual(
    hardRules(good).filter((rule) => rule === 'sync-owner'),
    [],
  )
})

test('transport-owner: offlineSince and the backoff formula only live in lib/transport.js', async () => {
  const COPY = [
    'const offlineSince = useRef(Date.now())',
    'const delay = Math.min(15000, 1000 * 2 ** retryRef.current)',
    '',
  ].join('\n')
  const REEXPORT = "export { reconnectDelay } from './transport.js'\n"

  const problems = transportOwnerProblems('apps/web/src/lib/useChatSocket.js', COPY)
  assert.equal(problems.length, 2)
  assert.ok(problems.some((problem) => /offlineSince/.test(problem.reason)))
  assert.ok(problems.some((problem) => /backoff/.test(problem.reason)))
  // The owner keeps both spellings.
  assert.deepEqual(transportOwnerProblems('apps/web/src/lib/transport.js', COPY), [])
  // A permitted re-export is not a second implementation, a copied formula is.
  assert.deepEqual(transportOwnerProblems('apps/web/src/lib/termReconnect.js', REEXPORT), [])
  assert.equal(
    transportOwnerProblems('apps/web/src/lib/termReconnect.js', 'export const d = 1000 * 2 ** n\n').length,
    1,
  )

  const bad = await analyzeRepo(ruleFixture({ 'apps/web/src/lib/useChatSocket.js': COPY }))
  const issue = bad.hardFails.find((entry) => entry.rule === 'transport-owner')
  assert.ok(issue, 'the second connection clock must be reported')
  assert.equal(issue.files[0].file, 'apps/web/src/lib/useChatSocket.js')
  assert.equal(issue.value, 2)

  const good = await analyzeRepo(
    ruleFixture({
      'apps/web/src/lib/transport.js': COPY,
      'apps/web/src/lib/termReconnect.js': REEXPORT,
    }),
  )
  assert.deepEqual(
    hardRules(good).filter((rule) => rule === 'transport-owner'),
    [],
  )
})

test('transition-owner: direct runKanban unblock / complete calls in the review modules are hard fails', async () => {
  const DIRECT = [
    'export async function answer(id, ops) {',
    "  return runKanban(['unblock', id, '--reason', ops.answered])",
    '}',
    'export async function approve(id) {',
    "  const done = await runKanban(['complete', id, '--result', 'ok'])",
    '  if (!done.ok) return runKanban(["unblock", id, "--reason", "fallback"])',
    '  return done',
    '}',
    '',
  ].join('\n')
  const VIA_TABLE = [
    'export async function answer(id, ops) {',
    "  return transitions.apply('answer.fresh', { id, reason: ops.answered })",
    '}',
    'export async function approve(id, ops) {',
    "  return transitions.apply('approve', { id, reason: ops.approved })",
    '}',
    '',
  ].join('\n')

  const problems = transitionOwnerProblems('apps/bridge/src/review.js', DIRECT)
  assert.equal(problems.length, 3)
  assert.equal(problems.filter((problem) => /unblock/.test(problem.reason)).length, 2)
  assert.deepEqual(transitionOwnerProblems('apps/bridge/src/review.js', VIA_TABLE), [])
  // A comment that names the verb is not a call site.
  assert.deepEqual(transitionOwnerProblems('apps/bridge/src/review/media.js', "// runKanban(['unblock', id]\n"), [])

  const bad = await analyzeRepo(ruleFixture({ 'apps/bridge/src/review.js': DIRECT }))
  const issue = bad.hardFails.find((entry) => entry.rule === 'transition-owner')
  assert.ok(issue, 'the bypassing transition must be reported')
  assert.equal(issue.files[0].file, 'apps/bridge/src/review.js')
  assert.equal(issue.value, 3)

  const good = await analyzeRepo(ruleFixture({ 'apps/bridge/src/review/media.js': VIA_TABLE }))
  assert.deepEqual(
    hardRules(good).filter((rule) => rule === 'transition-owner'),
    [],
  )
})

test('write-owner: fs.writeFileSync outside lib/atomic.js is a hard fail', async () => {
  const RAW = ["import fs from 'node:fs'", 'export function save(file, value) {', '  fs.writeFileSync(file, JSON.stringify(value))', '}', ''].join('\n')
  const VIA_ATOMIC = [
    "import { writeJsonAtomic } from './lib/atomic.js'",
    'export function save(file, value) {',
    '  writeJsonAtomic(file, value)',
    '}',
    '',
  ].join('\n')

  const problems = writeOwnerProblems('apps/bridge/src/memos.js', RAW)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].line, 3)
  assert.ok(problems[0].reason.includes('lib/atomic.js'))
  assert.deepEqual(writeOwnerProblems('apps/bridge/src/lib/atomic.js', RAW), [])
  assert.deepEqual(writeOwnerProblems('apps/bridge/src/memos.js', VIA_ATOMIC), [])
  // A comment that remembers the old idiom is not a call site.
  assert.deepEqual(writeOwnerProblems('apps/bridge/src/memos.js', '// fs.writeFileSync(tmp, body)'), [])

  const bad = await analyzeRepo(ruleFixture({ 'apps/bridge/src/memos.js': RAW }))
  const issue = bad.hardFails.find((entry) => entry.rule === 'write-owner')
  assert.ok(issue, 'the raw write must be reported')
  assert.equal(issue.files[0].file, 'apps/bridge/src/memos.js')

  const good = await analyzeRepo(
    ruleFixture({
      'apps/bridge/src/lib/atomic.js': RAW,
      'apps/bridge/src/memos.js': VIA_ATOMIC,
    }),
  )
  assert.deepEqual(
    hardRules(good).filter((rule) => rule === 'write-owner'),
    [],
  )
})

test('the recurrence guards are registered rules and stay ASCII', () => {
  assert.equal(RULES.length, 14)
  for (const rule of [
    'cli-invocation-guard',
    'silent-failure-guard',
    'create-route-parity',
    'sync-owner',
    'transport-owner',
    'transition-owner',
    'write-owner',
    'cli-owner',
    'swallow-owner',
  ]) {
    assert.ok(RULES.includes(rule), `${rule} must be registered`)
    assert.equal(containsCJK(rule), false)
  }
  // The live smoke prints machine output only, so its source stays ASCII.
  const smoke = fs.readFileSync(path.join(REPO_ROOT, 'scripts/smoke-live.mjs'), 'utf8')
  assert.equal(containsCJK(smoke), false)
})

test('silent-failure-guard: non-branching auth.audit({ ok: out.ok }) does not satisfy the guard', () => {
  const auditedButSilent = SILENT_SERVER.replace(
    '  return sendJson(res, 200, out)',
    '  auth.audit({ ok: out.ok })\n  return sendJson(res, 200, out)',
  )
  const problems = silentServerProblems(auditedButSilent)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].route, 'close')
})
