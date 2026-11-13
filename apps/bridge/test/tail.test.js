import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTailText } from '../src/tail.js'

test('readTailText は上限以下のファイルなら全文を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tail-'))
  const file = path.join(dir, 'small.log')
  const content = 'line1\nline2\nline3\n'
  fs.writeFileSync(file, content, 'utf8')
  assert.equal(readTailText(file, 4096), content)
})

test('readTailText は上限を超えるファイルで末尾だけを読み、切れた先頭行を捨てる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tail-big-'))
  const file = path.join(dir, 'big.jsonl')
  const rows = []
  for (let i = 0; i < 120; i++) {
    rows.push(JSON.stringify({ i, msg: 'あいうえおかきくけこ' }))
  }
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
  const tail = readTailText(file, 1024)
  const lines = tail.split('\n').filter(Boolean)
  assert.ok(lines.length > 0 && lines.length < 120)
  // すべての残った行が破損なく JSON.parse でき、最終行が i=119 である
  const parsed = lines.map((l) => JSON.parse(l))
  assert.equal(parsed[parsed.length - 1].i, 119)
})
