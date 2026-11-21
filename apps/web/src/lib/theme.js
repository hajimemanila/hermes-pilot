/**
 * テーマ（`dark` / `light` / `system`）の核（React 非依存）。
 *
 * - 保存は `HM_STORAGE.THEME`（`contracts/storage.js`）、既定は `dark`（SPEC §7.1）
 * - `system` のときだけ `matchMedia('(prefers-color-scheme: dark)')` を実際の色に解決する
 * - 解決結果は `<html data-theme="dark|light">` と `<meta name="theme-color">` に反映する
 * - React 側（`useTheme`）はこのモジュールの状態を購読するだけなので、
 *   `api.js` のようにフックを使えない場所からも `getThemePref()` を読める
 */

import { HM_STORAGE } from '../contracts/storage.js'

/** `localStorage` のキー。 */
export const THEME_KEY = HM_STORAGE.THEME
/** 選べる値（`system` は端末設定に従う）。 */
export const THEMES = ['dark', 'light', 'system']
/** 既定。SPEC §7.1 は Dark 既定。 */
export const DEFAULT_THEME = 'dark'
/** 実際に適用される色（`system` を解決した結果）。 */
export const RESOLVED = ['dark', 'light']
/** `<meta name="theme-color">` に入れる色（背景トークンと同じ）。 */
export const THEME_COLOR = { dark: '#051319', light: '#f4f7f8' }
/** 端末設定の判定に使うクエリ。 */
export const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

/**
 * 保存値を `dark` / `light` / `system` に正規化する（未知は null）。
 * @param {unknown} value 保存値
 * @returns {'dark'|'light'|'system'|null} 正規化
 */
export function normalizeTheme(value) {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  if (!s) return null
  if (s === 'system' || s === 'auto') return 'system'
  if (s === 'dark' || s === 'light') return s
  return null
}

/**
 * 端末設定がダークか。`matchMedia` が無い環境ではダーク扱い（既定と同じ）。
 * @param {{matches?: boolean}} [mql] MediaQueryList 相当
 * @returns {boolean} ダークなら true
 */
export function systemPrefersDark(mql) {
  if (mql && typeof mql.matches === 'boolean') return mql.matches
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return Boolean(window.matchMedia(SYSTEM_QUERY).matches)
    }
  } catch {
    /* matchMedia が無い/失敗する環境はダーク扱い */
  }
  return true
}

/**
 * 設定値を実際の色に解決する。
 * @param {'dark'|'light'|'system'|unknown} pref 設定値
 * @param {{systemDark?: boolean}} [opts] 端末設定（未指定なら matchMedia を読む）
 * @returns {'dark'|'light'} 適用する色
 */
export function resolveTheme(pref, opts) {
  const p = normalizeTheme(pref) ?? DEFAULT_THEME
  if (p === 'system') {
    const dark = opts && typeof opts.systemDark === 'boolean' ? opts.systemDark : systemPrefersDark()
    return dark ? 'dark' : 'light'
  }
  return p
}

/**
 * 保存されている設定値を読む（未保存・不正・localStorage 不可は既定）。
 * @returns {'dark'|'light'|'system'} 設定値
 */
export function readThemePref() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(THEME_KEY)
    return normalizeTheme(raw) ?? DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

let active = DEFAULT_THEME
let activeResolved = 'dark'
const listeners = new Set()
/** `system` 追従用の MediaQueryList（多重登録しないよう 1 本だけ持つ）。 */
let systemMql = null

function notify() {
  for (const fn of [...listeners]) {
    try {
      fn(activeResolved, active)
    } catch {
      /* 購読者の失敗でテーマ切替を止めない */
    }
  }
}

/**
 * 解決結果を DOM へ反映する（`data-theme` / `theme-color` / `color-scheme`）。
 * @param {'dark'|'light'} resolved 適用する色
 * @returns {'dark'|'light'} 反映した色
 */
export function applyResolved(resolved) {
  const theme = RESOLVED.includes(resolved) ? resolved : 'dark'
  if (typeof document === 'undefined') return theme
  try {
    const el = document.documentElement
    if (el.dataset.theme !== theme) el.dataset.theme = theme
    // ネイティブ UI（スクロールバー・フォーム部品・アドレスバー）も合わせる
    if (el.style.colorScheme !== theme) el.style.colorScheme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    const color = THEME_COLOR[theme]
    if (meta && meta.getAttribute('content') !== color) meta.setAttribute('content', color)
  } catch {
    /* DOM が無い/失敗しても致命的ではない */
  }
  return theme
}

/**
 * 設定値を適用する（`system` は端末設定に解決してから反映）。購読者へは変更時だけ伝える。
 * @param {'dark'|'light'|'system'|unknown} pref 設定値
 * @param {{systemDark?: boolean, silent?: boolean}} [opts] 端末設定・通知抑制
 * @returns {'dark'|'light'} 適用した色
 */
export function applyTheme(pref, opts) {
  const p = normalizeTheme(pref) ?? DEFAULT_THEME
  const resolved = resolveTheme(p, opts)
  const changed = p !== active || resolved !== activeResolved
  active = p
  activeResolved = resolved
  applyResolved(resolved)
  if (changed && !opts?.silent) notify()
  return resolved
}

/**
 * 設定値を保存して適用する。
 * @param {'dark'|'light'|'system'|unknown} pref 設定値
 * @returns {'dark'|'light'|'system'} 保存した設定値
 */
export function setThemePref(pref) {
  const p = normalizeTheme(pref) ?? DEFAULT_THEME
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, p)
  } catch {
    /* 保存できなくても表示は切り替える */
  }
  applyTheme(p)
  return p
}

/** @returns {'dark'|'light'|'system'} 現在の設定値 */
export function getThemePref() {
  return active
}

/** @returns {'dark'|'light'} 現在適用中の色 */
export function getResolvedTheme() {
  return activeResolved
}

/**
 * テーマ変更を購読する。
 * @param {(resolved: 'dark'|'light', pref: 'dark'|'light'|'system') => void} fn コールバック
 * @returns {() => void} 解除関数
 */
export function onThemeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 起動時に 1 度だけ呼ぶ。保存値を適用し、`system` 追従の監視を張る。
 * 何度呼んでも安全（監視は 1 本だけ）。
 * @returns {() => void} 監視を外す関数
 */
export function initTheme() {
  applyTheme(readThemePref(), { silent: true })
  if (systemMql || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  try {
    systemMql = window.matchMedia(SYSTEM_QUERY)
    const onChange = () => {
      if (active === 'system') applyTheme('system')
    }
    if (typeof systemMql.addEventListener === 'function') systemMql.addEventListener('change', onChange)
    else if (typeof systemMql.addListener === 'function') systemMql.addListener(onChange)
    return () => {
      try {
        if (typeof systemMql?.removeEventListener === 'function') systemMql.removeEventListener('change', onChange)
        else if (typeof systemMql?.removeListener === 'function') systemMql.removeListener(onChange)
      } catch {
        /* 解除失敗は無視 */
      }
      systemMql = null
    }
  } catch {
    return () => {}
  }
}
