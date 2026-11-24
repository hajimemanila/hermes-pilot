/**
 * 注釈の対象リポジトリ記憶の自動検証（SPEC-ver-0-2-1 §2.1）。
 *
 * 「＋ 注釈」を開くたびに対象リポジトリが空へ戻る不具合の再発防止:
 *
 * - `readReviewRepo` は `hm.reviewRepo` → `hm.repo` → `''` の順に落ちる
 * - `rememberReviewRepo` は `hm.reviewRepo` だけを書き、会話側の `hm.repo` を乗っ取らない
 * - 注釈シートは **id か path** の両方で初期対象を引く（保存は id・`ReadOnlyDetail` からは path が来る）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  REPO_KEY,
  REVIEW_REPO_KEY,
  readReviewRepo,
  rememberReviewRepo,
  rememberRepo,
} from '../src/lib/repoPicker.js'

const here = import.meta.dirname
// 注釈シート（`findTarget` / 対象の記憶）は `review/AnnotationCreate.jsx` へ切り出し済み。
// アサーションは分割前と同じ（2 ファイルを連結して 1 つの読み取り対象として扱う）。
const pane = ['ReviewPane.jsx', 'review/AnnotationCreate.jsx']
  .map((rel) => fs.readFileSync(path.resolve(here, '../src/features', rel), 'utf8')).join('\n')

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

test('REVIEW_REPO_KEY は hm.reviewRepo（会話側の hm.repo と別キー）', () => {
  assert.equal(REVIEW_REPO_KEY, 'hm.reviewRepo')
  assert.notEqual(REVIEW_REPO_KEY, REPO_KEY)
})

test('readReviewRepo: 両キーあり → hm.reviewRepo が勝つ', () => {
  const storage = fakeStorage({ [REVIEW_REPO_KEY]: 'hermes-mobile-pwa', [REPO_KEY]: 'app-launcher' })
  assert.equal(readReviewRepo(storage), 'hermes-mobile-pwa')
})

test('readReviewRepo: hm.repo だけ → そこへ落ちる（初回から空にしない）', () => {
  const storage = fakeStorage({ [REPO_KEY]: 'app-launcher' })
  assert.equal(readReviewRepo(storage), 'app-launcher')
})

test('readReviewRepo: どちらも無し → 空文字', () => {
  assert.equal(readReviewRepo(fakeStorage()), '')
  assert.equal(readReviewRepo(null), '')
})

test('readReviewRepo: 壊れたストレージでも落とさず空文字', () => {
  const broken = {
    getItem() {
      throw new Error('SecurityError')
    },
  }
  assert.equal(readReviewRepo(broken), '')
})

test('rememberReviewRepo: hm.reviewRepo だけを書き、hm.repo は変えない', () => {
  const storage = fakeStorage({ [REPO_KEY]: 'app-launcher' })
  assert.equal(rememberReviewRepo(storage, 'hermes-mobile-pwa'), 'hermes-mobile-pwa')
  assert.deepEqual(storage.dump(), {
    [REPO_KEY]: 'app-launcher',
    [REVIEW_REPO_KEY]: 'hermes-mobile-pwa',
  })
  // 書いた値が次回の初期値になる（往復）
  assert.equal(readReviewRepo(storage), 'hermes-mobile-pwa')
})

test('rememberReviewRepo: 空 id / storage 無し / 拒否では何も壊さない', () => {
  const storage = fakeStorage()
  assert.equal(rememberReviewRepo(storage, ''), '')
  assert.deepEqual(storage.dump(), {})
  assert.equal(rememberReviewRepo(null, 'x'), '')
  const denied = {
    setItem() {
      throw new Error('QuotaExceededError')
    },
  }
  assert.equal(rememberReviewRepo(denied, 'x'), '')
})

test('rememberRepo（会話側）は review のキーを書かない', () => {
  const storage = fakeStorage()
  rememberRepo(storage, { id: 'app-launcher' })
  assert.equal(storage.getItem(REVIEW_REPO_KEY), null)
})

test('注釈シートの初期値は readReviewRepo（空文字固定ではない）', () => {
  assert.match(pane, /useState\(\(\) => readReviewRepo\(\)\)/)
  assert.doesNotMatch(pane, /const \[newTarget, setNewTarget\] = useState\(''\)/)
  // 新規注釈ボタンで対象を捨てない（捨てると毎回選び直しになる）
  assert.doesNotMatch(pane, /haptic\('tap'\)\s*\n\s*setNewTarget\(''\)/)
})

test('対象の照合は id と path の両方（小文字比較）を 1 箇所で行う', () => {
  const at = pane.indexOf('function findTarget(')
  assert.notEqual(at, -1, 'findTarget が無い')
  const body = pane.slice(at, pane.indexOf('\n}\n', at))
  assert.match(body, /x\?\.id \?\? ''\)\.toLowerCase\(\) === w/)
  assert.match(body, /x\?\.path \?\? ''\)\.toLowerCase\(\) === w/)
  // path だけの照合は残さない（id で保存した値が引けなくなる）
  assert.doesNotMatch(pane, /x\.path\.toLowerCase\(\) === String\(initialTarget\)\.toLowerCase\(\)/)
})

test('対象が確定したら rememberReviewRepo に書く', () => {
  assert.match(pane, /rememberReviewRepo\(globalThis\.localStorage, chosen\.id\)/)
})
