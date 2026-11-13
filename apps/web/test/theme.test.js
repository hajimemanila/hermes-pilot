/**
 * テーマ（Dark / Light / System）の自動検証（SPEC §7.1 / Batch T5 受入条件）。
 *
 * - 既定は Dark、未知値は既定へ
 * - `system` だけが `prefers-color-scheme` に解決される
 * - `<html data-theme>` と `<meta name="theme-color">` が実際に書き換わる
 * - 保存は `localStorage['hm.theme']`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_THEME,
  SYSTEM_QUERY,
  THEME_COLOR,
  THEMES,
  THEME_KEY,
  applyTheme,
  getResolvedTheme,
  getThemePref,
  normalizeTheme,
  resolveTheme,
  setThemePref,
  systemPrefersDark,
} from '../src/lib/theme.js'

/** ブラウザの最小スタブ（document / localStorage / matchMedia）。 */
function stubDom({ stored = null, systemDark = true } = {}) {
  const meta = { attrs: { content: '' }, getAttribute(k) { return this.attrs[k] ?? null }, setAttribute(k, v) { this.attrs[k] = v } }
  const el = { dataset: {}, style: {} }
  const store = new Map()
  if (stored != null) store.set(THEME_KEY, stored)
  globalThis.document = { documentElement: el, querySelector: () => meta }
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.window = { matchMedia: (q) => ({ matches: q === SYSTEM_QUERY ? systemDark : false, addEventListener() {}, removeEventListener() {} }) }
  return { meta, el, store }
}

function clearDom() {
  delete globalThis.document
  delete globalThis.localStorage
  delete globalThis.window
}

test('normalizeTheme: dark/light/system だけを受け、auto は system 扱い、未知は null', () => {
  assert.equal(normalizeTheme('dark'), 'dark')
  assert.equal(normalizeTheme(' Light '), 'light')
  assert.equal(normalizeTheme('SYSTEM'), 'system')
  assert.equal(normalizeTheme('auto'), 'system', 'auto は system と同じ意味で受ける')
  assert.equal(normalizeTheme('blue'), null)
  assert.equal(normalizeTheme(''), null)
  assert.equal(normalizeTheme(null), null)
  assert.deepEqual(THEMES, ['dark', 'light', 'system'])
  assert.equal(DEFAULT_THEME, 'dark', 'SPEC §7.1: 既定は Dark')
})

test('resolveTheme: system だけが端末設定に追従し、明示値は端末設定を無視する', () => {
  assert.equal(resolveTheme('system', { systemDark: true }), 'dark')
  assert.equal(resolveTheme('system', { systemDark: false }), 'light')
  assert.equal(resolveTheme('light', { systemDark: true }), 'light')
  assert.equal(resolveTheme('dark', { systemDark: false }), 'dark')
  assert.equal(resolveTheme(undefined, { systemDark: false }), 'dark', '未設定は Dark')
})

test('systemPrefersDark: matchMedia が無ければ Dark 扱い（既定と同じ）', () => {
  clearDom()
  assert.equal(systemPrefersDark(), true)
  assert.equal(systemPrefersDark({ matches: false }), false)
  assert.equal(systemPrefersDark({ matches: true }), true)
})

test('applyTheme: html[data-theme] と theme-color を書き換える', () => {
  const { meta, el } = stubDom()
  try {
    assert.equal(applyTheme('dark'), 'dark')
    assert.equal(el.dataset.theme, 'dark')
    assert.equal(meta.attrs.content, THEME_COLOR.dark)
    assert.equal(el.style.colorScheme, 'dark')

    assert.equal(applyTheme('light'), 'light')
    assert.equal(el.dataset.theme, 'light')
    assert.equal(meta.attrs.content, THEME_COLOR.light)
    assert.equal(el.style.colorScheme, 'light')
    assert.equal(getResolvedTheme(), 'light')

    // system: 端末がダークならダークへ戻る
    assert.equal(applyTheme('system', { systemDark: true }), 'dark')
    assert.equal(el.dataset.theme, 'dark')
    assert.equal(getThemePref(), 'system', '設定値は system のまま（解決結果とは別）')
  } finally {
    clearDom()
  }
})

test('setThemePref: 保存して即座に反映する（リロード不要）', () => {
  const { el, store } = stubDom({ stored: 'dark' })
  try {
    setThemePref('light')
    assert.equal(store.get(THEME_KEY), 'light')
    assert.equal(el.dataset.theme, 'light')
    setThemePref('bogus')
    assert.equal(store.get(THEME_KEY), 'dark', '未知値は既定に落とす')
  } finally {
    clearDom()
  }
})
