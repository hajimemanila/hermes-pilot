import test from 'node:test'
import assert from 'node:assert/strict'
import { orderProfiles } from '../src/lib/profileOrder.js'

test('並び順: DEFAULT_PROFILE → default → 直近利用順 → 名前順（SPEC §5.3）', () => {
  const profiles = ['zeta', 'alpha', 'default', 'mobile', 'beta']
  const sessions = [
    { profile: 'beta', started_at: 300 },
    { profile: 'zeta', started_at: 200 },
    { profile: 'alpha', started_at: 100 },
  ]
  assert.deepEqual(orderProfiles(profiles, sessions, 'mobile'), ['mobile', 'default', 'beta', 'zeta', 'alpha'])
})

test('既定と default が同じでも重複しない', () => {
  assert.deepEqual(orderProfiles(['default', 'other'], [], 'default'), ['default', 'other'])
})

test('直近利用の記録が無ければ名前順（既定が一覧に無くても混ぜない）', () => {
  assert.deepEqual(orderProfiles(['c', 'a', 'b'], [], 'zzz'), ['a', 'b', 'c'])
})

test('セッションが壊れていても落ちない（profile 無し・時刻なし・重複）', () => {
  const sessions = [
    { profile: 'x', started_at: null },
    { profile: '', started_at: 5 },
    { started_at: 9 },
    { profile: 'y', started_at: 'not-a-number' },
    { profile: 'y', started_at: 50 },
  ]
  assert.deepEqual(orderProfiles(['x', 'y'], sessions, 'x'), ['x', 'y'])
})

test('プロファイル一覧が空なら既定 1 件を返す（シートが空にならない）', () => {
  assert.deepEqual(orderProfiles([], [], 'mobile'), ['mobile'])
  assert.deepEqual(orderProfiles(null, null, 'mobile'), ['mobile'])
})

test('同じ最終活動なら名前順で決まる（順序が揺れない）', () => {
  const sessions = [
    { profile: 'b', started_at: 100 },
    { profile: 'a', started_at: 100 },
  ]
  assert.deepEqual(orderProfiles(['b', 'a'], sessions, 'zz'), ['a', 'b'])
})
