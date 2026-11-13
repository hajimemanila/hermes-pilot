/**
 * i18n の React 層（SPEC §6）。`main.jsx` で `<App>` を包む。
 *
 * - `I18nProvider`: 言語状態（`Auto / English / 日本語`）を持ち、`<html lang>` と
 *   `localStorage['hm.lang']` を同期する
 * - `useI18n()`: `{ lang, pref, setPref, t, locale }` を返す
 * - `t()` を直接 import しても現在の言語で訳せる（フックの外・イベントハンドラ用）
 *
 * JSX を使わない（ビルド対象の拡張子を `.js` に固定するため `createElement`）。
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_LANG,
  STORAGE_KEY,
  detectLang,
  getLang,
  normalizePref,
  onLangChange,
  setLang as setActiveLang,
  t as translateCurrent,
  translate,
} from './lang.js'

const I18nContext = createContext(null)

/** `localStorage['hm.lang']` を読む（読めない環境では null）。 */
function readStoredPref() {
  try {
    return normalizePref(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

/** `localStorage` へ保存する（失敗は無視）。 */
function writeStoredPref(pref) {
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    /* プライベートモード等では保存できない。表示だけ切り替える */
  }
}

/**
 * 言語プロバイダ。
 * @param {{children: any, initial?: 'auto'|'en'|'ja'}} props 子要素と初期設定
 * @returns {any} プロバイダ要素
 */
export function I18nProvider({ children, initial }) {
  const [pref, setPrefState] = useState(() => normalizePref(initial) ?? readStoredPref() ?? 'auto')
  const lang = useMemo(() => (pref === 'en' || pref === 'ja' ? pref : detectLang('auto')), [pref])

  // 表示言語をモジュール側（Intl・api.js）へ反映し、<html lang> を同期する
  useEffect(() => {
    setActiveLang(lang)
    if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', lang)
  }, [lang])

  // モジュール側から言語が変わった場合（別タブ・テスト）も追従する
  useEffect(
    () =>
      onLangChange((next) => {
        if (next !== lang) setPrefState(next)
      }),
    [lang],
  )

  const setPref = useCallback((next) => {
    const normalized = normalizePref(next) ?? 'auto'
    setPrefState(normalized)
    writeStoredPref(normalized)
    setActiveLang(normalized === 'auto' ? detectLang('auto') : normalized)
  }, [])

  const value = useMemo(
    () => ({
      lang,
      pref,
      locale: lang === 'ja' ? 'ja-JP' : 'en-US',
      setPref,
      t: (key, vars) => translate(lang, key, vars),
    }),
    [lang, pref, setPref],
  )

  return createElement(I18nContext.Provider, { value }, children)
}

/**
 * i18n コンテキスト。Provider の外でも落ちない既定値を返す。
 * @returns {{lang: 'en'|'ja', pref: string, locale: string, setPref: (p: string) => void, t: (key: string, vars?: object) => string}} 文脈
 */
export function useI18n() {
  const ctx = useContext(I18nContext)
  return (
    ctx ?? {
      lang: getLang() ?? DEFAULT_LANG,
      pref: 'auto',
      locale: getLang() === 'ja' ? 'ja-JP' : 'en-US',
      setPref: () => {},
      t: translateCurrent,
    }
  )
}

export { t, detectLang, normalizePref, placeholders, translate } from './lang.js'
