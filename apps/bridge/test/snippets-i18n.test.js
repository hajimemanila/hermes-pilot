/**
 * 組み込みスニペットの多言語化（SPEC §6.3）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { listSnippets, SNIPPETS } from '../src/snippets.js'
import { listTermSnippets, buildTermSnippets } from '../src/term-snippets.js'

test('スニペット: id と hot は言語で変わらず、文面だけが変わる', () => {
  const en = listSnippets([], 'en')
  const ja = listSnippets([], 'ja')
  assert.deepEqual(en.map((s) => s.id), ja.map((s) => s.id))
  assert.deepEqual(en.map((s) => s.hot), ja.map((s) => s.hot))
  assert.equal(en.length, SNIPPETS.length)
  // 既定は英語（SPEC D5）
  assert.deepEqual(listSnippets([]), en)
  const diff = en.filter((s, i) => s.label !== ja[i].label || s.text !== ja[i].text)
  assert.ok(diff.length >= en.length - 2, `言語差がほぼ無い: ${en.length - diff.length} 件が同一`)
  assert.equal(ja.find((s) => s.id === 'summary').label, 'まとめ')
  assert.equal(en.find((s) => s.id === 'summary').label, 'Summary')
})

test('スニペット: プレースホルダ情報は両言語で保たれる', () => {
  for (const lang of ['en', 'ja']) {
    const cause = listSnippets([], lang).find((s) => s.id === 'cause')
    assert.equal(cause.hasPlaceholder, true)
    assert.match(cause.text, /\{\{.*\}\}/)
  }
  assert.match(listSnippets([], 'ja').find((s) => s.id === 'cause').text, /ここに貼り付け/)
  assert.match(listSnippets([], 'en').find((s) => s.id === 'cause').text, /paste here/)
})

test('スニペット: ユーザー定義は言語に関係なくそのまま出す', () => {
  const custom = [{ label: 'マイ', text: 'テスト本文', hot: true }]
  for (const lang of ['en', 'ja']) {
    const list = listSnippets(custom, lang)
    const last = list[list.length - 1]
    assert.equal(last.label, 'マイ')
    assert.equal(last.custom, true)
  }
})

test('端末スニペット: ラベル・説明は言語で変わり、コマンドは変わらない', () => {
  const caps = { serviceManager: 'launchd', pilotServiceUnit: 'ai.hermes.pilot' }
  const en = listTermSnippets(caps, 'en')
  const ja = listTermSnippets(caps, 'ja')
  assert.deepEqual(en.map((s) => s.id), ja.map((s) => s.id))
  assert.deepEqual(en.map((s) => s.text), ja.map((s) => s.text))
  assert.equal(en.find((s) => s.id === 't-gw-status').label, 'GW status')
  assert.equal(ja.find((s) => s.id === 't-gw-status').label, 'GW状態')
  assert.match(ja.find((s) => s.id === 't-gw-status').note, /gateway/)
  assert.match(en.find((s) => s.id === 't-gw-status').note, /Gateway/)
  // 既定は英語
  assert.deepEqual(listTermSnippets(caps), en)
  assert.deepEqual(buildTermSnippets(caps, 'xx').map((s) => s.label), en.map((s) => s.label))
})
