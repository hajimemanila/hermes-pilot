/**
 * ワンタップ QR ペアリング（SPEC §8.2）。
 *
 * QR には `https://<host>/?token=<app-token>`（または `#token=`）が入っている。
 * アプリ起動時にそのトークンを **HttpOnly セッション Cookie** に交換し、
 * すぐ `history.replaceState` で URL からトークンを消す（履歴・共有・スクショに残さない）。
 *
 * ここは DOM に直接触らず、`location` / `history` / `fetch` を引数で受ける（単体テスト用）。
 */

/** QR が載せてよいクエリ/ハッシュのキー（`pair` は §8.1 の表記ゆれ）。 */
export const PAIR_KEYS = ['token', 'pair']

/** 素のハッシュ（`#<token>`）として受け入れる最小長。誤爆を避けるため hex だけに限る。 */
const BARE_HASH = /^[0-9a-f]{32,}$/i

/**
 * URL からペアリングトークンを取り出す。
 * @param {{search?: string, hash?: string}} [loc] `window.location` 相当
 * @returns {string|null} トークン（無ければ null）
 */
export function readPairToken(loc = globalThis.location) {
  const search = String(loc?.search ?? '')
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  for (const key of PAIR_KEYS) {
    const value = params.get(key)
    if (value && String(value).trim()) return String(value).trim()
  }
  const raw = String(loc?.hash ?? '').replace(/^#/, '')
  if (!raw) return null
  if (raw.includes('=')) {
    const hashParams = new URLSearchParams(raw)
    for (const key of PAIR_KEYS) {
      const value = hashParams.get(key)
      if (value && String(value).trim()) return String(value).trim()
    }
    return null
  }
  return BARE_HASH.test(raw) ? raw : null
}

/**
 * URL からトークンを取り除く（他のクエリ・ハッシュは残す）。
 * @param {{href?: string, search?: string, hash?: string, pathname?: string}} [loc] `window.location` 相当
 * @param {{replaceState?: Function}} [historyObj] `window.history` 相当
 * @returns {boolean} 実際に書き換えたか
 */
export function stripPairToken(loc = globalThis.location, historyObj = globalThis.history) {
  if (!readPairToken(loc)) return false
  let url
  try {
    url = new URL(String(loc?.href ?? `http://127.0.0.1${loc?.pathname ?? '/'}${loc?.search ?? ''}${loc?.hash ?? ''}`))
  } catch {
    return false
  }
  let changed = false
  for (const key of PAIR_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  }
  const hashRaw = url.hash.replace(/^#/, '')
  if (hashRaw) {
    if (BARE_HASH.test(hashRaw)) {
      url.hash = ''
      changed = true
    } else if (hashRaw.includes('=')) {
      const hashParams = new URLSearchParams(hashRaw)
      let hashChanged = false
      for (const key of PAIR_KEYS) {
        if (hashParams.has(key)) {
          hashParams.delete(key)
          hashChanged = true
        }
      }
      if (hashChanged) {
        const rest = hashParams.toString()
        url.hash = rest ? `#${rest}` : ''
        changed = true
      }
    }
  }
  if (!changed) return false
  try {
    historyObj?.replaceState?.(null, '', `${url.pathname}${url.search}${url.hash}`)
    return true
  } catch {
    return false
  }
}

/**
 * トークンをセッション Cookie に交換する（`POST /api/auth/login`）。
 * @param {string} token アプリトークン
 * @param {Function} [fetchImpl] テスト用の差し替え
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>} 結果
 */
export async function loginWithToken(token, fetchImpl = globalThis.fetch) {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'EMPTY_TOKEN' }
  let res
  try {
    res = await fetchImpl('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-client': 'mobile' },
      body: JSON.stringify({ token }),
    })
  } catch {
    return { ok: false, error: 'OFFLINE' }
  }
  if (!res?.ok) return { ok: false, status: res?.status ?? 0, error: 'REJECTED' }
  return { ok: true, status: res.status }
}

/**
 * QR 導線の 1 手目。トークンがあればログインし、成功したら URL を掃除する。
 * @param {object} [opts] 差し替え（テスト用）
 * @param {object} [opts.loc] `window.location`
 * @param {object} [opts.historyObj] `window.history`
 * @param {Function} [opts.fetchImpl] `fetch`
 * @returns {Promise<{handled: boolean, ok: boolean, error?: string}>} 結果
 */
export async function consumePairToken({
  loc = globalThis.location,
  historyObj = globalThis.history,
  fetchImpl = globalThis.fetch,
} = {}) {
  const token = readPairToken(loc)
  if (!token) return { handled: false, ok: false }
  const result = await loginWithToken(token, fetchImpl)
  // 失敗したら URL はそのまま残す（打ち直せるように）。成功時だけ掃除する。
  if (!result.ok) return { handled: true, ok: false, error: result.error }
  stripPairToken(loc, historyObj)
  return { handled: true, ok: true }
}
