/**
 * リポジトリルートのプラグイン構成（D56 / Batch C2）の自動検証。
 *
 * `hermes plugins install hajimemanila/hermes-pilot --ref <sha>` はリポジトリをそのまま
 * `<plugins>/hermes-pilot/` に展開する。その直後から Hermes のプラグインローダと
 * ダッシュボードが動くには、ルートに `__init__.py` と `dashboard/` が**コミット済み**で
 * ある必要がある（`init` を走らせる前の状態）。
 *
 * ここで確かめるのは 4 点:
 *  1. **実在** — 受入条件の 6 ファイルがルートにあること
 *  2. **同期** — `apps/dashboard/`（編集する側・テストが読む側）とバイト一致すること
 *  3. **配置** — ルートをプラグインディレクトリとして `init` しても自己上書きしないこと
 *  4. **配布** — `package.json` の `files` がルート構成を含むこと
 *
 * 本物の `~/.hermes/plugins` は触らない（すべて一時 HOME / 直接呼び出し）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DASHBOARD_FILES,
  DASHBOARD_PLUGIN,
  installDashboardPlugin,
  resolveDashboardTarget,
  resolvePaths,
  sameDir,
} from '../../../bin/hermes-pilot.mjs'
import { ROOT_LAYOUT, statusOf, syncDashboard } from '../../../scripts/sync-dashboard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 受入条件に並んでいる 6 ファイル（ルートからの相対）。 */
const REQUIRED = [
  '__init__.py',
  'dashboard/manifest.json',
  'dashboard/plugin_api.py',
  'dashboard/pilot_dashboard.py',
  'dashboard/dist/index.js',
  'dashboard/dist/style.css',
]

/** 一時 HOME 用のパス一式。 */
function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-root-layout-'))
  const env = { ...process.env, HOME: home, HERMES_HOME: path.join(home, '.hermes') }
  delete env.HERMES_PLUGINS_DIR
  return { paths: resolvePaths(env), home }
}

/** ルート構成の現状ハッシュ（自己上書きの検出用）。 */
function snapshotRoot() {
  const out = {}
  for (const rel of REQUIRED) {
    const abs = path.join(ROOT, rel)
    out[rel] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  }
  return out
}

// ------------------------------------------------------------------ 1. 実在

test('D56: ルートにプラグイン構成（__init__.py + dashboard/）が揃っている', () => {
  for (const rel of REQUIRED) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `ルートにあること: ${rel}`)
    assert.ok(fs.statSync(path.join(ROOT, rel)).size > 100, `中身があること: ${rel}`)
  }
  // manifest の entry / css / api はルートの dashboard/ 配下で解決できること
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dashboard', 'manifest.json'), 'utf8'))
  assert.equal(manifest.name, DASHBOARD_PLUGIN)
  for (const key of ['entry', 'css', 'api']) {
    const target = path.join(ROOT, 'dashboard', manifest[key])
    assert.ok(fs.existsSync(target), `manifest.${key} がルートで解決できること: dashboard/${manifest[key]}`)
  }
  // `hermes plugins enable hermes-pilot` が名前を解決できる形（no-op の register）
  const init = fs.readFileSync(path.join(ROOT, '__init__.py'), 'utf8')
  assert.match(init, /^def register\(ctx\)/m)
})

test('D56: ルートの python は py_compile を通る（ローダがそのまま読める）', () => {
  const r = spawnSync(
    'python3',
    ['-m', 'py_compile', '__init__.py', 'dashboard/plugin_api.py', 'dashboard/pilot_dashboard.py'],
    { encoding: 'utf8', cwd: ROOT, timeout: 60_000 },
  )
  assert.equal(r.status, 0, r.stderr ?? '')
})

// ------------------------------------------------------------------ 2. 同期

test('D56: ルート構成は apps/dashboard/ とバイト一致する（sync --check が exit 0）', () => {
  const drift = ROOT_LAYOUT.filter((pair) => statusOf(pair, ROOT) !== 'ok')
  assert.deepEqual(
    drift.map((p) => `${p.to} ← ${p.from}`),
    [],
    'ルートが apps/dashboard/ とずれている。`node scripts/sync-dashboard.mjs` で同期すること',
  )
  const result = syncDashboard({ root: ROOT, check: true })
  assert.deepEqual(result.stale, [])
  assert.deepEqual(result.missing, [])
})

test('D56: sync:dashboard は冪等（2 回目は何も書かない）', () => {
  const first = syncDashboard({ root: ROOT })
  const second = syncDashboard({ root: ROOT })
  assert.deepEqual(first.written, [])
  assert.deepEqual(second.written, [])
})

// ------------------------------------------------------------------ 3. 配置

test('D56: ルートがプラグインディレクトリのとき init は自己上書きしない', () => {
  const { paths } = tempPaths()
  const before = snapshotRoot()

  for (const force of [false, true]) {
    const result = installDashboardPlugin(paths, { force, targetDir: ROOT })
    assert.equal(result.selfHosted, true, 'targetDir === ROOT は self-hosted と判定すること')
    assert.equal(sameDir(result.root, ROOT), true)
    assert.deepEqual(result.installed, [], 'ルートへは 1 ファイルもコピーしないこと')
    // --force でもコピーしない（写し元と写し先が同じツリーなので破壊的になりうる）
    if (force) assert.deepEqual(result.skipped, [])
  }

  assert.deepEqual(snapshotRoot(), before, 'ルートのファイルは 1 バイトも変わらないこと')
  // データ初期化（dashboard.json）だけは完了している
  const meta = path.join(paths.dataDir, 'dashboard.json')
  assert.ok(fs.existsSync(meta), 'self-hosted でも dashboard.json は書くこと')
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).root, ROOT)
})

test('D56: 通常の配置先（~/.hermes/plugins/hermes-pilot）へは従来通りコピーする', () => {
  const { paths } = tempPaths()
  const result = installDashboardPlugin(paths, {})
  assert.equal(result.selfHosted, false)
  assert.equal(result.root, path.join(paths.hermesHome, 'plugins', DASHBOARD_PLUGIN))
  assert.equal(result.installed.length, DASHBOARD_FILES.length, `全ファイルを配置すること（実測 ${result.installed.length}）`)
  for (const rel of REQUIRED) {
    assert.ok(fs.existsSync(path.join(result.root, rel)), `配置されること: ${rel}`)
  }
})

test('D56: HERMES_PLUGINS_DIR で配置ベースを差し替えられる', () => {
  const { paths, home } = tempPaths()
  const base = path.join(home, 'elsewhere', 'plugins')
  const env = { ...process.env, HERMES_PLUGINS_DIR: base }
  assert.equal(resolveDashboardTarget(paths, { env }), path.join(base, DASHBOARD_PLUGIN))
  // リポジトリの親をベースにすると配置先はリポジトリ自身 → self-hosted と判定される
  const parentEnv = { ...process.env, HERMES_PLUGINS_DIR: path.dirname(ROOT) }
  const target = resolveDashboardTarget(paths, { env: parentEnv })
  assert.equal(sameDir(target, ROOT), path.basename(ROOT) === DASHBOARD_PLUGIN)
})

// ------------------------------------------------------------------ 4. 配布

test('D56: package.json の files がルート構成を含む（npm pack で落ちない）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const entry of ['__init__.py', 'dashboard/']) {
    assert.ok(pkg.files.includes(entry), `files に ${entry} が必要`)
  }
  assert.equal(pkg.scripts['check:dashboard'], 'node scripts/sync-dashboard.mjs --check')
  assert.match(pkg.scripts.verify, /check:dashboard/, 'verify が同期チェックを含むこと')
})

test('D56: .gitignore が dashboard/dist/ を追跡対象に残す', () => {
  // `git check-ignore` は否定パターン（`!...`）にも当たって exit 0 を返すので、
  // 「当たったパターンが `!` で始まらない＝本当に無視」を判定する。
  const isIgnored = (rel) => {
    const r = spawnSync('git', ['check-ignore', '-v', rel], { encoding: 'utf8', cwd: ROOT })
    if (r.status !== 0) return false // どのパターンにも当たらない = 追跡対象
    const pattern = String(r.stdout ?? '').split('\t')[0].split(':').slice(2).join(':')
    return !pattern.startsWith('!')
  }
  assert.equal(isIgnored('dashboard/dist/index.js'), false, 'dashboard/dist/ は配布物なので追跡する')
  assert.equal(isIgnored('dashboard/manifest.json'), false, 'dashboard/manifest.json は追跡する')
  assert.equal(isIgnored('__init__.py'), false, '__init__.py は追跡する')
  // ビルド成果物は従来通り無視する（ネガティブパターンが広がりすぎていないこと）
  assert.equal(isIgnored('apps/web/dist/index.html'), true, 'apps/web/dist/ は成果物なので無視する')
})
