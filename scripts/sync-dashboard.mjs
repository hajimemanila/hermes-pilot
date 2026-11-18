#!/usr/bin/env node
/**
 * `apps/dashboard/` → リポジトリルートのプラグイン構成へ同期する（D56）。
 *
 * 背景: `hermes plugins install hajimemanila/hermes-pilot --ref <sha>` はリポジトリを
 * そのまま `<plugins>/hermes-pilot/` に展開する。その時点で
 * `__init__.py` と `dashboard/{manifest.json,plugin_api.py,pilot_dashboard.py,dist/*}`
 * がルートに無いと、Hermes のプラグインローダもダッシュボードも何も見つけられない。
 *
 * 編集は今まで通り `apps/dashboard/` 側で行い（テストもそちらを読む）、
 * このスクリプトがルートへ**バイト一致**の写しを作る。`--check` は差分があれば exit 1。
 *
 *   node scripts/sync-dashboard.mjs           # ルートへ書き出す
 *   node scripts/sync-dashboard.mjs --check   # 差分の検出だけ（CI / npm run verify）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** リポジトリのルート（このファイルは `scripts/` の下）。 */
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 写し元（編集する側）→ 写し先（インストール直後に読まれる側）。
 * `bin/hermes-pilot.mjs` の `DASHBOARD_FILES` と同じ対応でなければならない。
 */
export const ROOT_LAYOUT = [
  { from: 'apps/dashboard/plugin_init.py', to: '__init__.py' },
  { from: 'apps/dashboard/manifest.json', to: 'dashboard/manifest.json' },
  { from: 'apps/dashboard/plugin_api.py', to: 'dashboard/plugin_api.py' },
  { from: 'apps/dashboard/pilot_dashboard.py', to: 'dashboard/pilot_dashboard.py' },
  { from: 'apps/dashboard/index.js', to: 'dashboard/dist/index.js' },
  { from: 'apps/dashboard/style.css', to: 'dashboard/dist/style.css' },
]

/**
 * 1 ファイルの同期結果を返す。
 * @param {{from: string, to: string}} pair 対応
 * @param {string} root リポジトリのルート
 * @returns {'missing'|'stale'|'ok'} `missing` = 写し元が無い, `stale` = 不一致, `ok` = 一致
 */
export function statusOf(pair, root = ROOT) {
  const src = path.join(root, pair.from)
  const dest = path.join(root, pair.to)
  if (!fs.existsSync(src)) return 'missing'
  if (!fs.existsSync(dest)) return 'stale'
  return fs.readFileSync(src).equals(fs.readFileSync(dest)) ? 'ok' : 'stale'
}

/**
 * ルート構成を同期する。
 * @param {{root?: string, check?: boolean, log?: (line: string) => void}} [opts] オプション
 * @returns {{written: string[], stale: string[], missing: string[]}} 結果
 */
export function syncDashboard({ root = ROOT, check = false, log = () => {} } = {}) {
  const written = []
  const stale = []
  const missing = []
  for (const pair of ROOT_LAYOUT) {
    const state = statusOf(pair, root)
    if (state === 'missing') {
      missing.push(pair.from)
      log(`! 写し元が無い / missing source: ${pair.from}`)
      continue
    }
    if (state === 'ok') continue
    stale.push(pair.to)
    if (check) {
      log(`✗ 未同期 / out of sync: ${pair.to} ← ${pair.from}`)
      continue
    }
    const dest = path.join(root, pair.to)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(root, pair.from), dest)
    written.push(pair.to)
    log(`✓ ${pair.from} → ${pair.to}`)
  }
  return { written, stale, missing }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const check = process.argv.slice(2).includes('--check')
  const result = syncDashboard({ check, log: (line) => process.stdout.write(`${line}\n`) })
  if (result.missing.length) {
    process.stderr.write(`写し元が見つかりません / missing sources: ${result.missing.join(', ')}\n`)
    process.exit(2)
  }
  if (check && result.stale.length) {
    process.stderr.write(
      `ルートのプラグイン構成が apps/dashboard/ とずれています / out of sync:\n  ${result.stale.join('\n  ')}\n` +
        '→ `node scripts/sync-dashboard.mjs` で同期してください。\n',
    )
    process.exit(1)
  }
  if (!check && !result.written.length) process.stdout.write('既に同期済み / already in sync\n')
}
