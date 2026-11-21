/**
 * HTTP 応答の共通形（SPEC §6.3）。`server.js` から切り出した。
 *
 * ここには「リクエストを読む / 応答を書く」だけを置く。ルーティングや
 * ドメイン判断は `server.js` に残す（公開契約は変えない）。
 */

import { errorBody } from '../api-errors.js'
import { resolveLang } from '../lang.js'

/** 拡張子 → content-type。 */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/** @param {import('node:http').ServerResponse} res 応答 */
export function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * エラー応答（SPEC §6.3）。`{ok:false, code, error, params}` の形に統一する。
 * @param {import('node:http').ServerResponse} res 応答
 * @param {number} status HTTP ステータス
 * @param {string} code エラーコード
 * @param {Record<string, unknown>} [params] プレースホルダ値
 * @returns {void}
 */
export function sendError(res, status, code, params) {
  sendJson(res, status, errorBody(code, params))
}

/**
 * 内部モジュールの `{ok:false, code?, error|message}` を §6.3 の形へ正規化して返す。
 * 元の説明文は `detail` に残す（英語既定だけでは原因が分からない時用）。
 * @param {import('node:http').ServerResponse} res 応答
 * @param {number} status HTTP ステータス
 * @param {{code?: string, error?: unknown, message?: unknown, params?: object, status?: unknown, reason?: unknown}} r 失敗結果
 * @returns {void}
 */
export function sendFailure(res, status, r) {
  const fallback = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST'
  const code = r?.code ?? fallback
  const params = r?.params ?? (r?.status ? { status: r.status } : {})
  const body = errorBody(code, params)
  const detail = [r?.message, r?.error, r?.reason].find((v) => typeof v === 'string' && v.trim())
  if (detail && detail !== body.error) body.detail = String(detail)
  sendJson(res, status, body)
}

/**
 * リクエストの表示言語（`?lang=` → `Accept-Language` → en・SPEC §6.1）。
 * @param {import('node:http').IncomingMessage} req リクエスト
 * @param {URL} url URL
 * @returns {'en'|'ja'} 言語
 */
export function langOf(req, url) {
  return resolveLang({ queryLang: url.searchParams.get('lang'), acceptLanguage: req.headers['accept-language'] })
}

/** 本文を JSON として読む（上限 1MB）。 */
export function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}
