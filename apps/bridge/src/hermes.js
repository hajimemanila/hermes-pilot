/**
 * 既存 Hermes サーバ（127.0.0.1:9119）への薄いクライアント。
 *
 * セッショントークンは起動時に env か SPA の HTML から解決し、**端末には返さない**。
 * ダッシュボードが再起動してトークンが変わった場合は 401 を見て 1 回だけ再解決する。
 *
 * @param {object} cfg 設定
 * @returns {object} クライアント
 */
export function createHermesClient(cfg) {
  let token = process.env.HERMES_DASHBOARD_SESSION_TOKEN || ''
  let resolving = null

  /** SPA の HTML からトークンを拾う（env 未設定時の唯一の経路）。 */
  async function scrape() {
    const res = await fetch(`${cfg.hermesBase}/`, { signal: AbortSignal.timeout(5000) })
    const html = await res.text()
    const m = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/.exec(html)
    if (!m) throw new Error('Hermes のセッショントークンを取得できません（ダッシュボード停止？）')
    return m[1]
  }

  /**
   * トークンを保証する。
   * @param {boolean} force 強制再解決
   * @returns {Promise<string>} トークン
   */
  async function ensureToken(force = false) {
    if (process.env.HERMES_DASHBOARD_SESSION_TOKEN) return process.env.HERMES_DASHBOARD_SESSION_TOKEN
    if (token && !force) return token
    if (!resolving) {
      resolving = scrape()
        .then((t) => {
          token = t
          return t
        })
        .finally(() => {
          resolving = null
        })
    }
    return resolving
  }

  /**
   * REST を叩く。
   * @param {string} pathname `/api/...`
   * @param {{method?: string, body?: any, timeoutMs?: number}} [opts] オプション
   * @returns {Promise<{status: number, data: any}>} 応答
   */
  async function call(pathname, opts = {}) {
    const { method = 'GET', body, timeoutMs = 15000 } = opts
    const run = async (tok) => {
      const res = await fetch(`${cfg.hermesBase}${pathname}`, {
        method,
        headers: {
          'x-hermes-session-token': tok,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let data = text
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        /* テキストのまま */
      }
      return { status: res.status, data }
    }
    let out = await run(await ensureToken())
    // gateway を再起動するとセッショントークンが回る。401/403 のどちらでも1回だけ取り直す
    if (out.status === 401 || out.status === 403) out = await run(await ensureToken(true))
    return out
  }

  /** WS の上流 URL（トークンはサーバ側で付ける）。 */
  async function wsUrl(pathname = '/api/ws', { fresh = false } = {}) {
    // fresh: gateway 再起動でトークンが回っても、次に繋ぐときに拾い直す
    const tok = await ensureToken(fresh)
    return `${cfg.hermesBase.replace(/^http/, 'ws')}${pathname}?token=${encodeURIComponent(tok)}`
  }

  return {
    ensureToken,
    call,
    wsUrl,
    get cached() {
      return Boolean(token)
    },
  }
}
