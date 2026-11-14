/** ブラウザ側 API クライアント。同一オリジン（:8444）なので Cookie がそのまま乗る。 */
import { getLang, translate } from './i18n/lang.js'

export const BASE = ''

/*
 * デモビルド（`npm run build:demo`）の差し込み口。
 *
 * `main.jsx` がデモのときだけ `globalThis` に実装を置く。ここから `demo/` を **import しない**ので、
 * 通常ビルドのバンドルにはモックのコードも文字列も 1 バイトも入らない（実測: `dist/` を grep）。
 */
const demoFetchImpl = () => globalThis.__hmDemoFetch ?? null
const demoSocketImpl = () => globalThis.__hmDemoSocket ?? null


/**
 * エラーコードを現在の言語の表示文にする（辞書に無ければそのまま）。
 * @param {string} code コード
 * @param {string} fallback 既定文
 * @param {Record<string, unknown>} [params] `{status}` などのプレースホルダ値
 * @returns {string} 表示文
 */
function localizedMessage(code, fallback, params) {
  if (!code) return fallback
  const key = `err.${code}`
  const text = translate(getLang(), key, params)
  return text === key ? fallback : text
}

/**
 * JSON リクエスト。表示言語を `Accept-Language` で送る（SPEC §6.1）。
 * @param {string} path `/api/...`
 * @param {{method?: string, body?: any}} [opts] オプション
 * @returns {Promise<any>} 応答
 */
export async function api(path, { method = 'GET', body } = {}) {
  // デモビルドでは全リクエストをインメモリのモックが返す（バックエンド不要・SPEC-PILOT-V5 §3.4 ②）
  const demo = demoFetchImpl()
  if (demo) return demo(path, { method, body })
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
    // 表示文は `t('err.OFFLINE')`（SW の 503 も同じコードを返す・SPEC §1.2 G4）
    const err = new Error(localizedMessage('OFFLINE', 'Cannot reach the bridge'))
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
    const code = data?.code ?? legacy?.code ?? null
    const params = data?.params ?? legacy?.params ?? null
    const fallback =
      (typeof data?.error === 'string' ? data.error : null) ??
      legacy?.message ??
      data?.detail ??
      `HTTP ${res.status}`
    // 表示は必ず辞書（`err.<CODE>`）を優先する。辞書に無いコードだけブリッジの英語既定文へ落とす。
    // ここが「JA 表示なのに英語」「EN 表示なのに日本語」を無くす本丸（SPEC-i18n-resp B2）。
    const err = new Error(localizedMessage(code, fallback, params))
    err.status = res.status
    err.code = code
    err.params = params
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
  // デモビルドでは擬似ソケット（JSON-RPC をインメモリで返す）
  const demo = demoSocketImpl()
  if (demo) return demo(path)
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return new WebSocket(`${proto}://${location.host}${path}`)
}
