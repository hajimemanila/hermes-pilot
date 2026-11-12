import test from 'node:test'
import assert from 'node:assert/strict'
import { DONE_LIMIT, doneHint, groupItems, isWaiting, nextWaiting } from '../src/lib/akapenView.js'

/** 赤ペン待ち（blocked + label）。 */
const waitingItem = (id) => ({ id, status: 'blocked', akapen: { label: 'akapen-view-01', round: 1 } })
/** 進行中（回答できない）。 */
const activeItem = (id, status) => ({ id, status, akapen: { label: 'x' } })
/** 完了。 */
const doneItem = (id) => ({ id, status: 'done', akapen: { label: 'x' } })

test('isWaiting は blocked かつ label 付きだけを赤ペン待ちとする', () => {
  assert.equal(isWaiting(waitingItem('t1')), true)
  assert.equal(isWaiting({ id: 't2', status: 'blocked', akapen: {} }), false, 'label 無しは待ちではない')
  assert.equal(isWaiting({ id: 't3', status: 'ready', akapen: { label: 'x' } }), false, 'ready は待ちではない')
  assert.equal(isWaiting({ id: 't4', status: 'review', akapen: { label: 'x' } }), false, 'review は回答を受けない')
  assert.equal(isWaiting(null), false)
})

test('groupItems: 判断待ち / 進行中 / 完了 に分かれ、完了は直近 8 件だけ（総数は別に持つ）', () => {
  const items = [
    waitingItem('w1'),
    waitingItem('w2'),
    activeItem('a1', 'ready'),
    activeItem('a2', 'running'),
    { id: 'a3', status: 'blocked', akapen: { label: null } },
    activeItem('r1', 'review'),
    ...Array.from({ length: 10 }, (_, i) => doneItem(`d${i}`)),
  ]
  const g = groupItems(items)

  assert.deepEqual(g.waiting.map((i) => i.id), ['w1', 'w2'])
  assert.deepEqual(g.active.map((i) => i.id), ['a1', 'a2', 'a3', 'r1'])
  assert.equal(g.done.length, DONE_LIMIT, '完了タブは直近 8 件まで')
  assert.equal(g.doneTotal, 10, '総数は偽らない（チップに件数を出さない根拠）')
  assert.deepEqual(g.done.map((i) => i.id), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'])
})

test('groupItems は空・壊れた入力を落とさない', () => {
  assert.deepEqual(groupItems(undefined), { waiting: [], active: [], done: [], doneTotal: 0 })
  assert.deepEqual(groupItems([null, undefined]).waiting, [])
})

test('nextWaiting: 送信後は次を返し、最後の 1 件では null（閉じる）', () => {
  const afterFirst = [activeItem('w1', 'ready'), waitingItem('w2')]
  assert.equal(nextWaiting(afterFirst, 'w1')?.id, 'w2')

  const afterLast = [activeItem('w1', 'ready')]
  assert.equal(nextWaiting(afterLast, 'w1'), null)

  // 取得が古くて回答済みがまだ blocked のままでも、自分自身は開き直さない
  assert.equal(nextWaiting([waitingItem('w1'), waitingItem('w2')], 'w1')?.id, 'w2')
  assert.equal(nextWaiting([waitingItem('w1')], 'w1'), null)
})

test('doneHint は「直近 8 件」しか言わない（件数を偽らない）', () => {
  assert.equal(doneHint(0), '完了はまだありません')
  assert.equal(doneHint(3), '直近 3 件')
  assert.equal(doneHint(10), '直近 8 件')
  assert.equal(doneHint(undefined), '完了はまだありません')
})
