/**
 * AP2-2 unit and guard tests for `autopilot-contract.js`, `skills/autopilot-fastlane/SKILL.md`,
 * and updated `buildAutopilotRound1Lines()`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTO_RESOLVE_ALLOW_CATEGORIES,
  AUTO_RESOLVE_DENY_CATEGORIES,
  MAX_STYLE_GACHA_PER_CARD,
  STYLE_PRESETS,
  classifyAutoResolve,
  getStylePreset,
  isSafeSandboxRelPath,
  isValidStylePreset,
  normalizePromotePayload,
} from '../src/review/autopilot-contract.js'
import { buildAutopilotRound1Lines } from '../src/architect/autopilot.js'
import { findHardcodedVerification } from '../src/contracts/verify.js'
import { LANGUAGE_RULE_MARKER } from '../src/language-rule.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('STYLE_PRESETS exposes 5 presets with bilingual labels and MAX_STYLE_GACHA_PER_CARD === 3', () => {
  assert.equal(MAX_STYLE_GACHA_PER_CARD, 3)
  assert.deepEqual(
    STYLE_PRESETS.map((p) => p.id),
    ['minimal', 'neon', 'retro', 'editorial', 'bento'],
  )
  for (const preset of STYLE_PRESETS) {
    assert.ok(preset.labelEn && preset.labelJa && preset.promptHint)
    assert.equal(isValidStylePreset(preset.id), true)
    assert.equal(getStylePreset(preset.id)?.id, preset.id)
  }
  assert.equal(isValidStylePreset('MONOCHROME_UNKNOWN'), false)
  assert.equal(getStylePreset('unknown'), null)
})

test('classifyAutoResolve allows only reversible non-visual safe categories', () => {
  for (const category of AUTO_RESOLVE_ALLOW_CATEGORIES) {
    assert.deepEqual(classifyAutoResolve({ category }), {
      autoResolve: true,
      reason: 'safe_technical_default',
    })
    assert.deepEqual(classifyAutoResolve({ category, affectsVisual: true }), {
      autoResolve: false,
      reason: 'affects_visual_experience',
    })
    assert.deepEqual(classifyAutoResolve({ category, irreversible: true }), {
      autoResolve: false,
      reason: 'irreversible_action',
    })
  }
  for (const category of AUTO_RESOLVE_DENY_CATEGORIES) {
    assert.deepEqual(classifyAutoResolve({ category }), {
      autoResolve: false,
      reason: 'denied_category',
    })
  }
  assert.deepEqual(classifyAutoResolve({ category: 'unclassified_thing' }), {
    autoResolve: false,
    reason: 'unknown_category',
  })
})

test('isSafeSandboxRelPath rejects traversal, absolute paths, and backslashes', () => {
  assert.equal(isSafeSandboxRelPath('.hermes-pilot/sandbox/job-1/a.html'), true)
  assert.equal(isSafeSandboxRelPath('shots/variant-a.png'), true)
  assert.equal(isSafeSandboxRelPath('../etc/passwd'), false)
  assert.equal(isSafeSandboxRelPath('shots/../secret.txt'), false)
  assert.equal(isSafeSandboxRelPath('/etc/passwd'), false)
  assert.equal(isSafeSandboxRelPath('~/secret.html'), false)
  assert.equal(isSafeSandboxRelPath('C:\\temp\\a.html'), false)
  assert.equal(isSafeSandboxRelPath('shots\\a.html'), false)
  assert.equal(isSafeSandboxRelPath(''), false)
})

test('normalizePromotePayload validates and normalizes valid and invalid inputs', () => {
  const good = normalizePromotePayload({
    chosenVariantId: 'option-B',
    taskId: 'T42',
    mockHtmlPath: '.hermes-pilot/sandbox/demo/b.html',
    screenshotPath: '.hermes-pilot/sandbox/demo/shots/b.png',
    styleTag: 'Bento',
    annotations: [{ id: 'a1', x: 1.4, y: -0.2, text: '  Move button lower  ' }],
    autoResolved: [{ topic: 'Flag cleanup', decision: 'Drop ?ui= param', category: 'temp_flag_cleanup' }],
  })
  assert.equal(good.ok, true)
  assert.equal(good.payload.chosenVariantId, 'option-B')
  assert.equal(good.payload.styleTag, 'bento')
  assert.deepEqual(good.payload.annotations, [{ id: 'a1', x: 1, y: 0, text: 'Move button lower' }])
  assert.equal(good.payload.autoResolved.length, 1)

  const badId = normalizePromotePayload({ chosenVariantId: 'bad id with spaces' })
  assert.equal(badId.ok, false)
  assert.ok(badId.errors.includes('invalid_chosenVariantId'))

  const badPath = normalizePromotePayload({ chosenVariantId: 'A', mockHtmlPath: '../../escape.html' })
  assert.equal(badPath.ok, false)
  assert.ok(badPath.errors.includes('unsafe_mockHtmlPath'))

  const badStyle = normalizePromotePayload({ chosenVariantId: 'A', styleTag: 'cyberpunk99' })
  assert.equal(badStyle.ok, false)
  assert.ok(badStyle.errors.includes('invalid_styleTag'))
})

test('skills/autopilot-fastlane/SKILL.md obeys generic ASCII and language-rule contracts', () => {
  const skillPath = path.join(ROOT, 'skills', 'autopilot-fastlane', 'SKILL.md')
  assert.ok(fs.existsSync(skillPath), 'SKILL.md must exist')
  const text = fs.readFileSync(skillPath, 'utf8')
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  assert.equal(CJK.test(text), false, 'SKILL.md must not contain CJK characters')
  assert.match(text, /^## Language$/m)
  assert.ok(text.includes(LANGUAGE_RULE_MARKER), 'SKILL.md must include LANGUAGE_RULE_MARKER')
  assert.equal(findHardcodedVerification(text).ok, true)
  assert.doesNotMatch(text, /browser_exec/)
  assert.doesNotMatch(text, /apps\/web\/dist/)
})

test('buildAutopilotRound1Lines includes AP2-2 fast-lane guidance cleanly', () => {
  const joined = buildAutopilotRound1Lines({ slug: 'demo' }).join('\n')
  assert.equal(findHardcodedVerification(joined).ok, true)
  assert.doesNotMatch(joined, /browser_exec/)
  assert.match(joined, /\.hermes-pilot\/sandbox\/demo\//)
  assert.match(joined, /Safe Auto-Resolve/)
  assert.match(joined, /stylePreset/)
  assert.match(joined, /chosenVariantId/)
})
