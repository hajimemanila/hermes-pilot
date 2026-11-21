#!/usr/bin/env node
/**
 * 無停止デプロイ: ビルド → 検証 → 入れ替え（`dist.prev` に直前の正常ビルドを残す）。
 *
 * 背景（実測）: `dist` を直接作り替えると、ビルド中・失敗時に PWA が
 * 「ブリッジに接続できません」で使えなくなる。ブリッジは `dist` が無いとき
 * `dist.prev` を配るので、ここで「成功したものだけ」を入れ替える。
 *
 *   node scripts/deploy.mjs            # ビルドして入れ替え
 *   node scripts/deploy.mjs --check    # ビルドせず現状の検証だけ
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'apps/web/dist')
const next = path.join(root, 'apps/web/dist.next')
const prev = path.join(root, 'apps/web/dist.prev')
const checkOnly = process.argv.includes('--check')

function verify(dir, label) {
  const index = path.join(dir, 'index.html')
  if (!fs.existsSync(index)) throw new Error(`${label}: index.html not found (${dir})`)
  const html = fs.readFileSync(index, 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  if (!refs.length) throw new Error(`${label}: no /assets/ references in index.html`)
  for (const ref of refs) {
    const file = path.join(dir, ref.replace(/^\//, ''))
    if (!fs.existsSync(file)) throw new Error(`${label}: missing referenced asset ${ref}`)
  }
  return { assets: refs.length, bytes: fs.statSync(index).size }
}

if (checkOnly) {
  const v = verify(dist, 'dist')
  console.log(`Verify: dist (index ${v.bytes}B / ${v.assets} asset refs)`)
  process.exit(0)
}

fs.rmSync(next, { recursive: true, force: true })
console.log('build → apps/web/dist.next')
execFileSync('npx', ['vite', 'build', '--config', 'apps/web/vite.config.js', '--outDir', 'dist.next'], {
  cwd: root,
  stdio: 'inherit',
})

const v = verify(next, 'dist.next')
console.log(`Verify: index ${v.bytes}B / ${v.assets} asset refs`)

// 入れ替え（失敗しない限り dist は常に完全なビルド）
if (fs.existsSync(dist)) {
  fs.rmSync(prev, { recursive: true, force: true })
  fs.renameSync(dist, prev)
}
fs.renameSync(next, dist)
verify(dist, 'dist')
console.log('Deployed: dist <- new build (the previous good build is in dist.prev)')
