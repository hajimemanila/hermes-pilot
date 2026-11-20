/**
 * 貼り付け回答パーサ（`apps/web/src/lib/reviewPaste.js`）の両表記対応。
 *
 * 生成側（ブリッジの `toReplyText`）は実行時言語で出し分けるので、
 * 読み取り側は ja / en のどちらも同じ構造に落とせなければならない（SPEC-i18n-gen §3.3）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePastedReply, isUnselected } from '../src/lib/reviewPaste.js'

test('JA 表記（補足: / 全体へのレビュー: / (未選択）を読む', () => {
  const r = parsePastedReply(
    ['【レビュー回答】hud-02', 'Q1. 左右どちら？: A / 補足: 小さく', 'Q2. 色は？: (未選択 = お任せ)', '全体へのレビュー: これで', '---', '上の回答を反映して…'].join('\n'),
  )
  assert.deepEqual(r.answers, [
    { id: 'q1', choice: 'A', note: '小さく' },
    { id: 'q2', choice: null, note: '' },
  ])
  assert.equal(r.global, 'これで', '--- 以降の指示行は全体メモに混ぜない')
})

test('EN 表記（note: / Overall Note: / (unselected）を読む', () => {
  const r = parsePastedReply(
    [
      '[Review Answer] hud-02',
      'Q1. Which side?: A / note: keep it small',
      'Q2. Keep color?: (unselected = take recommended)',
      'Overall Note: ship it',
      '---',
      'Apply the answers above and continue.',
    ].join('\n'),
  )
  assert.deepEqual(r.answers, [
    { id: 'q1', choice: 'A', note: 'keep it small' },
    { id: 'q2', choice: null, note: '' },
  ])
  assert.equal(r.global, 'ship it')
})

test('混在（ja 見出し + en の note / 全体メモ）でも読める', () => {
  const r = parsePastedReply('【レビュー回答】hud-02\nQ1. どちら: B / note: tight\nOverall Note: go\n---\n')
  assert.deepEqual(r.answers, [{ id: 'q1', choice: 'B', note: 'tight' }])
  assert.equal(r.global, 'go')
})

test('note が無い回答は note: "" で、choice はそのまま', () => {
  const r = parsePastedReply('[Review Answer] x\nQ1. Which?: B\nOverall Note:\n---\n')
  assert.deepEqual(r.answers, [{ id: 'q1', choice: 'B', note: '' }])
  assert.equal(r.global, '')
})

test('isUnselected は日英の接頭辞だけを見る（通常の選択肢は false）', () => {
  assert.equal(isUnselected('(未選択 = お任せ)'), true)
  assert.equal(isUnselected('(unselected = take recommended)'), true)
  assert.equal(isUnselected('(UNSELECTED)'), true)
  assert.equal(isUnselected('A'), false)
  assert.equal(isUnselected('未選択っぽいラベル'), false)
  assert.equal(isUnselected(''), false)
})
