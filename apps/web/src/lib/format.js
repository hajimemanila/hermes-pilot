/**
 * 表示用のフォーマット（言語連動・SPEC §6）と数値フォーマット。
 *
 * 言語は `setLocale('en'|'ja')` で切り替える。i18n の Provider が
 * `<html lang>` と同時にこれを更新するので、`relTime()` などの既定引数は
 * 常に現在の表示言語に従う（引数で明示すれば上書きできる）。
 */

/** 表示言語 → Intl ロケール。 */
const LOCALES = { en: 'en-US', ja: 'ja-JP' }

let activeLocale = 'en'

/** 現在の表示言語。 */
export function getLocale() {
  return activeLocale
}

/**
 * メタ行の区切り記号。日本語の `・`（U+30FB 中黒）を英語 UI でも使うと、
 * 英語設定なのに日本語の記号が混ざって見える（実測: `cli ・ 12 msg ・ 2h ago`）。
 * 言語に合わせて `・` / `·`（U+00B7）を返す。
 *
 * @param {'en'|'ja'} [lang] 省略時は現在の表示言語
 * @returns {string} 区切り記号
 */
export function sep(lang) {
  const l = lang ?? activeLocale
  return l === 'ja' ? '・' : '·'
}

/**
 * 表示言語を設定する（Intl の各フォーマッタが従う）。
 * @param {string} lang `en` / `ja`
 * @returns {string} 反映後の言語
 */
export function setLocale(lang) {
  activeLocale = lang === 'ja' ? 'ja' : 'en'
  return activeLocale
}

/** 言語（または 'ja-JP' 等のロケール）から Intl ロケールを作る。 */
function localeOf(lang) {
  if (lang) {
    const s = String(lang).toLowerCase()
    if (s.startsWith('ja')) return LOCALES.ja
    if (s.startsWith('en')) return LOCALES.en
  }
  return LOCALES[activeLocale] ?? LOCALES.en
}

/** コスト: 0.01 未満は有効数字3桁、それ以上は2桁。 */
export function fmtCost(n) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v <= 0) return '$0'
  if (v < 0.01) return `$${v.toPrecision(2)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** トークン数: 1.97M / 257.9M / 12.3k / 842。 */
export function fmtTokens(n) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(Math.round(v))
}

/** 比率（0..1）を % に。null は '—'。 */
export function fmtPct(r) {
  if (r == null || !Number.isFinite(r)) return '—'
  const p = r * 100
  if (p >= 99.95) return '100%'
  return `${p.toFixed(1)}%`
}

/**
 * 数値を現在の言語で整形する（桁区切り）。
 * @param {number} n 数値
 * @param {{maximumFractionDigits?: number, minimumFractionDigits?: number}} [opts] Intl オプション
 * @returns {string} 整形済み文字列
 */
export function fmtNumber(n, opts = {}) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return '—'
  return new Intl.NumberFormat(localeOf(), opts).format(v)
}

/**
 * バイト数を読みやすく。単位は言語共通、数値だけ Intl で整形する。
 * @param {number} n バイト
 * @param {string} [lang] 明示言語（既定は現在の表示言語）
 * @returns {string} `12.3MB` 等
 */
export function fmtBytes(n, lang) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const nf = (v, digits) => new Intl.NumberFormat(localeOf(lang), { maximumFractionDigits: digits }).format(v)
  if (n < 1024) return `${nf(n, 0)}B`
  if (n < 1048576) return `${nf(n / 1024, 0)}KB`
  if (n < 1073741824) return `${nf(n / 1048576, 1)}MB`
  return `${nf(n / 1073741824, 1)}GB`
}

/**
 * 相対時刻（`3 min. ago` / `3 分前`）。
 * @param {number} ts epoch ms
 * @param {string} [lang] 明示言語（既定は現在の表示言語）
 * @returns {string} 相対時刻
 */
export function relTime(ts, lang) {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000))
  const rtf = new Intl.RelativeTimeFormat(localeOf(lang), { numeric: 'always', style: 'short' })
  if (s < 60) return rtf.format(-s, 'second')
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return rtf.format(-Math.round(s / 86400), 'day')
}

/**
 * 日時（`2026年11月13日 22:40` / `Nov 13, 2026, 10:40 PM`）。
 * @param {number|string|Date} value 値
 * @param {Intl.DateTimeFormatOptions} [opts] 上書き
 * @param {string} [lang] 明示言語
 * @returns {string} 日時
 */
export function fmtDateTime(value, opts = {}, lang) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(localeOf(lang), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...opts,
  }).format(d)
}

/**
 * 時刻（`22:40`）。
 * @param {number|string|Date} value 値
 * @param {string} [lang] 明示言語
 * @returns {string} 時刻
 */
export function fmtTime(value, lang) {
  return fmtDateTime(value, { year: undefined, month: undefined, day: undefined, hour: '2-digit', minute: '2-digit' }, lang)
}

/**
 * 日付（`2026/11/13`）。
 * @param {number|string|Date} value 値
 * @param {string} [lang] 明示言語
 * @returns {string} 日付
 */
export function fmtDate(value, lang) {
  return fmtDateTime(value, { hour: undefined, minute: undefined }, lang)
}
