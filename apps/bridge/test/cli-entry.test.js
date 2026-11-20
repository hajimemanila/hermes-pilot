/**
 * `hermes-pilot` CLI の入口の検証。
 *
 * `npm i -g hermes-pilot` / `npx hermes-pilot` は `node_modules/.bin/hermes-pilot`
 * （実体への**シンボリックリンク**）経由で起動する。0.2.2 では「直接実行か」を
 * `path.resolve(argv[1]) === path.resolve(import.meta.url)` で判定していたため、
 * リンク側のパスと実体パスが一致せず **main() が走らないまま exit 0**（何も出力しない）
 * 状態だった（npm から入れて実測）。ここが壊れると `npx hermes-pilot init` が無言で
 * 何もしなくなるので、リンク経由の起動を機械で固定する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const BIN = path.join(ROOT, 'bin', 'hermes-pilot.mjs')

test('CLI: 直接実行するとヘルプが出る', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Usage:/)
  assert.match(r.stdout, /hermes-pilot init/)
})

test('CLI: シンボリックリンク（npm の .bin）経由でも main が走る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cli-'))
  const link = path.join(dir, 'hermes-pilot')
  try {
    fs.symlinkSync(BIN, link)
    const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Usage:/, 'リンク経由だと何も出力しない（main が走っていない）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
