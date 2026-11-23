import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findHardcodedVerification } from '../src/contracts/verify.js'
import {
  listSnippets,
  allSnippets,
  normalizeCustom,
  normalizeOverrides,
  readSnippetStore,
  writeSnippetStore,
  CUSTOM_MAX,
  HOT_LIMIT,
  LABEL_MAX,
  TEXT_MAX,
  SNIPPETS,
} from '../src/snippets.js'

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

test('既定セットは SPEC §3.2 の14個＋仕様策定（Hot 7・trigger 3）で順序も仕様どおり', () => {
  assert.deepEqual(
    SNIPPETS.map((s) => s.id),
    [
      // 仕様策定はバーの先頭（別建てのボタンをやめて組み込みに統合）
      'spec-seed',
      'quick-review',
      'annotate-shot',
      'approve',
      'spec-kanban',
      'retry',
      'summary',
      'git-diff',
      'git-status',
      'test',
      'review',
      'explain',
      'cause',
      'handoff',
      'kanban',
    ],
  )
  assert.equal(SNIPPETS.length, 15)
  const hot = SNIPPETS.filter((s) => s.hot)
  assert.equal(hot.length, 7)
  assert.equal(hot.length <= HOT_LIMIT, true)
  assert.deepEqual(SNIPPETS.filter((s) => s.trigger).map((s) => s.id), ['spec-seed', 'quick-review', 'annotate-shot'])
  // 仕様策定だけ input に流し込まずシートを開く（action で UI が分岐）
  assert.equal(SNIPPETS[0].action, 'seed')
  assert.equal(SNIPPETS.filter((s) => s.action).length, 1)
  assert.equal(SNIPPETS.every((s) => s.hidden === false), true)
  // SPEC V7 §3.5 / D37: 日本語は「仕様策定」、英語は "Spec Seed" を維持（音声ボタン廃止で絵文字も整理）
  assert.equal(SNIPPETS[0].label, '📝 Spec Seed')
  assert.equal(listSnippets([], 'ja')[0].label, '📝 仕様策定')
  assert.equal(listSnippets([], 'en')[0].label, '📝 Spec Seed')
})

test('overrides: hidden は会話用一覧から外れ、allSnippets には残る', () => {
  const overrides = { retry: { hidden: true }, 'git-diff': { hot: true } }
  const visible = listSnippets([], 'en', overrides)
  assert.equal(visible.some((s) => s.id === 'retry'), false)
  assert.equal(visible.length, SNIPPETS.length - 1)
  const all = allSnippets([], 'en', overrides)
  assert.equal(all.length, SNIPPETS.length)
  assert.equal(all.find((s) => s.id === 'retry').hidden, true)
  assert.equal(all.find((s) => s.id === 'git-diff').hot, true)
  // hot の解除も効く（既定 true → false）
  assert.equal(listSnippets([], 'en', { approve: { hot: false } }).find((s) => s.id === 'approve').hot, false)
})

test('overrides は未知の id と非真偽値を捨てる', () => {
  const ov = normalizeOverrides({ nope: { hot: true }, retry: { hot: 'yes', hidden: true } })
  assert.deepEqual(ov, { retry: { hidden: true } })
  assert.deepEqual(normalizeOverrides(null), {})
})

test('保存ストア: overrides の round-trip（version 2）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippets-'))
  const file = path.join(dir, 'snippets.json')
  try {
    const saved = writeSnippetStore(file, {
      overrides: { retry: { hidden: true }, 'git-diff': { hot: false } },
      custom: [{ label: 'My Prompt', text: 'Run custom check', hot: true }],
    })
    assert.equal(saved.version, 2)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const read = readSnippetStore(file)
    assert.deepEqual(read.overrides, { retry: { hidden: true }, 'git-diff': { hot: false } })
    assert.equal(read.custom.length, 1)
    assert.equal(read.custom[0].custom, true)
    assert.match(read.custom[0].id, /^c-/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('保存ストア: version 1 は読取時に overrides: {} を補完する（後方互換）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippets-v1-'))
  const file = path.join(dir, 'snippets.json')
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, custom: [{ label: 'Old', text: 'legacy', hot: true }] }))
    const read = readSnippetStore(file)
    assert.equal(read.version, 2)
    assert.deepEqual(read.overrides, {})
    assert.equal(read.custom.length, 1)
    assert.equal(read.custom[0].label, 'Old')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('保存ストア: 壊れた JSON・存在しないファイルでも空の設定を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippets-bad-'))
  try {
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{not json')
    assert.deepEqual(readSnippetStore(broken), { version: 2, overrides: {}, custom: [] })
    assert.deepEqual(readSnippetStore(path.join(dir, 'missing.json')), { version: 2, overrides: {}, custom: [] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('公開プラグイン汎用性: 全組み込みスニペット（ja/en）に固有検証コマンドや特定リポジトリ名を含めない', () => {
  for (const lang of ['en', 'ja']) {
    for (const s of listSnippets([], lang)) {
      const check = findHardcodedVerification(s.text)
      assert.equal(check.ok, true, `${lang} snippet ${s.id} has hardcoded verification: ${check.hits.join(', ')}`)
      assert.doesNotMatch(s.text, /\b(hermes-mobile-pwa|Dopamine|Serotonin)\b/i, `${lang} snippet ${s.id}`)
    }
  }
})
