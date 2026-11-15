/**
 * スニペット／スタンプ帯の 3 個別表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）の単体検証。
 *
 * 受入: `hm.snippetBars.v1` に `{ chat, annotation, term }` が保存され、未設定時は
 * 3 項目とも `true`。設定タブの切替はリロードなしで他画面へ伝わる（イベント）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SNIPPET_BARS_EVENT,
  SNIPPET_BARS_KEY,
  SNIPPET_BAR_DEFAULTS,
  SNIPPET_BAR_IDS,
  emitSnippetBars,
  isBarVisible,
  normalizeSnippetBars,
  readSnippetBars,
  setSnippetBar,
  subscribeSnippetBars,
  toggleSnippetBar,
  writeSnippetBars,
} from '../src/lib/snippetBars.js'

/** localStorage 相当（getItem/setItem/removeItem だけ）。 */
function fakeStorage(seed) {
  const map = new Map()
  if (seed) for (const [k, v] of Object.entries(seed)) map.set(k, v)
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get raw() {
      return map
    },
  }
}

/** DOM の EventTarget 相当（window の代わり）。 */
function fakeTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) ?? []) fn(ev)
      return true
    },
  }
}

test('未設定なら 3 項目とも true（既定全 ON）', () => {
  const s = fakeStorage()
  assert.deepEqual(readSnippetBars(s), { chat: true, annotation: true, term: true })
  // storage 自体が無くても落ちない
  assert.deepEqual(readSnippetBars(null), SNIPPET_BAR_DEFAULTS)
  assert.deepEqual(normalizeSnippetBars(undefined), SNIPPET_BAR_DEFAULTS)
  assert.deepEqual(Object.keys(SNIPPET_BAR_DEFAULTS).sort(), [...SNIPPET_BAR_IDS].sort())
})

test('壊れた JSON・配列・未知キーは既定へ落ち、boolean 以外は既定を保つ', () => {
  const broken = fakeStorage({ [SNIPPET_BARS_KEY]: '{oops' })
  assert.deepEqual(readSnippetBars(broken), { chat: true, annotation: true, term: true })

  const arr = fakeStorage({ [SNIPPET_BARS_KEY]: '[1,2,3]' })
  assert.deepEqual(readSnippetBars(arr), { chat: true, annotation: true, term: true })

  assert.deepEqual(normalizeSnippetBars({ chat: false, bogus: false }), {
    chat: false,
    annotation: true,
    term: true,
  })
  // 旧形式（文字列・0/1）も読む
  assert.deepEqual(normalizeSnippetBars({ chat: 'false', annotation: 0, term: 'true' }), {
    chat: false,
    annotation: false,
    term: true,
  })
})

test('書き出しは 3 キー揃った JSON を 1 キーに保存する（部分更新は現在値に重ねる）', () => {
  const s = fakeStorage()
  const next = writeSnippetBars({ annotation: false }, s)
  assert.deepEqual(next, { chat: true, annotation: false, term: true })
  assert.equal(s.raw.get(SNIPPET_BARS_KEY), JSON.stringify({ chat: true, annotation: false, term: true }))
  // 以降の部分更新で他のキーが戻らない
  assert.deepEqual(writeSnippetBars({ term: false }, s), { chat: true, annotation: false, term: false })
  assert.deepEqual(JSON.parse(s.raw.get(SNIPPET_BARS_KEY)), { chat: true, annotation: false, term: false })
})

test('setSnippetBar は保存してから hm:snippet-bars を 1 回飛ばす', () => {
  const s = fakeStorage()
  const target = fakeTarget()
  const seen = []
  const off = subscribeSnippetBars((state) => seen.push(state), target)

  const after = setSnippetBar('chat', false, { storage: s, target })
  assert.deepEqual(after, { chat: false, annotation: true, term: true })
  assert.deepEqual(JSON.parse(s.raw.get(SNIPPET_BARS_KEY)), after)
  assert.equal(target.listeners.get(SNIPPET_BARS_EVENT)?.size, 1)
  assert.deepEqual(seen, [{ chat: false, annotation: true, term: true }])

  // 解除後は届かない
  off()
  setSnippetBar('chat', true, { storage: s, target })
  assert.equal(seen.length, 1)
  assert.deepEqual(readSnippetBars(s), { chat: true, annotation: true, term: true })
})

test('toggleSnippetBar は現在値の反転を保存する（3 帯それぞれ独立）', () => {
  const s = fakeStorage()
  const target = fakeTarget()
  assert.deepEqual(toggleSnippetBar('annotation', { storage: s, target }), {
    chat: true,
    annotation: false,
    term: true,
  })
  assert.deepEqual(toggleSnippetBar('term', { storage: s, target }), {
    chat: true,
    annotation: false,
    term: false,
  })
  assert.deepEqual(toggleSnippetBar('annotation', { storage: s, target }), {
    chat: true,
    annotation: true,
    term: false,
  })
})

test('isBarVisible は未知 id を表示扱いにする', () => {
  const state = { chat: false, annotation: true, term: false }
  assert.equal(isBarVisible(state, 'chat'), false)
  assert.equal(isBarVisible(state, 'annotation'), true)
  assert.equal(isBarVisible(state, 'term'), false)
  assert.equal(isBarVisible(state, 'nope'), true)
  assert.equal(isBarVisible(undefined, 'chat'), true)
})

test('他タブの storage 変化も購読できる（key 違いは無視）', () => {
  const target = fakeTarget()
  const seen = []
  subscribeSnippetBars((state) => seen.push(state), target)
  const onStorage = [...(target.listeners.get('storage') ?? [])][0]
  onStorage({ key: 'other.key' })
  assert.equal(seen.length, 0)
  // 実 localStorage を読む経路（テスト環境では未設定＝全 ON）
  onStorage({ key: SNIPPET_BARS_KEY })
  assert.deepEqual(seen, [{ chat: true, annotation: true, term: true }])
})

test('emitSnippetBars は target が無くても例外を投げない', () => {
  assert.doesNotThrow(() => emitSnippetBars({ chat: true, annotation: true, term: true }, null))
})
