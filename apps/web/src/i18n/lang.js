/**
 * i18n の核（React 非依存）。辞書・言語解決・`t()`。
 *
 * - 辞書はフラット JSON（`en.json` が基準・`ja.json` は同一キー集合）
 * - キー欠落時は en → キー文字列の順にフォールバック（画面クラッシュ防止・SPEC §6.2）
 * - React 側の `I18nProvider` はこのモジュールの状態を購読するだけ
 *   （`api.js` のようにフックを使えない場所からも `getLang()` を読める）
 */

import en from './en.json' with { type: 'json' }
import ja from './ja.json' with { type: 'json' }
import { setLocale } from '../lib/format.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { HM_STORAGE } from '../contracts/storage.js'

export const LANGS = ['en', 'ja']
export const DEFAULT_LANG = 'en'
/** `localStorage` のキー。値は `en` / `ja` / `auto`。 */
export const STORAGE_KEY = HM_STORAGE.LANG

/** @type {Record<string, Record<string, string>>} */
export const DICTS = { en, ja }

/**
 * 保存値を `en` / `ja` / `auto` に正規化する（未知は null）。
 * @param {unknown} value 保存値
 * @returns {'en'|'ja'|'auto'|null} 正規化
 */
export function normalizePref(value) {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  if (!s) return null
  if (s === 'auto') return 'auto'
  if (s.startsWith('ja')) return 'ja'
  if (s.startsWith('en')) return 'en'
  return null
}

/**
 * 言語タグ（`ja-JP` 等）が日本語か。`ja` 以外はすべて英語扱い（SPEC §6.1）。
 * @param {unknown} tag タグ
 * @returns {'ja'|'en'} 言語
 */
export function langOfTag(tag) {
  return String(tag ?? '').trim().toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * 言語を決める（localStorage → navigator.languages → en）。
 * @param {{stored?: unknown, languages?: string[], language?: string}} [input] 入力
 * @returns {'en'|'ja'} 言語
 */
export function resolveLang({ stored, languages, language } = {}) {
  const pref = normalizePref(stored)
  if (pref === 'en' || pref === 'ja') return pref
  const list = Array.isArray(languages) ? languages.filter(Boolean) : []
  if (list.length) return langOfTag(list[0])
  if (language) return langOfTag(language)
  return DEFAULT_LANG
}

/**
 * 保存値と `navigator` から言語を決める（ブラウザ用の入口）。
 * @param {unknown} [stored] `HM_STORAGE.LANG` の保存値
 * @returns {'en'|'ja'} 言語
 */
export function detectLang(stored) {
  if (typeof navigator === 'undefined') return resolveLang({ stored })
  return resolveLang({ stored, languages: navigator.languages, language: navigator.language })
}

/**
 * テンプレート中の `{name}` を vars で置換する。未知の変数はそのまま残す。
 * @param {string} template 文面
 * @param {Record<string, unknown>} [vars] 値
 * @returns {string} 置換後
 */
export function formatMessage(template, vars) {
  const s = String(template ?? '')
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null ? String(vars[name]) : whole,
  )
}

/**
 * テンプレート中のプレースホルダ名（重複除去・ソート済み）。テストと検証用。
 * @param {string} template 文面
 * @returns {string[]} プレースホルダ名
 */
export function placeholders(template) {
  const out = new Set()
  for (const m of String(template ?? '').matchAll(/\{(\w+)\}/g)) out.add(m[1])
  return [...out].sort()
}

/**
 * 翻訳する。辞書に無ければ en、それも無ければキー名を返す。
 * @param {'en'|'ja'} lang 言語
 * @param {string} key キー
 * @param {Record<string, unknown>} [vars] プレースホルダ値
 * @returns {string} 訳文
 */
export function translate(lang, key, vars) {
  const l = normalizePref(lang) === 'ja' ? 'ja' : DEFAULT_LANG
  const dict = DICTS[l] ?? DICTS.en
  const raw = dict[key] ?? DICTS.en[key]
  if (raw == null) return String(key)
  return formatMessage(raw, vars)
}

let active = detectLang(readStoredPref())
const listeners = new Set()

/**
 * `HM_STORAGE.LANG` を読む（読めない環境では null）。
 * @returns {'en'|'ja'|'auto'|null} 保存値
 */
export function readStoredPref() {
  try {
    return normalizePref(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

/**
 * 現在の表示言語（React 外から読む）。
 * @returns {'en'|'ja'} 言語
 */
export function getLang() {
  return active
}

/**
 * 表示言語を切り替え、`Intl` 系のフォーマッタと購読者へ伝える。
 * `hm:lang` を発火するので、スニペット取得などはリロードなしで追従できる（SPEC §3.1）。
 * @param {'en'|'ja'|'auto'|unknown} next 言語（auto は現状維持）
 * @returns {'en'|'ja'} 反映後の言語
 */
export function setLang(next) {
  const pref = normalizePref(next)
  const lang = pref === 'en' || pref === 'ja' ? pref : active
  const changed = lang !== active
  active = lang
  setLocale(lang)
  if (changed) for (const fn of [...listeners]) {
    try {
      fn(lang)
    } catch {
      /* 購読者の失敗で言語切替を止めない */
    }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      emitHmEvent(HM_EVENTS.LANG, { lang })
    }
  } catch {
    /* SSR / テスト環境で CustomEvent が無いときは無視する */
  }
  return lang
}

/**
 * 言語変更を購読する。
 * @param {(lang: 'en'|'ja') => void} fn コールバック
 * @returns {() => void} 解除関数
 */
export function onLangChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 現在の言語で翻訳する（フックを使えない場所用）。
 * @param {string} key キー
 * @param {Record<string, unknown>} [vars] プレースホルダ値
 * @returns {string} 訳文
 */
export function t(key, vars) {
  return translate(active, key, vars)
}

/**
 * ブリッジのエラー応答 `{code, error, params}` を現在の言語で表示用に変換する。
 * 辞書に無いコードはサーバーの英語メッセージをそのまま返す。
 * @param {{code?: string, error?: string, message?: string, params?: Record<string, unknown>}} [res] 応答
 * @returns {string} 表示文
 */
export function localizeError(res) {
  const code = String(res?.code ?? 'BAD_REQUEST')
  const key = `err.${code}`
  const text = translate(active, key, res?.params ?? {})
  if (text !== key) return text
  return String(res?.error ?? res?.message ?? translate(active, 'err.BAD_REQUEST'))
}
