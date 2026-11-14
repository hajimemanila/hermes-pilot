/**
 * Spec Launchpad の進捗判定（Q3=A: 全バッチ完了 → ✅ カード → 履歴）。
 *
 * カードの見た目と行き先は `specProgress()` の戻り値だけで決まるため、
 * 「起票済みだが未完走」を完了と誤判定しないことをここで固定する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { batchIdOf, specProgress } from '../src/lib/specProgress.js'

const batches = [{ id: 'B1' }, { id: 'B2' }]
const task = (title, status) => ({ title, status })

test('batchIdOf はタイトル先頭の [ID] だけを拾う', () => {
  assert.equal(batchIdOf('[B1] 縦リスト化'), 'B1')
  assert.equal(batchIdOf('[spec-picker-01] 赤ペン'), 'spec-picker-01')
  assert.equal(batchIdOf('B1 だけのタイトル'), null)
  assert.equal(batchIdOf('前置き [B1] タイトル'), null)
  assert.equal(batchIdOf(null), null)
})

test('未起票なら allFiled / allDone はどちらも false', () => {
  const p = specProgress(batches, [])
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)
  assert.equal(p.byId.size, 0)
})

test('一部だけ起票済みなら全バッチ完了にしない', () => {
  const p = specProgress(batches, [task('[B1] 一', 'done')])
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)
})

test('全バッチ起票済みでも未完了があれば ✅ にしない', () => {
  const tasks = [task('[B1] 一', 'done'), task('[B2] 二', 'running')]
  const p = specProgress(batches, tasks)
  assert.equal(p.allFiled, true)
  assert.equal(p.allDone, false)
})

test('全バッチが done / archived のときだけ ✅ になる', () => {
  const tasks = [task('[B1] 一', 'done'), task('[B2] 二', 'archived')]
  const p = specProgress(batches, tasks)
  assert.equal(p.allFiled, true)
  assert.equal(p.allDone, true)
  assert.equal(p.byId.get('B2')?.status, 'archived')
})

test('バッチが 0 件なら完了を名乗らない', () => {
  const p = specProgress([], [task('[B1] 一', 'done')])
  assert.equal(p.allFiled, false)
  assert.equal(p.allDone, false)
})

test('同じバッチ ID のタスクが複数あっても最初の 1 件だけを見る', () => {
  const p = specProgress([{ id: 'B1' }], [task('[B1] 一', 'done'), task('[B1] 再起票', 'running')])
  assert.equal(p.byId.size, 1)
  assert.equal(p.allDone, true)
})
