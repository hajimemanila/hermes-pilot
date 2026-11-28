import test from 'node:test'
import assert from 'node:assert/strict'
import {
  originFromEvent,
  switchLensWithTransition,
  switchThemeWithTransition,
  switchVibeWithTransition,
} from '../src/lib/modeTransition.js'
import { initVibe, setVibe } from '../src/lib/vibe.js'

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

test('switchLensWithTransition は同値切替を無視し、Serotonin 時は startViewTransition を呼ばない', () => {
  const prevDoc = globalThis.document
  let vtCalls = 0
  let applied = null
  globalThis.document = {
    documentElement: { dataset: { vibe: 'serotonin' }, animate: () => {} },
    startViewTransition: () => {
      vtCalls += 1
      return { ready: Promise.resolve(), finished: Promise.resolve() }
    },
  }
  try {
    setVibe('serotonin')
    assert.equal(switchLensWithTransition('autopilot', 'autopilot', (v) => { applied = v }), 'autopilot')
    assert.equal(applied, null)

    assert.equal(switchLensWithTransition('autopilot', 'cockpit', (v) => { applied = v }), 'autopilot')
    assert.equal(applied, 'autopilot')
    assert.equal(vtCalls, 0)
  } finally {
    globalThis.document = prevDoc
    initVibe()
  }
})

test('switchLensWithTransition は Dopamine 時に startViewTransition と clipPath 円形展開を呼ぶ', async () => {
  const prevDoc = globalThis.document
  const prevWin = globalThis.window
  const animCalls = []
  let applied = null
  let focused = false
  globalThis.window = { innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: false }) }
  globalThis.document = {
    body: {},
    activeElement: null,
    contains: () => false,
    documentElement: {
      dataset: { vibe: 'dopamine' },
      animate: (keyframes, options) => animCalls.push({ keyframes, options }),
    },
    querySelector: () => ({ focus: () => { focused = true } }),
    startViewTransition: (cb) => {
      cb()
      return { ready: Promise.resolve(), finished: Promise.resolve() }
    },
  }
  try {
    setVibe('dopamine')
    const out = switchLensWithTransition('autopilot', 'cockpit', (v) => { applied = v }, { clientX: 195, clientY: 22 })
    assert.equal(out, 'autopilot')
    assert.equal(applied, 'autopilot')
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(animCalls.length, 1)
    assert.match(animCalls[0].keyframes.clipPath[0], /^circle\(0px at 195px 22px\)$/)
    assert.equal(animCalls[0].options.pseudoElement, '::view-transition-new(root)')
    assert.equal(focused, true)
  } finally {
    globalThis.document = prevDoc
    globalThis.window = prevWin
    initVibe()
  }
})

test('switchLensWithTransition は startViewTransition 非対応環境でもフォールバックで切り替える', () => {
  const prevDoc = globalThis.document
  const prevWin = globalThis.window
  let applied = null
  let shellAnimated = false
  globalThis.window = { innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: false }) }
  globalThis.document = {
    body: {},
    activeElement: {},
    contains: () => true,
    documentElement: { dataset: { vibe: 'dopamine' } },
    querySelector: () => ({
      animate: () => {
        shellAnimated = true
        return {}
      },
    }),
  }
  try {
    setVibe('dopamine')
    switchLensWithTransition('cockpit', 'autopilot', (v) => { applied = v }, null)
    assert.equal(applied, 'cockpit')
    assert.equal(shellAnimated, true)
  } finally {
    globalThis.document = prevDoc
    globalThis.window = prevWin
    initVibe()
  }
})
