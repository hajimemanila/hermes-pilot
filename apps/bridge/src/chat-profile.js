/**
 * チャット WS 中継で `session.create` / `session.resume` の `profile` を検証する。
 *
 * SPEC: `docs/SPEC-PROFILE-CHAT.md`（決定 D1: 3 プロファイルすべて送信可）。
 * 端末は 1 本の `/ws/chat` しか持たないので、上流（`/api/ws`）へ流す前に
 * **serve 済みプロファイル名だけ**を許す。名前は DB パスに化けるので厳しめに弾く。
 *
 * 設計上の約束:
 * - 検証は純関数（上流も DB も触らない）→ テストは CLI なしで書ける
 * - `profile` 省略は従来どおり（default）＝ 後方互換
 * - 未知名・注入・型違いは **`-32602` をクライアントに返し、上流には流さない**
 *   （流すと `_profile_home()` 側の解決に任せることになり、失敗の見え方が遠くなる）
 */

import { errorBody } from './api-errors.js'

/** `profile` を受けてよい RPC。`prompt.submit` はセッションに束縛済みなので対象外。 */
export const PROFILE_METHODS = new Set(['session.create', 'session.resume'])

/** 常に許可する名前（プロファイル一覧が取れないときの退避）。 */
const ALWAYS = 'default'

/** プロファイル名として妥当か（パス区切り・空白・過長を弾く）。 */
export function isSafeProfileName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)
}

/**
 * 1 フレームを検証する。
 *
 * @param {string} text 端末から来た生フレーム
 * @param {Iterable<string>} allowed serve 済みプロファイル名
 * @returns {{ok: true, text: string, profile: string|null, method: string|null}
 *          | {ok: false, id: number|string|null, message: string, profile: string|null, method: string|null}}
 *   `ok:false` のときは応答を返して上流へ流さない
 */
export function checkFrame(text, allowed) {
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return { ok: true, text, profile: null, method: null } // 壊れたフレームは従来どおり素通し（上流が判断）
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: true, text, profile: null, method: null }
  }
  const method = typeof msg.method === 'string' ? msg.method : null
  if (!method || !PROFILE_METHODS.has(method)) {
    return { ok: true, text, profile: null, method }
  }
  const params = msg.params
  if (!params || typeof params !== 'object') return { ok: true, text, profile: null, method }
  if (!('profile' in params)) return { ok: true, text, profile: null, method }

  const raw = params.profile
  if (raw === null || raw === undefined || raw === '') {
    // 明示的な「既定」はパラメータごと落として上流に既定を選ばせる
    const next = { ...msg, params: { ...params } }
    delete next.params.profile
    return { ok: true, text: JSON.stringify(next), profile: null, method }
  }
  const name = String(raw).trim()
  const allow = new Set([ALWAYS, ...(allowed ?? [])])
  if (!isSafeProfileName(name) || !allow.has(name)) {
    // 日本語を返さない: 文言は英語既定（`err.PROFILE_UNKNOWN`）で組み、コードで自言語化させる。
    // `message` は WS の JSON-RPC 拒否フレーム（`rejectionFrame`）が読む。
    const failure = errorBody('PROFILE_UNKNOWN', { profile: String(raw).slice(0, 60) })
    return {
      ok: false,
      id: msg.id ?? null,
      message: failure.error,
      code: failure.code,
      params: failure.params,
      profile: name,
      method,
    }
  }
  const next = { ...msg, params: { ...params, profile: name } }
  return { ok: true, text: JSON.stringify(next), profile: name, method }
}

/**
 * `checkFrame` が拒否したときの JSON-RPC エラーフレーム。
 *
 * @param {number|string|null} id リクエスト ID
 * @param {string} message 文言
 * @returns {string} JSON
 */
export function rejectionFrame(id, message) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32602, message: `profile: ${message}` },
  })
}
