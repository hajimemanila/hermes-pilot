/**
 * 「↓ 最新へ」ピルがスニペット帯・入力欄に被らない位置にいることを機械で固定する
 * （spec-chat-jump-pos Q1=A / Q2=A / Q3=A / Q4=A）。
 *
 * これまでは `.pane.chat` 基準の `bottom: 68px` という手計算の固定値だったので、
 * チップ帯の表示/非表示・入力欄の伸長・バナーで帯の高さが変わると被った。
 * いまは `.chat-body`（スクロール領域を包む相対配置の箱）の中にピルが居るので、
 * 下端に何が積まれても位置が変わらない。**その DOM の入れ子をここで固定する**:
 * ピルが `.chat-scroll` の外・`.chat-body` の中に戻ったら落ちる。
 *
 * タイムラインは CSW3-3 で `features/chat/ChatTimeline.jsx` へ移った（ソースの読み先だけ
 * 変えて、期待値は変えない）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readStyles } from './helpers/styles.js'

const SRC = path.resolve(import.meta.dirname, '../src/features/chat/ChatTimeline.jsx')

const jsx = fs.readFileSync(SRC, 'utf8')
const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * `className="<name>"`（完全一致）の要素を開始タグから対応する閉じタグまで切り出す。
 * div の入れ子だけを数える。自己閉じタグ（`<div … />`）は深さに数えない。
 * @param {string} source
 * @param {string} className
 * @returns {string|null}
 */
function elementSlice(source, className) {
  const openAt = source.indexOf(`className="${className}"`)
  if (openAt < 0) return null
  const start = source.lastIndexOf('<', openAt)
  let i = start
  let depth = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) return null
    if (source.startsWith('</div>', lt)) {
      depth -= 1
      i = lt + '</div>'.length
      if (depth === 0) return source.slice(start, i)
      continue
    }
    if (/^<div\b/.test(source.slice(lt, lt + 5))) {
      const gt = source.indexOf('>', lt)
      if (gt < 0) return null
      if (!source.slice(lt, gt).trimEnd().endsWith('/')) depth += 1
      i = gt + 1
      continue
    }
    i = lt + 1
  }
  return null
}

/** CSS の 1 ルール（`selector { … }`）の中身を取り出す。 */
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`)
  if (at < 0) return null
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return close < 0 ? null : css.slice(open + 1, close)
}

const body = elementSlice(jsx, 'chat-body')
const scroll = elementSlice(jsx, 'chat-scroll')

test('ピルは .chat-body の中・.chat-scroll の外に居る（帯や入力欄の高さに左右されない）', () => {
  assert.ok(body, '.chat-body（スクロール領域を包む相対配置の箱）が ChatPane.jsx に無い')
  assert.ok(scroll, '.chat-scroll が ChatPane.jsx に無い')
  assert.ok(body.includes('className="chat-scroll"'), '.chat-scroll が .chat-body の中に無い')
  assert.ok(
    !scroll.includes('chat-jump-bottom'),
    'ピルが .chat-scroll の中に入っている（sticky 化していないなら .chat-body 直下に戻す）',
  )
  assert.ok(body.includes('chat-jump-bottom'), 'ピルが .chat-body の外に居る（bottom の基準が pane に戻る）')
})

test('ピルは .chat-scroll より後ろ（下端側）に置かれている', () => {
  const scrollEnd = body.indexOf('className="chat-scroll"') + scroll.length
  assert.ok(
    body.indexOf('chat-jump-bottom') > scrollEnd,
    'ピルが .chat-scroll より前にある（absolute の基準が箱の上端になる）',
  )
})

test('.chat-body が伸長と相対配置を持ち、.chat-scroll のスクロール設定は残っている', () => {
  const b = rule('.chat-body')
  const s = rule('.chat-scroll')
  assert.ok(b, '.chat-body の CSS ルールが無い')
  assert.match(b, /position:\s*relative/, '.chat-body が position: relative でない（absolute の基準にならない）')
  assert.match(b, /flex:\s*1/, '.chat-body が伸びない（スクロール領域が潰れる）')
  assert.match(b, /min-height:\s*0/, '.chat-body に min-height: 0 が無い（flex 子が縮まない）')
  assert.ok(s, '.chat-scroll の CSS ルールが無い')
  assert.match(s, /flex:\s*1/, '.chat-scroll が箱の中で伸びない')
  assert.match(s, /min-height:\s*0/, '.chat-scroll に min-height: 0 が無い')
  assert.match(s, /overflow-y:\s*auto/, '.chat-scroll がスクロールしない')
})

test('ピルはスクロール領域の下端 8px 内側にあり、当たり判定は 44px（Q2=A / Q3=A）', () => {
  const p = rule('.chat-jump-bottom')
  assert.ok(p, '.chat-jump-bottom の CSS ルールが無い')
  assert.match(p, /position:\s*absolute/)
  assert.match(p, /bottom:\s*8px/, 'bottom が 8px でない（固定値の手計算に戻っていないか）')
  assert.ok(!/bottom:\s*68px/.test(p), 'bottom: 68px の固定値が戻っている（帯の高さが変わるとまた被る）')
  const hit = rule('.chat-jump-bottom::before')
  assert.ok(hit, '当たり判定を広げる .chat-jump-bottom::before が無い')
  assert.match(hit, /height:\s*44px/, '当たり判定が 44px でない（片手で押しにくい）')
  assert.match(hit, /position:\s*absolute/)
  assert.match(hit, /content:\s*(''|"")/, '::before に content が無いと描画されない')
})
