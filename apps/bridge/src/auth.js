import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * アプリの入り口認証。
 *
 * - 端末には**アプリトークンだけ**を渡す（Hermes のセッショントークンは渡さない）
 * - 起動時に 1 回だけ `/auth?t=<token>` を踏ませて HttpOnly Cookie にする
 * - 書き込み系は `X-Client: mobile` 必須（CSRF の多層防御）
 * - 待受は 127.0.0.1。外部公開は Tailscale serve のみ
 *
 * @param {object} cfg 設定
 * @returns {object} 認証ヘルパ
 */
export function createAuth(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  let token = ''
  try {
    token = fs.readFileSync(cfg.tokenPath, 'utf8').trim()
  } catch {
    /* 初回 */
  }
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url')
    fs.writeFileSync(cfg.tokenPath, token, { mode: 0o600 })
  }

  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex')
  /** @type {Map<string, number>} */
  const sessions = new Map()

  const parseCookies = (header) => {
    const out = {}
    for (const part of String(header ?? '').split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    }
    return out
  }

  return {
    token,
    auditPath: cfg.auditPath,

    /** ワンタイム URL のトークンをセッション Cookie に交換する。 */
    exchange(given) {
      if (!given || given.length !== token.length) return null
      if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return null
      const value = crypto.randomBytes(24).toString('base64url')
      sessions.set(hash(value), Date.now())
      return value
    },

    /** @param {import('node:http').IncomingMessage} req リクエスト @returns {boolean} */
    authorized(req) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('t') === token) return true
      const cookie = parseCookies(req.headers.cookie)[cfg.cookieName]
      if (!cookie) return false
      const created = sessions.get(hash(cookie))
      if (!created) return false
      if (Date.now() - created > cfg.sessionTtlMs) {
        sessions.delete(hash(cookie))
        return false
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-client'] !== 'mobile') return false
      return true
    },

    cookieHeader(value) {
      return `${cfg.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}`
    },

    /** 監査ログ（追記のみ）。 */
    audit(entry) {
      try {
        fs.mkdirSync(path.dirname(cfg.auditPath), { recursive: true })
        fs.appendFileSync(cfg.auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
      } catch {
        /* 監査の失敗で本処理は止めない */
      }
    },
  }
}
