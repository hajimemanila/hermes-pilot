/**
 * タブレット 2 ペイン分割（SPEC §7.2 / Batch T5 受入条件）の自動検証。
 *
 * - CSS: `@media (min-width: 820px)` の中に `.split-layout` / `.split-master` / `.split-detail` がある
 * - JS: 同じ 820px を判定する（CSS と JS で閾値がずれると「右ペインは出るが中身はシート」等の半端な状態になる）
 * - 820px 未満では 1 ペイン（`isSplitLayout()` は false）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SPLIT_QUERY, isSplitLayout } from '../src/lib/useSplitLayout.js'

const CSS_PATH = path.resolve(import.meta.dirname, '../src/styles.css')
const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** `@media (min-width: 820px) { … }` の中身（対応する閉じ括弧まで）。 */
function mediaBlock(source, query) {
  const at = source.indexOf(`@media ${query}`)
  assert.notEqual(at, -1, `@media ${query} が無い`)
  let depth = 0
  let start = -1
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1
      if (depth === 1) start = i + 1
    } else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i)
    }
  }
  throw new Error('@media ブロックが閉じていない')
}

const SPLIT_CSS = mediaBlock(css, '(min-width: 820px)')

test('CSS: 820px 以上のブロックに 2 ペインの 3 クラスがある', () => {
  for (const cls of ['.split-layout', '.split-master', '.split-detail']) {
    assert.ok(SPLIT_CSS.includes(cls), `@media (min-width: 820px) に ${cls} が無い`)
  }
  // 左は固定幅・右は伸ばす
  assert.match(SPLIT_CSS, /\.split-master\s*\{[^}]*flex:\s*0 0 var\(--split-master-w/)
  assert.match(SPLIT_CSS, /\.split-detail\s*\{[^}]*flex:\s*1 1 auto/)
  // それぞれ独立スクロール（片方を動かして他方が動かない）
  assert.match(SPLIT_CSS, /\.split-master\s*\{[^}]*overflow-y:\s*auto/)
  assert.match(SPLIT_CSS, /\.split-detail\s*\{[^}]*overflow-y:\s*auto/)
})

test('CSS: 左ペインの幅は Review 380px / Tasks 360px（SPEC §7.2）', () => {
  assert.match(css, /\.split-layout\.review\s*\{\s*--split-master-w:\s*380px/)
  assert.match(css, /\.split-layout\.tasks\s*\{\s*--split-master-w:\s*360px/)
})

test('JS と CSS の閾値が一致する（820px）', () => {
  assert.equal(SPLIT_QUERY, '(min-width: 820px)')
  assert.ok(css.includes('@media (min-width: 820px)'), 'CSS 側の閾値が 820px でない')
})

test('820px 未満では 2 ペインにしない（390px は今までどおり 1 ペイン）', () => {
  // node には window が無い = 幅不明。既定は 1 ペイン（シートの全画面被せ）
  assert.equal(isSplitLayout(), false)
})
