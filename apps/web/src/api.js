/** ブラウザ側 API クライアント。同一オリジン（:8444）なので Cookie がそのまま乗る。 */
import { getLang } from './i18n/lang.js'

export const BASE = ''

/**
 * JSON リクエスト。表示言語を `Accept-Language` で送る（SPEC §6.1）。
 * @param {string} path `/api/...`
 * @param {{method?: string, body?: any}} [opts] オプション
 * @returns {Promise<any>} 応答
 */
export async function api(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'accept-language': getLang(),
        'x-client': 'mobile',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    // 表示文は呼び出し側が `t('err.' + err.code)` で自言語化する（§6.3）
    const err = new Error('Cannot reach the bridge')
    err.code = 'OFFLINE'
    throw err
  }
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    // エラー応答は `{ok:false, code, error, params}`（§6.3）。旧 `{error:{message}}` も読む。
    const legacy = data?.error && typeof data.error === 'object' ? data.error : null
    const message =
      (typeof data?.error === 'string' ? data.error : null) ??
      legacy?.message ??
      data?.detail ??
      `HTTP ${res.status}`
    const err = new Error(message)
    err.status = res.status
    err.code = data?.code ?? legacy?.code ?? null
    err.params = data?.params ?? null
    throw err
  }
  return data
}

/**
 * WebSocket を開く（Cookie 認証なので URL にトークンを載せない）。
 * @param {string} path `/ws/...`
 * @returns {WebSocket} ソケット
 */
export function openSocket(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return new WebSocket(`${proto}://${location.host}${path}`)
}
