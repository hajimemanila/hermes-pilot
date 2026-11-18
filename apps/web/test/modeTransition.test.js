import test from 'node:test'
import assert from 'node:assert/strict'
import { originFromEvent, switchThemeWithTransition, switchVibeWithTransition } from '../src/lib/modeTransition.js'

test('originFromEvent は clientX/Y → currentTarget rect → 画面中央の順で座標を決める', () => {
  assert.deepEqual(originFromEvent({ clientX: 120.4, clientY: 240.6 }, { innerWidth: 390, innerHeight: 844 }), {
    x: 120,
    y: 241,
  })
  assert.deepEqual(
    originFromEvent(
      {
        clientX: 0,
        clientY: 0,
        currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 40 }) },
      },
      { innerWidth: 390, innerHeight: 844 },
    ),
    { x: 50, y: 40 },
  )
  assert.deepEqual(originFromEvent(null, { innerWidth: 400, innerHeight: 800 }), { x: 200, y: 400 })
})

test('switchVibeWithTransition は DOM 不在環境でも例外を出さず正規化モードを返す', () => {
  assert.equal(switchVibeWithTransition('dopamine', null), 'dopamine')
  assert.equal(switchVibeWithTransition('serotonin', null), 'serotonin')
})

test('switchThemeWithTransition はコールバックを安全に呼び出す', () => {
  let called = null
  switchThemeWithTransition('light', (p) => {
    called = p
  })
  assert.equal(called, 'light')
})
