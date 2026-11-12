import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROFILE,
  DEFAULT_PROFILE_MARK,
  STORED_PROFILE_KEY,
  applyDefaultProfile,
} from '../src/lib/profile.js'

/** localStorage 相当（テスト用の最小実装）。 */
function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

test('既定プロファイルは mobile（sheets/mobile-profile-01-1 Q4=A）', () => {
  assert.equal(DEFAULT_PROFILE, 'mobile')
  assert.equal(STORED_PROFILE_KEY, 'hm.storedProfile', '保存キーは従来のまま（既存端末を読む）')
})

test('移行は「前の既定の選択」を1回だけ捨てる', () => {
  const s = fakeStorage({ [STORED_PROFILE_KEY]: 'default' })
  assert.equal(applyDefaultProfile(s), true, '初回は移行する')
  assert.equal(s.getItem(STORED_PROFILE_KEY), null, '保存済みの選択を消す')
  assert.equal(s.getItem(DEFAULT_PROFILE_MARK), DEFAULT_PROFILE, '目印を立てる')
})

test('移行後は利用者の選択を尊重する（2回目以降は何もしない）', () => {
  const s = fakeStorage({ [DEFAULT_PROFILE_MARK]: DEFAULT_PROFILE, [STORED_PROFILE_KEY]: 'default' })
  assert.equal(applyDefaultProfile(s), false)
  assert.equal(s.getItem(STORED_PROFILE_KEY), 'default', '自分で選び直した値は消さない')
})

test('保存が空・壊れていても起動を止めない', () => {
  const s = fakeStorage()
  assert.equal(applyDefaultProfile(s), true, '目印が無ければ移行（消す対象も無い）')
  assert.equal(applyDefaultProfile(null), false, 'storage が無い')
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {},
    removeItem: () => {},
  }
  assert.equal(applyDefaultProfile(broken), false, '例外は握って false')
})
