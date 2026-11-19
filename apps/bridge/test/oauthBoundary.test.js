/**
 * 外部 AI CLI 境界（`scripts/check-oauth-boundary.mjs` の D63 拡張）の機械検証。
 *
 * `npm run check:oauth` は「現行コードが汚れていない」ことしか言わない。検出パターンが
 * 本当に効いているか（`gemini` CLI 起動と `agy` 起動の**両方**を拾い、正常なコードは拾わない）は
 * スクリプトの `--self-test` が証明する。ここはそれを毎回の `npm test` に載せる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-oauth-boundary.mjs')

test('check-oauth-boundary --self-test は gemini CLI と agy 起動の両方を検出する', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `self-test が失敗した: ${r.stderr || r.stdout}`)
  assert.match(r.stdout, /self-test OK/)
  assert.match(r.stdout, /gemini and agy launches are both detected/)
})

test('check-oauth-boundary は現行コードを 0 件で通す（npm run check:oauth と同じ判定）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `境界違反が見つかった: ${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /0 forbidden access points/)
})
