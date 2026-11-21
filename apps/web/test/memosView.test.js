/**
 * メモ一覧の表示切替（1 列 / 2 列 / リスト）と二列カードの上限（SPEC-ver-0-2-1 §2.2 / Q2=A・Q4=A）。
 *
 * - 端末保存: `hm.memosView` を読み書きし、未知・欠損は既定の二列に落ちる
 * - 二列の上限: 本文 4 行（clamp 4）・カード高さ 220px・チェックリストは先頭 3 件＋「残り N 件」
 * - 検索行: 390px でも入力が潰れない（`min-width: 0` ＋ `flex: 1`）・切替ボタンは 44px タップ領域
 *
 * CSS は現物（`styles.css`）を読んで規則の存在を機械で確かめる。JSX とテストで
 * 同じ数値を二重管理しないよう、判定は `lib/memoView.js` の純関数を正本にする。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MEMOS_VIEW,
  MEMOS_VIEW_KEY,
  TWO_COL_CHECK_LIMIT,
  VIEWS,
  checklistPreview,
  parseMemosView,
  readMemosView,
  rememberMemosView,
} from '../src/lib/memoView.js'
import { readStyles } from './helpers/styles.js'

const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, '')

/** localStorage の代わり（ブラウザ無しで読める素の入れ物）。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  }
}

test('VIEWS は one / two / list、既定は二列（Q2=A）', () => {
  assert.deepEqual(VIEWS, ['one', 'two', 'list'])
  assert.equal(DEFAULT_MEMOS_VIEW, 'two')
  assert.equal(MEMOS_VIEW_KEY, 'hm.memosView')
})

test('parseMemosView は 3 モードを通し、未知・欠損・非文字列は two に落ちる', () => {
  for (const v of VIEWS) assert.equal(parseMemosView(v), v)
  // 端末に残った前の値・空白・大文字・未知のキー
  assert.equal(parseMemosView(' grid'), 'two')
  assert.equal(parseMemosView('TWO'), 'two')
  assert.equal(parseMemosView('three'), 'two')
  assert.equal(parseMemosView(''), 'two')
  // 欠損（null / undefined / 数値 / オブジェクト）
  assert.equal(parseMemosView(null), 'two')
  assert.equal(parseMemosView(undefined), 'two')
  assert.equal(parseMemosView(2), 'two')
  assert.equal(parseMemosView({ view: 'one' }), 'two')
})

test('rememberMemosView は 3 モードだけ保存し、readMemosView が読み戻す', () => {
  const store = fakeStorage()
  assert.equal(rememberMemosView(store, 'list'), true)
  assert.equal(store.map.get(MEMOS_VIEW_KEY), 'list')
  assert.equal(readMemosView(store), 'list')
  assert.equal(rememberMemosView(store, 'one'), true)
  assert.equal(readMemosView(store), 'one')
  // 未知の値は保存しない（前の値を壊さない）
  assert.equal(rememberMemosView(store, 'grid'), false)
  assert.equal(readMemosView(store), 'one')
})

test('storage が無い／壊れている環境でも既定の二列で動く', () => {
  assert.equal(readMemosView(null), 'two')
  assert.equal(readMemosView(undefined), 'two')
  assert.equal(readMemosView({}), 'two')
  assert.equal(rememberMemosView(null, 'list'), false)
  assert.equal(rememberMemosView({}, 'list'), false)
  assert.equal(
    readMemosView({
      getItem() {
        throw new Error('SecurityError')
      },
    }),
    'two',
  )
  assert.equal(
    rememberMemosView(
      {
        setItem() {
          throw new Error('QuotaExceededError')
        },
      },
      'list',
    ),
    false,
  )
})

test('二列は先頭 3 件＋残り N 件、一列・リストは全件（Q4=A）', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, text: `項目${i}`, done: false }))
  const two = checklistPreview(items, 'two')
  assert.equal(TWO_COL_CHECK_LIMIT, 3)
  assert.deepEqual(
    two.visible.map((c) => c.id),
    ['c0', 'c1', 'c2'],
  )
  assert.equal(two.hidden, 4)
  // 3 件以下なら畳まない
  assert.equal(checklistPreview(items.slice(0, 3), 'two').hidden, 0)
  assert.equal(checklistPreview(items.slice(0, 2), 'two').visible.length, 2)
  // 一列・リストは従来どおり全件・+N なし
  assert.equal(checklistPreview(items, 'one').visible.length, 7)
  assert.equal(checklistPreview(items, 'one').hidden, 0)
  assert.equal(checklistPreview(items, 'list').visible.length, 7)
  assert.equal(checklistPreview(items, 'list').hidden, 0)
  // 空・欠損でも落ちない
  assert.deepEqual(checklistPreview(undefined, 'two'), { visible: [], hidden: 0 })
  assert.deepEqual(checklistPreview([], 'two'), { visible: [], hidden: 0 })
  // 元の配列は書き換えない
  assert.equal(items.length, 7)
})

test('CSS: 二列は 2 列固定・カード高 220px・本文 clamp 4', () => {
  assert.match(
    css,
    /\.memos-grid\.view-two\s*\{[^}]*grid-template-columns:\s*repeat\(\s*2\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/,
    '.memos-grid.view-two が 2 列固定になっていない',
  )
  assert.match(
    css,
    /\.view-two \.memo-card\s*\{[^}]*height:\s*220px/,
    '.view-two .memo-card の height: 220px が無い',
  )
  assert.match(
    css,
    /\.view-two \.memo-card-body\s*\{[^}]*(-webkit-)?line-clamp:\s*4/,
    '.view-two .memo-card-body の clamp 4 が無い',
  )
  // 一列は 1 列固定・リストは 1 列の行レイアウト
  assert.match(css, /\.memos-grid\.view-one\s*\{[^}]*grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/)
  assert.match(css, /\.memos-grid\.view-list\s*\{[^}]*grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/)
})

test('CSS: 検索入力は 390px でも潰れない（min-width: 0 と flex: 1）', () => {
  assert.match(
    css,
    /\.memos-search-row\s*\{[^}]*display:\s*flex/,
    '検索行が flex になっていない（入力とセグメントが並ばない）',
  )
  assert.match(css, /\.memos-search-row \.memos-search-input\s*\{[^}]*flex:\s*1(?![.\d])[^}]*\}/, 'flex: 1 が無い')
  assert.match(css, /\.memos-search-row \.memos-search-input\s*\{[^}]*min-width:\s*0/, 'min-width: 0 が無い')
})

test('CSS: 表示切替ボタンは 44px のタップ領域（検索行の右端）', () => {
  const block = css.match(/\.memos-view-btn\s*\{([^}]*)\}/)
  assert.ok(block, '.memos-view-btn が無い')
  const body = block[1]
  assert.match(body, /height:\s*44px/, '高さが 44px でない（監査の tap チェックに落ちる）')
  assert.match(body, /min-width:\s*44px/, '幅が 44px 未満')
  assert.match(css, /\.memos-view-seg\s*\{[^}]*flex:\s*none/, 'セグメントが縮む設定になっている')
})
