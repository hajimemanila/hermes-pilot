/**
 * 運用系（SystemOps バッジ + キルスイッチ）。
 *
 * キルスイッチは Hermes 自身の API を叩く（生の launchctl は使わない）。
 * 実測した挙動:
 *  - drain   … 新規ターンを止め、実行中は完走
 *  - restart … SIGUSR1 → 実行中ターンの完了を待って再起動（最大1800秒）
 *  - stop    … interrupt=true で実行中も停止
 *
 * @param {object} cfg 設定
 * @param {object} hermes Hermes クライアント
 * @param {object} auth 認証（監査用）
 * @returns {object} 運用操作
 */
export function createOps(cfg, hermes, auth) {
  const GATEWAY_ACTIONS = new Map([
    ['drain', '/api/gateway/drain'],
    ['restart', '/api/gateway/restart'],
    ['stop', '/api/gateway/stop?interrupt=true'],
    ['start', '/api/gateway/start'],
  ])

  /** 画面の 3 枚カード分をまとめて取る（片方が落ちても他は返す）。 */
  async function overview() {
    const [status, stats, blocked] = await Promise.allSettled([
      hermes.call('/api/status', { timeoutMs: 8000 }),
      hermes.call('/api/system/stats', { timeoutMs: 8000 }),
      hermes.call('/api/plugins/system-ops/blocked-processes', { timeoutMs: 12000 }),
    ])
    const s = status.status === 'fulfilled' && status.value.status === 200 ? status.value.data : null
    const sys = stats.status === 'fulfilled' && stats.value.status === 200 ? stats.value.data : null
    const bl = blocked.status === 'fulfilled' && blocked.value.status === 200 ? blocked.value.data : null
    return {
      hermes: s
        ? {
            version: s.version,
            model: s.model ?? null,
            gateway: s.gateway ?? null,
            sessions: s.sessions ?? null,
            profiles: s.profiles ?? null,
          }
        : null,
      system: sys
        ? {
            cpuCount: sys.cpu_count ?? null,
            memory: sys.memory ?? null,
            disk: sys.disk ?? null,
            load: sys.loadavg ?? null,
            uptime: sys.uptime ?? null,
          }
        : null,
      ops: bl
        ? {
            ok: Boolean(bl.data?.ok ?? bl.ok),
            generatedAt: bl.generated_at ?? bl.data?.generated_at ?? null,
            host: bl.data?.host ?? null,
            findings: bl.data?.findings ?? bl.data?.summary ?? null,
          }
        : null,
      checkedAt: Date.now(),
    }
  }

  /**
   * キルスイッチ。`confirm` が正しくないと実行しない（誤爆防止）。
   * @param {string} action drain|restart|stop|start
   * @param {string} confirm 画面で入力/長押しした確認語
   * @param {string} by 実行者（端末識別）
   * @returns {Promise<object>} 結果
   */
  async function gateway(action, confirm, by = 'mobile') {
    const pathname = GATEWAY_ACTIONS.get(action)
    if (!pathname) {
      throw Object.assign(new Error(`不明な操作です: ${action}`), { statusCode: 400 })
    }
    const expected = action === 'drain' ? 'DRAIN' : action.toUpperCase()
    if (String(confirm ?? '').toUpperCase() !== expected) {
      throw Object.assign(new Error(`確認語が一致しません（${expected}）`), { statusCode: 400 })
    }
    const res = await hermes.call(pathname, { method: 'POST', body: {}, timeoutMs: 30000 })
    const ok = res.status >= 200 && res.status < 300
    auth.audit({ kind: `gateway.${action}`, ok, status: res.status, by, result: res.data })
    if (!ok) {
      const detail = res.data?.detail ?? res.data?.error?.message ?? `HTTP ${res.status}`
      throw Object.assign(new Error(`Hermes が拒否しました: ${detail}`), { statusCode: 502 })
    }
    return { ok, action, result: res.data, at: Date.now() }
  }

  return { overview, gateway }
}
