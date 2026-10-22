/** ブラウザ側 API クライアント。同一オリジン（:8444）なので Cookie がそのまま乗る。 */
export const BASE = ''

/**
 * JSON リクエスト。
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
        'x-client': 'mobile',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    const err = new Error('ブリッジに接続できません')
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
    const err = new Error(data?.error?.message ?? data?.detail ?? `HTTP ${res.status}`)
    err.status = res.status
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
