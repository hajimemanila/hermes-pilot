/**
 * 実行中ドットの色抜けの自動検証（SPEC-ver-0-2-1 §2.1）。
 *
 * `.working-dot` の `hm-working-pulse` が要素全体の不透明度を 1 → 0.45 に動かしていたため、
 * 背景色（`var(--accent)`）ごと薄くなり、暗い面では黒く見えていた。
 * 直したあとは **色は固定・外側リングだけを明滅** させる。見た目が戻ったらここで落ちる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const css = fs
  .readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** セレクタ 1 つの宣言ブロック（行頭一致・`.a .b` を `.b` と誤認しない）。 */
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`)
  assert.notEqual(at, -1, `${selector} の規則が無い`)
  const end = css.indexOf('}', at)
  assert.notEqual(end, -1, `${selector} のブロックが閉じていない`)
  return css.slice(at, end)
}

/** `@keyframes <name>` のブロックを波括弧の対応で切り出す（入れ子の % ブロックを含む）。 */
function keyframes(name) {
  const at = css.indexOf(`@keyframes ${name}`)
  assert.notEqual(at, -1, `@keyframes ${name} が無い`)
  const open = css.indexOf('{', at)
  assert.notEqual(open, -1, `@keyframes ${name} のブロックが開いていない`)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  assert.fail(`@keyframes ${name} のブロックが閉じていない`)
}

test('@keyframes hm-working-pulse に opacity が 1 回も出現しない', () => {
  const block = keyframes('hm-working-pulse')
  assert.doesNotMatch(block, /opacity/i, '要素全体を薄くすると暗い面で黒く見える')
})

test('明滅はリング（box-shadow）だけで動かし、0%/50%/100% を持つ', () => {
  const block = keyframes('hm-working-pulse')
  assert.match(block, /0%,\s*100%\s*\{/, '0%/100% の区間が無い')
  assert.match(block, /50%\s*\{/, '50% の区間が無い')
  const shadows = block.match(/box-shadow:/g) || []
  assert.ok(shadows.length >= 2, 'リングの明滅（box-shadow）が 2 箇所以上に無い')
})

test('.working-dot は色を固定したままアニメを当てる', () => {
  const dot = rule('.working-dot')
  assert.match(dot, /background:\s*var\(--accent\)/, '背景色が accent でない')
  assert.doesNotMatch(dot, /opacity/, '.working-dot 側でも薄くしていない')
  assert.match(dot, /animation:\s*hm-working-pulse/, 'アニメが当たっていない')
})

test('他タブの .dot.running と同じ見え方（accent ベタ＋淡いリング）', () => {
  const dot = rule('.dot.running')
  assert.match(dot, /background:\s*var\(--accent\)/)
  assert.match(dot, /box-shadow:/)
})
