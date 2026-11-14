/**
 * Light テーマのコントラスト比の自動検証（SPEC §7.1 / Batch T5 受入条件）。
 *
 * - Light: `--text` は 7:1 以上、`--muted` は 4.5:1 以上（`--bg` / `--bg-elev` / `--surface` 相手）
 * - Dark も同じ基準を満たすこと（既定テーマの退行防止）
 * - 両テーマでトークン名が揃っていること（Light 側の定義漏れは
 *   `var(--text-dim, #9fb3b0)` のような暗色フォールバックが漏れる原因になる）
 *
 * 視覚確認（スクショ）と違い、これは数値の機械検査。色を変えたら必ずここが落ちる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const CSS_PATH = path.resolve(import.meta.dirname, '../src/styles.css')

/** コメントを落とす（`/* … *\/`）。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** セレクタ直後の `{ … }` を取り出す（入れ子は無い前提）。 */
function block(css, selector) {
  const at = css.indexOf(selector)
  assert.notEqual(at, -1, `${selector} が見つからない`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  assert.ok(open !== -1 && close !== -1, `${selector} のブロックが閉じていない`)
  return css.slice(open + 1, close)
}

/** `--name: value;` を拾う。 */
function tokens(body) {
  const out = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim()
  return out
}

/** `#rrggbb` / `#rgb` を [r,g,b] に。 */
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  assert.match(full, /^[0-9a-f]{6}$/i, `色として読めない: ${hex}`)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

/** 相対輝度（WCAG 2.x）。 */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** コントラスト比。 */
function contrast(a, b) {
  const la = luminance(hexToRgb(a))
  const lb = luminance(hexToRgb(b))
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const css = stripComments(fs.readFileSync(CSS_PATH, 'utf8'))
const dark = tokens(block(css, ':root {'))
const light = tokens(block(css, "html[data-theme='light'] {"))

/** SPEC §7.1 の表にあるトークン（両テーマで必ず定義されていること）。 */
const SPEC_TOKENS = ['--bg', '--bg-elev', '--surface', '--text', '--muted', '--line', '--accent', '--warn', '--bad']

test('SPEC §7.1 の表のトークンが Dark / Light の両方で定義されている', () => {
  for (const name of SPEC_TOKENS) {
    assert.ok(dark[name], `Dark に ${name} が無い`)
    assert.ok(light[name], `Light に ${name} が無い`)
  }
  // 表の値そのもの（誰かが独断で変えたら落ちる）
  assert.equal(dark['--bg'], '#051319')
  assert.equal(dark['--bg-elev'], '#0a2029')
  assert.equal(dark['--surface'], '#0e2a35')
  assert.equal(dark['--text'], '#e8f4f6')
  assert.equal(dark['--muted'], '#84a5ad')
  assert.equal(dark['--accent'], '#2dd4bf')
  assert.equal(light['--bg'], '#f4f7f8')
  assert.equal(light['--bg-elev'], '#ffffff')
  assert.equal(light['--surface'], '#eef3f5')
  assert.equal(light['--text'], '#0f242a')
  assert.equal(light['--muted'], '#526d75')
  assert.equal(light['--accent'], '#0d9488')
})

test('Light: --text は 7:1 以上、--muted は 4.5:1 以上', () => {
  const text = light['--text']
  const muted = light['--muted']
  for (const bgName of ['--bg', '--bg-elev', '--surface']) {
    const bg = light[bgName]
    const cText = contrast(text, bg)
    const cMuted = contrast(muted, bg)
    assert.ok(cText >= 7, `Light ${text} on ${bgName}(${bg}) = ${cText.toFixed(2)}:1 < 7:1`)
    assert.ok(cMuted >= 4.5, `Light ${muted} on ${bgName}(${bg}) = ${cMuted.toFixed(2)}:1 < 4.5:1`)
  }
})

test('Dark: --text は 7:1 以上、--muted は 4.5:1 以上（既定テーマの退行防止）', () => {
  for (const bgName of ['--bg', '--bg-elev', '--surface']) {
    const bg = dark[bgName]
    assert.ok(contrast(dark['--text'], bg) >= 7, `Dark --text on ${bgName} が 7:1 未満`)
    assert.ok(contrast(dark['--muted'], bg) >= 4.5, `Dark --muted on ${bgName} が 4.5:1 未満`)
  }
})

test('Light ブロックは色トークンをすべて上書きしている（暗色フォールバック漏れ防止）', () => {
  // レイアウト用（--nav-h / --safe-*）は色ではないので :root だけにある
  const LAYOUT = new Set(['--nav-h', '--safe-b', '--safe-t', '--safe-l', '--safe-r'])
  const missing = Object.keys(dark).filter((name) => !LAYOUT.has(name) && !light[name])
  assert.deepEqual(missing, [], `Light に無いトークン: ${missing.join(', ')}`)
})
