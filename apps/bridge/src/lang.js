/**
 * 言語解決の共通ロジック（ブリッジ側）。
 *
 * - `?lang=ja` などのクエリが最優先（明示指定）
 * - 次に `Accept-Language`（q 値の高い順。`ja` で始まれば ja、それ以外は en）
 * - どちらも無ければ既定 `en`（フォールバック言語・SPEC §6.1）
 */

export const LANGS = ['en', 'ja']
export const DEFAULT_LANG = 'en'

/**
 * 1 つの言語タグを `en` / `ja` に落とす（未知は null）。
 * @param {unknown} value タグ
 * @returns {'en'|'ja'|null} 正規化
 */
export function normalizeLang(value) {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  if (!s) return null
  if (s.startsWith('ja')) return 'ja'
  if (s.startsWith('en')) return 'en'
  return null
}

/**
 * Accept-Language ヘッダーを解釈する。
 * q 値の降順で最初のタグを見て、`ja` で始まれば ja、それ以外は en。
 * ヘッダーが空・不正なら null（＝呼び出し側の既定に任せる）。
 * @param {string} [header] ヘッダー値
 * @returns {'en'|'ja'|null} 言語
 */
export function fromAcceptLanguage(header) {
  const raw = String(header ?? '').trim()
  if (!raw) return null
  const entries = raw
    .split(',')
    .map((part, i) => {
      const [tag, ...attrs] = part.trim().split(';')
      let q = 1
      for (const a of attrs) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(a)
        if (m) q = Number(m[1])
      }
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 1, i }
    })
    .filter((e) => e.tag && e.tag !== '*')
    .sort((x, y) => (y.q - x.q) || (x.i - y.i))
  if (!entries.length) return null
  return entries[0].tag.startsWith('ja') ? 'ja' : 'en'
}

/**
 * リクエストから表示言語を決める。
 * @param {{queryLang?: unknown, acceptLanguage?: string, fallback?: 'en'|'ja'}} [input] 入力
 * @returns {'en'|'ja'} 言語
 */
export function resolveLang({ queryLang, acceptLanguage, fallback = DEFAULT_LANG } = {}) {
  return normalizeLang(queryLang) ?? fromAcceptLanguage(acceptLanguage) ?? normalizeLang(fallback) ?? DEFAULT_LANG
}
