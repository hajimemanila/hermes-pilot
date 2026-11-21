/**
 * WorkerFeed 実行ログの 2 列 2 段グリッド（SPEC-UI-POLISH-V22 D67）の機械検証。
 *
 * `.ak-worker-row` はかつて `grid-template-columns: 40px 62px 1fr` の 3 列固定で、
 * `kanban_comment` / `kanban_complete` / `execute_code` のような長いツール名が 62px 列から
 * はみ出して右隣の `.ak-worker-text` と重なっていた。いまは時刻だけ固定幅の 2 列 2 段
 * （1 行目 = 時刻 + ツール名 / 2 行目 = 本文）で、ツール名と本文は同じ列を共有する。
 * 3 列に戻す・`min-width: 0` を外すとここで落ちる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readStyles } from './helpers/styles.js'

const css = readStyles()
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** セレクタ 1 つの宣言ブロック（行頭一致・`.a .b` を誤認しない）。 */
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`)
  assert.notEqual(at, -1, `${selector} の規則が無い`)
  const end = css.indexOf('}', at)
  assert.notEqual(end, -1, `${selector} のブロックが閉じていない`)
  return css.slice(at, end)
}

/** `prop: value` の値（無ければ null）。 */
function decl(block, prop) {
  const m = block.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

test('.ak-worker-row は時刻 42px + 可変 1 列の 2 列グリッド', () => {
  const row = rule('.ak-worker-row')
  assert.equal(decl(row, 'display'), 'grid')
  assert.equal(decl(row, 'grid-template-columns'), '42px minmax(0, 1fr)')
})

test('.ak-worker-row は 62px の固定ツール名列を持たない（重なりの真因の再発防止）', () => {
  const row = rule('.ak-worker-row')
  assert.ok(!/62px/.test(row), '旧 62px 固定列が戻っている')
  assert.ok(!/1fr\s*;/.test(decl(row, 'grid-template-columns') || ''), '3 列目の 1fr が戻っている')
})

test('.ak-worker-tag は 2 列目 1 行目で縮み、長いツール名は省略記号で切れる', () => {
  const tag = rule('.ak-worker-tag')
  assert.equal(decl(tag, 'grid-column'), '2')
  assert.equal(decl(tag, 'grid-row'), '1')
  assert.equal(decl(tag, 'min-width'), '0')
  assert.equal(decl(tag, 'overflow'), 'hidden')
  assert.equal(decl(tag, 'text-overflow'), 'ellipsis')
  assert.equal(decl(tag, 'white-space'), 'nowrap')
})

test('.ak-worker-text は 2 列目 2 行目に落ち、長い語も折り返す', () => {
  const text = rule('.ak-worker-text')
  assert.equal(decl(text, 'grid-column'), '2')
  assert.equal(decl(text, 'grid-row'), '2')
  assert.equal(decl(text, 'min-width'), '0')
  assert.equal(decl(text, 'overflow-wrap'), 'anywhere')
})

test('.ak-worker-time は 1 列目 1 行目', () => {
  const time = rule('.ak-worker-time')
  assert.equal(decl(time, 'grid-column'), '1')
  assert.equal(decl(time, 'grid-row'), '1')
})

test('ツール行の色分け（.ak-worker-row.tool .ak-worker-tag）は残っている', () => {
  const tool = rule('.ak-worker-row.tool .ak-worker-tag')
  assert.match(tool, /color:\s*var\(--warn\)/)
})
