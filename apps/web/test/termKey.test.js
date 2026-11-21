import test from 'node:test'
import assert from 'node:assert/strict'
import { TERM_ENTER_BYTES, isEnterKey, termKeyBytes } from '../src/lib/termKey.js'

// SPEC-enter-enter-discuss-next-ste Q1/Q2 = A:
// Enter はターミナルのホストで拾って `\r` を自分で書く。IME 変換中でも実行する。

test('Enter は CR 1 バイト（PTY の実行）', () => {
  assert.equal(TERM_ENTER_BYTES, '\r')
  assert.equal(termKeyBytes({ key: 'Enter' }), '\r')
})

test('Shift+Enter / Ctrl+Enter も同じ CR（修飾で黙る分岐を作らない）', () => {
  assert.equal(termKeyBytes({ key: 'Enter', shiftKey: true }), '\r')
  assert.equal(termKeyBytes({ key: 'Enter', ctrlKey: true }), '\r')
})

test('IME 変換中の Enter でも実行する（Q2=A: 確定 Enter で止まらない）', () => {
  assert.equal(termKeyBytes({ key: 'Enter', isComposing: true }), '\r')
})

test('key を省いた IME 経路（code / keyCode だけ）でも Enter と分かる', () => {
  assert.equal(termKeyBytes({ key: 'Process', code: 'Enter', keyCode: 229 }), '\r')
  assert.equal(termKeyBytes({ keyCode: 13 }), '\r')
  assert.equal(termKeyBytes({ code: 'NumpadEnter' }), '\r')
})

test('Enter 以外は担当外（null = xterm に任せる）', () => {
  for (const e of [{ key: 'a' }, { key: 'Backspace' }, { key: 'Tab' }, { key: 'Process' }, { keyCode: 65 }, {}]) {
    assert.equal(termKeyBytes(e), null, JSON.stringify(e))
  }
  assert.equal(termKeyBytes(), null)
  assert.equal(isEnterKey(), false)
})

test('矢印・Ctrl+C などの制御キーは横取りしない（中断・履歴移動を壊さない）', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'c', 'd', 'Escape', 'Delete']) {
    assert.equal(termKeyBytes({ key, ctrlKey: true }), null)
  }
})
