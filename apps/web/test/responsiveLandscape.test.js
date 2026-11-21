/**
 * 横向き・safe-area・低い高さの自動検証（SPEC-i18n-resp §2 B4 / 決定 Q3=A）。
 *
 * 人に見てもらうのは「実機で綺麗か」だけで、ここで見るのは壊れたら必ず落ちる構造:
 *
 * - manifest: `orientation` が `portrait` 固定だとインストール版が回らない（PWA の唯一の門番）
 * - CSS: 左右の safe-area トークン（`--safe-l` / `--safe-r`）が `:root` にあり、
 *   `viewport-fit=cover` を使っている以上、`.app` と固定の被せ物（`.sheet`）がそれを使っている
 * - CSS: `@media (max-height: 430px)`（横向きスマホ）で `--nav-h` を詰めている
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readStyles } from './helpers/styles.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'))
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
const rawCss = readStyles()
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** セレクタ直後の `{ … }`（入れ子なし前提）。 */
function block(source, selector) {
  const at = source.indexOf(selector)
  assert.notEqual(at, -1, `${selector} が見つからない`)
  const open = source.indexOf('{', at)
  const close = source.indexOf('}', open)
  assert.ok(open !== -1 && close !== -1, `${selector} のブロックが閉じていない`)
  return source.slice(open + 1, close)
}

/** `@media <query> { … }` の中身。 */
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
  throw new Error(`@media ${query} が閉じていない`)
}

test('manifest: orientation は any（インストール版が横向きに回れる）', () => {
  assert.equal(manifest.orientation, 'any')
  // display_override はそのまま残す（minimal-ui の退行防止）
  assert.deepEqual(manifest.display_override, ['standalone', 'minimal-ui'])
})

test('index.html: viewport-fit=cover がある（無いと env(safe-area-*) が常に 0）', () => {
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/)
})

test('CSS: :root に左右の safe-area トークンがある', () => {
  const root = block(css, ':root {')
  assert.match(root, /--safe-l:\s*env\(safe-area-inset-left,\s*0px\)/)
  assert.match(root, /--safe-r:\s*env\(safe-area-inset-right,\s*0px\)/)
})

test('CSS: 左右の safe-area を足すのは .app（通常画面）と .sheet（固定の被せ物）だけ', () => {
  // `.app` が左右を持つ = 子で二重に足さない前提が守られていること
  const app = block(css, '.app {')
  assert.match(app, /padding:\s*var\(--safe-t\)\s+var\(--safe-r\)\s+0\s+var\(--safe-l\)/)

  // 固定配置のシートは `.app` の padding の外なので自前で持つ
  const sheet = block(css, '.sheet {')
  assert.match(sheet, /padding:\s*0\s+var\(--safe-r\)\s+var\(--safe-b\)\s+var\(--safe-l\)/)

  // 2 ペインは `.app` の内側なので左右を足さない（足すと 2 倍になる）
  const split = mediaBlock(css, '(min-width: 820px)')
  for (const cls of ['.split-master', '.split-detail']) {
    const body = block(split, `${cls} {`)
    assert.ok(!/--safe-l|--safe-r/.test(body), `${cls} が左右 safe-area を二重に足している`)
    assert.match(body, /var\(--safe-b\)/) // 上下はスクロール末尾に要る
  }
})

test('CSS: 横向きスマホ（max-height: 430px）でナビとトップバーを詰めている', () => {
  const low = mediaBlock(css, '(max-height: 430px)')
  assert.match(low, /--nav-h:\s*48px/)
  assert.match(low, /\.topbar\s*\{[^}]*height:\s*40px/)
  assert.match(low, /\.sheet-head\s*\{/)
  // 左右の safe-area をここでも足すと 2 倍になる
  assert.ok(!/--safe-l|--safe-r/.test(low), 'max-height ブロックが左右 safe-area を足している')
})
