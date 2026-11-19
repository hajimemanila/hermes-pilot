/**
 * 動作中カード（`ArchitectJobBar`）のボタン文字色 — SPEC-UI-POLISH-V22 U1 の機械検証。
 *
 * 直したかった不具合:
 *   `.job-bar-btn` の素の文字色は `--on-accent`（アクセント面用の暗いインク）。
 *   Dopamine は面だけを `--vibe-btn-bg`（Dark: #14485a→#0b2a38 の暗いグラデーション）に
 *   差し替えるため、Dark × Dopamine では暗い面に #04191c が乗って **1.2〜1.8:1** まで落ち、
 *   ボタンの文字が読めなかった。
 *   さらに Dopamine の面ルール（特異度 0,5,1）が `.job-bar.failed .job-bar-btn`（0,3,0）に
 *   勝つ位置にあったので、`:not(.failed)` で除外しないと「失敗カードの赤面＋白文字」を潰す。
 *
 * ここでは「宣言が書いてある」だけでなく **実際の色トークンを合成してコントラスト比を計算する**
 * （スクショでは Light / Dark を 1 枚ずつしか撮れないので、4 組合せは数値で固定する）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const CSS_PATH = path.resolve(import.meta.dirname, '../src/styles.css')
const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 平坦な CSS を `{ selector, body }` に割る（入れ子・@media の中身も規則として拾える）。 */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, ' '),
  body: m[2],
}))

/** 1 宣言を取る（無ければ null）。 */
function decl(body, prop) {
  for (const part of body.split(';')) {
    const at = part.indexOf(':')
    if (at === -1) continue
    if (part.slice(0, at).trim().toLowerCase() === prop) return part.slice(at + 1).trim()
  }
  return null
}

/** セレクタ一致で最初の規則を返す（無ければ落とす）。 */
function rule(selector) {
  const found = RULES.find((r) => r.selector === selector)
  assert.ok(found, `セレクタが見つからない: ${selector}`)
  return found
}

/** `--name: value;` を集める。 */
function tokensOf(selector) {
  const body = rule(selector).body
  const out = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim()
  return out
}

/** `#rgb` / `#rrggbb` / `rgb()` / `rgba()` を `{ rgb, a }` に。 */
function parseColor(text) {
  const t = String(text).trim()
  const hex = t.match(/#([0-9a-f]{3,8})/i)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1].slice(0, 6)
    assert.match(h, /^[0-9a-f]{6}$/i, `色として読めない: ${text}`)
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 }
  }
  const fn = t.match(/rgba?\(([^)]+)\)/i)
  assert.ok(fn, `色として読めない: ${text}`)
  const [r, g, b, a] = fn[1].split(',').map((v) => parseFloat(v))
  return { rgb: [r, g, b], a: a === undefined ? 1 : a }
}

/** グラデーション文字列から色を順に拾う。 */
function gradientStops(value) {
  assert.ok(value, 'グラデーションが未定義')
  const out = [...value.matchAll(/#[0-9a-f]{3,8}|rgba?\([^)]+\)/gi)].map((m) => parseColor(m[0]))
  assert.ok(out.length >= 2, `グラデーションの色が 2 つ未満: ${value}`)
  return out
}

/** 半透明の色を面の上に重ねた実効色。 */
function over(color, base) {
  if (color.a >= 1) return color.rgb
  return color.rgb.map((c, i) => c * color.a + base[i] * (1 - color.a))
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
function contrast(fg, bg) {
  const la = luminance(fg)
  const lb = luminance(bg)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** テーマ + Dopamine のトークンを 1 つに畳む（カスケード順: theme → vibe）。 */
const DARK_VIBE = { ...tokensOf(':root'), ...tokensOf("html[data-vibe='dopamine']") }
const LIGHT_VIBE = {
  ...tokensOf("html[data-theme='light']"),
  ...tokensOf("html[data-vibe='dopamine'][data-theme='light']"),
}
const THEMES = [
  ['Dark', DARK_VIBE],
  ['Light', LIGHT_VIBE],
]

/** テーマごとの「`--vibe-btn-bg` 面」を不透明色で表したもの。 */
function faces(theme) {
  const surface = parseColor(theme['--surface']).rgb
  return gradientStops(theme['--vibe-btn-bg']).map((stop) => over(stop, surface))
}

const JOB_FACE_SELECTOR =
  "html[data-vibe='dopamine'] .job-bar:not(.failed) .job-bar-btn:not(:disabled)"

test('Dopamine の動作中カードは、面を --vibe-btn-bg にしても文字色 --text を明示する', () => {
  const job = rule(JOB_FACE_SELECTOR)
  assert.equal(decl(job.body, 'background'), 'var(--vibe-btn-bg)')
  assert.equal(decl(job.body, 'color'), 'var(--text)')
  // 面ルールはすべての Dopamine 配色で共通（Dark / Light の差はトークン側だけ）
  assert.equal(decl(job.body, 'border-color'), 'var(--vibe-border)')
})

test('Dark / Light × Dopamine: 動作中カードの文字は 4.5:1 以上', () => {
  for (const [name, theme] of THEMES) {
    const fg = parseColor(theme['--text']).rgb
    for (const face of faces(theme)) {
      const ratio = contrast(fg, face)
      assert.ok(ratio >= 4.5, `${name} Dopamine: --text on --vibe-btn-bg = ${ratio.toFixed(2)}:1 < 4.5:1`)
    }
  }
})

test('退行ガード: 素の --on-accent は Dark の --vibe-btn-bg 面で 3:1 すら無い（だから明示が必要）', () => {
  const fg = parseColor(DARK_VIBE['--on-accent']).rgb
  for (const face of faces(DARK_VIBE)) {
    const ratio = contrast(fg, face)
    assert.ok(ratio < 3, `--on-accent が面上で ${ratio.toFixed(2)}:1 になっている。前提が変わったのでこのテストの意図を見直す`)
  }
})

test('失敗カードの「赤面＋白文字」は Dopamine の面ルールに上書きされない', () => {
  const failed = rule('.job-bar.failed .job-bar-btn')
  assert.match(decl(failed.body, 'background'), /--danger-grad/, '失敗は赤グラデーション面を維持する')
  assert.equal(decl(failed.body, 'color'), '#fff')

  // Dopamine 側で job-bar ボタンの色/面を塗る規則は、必ず .failed を除外していること。
  const painters = RULES.filter(
    (r) =>
      r.selector.includes("data-vibe='dopamine'") &&
      r.selector.includes('.job-bar-btn') &&
      (decl(r.body, 'color') || decl(r.body, 'background')),
  )
  assert.ok(painters.length > 0, 'Dopamine の job-bar ボタン面ルールが消えている（この検査が空振りする）')
  for (const r of painters) {
    assert.match(
      r.selector,
      /\.job-bar:not\(\.failed\)/,
      `Dopamine の面ルールが失敗カードにも当たる: ${r.selector}`,
    )
  }

  // 実効値: 白文字 on 赤面。Dark の明るい側 #d1584c がボトルネック（4.03:1）。
  for (const [name, theme] of THEMES) {
    const white = [255, 255, 255]
    for (const face of gradientStops(theme['--danger-grad']).map((s) => over(s, white))) {
      const ratio = contrast(white, face)
      assert.ok(ratio >= 4, `${name} 失敗カード: #fff on --danger-grad = ${ratio.toFixed(2)}:1 < 4:1`)
    }
  }
})

test('隣接コントロール（seed-seg / receipt / spec-banner ghost）に同じ文字色漏れが無い', () => {
  // 面だけを差し替える規則に color を書かない（素の規則の文字色を残す = 漏れを作らない）
  const faceRule = RULES.find(
    (r) =>
      r.selector.includes('.seed-seg-btn:not(.on):not(:disabled)') &&
      r.selector.includes('.receipt-btn:not(.primary):not(:disabled)'),
  )
  assert.ok(faceRule, '--vibe-btn-bg を当てる隣接コントロールの規則が見つからない')
  assert.equal(decl(faceRule.body, 'background'), 'var(--vibe-btn-bg)')
  assert.equal(decl(faceRule.body, 'color'), null, '面ルールで color を塗ると素の文字色が消える')

  // 素の規則がテーマ追随の文字色を明示している
  assert.equal(decl(rule('.seed-seg-btn').body, 'color'), 'var(--text)')
  assert.equal(decl(rule('.receipt-btn').body, 'color'), 'var(--text)')

  // ghost は素が --accent（Light の白面で 3.3〜3.7:1）。Dopamine では --accent-2 に寄せる。
  assert.equal(decl(rule('.spec-banner-btn.ghost').body, 'color'), 'var(--accent)')
  const ghost = RULES.find(
    (r) =>
      r.selector === "html[data-vibe='dopamine'] .spec-banner-btn.ghost:not(:disabled)" &&
      decl(r.body, 'color'),
  )
  assert.ok(ghost, 'Dopamine の ghost 文字色上書きが無い')
  assert.equal(decl(ghost.body, 'color'), 'var(--accent-2, var(--accent))')

  for (const [name, theme] of THEMES) {
    const worst = faces(theme).map((face) => ({
      face,
      text: contrast(parseColor(theme['--text']).rgb, face),
      ghost: contrast(parseColor(theme['--accent-2']).rgb, face),
    }))
    const minText = Math.min(...worst.map((w) => w.text))
    const minGhost = Math.min(...worst.map((w) => w.ghost))
    assert.ok(minText >= 4.5, `${name} Dopamine: seed-seg / receipt の --text = ${minText.toFixed(2)}:1`)
    assert.ok(minGhost >= 4.5, `${name} Dopamine: ghost の --accent-2 = ${minGhost.toFixed(2)}:1`)
  }
})
