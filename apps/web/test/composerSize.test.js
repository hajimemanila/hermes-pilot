import test from 'node:test'
import assert from 'node:assert/strict'
import { composerHeight } from '../src/lib/composerSize.js'

// 実測（390x844 Chrome）: 1行 = 行間19.6 + 余白18 = 38、枠 2 → clientHeight 36 / scrollHeight 38。
// scrollHeight をそのまま高さにすると 2px 足りず、空でも全高のスクロールバー（縦棒）が出ていた。
test('枠の分を足して溢れさせない', () => {
  assert.equal(composerHeight({ scrollHeight: 38, clientHeight: 36, offsetHeight: 38 }), 40)
})

test('2行は 57 → 59（枠2を加算）', () => {
  assert.equal(composerHeight({ scrollHeight: 57, clientHeight: 55, offsetHeight: 57 }), 59)
})

test('上限 120 で頭打ち', () => {
  assert.equal(composerHeight({ scrollHeight: 253, clientHeight: 118, offsetHeight: 120 }), 120)
})

test('引数なしでも壊れない', () => {
  assert.equal(composerHeight(), 0)
  assert.equal(composerHeight({ scrollHeight: 38 }), 38)
})
