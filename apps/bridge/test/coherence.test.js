/**
 * コヒーレンス診断エンジン（`apps/bridge/src/coherence.js`）のテスト。SPEC-COHERENCE §3.3 / D80・D83。
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
  gitHotspots,
  isArchivedSpecText,
  listSourceFiles,
  readRepoConfig,
  resolveInsideRepo,
  runRepoChecker,
} from '../src/coherence.js'
import {
  analyzeRepo,
  baselineRatchet,
  containsCJK,
  namespaceMatches,
  normalizeApiPath,
  pathMatches,
  stripComments,
  updateBaseline,
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

test('Layer 1 は Node を仮定しない（Python/markdown だけのリポジトリで file-bloat と spec-sprawl を返す）', async () => {
  const root = tempDir()
  write(root, 'pkg/big.py', lines(900))
  write(root, 'pkg/small.py', lines(20))
  write(root, 'docs/SPEC-A.md', '# SPEC: A\n')
  write(root, 'docs/SPEC-B.md', '# SPEC: B\n')
  for (let i = 0; i < 6; i += 1) write(root, `docs/SPEC-X${i}.md`, `# SPEC: X${i}\n`)
  write(root, 'docs/SPEC-OLD.md', '# SPEC: OLD\n\n- **Status**: archived\n')

  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  assert.equal(report.layers.universal, true)
  assert.equal(report.layers.repoConfig, false)
  assert.equal(report.layers.repoChecker, false)
  // 900 行 > 既定 800 行
  const bloat = report.softSignals.filter((s) => s.rule === 'file-bloat')
  assert.equal(bloat.length, 1)
  assert.equal(bloat[0].file, 'pkg/big.py')
  assert.equal(bloat[0].value, 900)
  // アクティブ SPEC は 8 件（> 6）で sprawl、アーカイブ済みは数えない
  const sprawl = report.softSignals.find((s) => s.rule === 'spec-sprawl')
  assert.ok(sprawl, 'spec-sprawl が soft signal に出る')
  assert.equal(sprawl.value, 8)
  assert.equal(report.summary.archivedSpecCount, 1)
  assert.equal(report.summary.activeSpecCount, 8)
  // Hard Fail は無い（設定ゼロなら ok=true）
  assert.equal(report.ok, true)
  assert.equal(report.hardFails.length, 0)
  assert.equal(report.recommendedSweep, 'docs-specs')
})

test('生成物・依存ディレクトリ・ignoreGlobs は走査しない', async () => {
  const root = tempDir()
  write(root, 'node_modules/pkg/i.js', lines(2000))
  write(root, 'dist/bundle.js', lines(2000))
  write(root, 'vendor/lib.go', lines(2000))
  write(root, 'src/keep.js', lines(10))
  write(root, 'src/generated.js', lines(2000))

  const rels = listSourceFiles(root, { ignoreGlobs: ['src/generated.js'] }).map((f) => f.rel)
  assert.deepEqual(rels, ['src/keep.js'])
})

test('ラチェット（baselineFile）は個別の上限を上書きし、無いファイルは maxLines を使う', async () => {
  const root = tempDir()
  write(root, 'src/legacy.js', lines(1000))
  write(root, 'src/new.js', lines(900))
  write(root, 'scripts/coherence-baseline.json', JSON.stringify({ files: { 'src/legacy.js': 1200 } }))
  write(root, '.hermes-coherence.json', JSON.stringify({ maxLines: 800, baselineFile: 'scripts/coherence-baseline.json' }))

  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  const files = report.softSignals.filter((s) => s.rule === 'file-bloat').map((s) => s.file)
  assert.deepEqual(files, ['src/new.js'])
  assert.equal(report.layers.repoConfig, true)
})

test('Layer 2 の forbiddenPatterns は Hard Fail（ok=false）になり、recommendedSweep は contracts', async () => {
  const root = tempDir()
  write(root, 'src/keep.js', 'export const ok = 1\n')
  write(root, 'src/bad.js', 'const x = optimizeAntigravitySkills()\n')
  write(
    root,
    '.hermes-coherence.json',
    JSON.stringify({ forbiddenPatterns: [{ pattern: 'optimizeAntigravitySkills', message: 'legacy alias is gone' }] }),
  )

  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  assert.equal(report.ok, false)
  assert.equal(report.hardFails.length, 1)
  assert.equal(report.hardFails[0].rule, 'forbidden-pattern')
  assert.equal(report.hardFails[0].files[0].file, 'src/bad.js')
  assert.equal(report.recommendedSweep, 'contracts')
})

test('checker はリポジトリ外・絶対パス・`..` を実行しない（soft signal に落とす）', async () => {
  const root = tempDir()
  write(root, 'src/keep.js', 'export const ok = 1\n')
  write(root, '.hermes-coherence.json', JSON.stringify({ checker: '../evil.mjs' }))

  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  assert.equal(report.layers.repoChecker, false)
  const soft = report.softSignals.find((s) => s.rule === 'repo-checker')
  assert.ok(soft)
  assert.match(soft.message, /relative/)

  const direct = await runRepoChecker(root, '/tmp/evil.mjs')
  assert.equal(direct.ok, false)
})

test('checker が JSON を返せば hardFails / softSignals を併合する', async () => {
  const root = tempDir()
  write(root, 'src/keep.js', 'export const ok = 1\n')
  write(
    root,
    'scripts/checker.mjs',
    [
      'const out = { ok: false, hardFails: [{ rule: "api-parity", message: "missing /api/demo" }], softSignals: [{ rule: "akapen", message: "2 leftovers" }] }',
      'process.stdout.write(JSON.stringify(out))',
      '',
    ].join('\n'),
  )
  write(root, '.hermes-coherence.json', JSON.stringify({ checker: 'scripts/checker.mjs' }))

  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  assert.equal(report.layers.repoChecker, true)
  assert.equal(report.hardFails.length, 1)
  assert.equal(report.hardFails[0].rule, 'api-parity')
  assert.ok(report.softSignals.some((s) => s.rule === 'akapen'))
  assert.equal(report.ok, false)
})

test('checker の異常終了・非 JSON は soft signal で吸収し、本体は落とさない', async () => {
  const root = tempDir()
  write(root, 'src/keep.js', 'export const ok = 1\n')
  write(root, 'scripts/broken.mjs', 'process.exit(3)\n')
  write(root, '.hermes-coherence.json', JSON.stringify({ checker: 'scripts/broken.mjs' }))
  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  assert.equal(report.layers.repoChecker, false)
  assert.ok(report.softSignals.some((s) => s.rule === 'repo-checker'))
})

test('hotspot は閾値以上のファイルだけを lines 付きで返し、削除済み・ignoreGlobs を除外する', async () => {
  const root = tempDir()
  write(root, 'src/a.js', lines(30))
  write(root, 'src/b.js', lines(10))
  write(root, 'demo/index.html', lines(200))
  write(root, '.hermes-coherence.json', JSON.stringify({ ignoreGlobs: ['demo/**'] }))
  const git = async () => [
    { file: 'src/a.js', touches: 7 },
    { file: 'src/b.js', touches: 2 },
    { file: 'src/deleted.js', touches: 12 },
    { file: 'demo/index.html', touches: 9 },
  ]
  const report = await analyzeCoherence(root, { gitHotspots: git, hotspotTouches: 5 })
  assert.deepEqual(report.hotspots, [{ file: 'src/a.js', touches: 7, lines: 30 }])
  assert.equal(report.summary.hotspotCount, 1)
})

test('git が無い・存在しないディレクトリでも落ちない', async () => {
  const root = tempDir()
  const report = await analyzeCoherence(root)
  assert.equal(report.hotspots.length, 0)
  assert.equal(report.ok, true)

  const missing = await analyzeCoherence(path.join(root, 'nope'), { gitHotspots: noGit })
  assert.equal(missing.layers.repoConfig, false)
  assert.deepEqual(missing.hotspots, [])

  // `.git` の無いディレクトリで git を直接呼んでも空配列（例外を投げない）
  assert.deepEqual(await gitHotspots(root, { days: 1 }), [])
})

test('壊れた・巨大な `.hermes-coherence.json` は無効（例外を投げない）', async () => {
  const root = tempDir()
  write(root, 'src/keep.js', 'export const ok = 1\n')
  write(root, '.hermes-coherence.json', '{ not json')
  assert.equal(readRepoConfig(root), null)
  const broken = await analyzeCoherence(root, { gitHotspots: noGit })
  assert.equal(broken.layers.repoConfig, false)

  write(root, '.hermes-coherence.json', JSON.stringify({ pad: 'x'.repeat(CONFIG_MAX_BYTES + 10) }))
  assert.equal(readRepoConfig(root), null)
})

test('resolveInsideRepo は `..`・絶対パス・外側を拒否する', () => {
  const root = '/tmp/repo'
  assert.equal(resolveInsideRepo(root, 'scripts/a.mjs'), '/tmp/repo/scripts/a.mjs')
  assert.equal(resolveInsideRepo(root, '../a.mjs'), null)
  assert.equal(resolveInsideRepo(root, 'a/../../b.mjs'), null)
  assert.equal(resolveInsideRepo(root, '/etc/passwd'), null)
  assert.equal(resolveInsideRepo(root, ''), null)
})

test('isArchivedSpecText は EN / JA のアーカイブ宣言を先頭 40 行から読む', () => {
  assert.equal(isArchivedSpecText('# SPEC: X\n\n- **Status**: archived\n'), true)
  assert.equal(isArchivedSpecText('# SPEC: X\n\n- **状態**: アーカイブ（2026-11）\n'), true)
  assert.equal(isArchivedSpecText('# SPEC: X\n\n- **状態**: 仕様確定\n'), false)
  assert.equal(isArchivedSpecText(`# SPEC: X\n${'\n'.repeat(60)}- **Status**: archived\n`), false)
})

test('coherenceAlertFrom は閾値超過だけ alert=true（D83・自動起票しない）', () => {
  const base = { summary: { hardFailCount: 0, softSignalCount: 2, hotspotCount: 0 }, recommendedSweep: null, layers: {} }
  assert.equal(coherenceAlertFrom(base).alert, false)

  const hard = { ...base, summary: { ...base.summary, hardFailCount: 1 } }
  assert.equal(coherenceAlertFrom(hard).alert, true)

  const hotspot = { ...base, summary: { ...base.summary, hotspotCount: 1 } }
  assert.equal(coherenceAlertFrom(hotspot).alert, true)

  const soft = { ...base, summary: { ...base.summary, softSignalCount: 3 } }
  assert.equal(coherenceAlertFrom(soft).alert, true)

  const withIssues = {
    summary: { hardFailCount: 1, softSignalCount: 0, hotspotCount: 0 },
    hardFails: [{ rule: 'api-parity', message: 'missing /api/demo' }],
    recommendedSweep: 'contracts',
    layers: { universal: true, repoConfig: true, repoChecker: false },
  }
  const alert = coherenceAlertFrom(withIssues)
  assert.deepEqual(alert.highlights, ['missing /api/demo'])
  assert.equal(alert.recommendedSweep, 'contracts')
  assert.equal(alert.layers.repoConfig, true)
})

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

test('Layer 2 integration: the real repository wires the checker and passes it', async () => {
  const report = await analyzeCoherence(REPO_ROOT, { withRepoConfig: true })
  assert.equal(report.layers.repoConfig, true)
  assert.equal(report.layers.repoChecker, true)
  assert.equal(report.ok, true)
  assert.equal(report.hardFails.length, 0)
  // Soft signals never flip report.ok to false when all Hard Fails are zero.
  assert.equal(Array.isArray(report.softSignals), true)
  assert.equal(report.softSignals.every((signal) => signal.severity === 'soft'), true)
})

test('Layer 2 CLI: --json contract, exit code and English-only output', () => {
  const out = execFileSync(process.execPath, [CHECKER, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' })
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, true)
  assert.ok(Array.isArray(parsed.hardFails))
  assert.ok(Array.isArray(parsed.softSignals))
  // Acceptance: nothing printed by the checker may contain CJK / full width text.
  const cjk = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/
  assert.equal(cjk.test(out), false)

  const source = fs.readFileSync(CHECKER, 'utf8')
  assert.equal(cjk.test(source), false, 'check-coherence.mjs must stay ASCII')
})

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

test('baseline ratchet: growth is a fatal soft signal and --update-baseline only lowers', () => {
  const root = ruleFixture({
    'src/stable.js': 'a\nb\nc\n',
    'src/grown.js': 'a\nb\nc\nd\ne\n',
    'src/shrunk.js': 'a\n',
    'scripts/coherence-baseline.json': JSON.stringify({
      maxLines: 800,
      files: { 'src/stable.js': 3, 'src/grown.js': 3, 'src/shrunk.js': 9, 'src/gone.js': 4 },
    }),
  })
  const ratchet = baselineRatchet(root)
  assert.equal(ratchet.loaded, true)
  const grown = ratchet.entries.find((entry) => entry.file === 'src/grown.js')
  assert.deepEqual(grown, { file: 'src/grown.js', base: 3, current: 5, delta: 2 })

  const kept = updateBaseline(root, { allowGrow: false })
  assert.equal(kept.ok, true)
  const afterKeep = JSON.parse(fs.readFileSync(path.join(root, 'scripts/coherence-baseline.json'), 'utf8'))
  assert.equal(afterKeep.files['src/grown.js'], 3, 'growth needs --allow-grow')
  assert.equal(afterKeep.files['src/shrunk.js'], 1, 'shrink is ratcheted down')
  assert.equal(afterKeep.files['src/gone.js'], undefined, 'missing files leave the baseline')
  assert.equal(afterKeep.files['src/stable.js'], 3)

  const grownRoot = ruleFixture({
    'src/grown.js': 'a\nb\nc\nd\ne\n',
    'scripts/coherence-baseline.json': JSON.stringify({ files: { 'src/grown.js': 3 } }),
  })
  updateBaseline(grownRoot, { allowGrow: true })
  const afterGrow = JSON.parse(fs.readFileSync(path.join(grownRoot, 'scripts/coherence-baseline.json'), 'utf8'))
  assert.equal(afterGrow.files['src/grown.js'], 5)
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

test('gitHotspots は COHERENCE/ スイープコミットを境界に過去チャーンをリセットし、以降の再編集を検知する', async () => {
  const root = tempDir()
  write(root, 'src/hot.js', 'export const n = 0\n')
  const git = (args, extraEnv = {}) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        ...extraEnv,
      },
    })
  git(['init', '-q'])
  const baseSec = Math.floor(Date.now() / 1000) - 3600
  const commitAt = (offsetSec, msg, content) => {
    write(root, 'src/hot.js', content)
    git(['add', 'src/hot.js'])
    const iso = new Date((baseSec + offsetSec) * 1000).toISOString()
    git(['commit', '-q', '-m', msg], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso })
  }

  for (let i = 1; i <= 5; i += 1) {
    commitAt(i * 10, `feat: edit ${i}`, `export const n = ${i}\n`)
  }
  const before = await gitHotspots(root, { days: 14 })
  assert.deepEqual(before, [{ file: 'src/hot.js', touches: 5 }])

  // スイープ完了コミットでそれ以前のホットスポットがクリアされる
  commitAt(100, 'refactor(hot): split module（COHERENCE/HOTSPOTS）', 'export const n = 100\n')
  const afterSweep = await gitHotspots(root, { days: 14 })
  assert.deepEqual(afterSweep, [])

  // スイープ後に再び集中変更が起きれば新規ホットスポットとして検知する
  for (let i = 1; i <= 5; i += 1) {
    commitAt(200 + i * 10, `fix: post-sweep ${i}`, `export const n = ${200 + i}\n`)
  }
  const afterDrift = await gitHotspots(root, { days: 14 })
  assert.deepEqual(afterDrift, [{ file: 'src/hot.js', touches: 5 }])
})

