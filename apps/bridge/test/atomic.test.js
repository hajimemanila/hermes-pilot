/**
 * 状態ファイルの書き込み器（`apps/bridge/src/lib/atomic.js`）のテスト。D101 / SPEC-COHERENCE-AUDIT-2 §3.1。
 *
 * **要点**: 21 か所の書き込みが通る唯一の実装なので、ここで
 * (1) tmp → rename で書く、(2) 権限が 0600 になる、(3) 組の 2 枚目で落ちても
 * 正本（1 枚目）が壊れない、を固定する。一時ディレクトリだけを使う。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAtomic, writeFileAtomic, writeJsonAtomic, writePairAtomic } from '../src/lib/atomic.js'

/** 一時ディレクトリを作る。 */
function tempDir(prefix = 'hm-atomic-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 権限（下位 9 bit）。 */
function modeOf(file) {
  return fs.statSync(file).mode & 0o777
}

/** ディレクトリ直下に残っている tmp ファイル。 */
function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
}

test('writeJsonAtomic は整形・0600・親ディレクトリ作成をまとめて行う', () => {
  const root = tempDir()
  const file = path.join(root, 'nested', 'deep', 'state.json')

  writeJsonAtomic(file, { version: 1, tasks: { a: 'blocked' } })

  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ version: 1, tasks: { a: 'blocked' } }, null, 2))
  assert.equal(modeOf(file), 0o600)
  assert.deepEqual(leftovers(path.dirname(file)), [])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, tasks: { a: 'blocked' } })
})

test('writeJsonAtomic は pretty / newline で現行の整形を保てる', () => {
  const root = tempDir()

  const compact = path.join(root, 'pair-codes.json')
  writeJsonAtomic(compact, { version: 1, codes: {} }, { pretty: 0 })
  assert.equal(fs.readFileSync(compact, 'utf8'), '{"version":1,"codes":{}}')

  const tailed = path.join(root, 'repos.json')
  writeJsonAtomic(tailed, { repos: [] }, { newline: true })
  assert.equal(fs.readFileSync(tailed, 'utf8'), `${JSON.stringify({ repos: [] }, null, 2)}\n`)
})

test('writeFileAtomic は Buffer を 1 バイトも変えずに書く', () => {
  const root = tempDir()
  const file = path.join(root, 'shot.png')
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])

  writeFileAtomic(file, buf)

  assert.deepEqual(fs.readFileSync(file), buf)
  assert.equal(modeOf(file), 0o600)
})

test('writePairAtomic は正本から順に書き、成功時は written を返す', () => {
  const root = tempDir()
  const json = path.join(root, 'answer.json')
  const text = path.join(root, 'answer.txt')

  const result = writePairAtomic([
    [json, { sha256: 'abc' }, { json: true }],
    [text, 'reply body'],
  ])

  assert.deepEqual(result.written, [json, text])
  assert.equal(result.failedAt, null)
  assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), { sha256: 'abc' })
  assert.equal(fs.readFileSync(text, 'utf8'), 'reply body')
  assert.deepEqual(leftovers(root), [])
})

test('writePairAtomic は 2 枚目で落ちても正本を壊さず failedAt を返す', () => {
  const root = tempDir()
  const json = path.join(root, 'answer.json')
  const text = path.join(root, 'answer.txt')
  fs.writeFileSync(text, 'OLD TEXT')

  // 偽 fs: `answer.txt` への rename だけが失敗する（ディスク満杯・権限エラーの代役）。
  const atomic = createAtomic({
    renameSync(from, to) {
      if (to === text) throw Object.assign(new Error('EPERM: fake rename'), { code: 'EPERM' })
      return fs.renameSync(from, to)
    },
  })

  const result = atomic.writePairAtomic([
    [json, { sha256: 'new' }, { json: true }],
    [text, 'NEW TEXT'],
  ])

  assert.equal(result.failedAt, 1)
  assert.deepEqual(result.written, [json])
  assert.match(result.error.message, /EPERM/)
  // 正本は新しい内容で確定している（途中終了しても壊れない）。
  assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), { sha256: 'new' })
  // 派生コピーは旧内容のまま＝半端な追記になっていない。
  assert.equal(fs.readFileSync(text, 'utf8'), 'OLD TEXT')
  // 失敗した tmp は残さない。
  assert.deepEqual(leftovers(root), [])
})

test('writeFileAtomic は rename 失敗時に元ファイルと tmp をどちらも壊さない', () => {
  const root = tempDir()
  const file = path.join(root, 'state.json')
  fs.writeFileSync(file, '{"ok":true}')

  const atomic = createAtomic({
    renameSync() {
      throw new Error('EXDEV: fake cross-device rename')
    },
  })

  assert.throws(() => atomic.writeJsonAtomic(file, { ok: false }), /EXDEV/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}')
  assert.deepEqual(leftovers(root), [])
})
