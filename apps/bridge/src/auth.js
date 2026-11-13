import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * アプリの入り口認証。
 *
 * - 端末には**アプリトークンだけ**を渡す（Hermes のセッショントークンは渡さない）
 * - 最初の 1 回だけ `/auth?t=<token>` を踏ませて HttpOnly Cookie にする
 * - **発行済みセッションはディスクに永続化**する（ブリッジ再起動で端末がログアウトしない）
 * - トークンをローテーションすると（ファイルを消して再生成）、過去のセッションは自動で全失効
 * - 書き込み系は `X-Client: mobile` 必須（CSRF の多層防御）
 * - 待受は 127.0.0.1。外部公開は Tailscale serve のみ
 *
 * @param {object} cfg 設定
 * @returns {object} 認証ヘルパ
 */
/**
 * WebSocket アップグレード時の Origin 検証（CSWSH 対策）。
 * ブラウザからの接続（Origin ヘッダあり）は Host と同一オリジンのみ許可する。
 * @param {import('node:http').IncomingMessage} req リクエスト
 * @returns {boolean} 許可してよいか
 */
export function isAllowedWsOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  if (typeof origin !== 'string') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const rawHost = req.headers['x-forwarded-host'] ?? req.headers.host
  const expectedHost = (Array.isArray(rawHost) ? rawHost[0] : rawHost ?? '').split(',')[0].trim().toLowerCase()
  if (!expectedHost) return false
  return parsed.host.toLowerCase() === expectedHost
}

export function createAuth(cfg, { pairCodes = null } = {}) {
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
  const fingerprint = hash(token).slice(0, 16)
  const sessionsPath = path.join(cfg.dataDir, 'sessions.json')

  /**
   * 永続セッション。`{version, tokenFingerprint, sessions: {hash: {created, lastSeen}}}`
   * @type {{version: number, tokenFingerprint: string, sessions: Record<string, {created: number, lastSeen: number}>}}
   */
  let store = { version: 1, tokenFingerprint: fingerprint, sessions: {} }
  try {
    const loaded = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
    if (loaded?.sessions && typeof loaded.sessions === 'object' && loaded.tokenFingerprint === fingerprint) {
      store = { version: 1, tokenFingerprint: fingerprint, sessions: loaded.sessions }
    }
  } catch {
    /* 初回・破損時は空から */
  }

  let dirty = false
  let lastFlush = 0
  const flush = (force = false) => {
    if (!dirty && !force) return
    const now = Date.now()
    if (!force && now - lastFlush < 5000) return // ディスク書き込みは 5 秒に 1 回まで
    lastFlush = now
    dirty = false
    try {
      const tmp = `${sessionsPath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tokenFingerprint: fingerprint, sessions: store.sessions }, null, 2), {
        mode: 0o600,
      })
      fs.renameSync(tmp, sessionsPath)
    } catch {
      /* 永続化に失敗しても認証は続ける */
    }
  }

  /** 期限切れを落とす。 */
  const prune = () => {
    const now = Date.now()
    let removed = 0
    for (const [k, rec] of Object.entries(store.sessions)) {
      if (now - (rec.lastSeen ?? rec.created ?? 0) > cfg.sessionTtlMs) {
        delete store.sessions[k]
        removed += 1
      }
    }
    if (removed) {
      dirty = true
      flush(true)
    }
    return removed
  }
  prune()

  const parseCookies = (header) => {
    const out = {}
    for (const part of String(header ?? '').split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    }
    return out
  }

  function tokenMatches(given) {
    if (typeof given !== 'string') return false
    const a = Buffer.from(given)
    const b = Buffer.from(token)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  }

  return {
    token,
    auditPath: cfg.auditPath,

    /** ワンタイム URL のトークンをセッション Cookie に交換する。 */
    exchange(given) {
      // 本トークン（64 文字）か、ワンタイム・ペアリングコード（短い使い捨て）のどちらでも通す
      const byToken = tokenMatches(given)
      if (!byToken && !pairCodes?.consume?.(given)) return null
      prune()
      const value = crypto.randomBytes(24).toString('base64url')
      const now = Date.now()
      store.sessions[hash(value)] = { created: now, lastSeen: now }
      dirty = true
      flush(true)
      return value
    },

    /** @param {import('node:http').IncomingMessage} req リクエスト @returns {boolean} */
    authorized(req) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const byToken = tokenMatches(url.searchParams.get('t'))
      if (!byToken) {
        const cookie = parseCookies(req.headers.cookie)[cfg.cookieName]
        if (!cookie) return false
        const key = hash(cookie)
        const rec = store.sessions[key]
        if (!rec) return false
        const now = Date.now()
        if (now - (rec.lastSeen ?? rec.created ?? 0) > cfg.sessionTtlMs) {
          delete store.sessions[key]
          dirty = true
          flush(true)
          return false
        }
        rec.lastSeen = now
        dirty = true
        flush()
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-client'] !== 'mobile') return false
      return true
    },

    cookieHeader(value) {
      return `${cfg.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}`
    },

    /** 端末セッション一覧（診断用。Cookie の値は返さない）。 */
    sessions() {
      return Object.entries(store.sessions).map(([k, v]) => ({
        id: k.slice(0, 8),
        created: new Date(v.created).toISOString(),
        lastSeen: new Date(v.lastSeen ?? v.created).toISOString(),
      }))
    },

    /** 全端末をログアウトさせる（トークンは変えない）。 */
    revokeAll() {
      const n = Object.keys(store.sessions).length
      store.sessions = {}
      dirty = true
      flush(true)
      return n
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
