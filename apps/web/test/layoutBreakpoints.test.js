/**
 * レイアウト境界の一本化（SPEC-i18n-resp §2 B3）の機械検証。
 *
 * これまで 820 が CSS（`styles.css` の `@media`）と JS（`lib/useSplitLayout.js`）に
 * 手書きで 2 つあった。正本を `lib/layout.js` に寄せたので、ここで
 * **CSS の `min-width` の集合 == layout.js の定数集合** を固定する。
 * 3 つ目の境界（例: 700px の `@media`）を足すとこのテストが落ちる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SPLIT_MIN, SPLIT_WIDE_MIN, MASTER_W, query } from '../src/lib/layout.js'

const CSS_PATH = path.resolve(import.meta.dirname, '../src/styles.css')
const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** `@media` の前口（`{` まで）を全部集める。 */
function mediaQueries(source) {
  const out = []
  const re = /@media([^{]+)\{/g
  let m = re.exec(source)
  while (m) {
    out.push(m[1].trim())
    m = re.exec(source)
  }
  return out
}

const queries = mediaQueries(css)

/**
 * `@media …` ブロックの中身（対応する閉じ括弧まで）。
 * @param {string} source コメント除去済みの CSS
 * @param {RegExp} re `@media` にマッチする正規表現
 * @returns {string}
 */
function mediaBlock(source, re) {
  const at = source.search(re)
  assert.notEqual(at, -1, `${re} が無い`)
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

/** `min-width: <n>px` を全部拾う（`min-width: 0` 等の宣言は `@media` の外なので入らない）。 */
const minWidths = new Set()
for (const q of queries) {
  const re = /min-width:\s*(\d+(?:\.\d+)?)px/g
  let m = re.exec(q)
  while (m) {
    minWidths.add(Number(m[1]))
    m = re.exec(q)
  }
}

test('layout.js: 境界の定数は 680 / 820 の 2 本だけ', () => {
  assert.equal(SPLIT_MIN, 680)
  assert.equal(SPLIT_WIDE_MIN, 820)
  assert.equal(query(SPLIT_MIN), '(min-width: 680px)')
  assert.equal(query(SPLIT_WIDE_MIN), '(min-width: 820px)')
})

test('CSS の min-width は layout.js の定数と一致する（3 つ目の境界を作らない）', () => {
  const expected = [SPLIT_MIN, SPLIT_WIDE_MIN].sort((a, b) => a - b)
  const actual = [...minWidths].sort((a, b) => a - b)
  assert.deepEqual(actual, expected, `styles.css の @media min-width: ${actual.join(',')} / layout.js: ${expected.join(',')}`)
})

test('狭い 2 ペイン（680px）のブロックは 820px のブロックより前にある（後勝ちで 820 が効く）', () => {
  const narrow = css.search(new RegExp(`@media\\s*\\(min-width:\\s*${SPLIT_MIN}px\\)`))
  const wide = css.search(new RegExp(`@media\\s*\\(min-width:\\s*${SPLIT_WIDE_MIN}px\\)`))
  assert.notEqual(narrow, -1, '680px の @media が無い')
  assert.notEqual(wide, -1, '820px の @media が無い')
  assert.ok(narrow < wide, '680px のブロックが 820px より後ろにある（820 の値が上書きされる）')
})

test('左ペイン幅は layout.js の MASTER_W と一致する', () => {
  assert.equal(MASTER_W.narrow, 280)
  assert.equal(MASTER_W.wide.review, 380)
  assert.equal(MASTER_W.wide.tasks, 360)
  assert.match(css, new RegExp(`\\.split-layout\\.review\\s*\\{\\s*--split-master-w:\\s*${MASTER_W.wide.review}px`))
  assert.match(css, new RegExp(`\\.split-layout\\.tasks\\s*\\{\\s*--split-master-w:\\s*${MASTER_W.wide.tasks}px`))
  // 狭い帯（680–819）でだけ 280px に落とす
  const narrow = mediaBlock(css, new RegExp(`@media\\s*\\(min-width:\\s*${SPLIT_MIN}px\\)`))
  assert.match(
    narrow,
    new RegExp(`--split-master-w:\\s*${MASTER_W.narrow}px`),
    '狭い 2 ペインの左幅が layout.js の MASTER_W.narrow と違う',
  )
})
