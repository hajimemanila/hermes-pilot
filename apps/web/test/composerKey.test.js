import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSendOnEnter } from '../src/lib/composerKey.js'

// レビュー enter-key-01（round 1 / すべて A）: Enter は改行、送信は丸ボタンと物理キーボードの Shift+Enter だけ。
test('Enter だけでは送らない（改行）', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter' }), false)
})

test('Shift+Enter で送る', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: true }), true)
})

test('Enter 以外のキーは対象外', () => {
  assert.equal(shouldSendOnEnter({ key: 'a', shiftKey: true }), false)
  assert.equal(shouldSendOnEnter({ key: 'NumpadEnter', shiftKey: true }), false)
})

test('IME 変換中の Enter（確定）は送らない', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter', isComposing: true }), false)
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: true, isComposing: true }), false)
})

test('引数なしでも壊れない', () => {
  assert.equal(shouldSendOnEnter(), false)
})
