/**
 * コヒーレンス診断エンジン（`apps/bridge/src/coherence.js`）の統合テスト。SPEC-COHERENCE §3.3 / D80・D83。
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

test('duplicate-batch-id: アクティブ SPEC 間の同名バッチ ID を検知する（アーカイブは除外・D91）', async () => {
  const root = tempDir()
  write(root, 'docs/SPEC-A.md', '# SPEC: A\n\n### Batch RG-1: one\n\nbody\n### RG-1: same id inside one file\n')
  write(root, 'docs/SPEC-B.md', '# SPEC: B\n\n### Batch RG-1: one again\n\n### Batch RG-2: two\n')
  // 退避済み（宣言・置き場）は履歴なので数えない
  write(root, 'docs/SPEC-OLD.md', '# SPEC: OLD\n\n- **Status**: archived\n\n### Batch RG-2: old\n')
  write(root, 'docs/archive/SPEC-MOVED.md', '# SPEC: moved\n\n### Batch RG-1: moved\n')

  assert.deepEqual(duplicateBatchIds(root), [
    { batchId: 'RG-1', files: ['docs/SPEC-A.md', 'docs/SPEC-B.md'] },
  ])

  const report = await analyzeCoherence(root, { gitHotspots: noGit })
  const signal = report.softSignals.find((s) => s.rule === 'duplicate-batch-id')
  assert.ok(signal, 'duplicate-batch-id が soft signal に出る')
  assert.equal(signal.batchId, 'RG-1')
  assert.equal(signal.value, 2)
  assert.deepEqual(signal.files, ['docs/SPEC-A.md', 'docs/SPEC-B.md'])
  assert.equal(report.summary.duplicateBatchIdCount, 1)
  // 汎用 Layer 1 のシグナルなので Hard Fail にはしない（ok は保つ）
  assert.equal(report.ok, true)
  assert.equal(report.hardFails.length, 0)

  // 衝突が無ければシグナルは出ない
  const clean = tempDir()
  write(clean, 'docs/SPEC-A.md', '# SPEC: A\n\n### Batch AA-1: one\n')
  write(clean, 'docs/SPEC-B.md', '# SPEC: B\n\n### Batch BB-1: one\n')
  const cleanReport = await analyzeCoherence(clean, { gitHotspots: noGit })
  assert.equal(cleanReport.softSignals.some((s) => s.rule === 'duplicate-batch-id'), false)
  assert.equal(cleanReport.summary.duplicateBatchIdCount, 0)
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
