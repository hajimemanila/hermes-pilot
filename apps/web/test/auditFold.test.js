/**
 * 監査ログ折りたたみロジックの自動検証（SPEC-PILOT-V3 §3.4 の受入条件）。
 *
 * - 9 件以上: 既定は最新 8 件のみ、`canExpand` が真、展開で全件
 * - 8 件以下: ボタンを出さない（`canExpand` 偽）・件数はそのまま
 * - 空 / 非配列 / 上限変更でも落ちない
 * - 並び順（新しい順）を保つ
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_PREVIEW_LIMIT, foldAudit } from '../src/lib/auditFold.js'

/** 新しい順の監査ログを作る（`kind` に連番を入れて順序を確認する）。 */
const make = (n) => Array.from({ length: n }, (_, i) => ({ kind: `k${i}`, at: 1000 - i }))

test('既定の上限は 8 件', () => {
  assert.equal(AUDIT_PREVIEW_LIMIT, 8)
})

test('9 件以上のとき既定表示は最新 8 件で、ボタン用の残件数は総数 - 8', () => {
  const list = make(9)
  const r = foldAudit(list)
  assert.equal(r.visible.length, 8)
  assert.deepEqual(
    r.visible.map((x) => x.kind),
    list.slice(0, 8).map((x) => x.kind),
  )
  assert.equal(r.hiddenCount, 1)
  assert.equal(r.canExpand, true)
  assert.equal(r.expanded, false)
})

test('展開すると全件表示になり、残件数はボタン文言用に保たれる', () => {
  const r = foldAudit(make(12), { expanded: true })
  assert.equal(r.visible.length, 12)
  assert.equal(r.hiddenCount, 4)
  assert.equal(r.canExpand, true)
  assert.equal(r.expanded, true)
})

test('8 件以下なら折りたたまない（ボタン非表示）', () => {
  for (const n of [0, 1, 7, 8]) {
    const r = foldAudit(make(n))
    assert.equal(r.visible.length, n, `n=${n}`)
    assert.equal(r.hiddenCount, 0, `n=${n}`)
    assert.equal(r.canExpand, false, `n=${n}`)
  }
})

test('8 件ちょうどで展開フラグが立っていても全件のまま・ボタンは出さない', () => {
  const r = foldAudit(make(8), { expanded: true })
  assert.equal(r.visible.length, 8)
  assert.equal(r.canExpand, false)
  assert.equal(r.expanded, false)
})

test('非配列・undefined でも空配列として扱う', () => {
  for (const v of [null, undefined, 'x', 42, {}]) {
    const r = foldAudit(v)
    assert.deepEqual(r.visible, [], String(v))
    assert.equal(r.canExpand, false, String(v))
  }
})

test('上限を変えても同じ規則で分割する', () => {
  const r = foldAudit(make(30), { limit: 5 })
  assert.equal(r.visible.length, 5)
  assert.equal(r.hiddenCount, 25)
  assert.equal(foldAudit(make(30), { limit: 5, expanded: true }).visible.length, 30)
  // 不正な上限は既定に戻す
  assert.equal(foldAudit(make(30), { limit: 0 }).visible.length, 8)
  assert.equal(foldAudit(make(30), { limit: Number.NaN }).visible.length, 8)
})
