/**
 * `BrainstormSheet` 用純関数と i18n テンプレートの汎用性（公開プラグイン規約）テスト。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setLang, t } from '../src/i18n/lang.js'
import { BRAINSTORM_ANGLES, buildBrainstormChatPrompt, buildBrainstormItems } from '../src/lib/brainstorm.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(here, '..', '..', '..')
const FORBIDDEN_RE = /\b(390px|390x844|Dopamine|Serotonin|hermes-mobile-pwa|npm run verify|npm run deploy)\b/i

test('buildBrainstormItems は観点ごとに汎用テンプレートを展開する', () => {
  setLang('ja')
  const items = buildBrainstormItems('通知まとめ', ['feature', 'ux', 'edge'], t)
  assert.equal(items.length, 6)
  assert.ok(items[0].text.includes('通知まとめ'))
  assert.equal(items.every((c) => c.done === false && typeof c.text === 'string' && c.text.length > 0), true)
})

test('buildBrainstormChatPrompt は発散・ブレスト指示を先頭に付け、元メモと観点を渡す', () => {
  setLang('ja')
  const items = buildBrainstormItems('オフライン閲覧改善', ['feature', 'ux'], t)
  const prompt = buildBrainstormChatPrompt({
    seed: 'オフライン閲覧改善\n外出先で直近メモを見たい',
    angles: ['feature', 'ux'],
    items,
    t,
  })
  assert.match(prompt, /ブレスト/)
  assert.match(prompt, /決め打ちせず/)
  assert.match(prompt, /機能アイデア/)
  assert.match(prompt, /オフライン閲覧改善/)
  assert.match(prompt, /外出先で直近メモを見たい/)
  assert.match(prompt, /- \[ \] /)

  setLang('en')
  const promptEn = buildBrainstormChatPrompt({
    seed: 'Offline notes viewing',
    angles: ['edge'],
    items: buildBrainstormItems('Offline notes viewing', ['edge'], t),
    t,
  })
  assert.match(promptEn, /brainstorm/i)
  assert.match(promptEn, /Do not jump straight to a single implementation/i)
  assert.match(promptEn, /Offline notes viewing/)
  assert.equal(BRAINSTORM_ANGLES.length, 3)
})

test('公開プラグイン汎用性: brainstorm.* の JA/EN 辞書にプロジェクト固有語を含めない', () => {
  for (const lang of ['ja', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, `apps/web/src/i18n/${lang}.json`), 'utf8'))
    const keys = Object.keys(dict).filter((k) => k.startsWith('brainstorm.'))
    assert.ok(keys.length >= 10)
    for (const k of keys) {
      assert.equal(FORBIDDEN_RE.test(dict[k]), false, `${lang}.json ${k} contains project-specific text: ${dict[k]}`)
    }
  }
})
