/**
 * 行数ラチェットとホットスポット（soft signal）のテスト。SPEC-COHERENCE §6.1。
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

  // `docs(coherence):` のような SPEC ドラフトではリセットしない
  write(root, 'docs/SPEC-draft.md', '# Draft\n')
  git(['add', 'docs/SPEC-draft.md'])
  const docsIso = new Date((baseSec + 280) * 1000).toISOString()
  git(['commit', '-q', '-m', 'docs(coherence): draft split spec'], { GIT_AUTHOR_DATE: docsIso, GIT_COMMITTER_DATE: docsIso })
  const afterDocsCommit = await gitHotspots(root, { days: 14 })
  assert.deepEqual(afterDocsCommit, [{ file: 'src/hot.js', touches: 5 }])

  // `refactor(coherence):` / `chore(coherence):` も同じくスイープ完了境界として扱う
  commitAt(300, 'refactor(coherence): extract module after drift', 'export const n = 300\n')
  const afterScopeSweep = await gitHotspots(root, { days: 14 })
  assert.deepEqual(afterScopeSweep, [])

  for (let i = 1; i <= 5; i += 1) {
    commitAt(310 + i * 10, `fix: drift2 ${i}`, `export const n = ${310 + i}\n`)
  }
  assert.deepEqual(await gitHotspots(root, { days: 14 }), [{ file: 'src/hot.js', touches: 5 }])
  commitAt(400, 'chore(coherence): finalize sweep', 'export const n = 400\n')
  assert.deepEqual(await gitHotspots(root, { days: 14 }), [])
})
