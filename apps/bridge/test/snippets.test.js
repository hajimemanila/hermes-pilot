import test from 'node:test'
import assert from 'node:assert/strict'
import { listSnippets, normalizeCustom, CUSTOM_MAX, LABEL_MAX, TEXT_MAX, SNIPPETS } from '../src/snippets.js'

test('組み込みスニペットは hot が5〜8個で、id が一意', () => {
  const hot = SNIPPETS.filter((s) => s.hot)
  assert.ok(hot.length >= 5 && hot.length <= 8, `hot=${hot.length}`)
  const ids = new Set(SNIPPETS.map((s) => s.id))
  assert.equal(ids.size, SNIPPETS.length)
  for (const s of SNIPPETS) {
    assert.ok(s.label && s.text, s.id)
    assert.ok(s.text.length <= TEXT_MAX)
  }
})

test('listSnippets は custom フラグと placeholder 情報を付ける', () => {
  const list = listSnippets([])
  assert.equal(list.length, SNIPPETS.length)
  assert.equal(list.every((s) => s.custom === false), true)
  const cause = list.find((s) => s.id === 'cause')
  assert.equal(cause.hasPlaceholder, true)
})

test('normalizeCustom は不正要素を落とし、id を振り、上限で切る', () => {
  const dirty = [
    { label: '', text: 'x' },
    { label: 'ok', text: 'body' },
    { label: 'a'.repeat(50), text: 'b'.repeat(1000) },
    null,
    'str',
  ]
  const out = normalizeCustom(dirty)
  assert.equal(out.length, 2)
  assert.equal(out[0].custom, true)
  assert.match(out[0].id, /^c-/)
  assert.equal(out[1].label.length, LABEL_MAX)
  assert.equal(out[1].text.length, TEXT_MAX)
  // 上限
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `l${i}`, text: `t${i}` }))
  assert.equal(normalizeCustom(many).length, CUSTOM_MAX)
})

test('normalizeCustom は重複 id を振り直す', () => {
  const out = normalizeCustom([
    { id: 'c-fixed', label: 'A', text: 'a' },
    { id: 'c-fixed', label: 'B', text: 'b' },
  ])
  assert.equal(out.length, 2)
  assert.notEqual(out[0].id, out[1].id)
  assert.equal(out[0].id, 'c-fixed')
})

test('listSnippets はユーザー定義を後ろに足す', () => {
  const list = listSnippets([{ label: 'マイ', text: 'テスト本文', hot: true }])
  assert.equal(list.length, SNIPPETS.length + 1)
  const last = list[list.length - 1]
  assert.equal(last.label, 'マイ')
  assert.equal(last.custom, true)
  assert.equal(last.hot, true)
  assert.equal(list.filter((s) => s.hot).length, SNIPPETS.filter((s) => s.hot).length + 1)
})
