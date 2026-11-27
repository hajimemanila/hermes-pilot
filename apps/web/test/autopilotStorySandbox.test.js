/**
 * AP2-4 tests for 0.1s story flick compare, Live Sandbox iframe CSP boundary,
 * Style Gacha presets, and i18n key parity.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_STYLE_GACHA,
  STYLE_GACHA_PRESETS,
  buildRemixPayload,
  currentOptionCard,
  nextOptionIndex,
  resolveStoryTapZone,
} from '../src/lib/autopilotDeck.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('resolveStoryTapZone classifies left 45%, right 45%, center, and invalid rects', () => {
  const rect = { left: 100, width: 200 }
  assert.equal(resolveStoryTapZone(140, rect), 'prev')
  assert.equal(resolveStoryTapZone(190, rect), 'prev')
  assert.equal(resolveStoryTapZone(200, rect), 'center')
  assert.equal(resolveStoryTapZone(210, rect), 'next')
  assert.equal(resolveStoryTapZone(290, rect), 'next')
  assert.equal(resolveStoryTapZone(150, null), 'center')
  assert.equal(resolveStoryTapZone(150, { left: 0, width: 0 }), 'center')
})

test('nextOptionIndex wraps forward and backward within option bounds', () => {
  assert.equal(nextOptionIndex(0, 3, 1), 1)
  assert.equal(nextOptionIndex(2, 3, 1), 0)
  assert.equal(nextOptionIndex(0, 3, -1), 2)
  assert.equal(nextOptionIndex(1, 3, -1), 0)
  assert.equal(nextOptionIndex(0, 1, 1), 0)
})

test('currentOptionCard exposes mockUrl for visualMock.html and omits when absent', () => {
  const card = {
    taskId: 't_99',
    options: [
      { id: 'A', label: 'A', visualMock: { shot: 'shots/a.png', html: '.hermes-pilot/sandbox/j1/a.html' } },
      { id: 'B', label: 'B', visualMock: { shot: 'shots/b.png' } },
    ],
  }
  const viewA = currentOptionCard(card, 0)
  assert.equal(
    viewA.mockUrl,
    '/api/review/t_99/mock?file=.hermes-pilot%2Fsandbox%2Fj1%2Fa.html',
  )
  const viewB = currentOptionCard(card, 1)
  assert.equal(viewB.mockUrl, null)
})

test('buildRemixPayload includes stylePreset only when supplied and exposes 5 presets', () => {
  assert.equal(MAX_STYLE_GACHA, 3)
  assert.deepEqual(
    STYLE_GACHA_PRESETS.map((p) => p.id),
    ['minimal', 'neon', 'retro', 'editorial', 'bento'],
  )
  const withStyle = buildRemixPayload({ questionId: 'q1' }, 'style_gacha', 'bento', 'bento')
  assert.deepEqual(withStyle, {
    questionId: 'q1',
    reason: 'style_gacha',
    hint: 'bento',
    stylePreset: 'bento',
  })
  const plain = buildRemixPayload({ questionId: 'q1' }, 'simpler', '')
  assert.equal('stylePreset' in plain, false)
})

test('MockCompareStage enforces sandbox="allow-scripts allow-forms" without allow-same-origin', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'apps', 'web', 'src', 'features', 'autopilot', 'MockCompareStage.jsx'),
    'utf8',
  )
  assert.match(src, /sandbox="allow-scripts allow-forms"/)
  assert.doesNotMatch(src, /allow-same-origin/)
})

test('AP2-4 i18n keys exist in both en.json and ja.json', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'i18n', 'en.json'), 'utf8'))
  const ja = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'i18n', 'ja.json'), 'utf8'))
  const keys = [
    'autopilot.sandbox.tryLive',
    'autopilot.sandbox.backToShot',
    'autopilot.sandbox.iframeTitle',
    'autopilot.flick.peek',
    'autopilot.flick.prevAria',
    'autopilot.flick.nextAria',
    'autopilot.gacha.title',
    'autopilot.gacha.remaining',
    'autopilot.gacha.limitReached',
    'autopilot.gacha.minimal',
    'autopilot.gacha.neon',
    'autopilot.gacha.retro',
    'autopilot.gacha.editorial',
    'autopilot.gacha.bento',
  ]
  for (const key of keys) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `Missing en.json key: ${key}`)
    assert.ok(typeof ja[key] === 'string' && ja[key].length > 0, `Missing ja.json key: ${key}`)
  }
})
