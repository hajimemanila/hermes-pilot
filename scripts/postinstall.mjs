#!/usr/bin/env node
/**
 * npm install 後に node-pty の spawn-helper へ実行権限を与える。
 *
 * node-pty 1.1.0 の prebuilds は tar 展開時に exec bit を落とすことがあり、
 * その状態だと `pty.spawn()` が `posix_spawnp failed` で失敗する（実測）。
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../node_modules/node-pty/prebuilds')
if (!existsSync(root)) {
  console.log('[postinstall] node-pty の prebuilds が見つかりません（スキップ）')
  process.exit(0)
}

let fixed = 0
for (const platform of readdirSync(root, { withFileTypes: true })) {
  if (!platform.isDirectory()) continue
  for (const name of ['spawn-helper', 'spawn-helper.exe']) {
    const file = path.join(root, platform.name, name)
    if (!existsSync(file)) continue
    try {
      chmodSync(file, 0o755)
      fixed += 1
      console.log(`[postinstall] chmod +x ${path.relative(process.cwd(), file)}`)
    } catch (err) {
      console.warn(`[postinstall] chmod 失敗: ${err?.message}`)
    }
  }
}
console.log(`[postinstall] node-pty spawn-helper: ${fixed} 件を修正`)
