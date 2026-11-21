/**
 * コックピット計器盤（`.telemetry`）の 1 行固定の機械検証（SPEC-PILOT-V10 §V10-B4）。
 *
 * 390px 幅で 🔔 判断待ちのピルが 1 枚増えると 4 枚目（💎 キャッシュ燃費）が 2 行目へ落ち、
 * 計器盤の高さが 46px → 74px に伸びて下の一覧が 28px ずれる（実測）。
 * 折り返しを禁じて横スクロールに逃がす、という**構造**が崩れたらここで落とす:
 *
 * - `flex-wrap: nowrap`（`wrap` に戻すと 2 行目が出る）
 * - `overflow-x: auto|scroll` + スクロールバー非表示（はみ出しをページへ漏らさない）
 * - `overflow-y: hidden`（縦は常に切る。`visible` のままだと片軸だけ auto で
 *   縦スクロールが生まれ、44px の当たり判定が切られ得る）
 * - `padding` の上下 >= 10px（ピル 25px + 上下 10px = 45px で監査の 44px を満たす）
 * - `.t-tool` の省略（長いツール名で 1 行が伸びない）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readStyles } from './helpers/styles.js'

const raw = readStyles()
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/** セレクタ直後の `{ … }`（入れ子なし前提）。 */
function block(source, selector) {
  const at = source.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `${selector} が見つからない`)
  const open = source.indexOf('{', at)
  const close = source.indexOf('}', open)
  assert.ok(open !== -1 && close !== -1, `${selector} のブロックが閉じていない`)
  return source.slice(open + 1, close)
}

/** 宣言 `prop: value` の値を取る（無ければ null）。 */
function decl(body, prop) {
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body)
  return m ? m[1].trim() : null
}

const telemetry = block(css, '.telemetry')

test('.telemetry は折り返さない（1 行固定）', () => {
  assert.equal(decl(telemetry, 'flex-wrap'), 'nowrap')
  assert.equal(decl(telemetry, 'flex'), 'none', '空きを詰めて縮まないよう flex: none を保つ')
})

test('.telemetry のはみ出しは横スクロールで受ける（ページへ漏らさない）', () => {
  const ox = decl(telemetry, 'overflow-x')
  assert.ok(['auto', 'scroll'].includes(ox), `overflow-x は auto/scroll（実際: ${ox}）`)
  assert.equal(decl(telemetry, 'overflow-y'), 'hidden')
  assert.equal(decl(telemetry, 'scrollbar-width'), 'none', 'スクロールバーは場所を食うので隠す')
})

test('.telemetry の上下 padding は 10px 以上（44px の当たり判定を切らない）', () => {
  const padding = decl(telemetry, 'padding')
  assert.ok(padding, 'padding が未指定')
  const parts = padding.split(/\s+/).map((v) => Number.parseFloat(v))
  assert.ok(parts.every((v) => Number.isFinite(v)), `padding の値を読めない: ${padding}`)
  const top = parts[0]
  const bottom = parts.length >= 3 ? parts[2] : parts[0]
  assert.ok(top >= 10 && bottom >= 10, `上下 padding は 10px 以上（実際: ${top}/${bottom}）`)
})

test('.telemetry のスクロールバーは WebKit 側でも消す', () => {
  const webkit = block(css, '.telemetry::-webkit-scrollbar')
  assert.equal(decl(webkit, 'display'), 'none')
})

test('ツール名は 1 行の中で省略される（実行中ピルが伸び続けない）', () => {
  const tool = block(css, '.t-tool')
  assert.equal(decl(tool, 'overflow'), 'hidden')
  assert.equal(decl(tool, 'text-overflow'), 'ellipsis')
  const maxWidth = decl(tool, 'max-width') || ''
  const vw = Number.parseFloat(maxWidth)
  assert.ok(maxWidth.endsWith('vw') && Number.isFinite(vw), `max-width は vw で書く（実際: ${maxWidth}）`)
  assert.ok(vw <= 26, `22vw 目安。26vw を超えると 390px で実行中ピルが太り 4 枚目が欠ける（実際: ${maxWidth}）`)
})

test('ピル単体の上限があり、4 枚並びでも 390px に収まる幅を保つ', () => {
  const pill = block(css, '.t-pill')
  const maxWidth = decl(pill, 'max-width') || ''
  const vw = Number.parseFloat(maxWidth)
  assert.ok(maxWidth.endsWith('vw') && vw <= 62, `max-width は 62vw 以下（実際: ${maxWidth}）`)
  assert.equal(decl(pill, 'white-space'), 'nowrap')
  // 左右 padding 8px（9px だと 4 枚で 7px 溢れて 💎 が欠ける・実測）
  const padding = decl(pill, 'padding') || ''
  const parts = padding.split(/\s+/).map((v) => Number.parseFloat(v))
  if (parts.length >= 2) assert.ok(parts[1] <= 9, `左右 padding は 9px 以下（実際: ${parts[1]}）`)
})
