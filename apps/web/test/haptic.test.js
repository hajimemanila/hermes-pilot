import test from 'node:test'
import assert from 'node:assert/strict'
import { HAPTIC_KEY, HAPTIC_PATTERNS, haptic, isHapticEnabled, setHapticEnabled } from '../src/lib/haptic.js'

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  }
}

test('ハプティック設定は既定 ON で、0 を保存すると OFF になる', () => {
  const s = fakeStorage()
  assert.equal(isHapticEnabled(s), true)
  setHapticEnabled(false, s)
  assert.equal(s.getItem(HAPTIC_KEY), '0')
  assert.equal(isHapticEnabled(s), false)
  setHapticEnabled(true, s)
  assert.equal(isHapticEnabled(s), true)
})

test('haptic は有効時のみ navigator.vibrate を呼び、非対応環境でも落ちない', () => {
  const calls = []
  const nav = { vibrate: (p) => calls.push(p) > 0 }
  const s = fakeStorage()

  assert.equal(haptic('tap', nav, s), true)
  assert.equal(haptic('action', nav, s), true)
  assert.equal(haptic('error', nav, s), true)
  assert.deepEqual(calls, [HAPTIC_PATTERNS.tap, HAPTIC_PATTERNS.action, HAPTIC_PATTERNS.error])

  setHapticEnabled(false, s)
  assert.equal(haptic('tap', nav, s), false)
  assert.equal(calls.length, 3)

  // vibrate 非対応
  assert.equal(haptic('tap', {}, fakeStorage()), false)
  assert.equal(haptic('tap', null, fakeStorage()), false)
})
