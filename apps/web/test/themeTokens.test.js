/**
 * テーマ（Dark / Light）× Vibe（dopamine / serotonin）の色漏れを機械で止める。
 *
 * 実測した不具合（2026-11-19）:
 * - `.nav-badge` / `.nav-dot` / `.drawer-btn-badge` の縁取りが `rgba(6, 22, 26, .96)` 直書きで、
 *   Light では**黒いリング**になっていた（ナビ面の色はテーマで変わるので縁取りも変える必要がある）
 * - `.t-dot.live` が文字用トークン `--on-warn`（#1d1300）を流用していて、**実行中ドットが両テーマで黒**
 * - `.row-badge` / `.drawer-btn-badge` の文字色が `#06201a` 直書き（Light の緑バッジで沈む）
 * - `.ak-thumb-btn::after`（拡大ラベル）の面が `rgba(6, 22, 26, .78)` 直書き（Light で暗い面＋暗い文字）
 * - `SettingsPane` の PWA 診断の ✓/✗ が inline で `#4ade80` / `#f87171`（Light の白カードで読めない）
 *
 * 直すときは**個別セレクタに色を足さず、トークンか共通規則で直す**（重複の温床）。
 * ここが落ちたら、まず `:root` / `html[data-theme='light']` のトークンを見る。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readStyles } from './helpers/styles.js'

const SRC = path.resolve(import.meta.dirname, '../src')
const RAW = readStyles()
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '')

/** セレクタ 1 つの宣言ブロック（行頭一致）。 */
function rule(selector) {
  const at = CSS.indexOf(`\n${selector} {`)
  assert.notEqual(at, -1, `${selector} の規則が無い`)
  const end = CSS.indexOf('}', at)
  return CSS.slice(at, end)
}

/** `:root` と Light のトークン定義ブロック。 */
function themeBlock(selector) {
  const at = CSS.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `${selector} のブロックが無い`)
  const end = CSS.indexOf('\n}', at)
  return CSS.slice(at, end)
}

test('ナビの縁取りトークン --badge-ring が両テーマで定義される', () => {
  const dark = themeBlock(':root')
  const light = themeBlock("html[data-theme='light']")
  assert.match(dark, /--badge-ring:\s*rgba\(6,\s*22,\s*26/, 'Dark は背景と同じ暗色')
  assert.match(light, /--badge-ring:\s*rgba\(255,\s*255,\s*255/, 'Light はナビ面と同じ白')
})

test('点・バッジの縁取りは --badge-ring 経由（直書きしない）', () => {
  for (const sel of ['.nav-badge', '.nav-dot', '.drawer-btn-badge']) {
    const block = rule(sel)
    assert.match(block, /box-shadow:[^;]*var\(--badge-ring\)/, `${sel} が --badge-ring を使っていない`)
    assert.doesNotMatch(block, /rgba\(6,\s*22,\s*26/, `${sel} に Dark の直書きが残っている`)
  }
})

test('実行中ドットは accent（--on-warn を点の色に流用しない）', () => {
  const block = rule('.t-dot.live')
  assert.match(block, /background:\s*var\(--accent\)/, '.t-dot.live は var(--accent)')
  assert.doesNotMatch(block, /var\(--on-warn\)/, '--on-warn は文字用（点に使うと黒くなる）')
})

test('バッジの文字色は --on-good / --on-accent 経由', () => {
  assert.match(rule('.row-badge'), /color:\s*var\(--on-good\)/)
  assert.match(rule('.row-badge.new'), /color:\s*var\(--on-accent\)/)
  assert.match(rule('.drawer-btn-badge'), /color:\s*var\(--on-good\)/)
})

test('Dark 前提の色を宣言に直書きしない（トークン定義の行だけ許可）', () => {
  const offenders = []
  CSS.split('\n').forEach((line, i) => {
    if (/^\s*--[a-z0-9-]+:/.test(line)) return // トークン定義は OK
    if (/rgba\(\s*6,\s*22,\s*26/.test(line)) offenders.push(`styles.css:${i + 1} ${line.trim()}`)
    if (/#06201a|#04202a|#06181f/i.test(line)) offenders.push(`styles.css:${i + 1} ${line.trim()}`)
  })
  assert.deepEqual(offenders, [], `トークンへ寄せてください:\n${offenders.join('\n')}`)
})

test('JSX の inline style に色を直書きしない', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'demo') continue
        walk(p)
      } else if (entry.name.endsWith('.jsx')) {
        const text = fs.readFileSync(p, 'utf8')
        text.split('\n').forEach((line, i) => {
          if (!/style=\{\{/.test(line)) return
          if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) {
            offenders.push(`${path.relative(SRC, p)}:${i + 1} ${line.trim().slice(0, 90)}`)
          }
        })
      }
    }
  }
  walk(SRC)
  assert.deepEqual(offenders, [], `var(--token) に置き換えてください:\n${offenders.join('\n')}`)
})
