/**
 * スタイルの分割（`src/styles.css` = manifest）が壊れていないことの機械検証。
 *
 * 7,000 行の 1 ファイルに追記し続けるのをやめ、`src/styles/*.css` を意味単位で
 * 並べる構成にした。守るべき契約は 3 つだけ:
 *
 *  1. `src/styles.css` はコメントと `@import` だけでできている（規則を書き戻さない）
 *  2. `@import` の参照先が実在し、読み込み順が manifest の記述順である
 *  3. 分割後の各ファイルは上限行数（ratchet の `maxLines`）を超えない
 *
 * 3 が無いと、また 1 ファイルが育って同じ問題に戻る。上限は
 * `scripts/coherence-baseline.json` の `maxLines` を正本にする（二重管理しない）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { readStyles } from './helpers/styles.js'

const SRC = path.resolve(import.meta.dirname, '../src')
const ROOT = path.resolve(import.meta.dirname, '../../..')
const MANIFEST = path.join(SRC, 'styles.css')
const manifest = fs.readFileSync(MANIFEST, 'utf8')
const imports = [...manifest.matchAll(/@import\s+'([^']+)';/g)].map((m) => m[1])

test('styles.css は @import の manifest（規則を持たない）', () => {
  const bare = manifest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import\s+'[^']+';/g, '')
  assert.equal(bare.trim(), '', `manifest に @import 以外の中身がある: ${bare.trim().slice(0, 120)}`)
  assert.ok(imports.length >= 10, `@import が ${imports.length} 件しかない（分割が巻き戻っている）`)
})

test('@import はすべて実在し、順序どおりに展開される', () => {
  for (const rel of imports) {
    assert.ok(fs.existsSync(path.resolve(SRC, rel)), `参照先が無い: ${rel}`)
  }
  const css = readStyles()
  // 先頭のトークン定義が最初、末尾のファイルが最後に来る（カスケード順の担保）
  const first = readStyles(imports[0])
  // 末尾は入れ子 manifest かもしれない（styles/autopilot.css）ので、生のファイルではなく展開後で比べる
  const last = readStyles(imports[imports.length - 1])
  assert.ok(css.indexOf(first.slice(-200)) < css.indexOf(last.slice(-200)), '展開順が manifest と違う')
})

test('分割後の各ファイルは ratchet の上限行数を超えない', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/coherence-baseline.json'), 'utf8'))
  const max = baseline.maxLines
  for (const rel of imports) {
    const file = path.resolve(SRC, rel)
    const lines = fs.readFileSync(file, 'utf8').split('\n').length
    assert.ok(lines <= max, `${rel} が ${lines} 行（上限 ${max}）。意味単位でさらに分割する`)
  }
})

test('テーマトークンは 1 か所（tokens.css）だけに置く', () => {
  const withRoot = imports.filter((rel) =>
    /^:root\s*\{/m.test(fs.readFileSync(path.resolve(SRC, rel), 'utf8')),
  )
  assert.deepEqual(withRoot, [imports[0]], `:root を持つファイル: ${withRoot.join(', ')}`)
})

test('review.css の設問・選択肢は長大な無空白文字列でも横にはみ出さない', () => {
  const css = fs.readFileSync(path.resolve(SRC, 'styles/review.css'), 'utf8')
  assert.match(css, /\.ak-q-no\s*\{[^}]*flex-shrink:\s*0/)
  assert.match(css, /\.ak-q-text\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/)
  assert.match(css, /\.ak-opt-detail\s*\{[^}]*overflow-wrap:\s*anywhere/)
})
