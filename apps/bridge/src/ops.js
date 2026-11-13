import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * 運用系（状態の俯瞰 + キルスイッチ）。
 *
 * `/api/overview` は **Hermes 標準 API とブリッジ自身のメトリクスだけ**で組み立てる
 * （SPEC §5.2）。外部プラグインのエンドポイントは叩かない。
 *
 * キルスイッチは Hermes 自身の API を叩く（生の launchctl は使わない）。
 * 実測した挙動:
 *  - drain   … 新規ターンを止め、実行中は完走
 *  - restart … SIGUSR1 → 実行中ターンの完了を待って再起動（最大1800秒）
 *  - stop    … interrupt=true で実行中も停止
 *
 * 緊急停止（pause / resume）だけは CLI を使う（`~/.hermes/ESTOP` センチネルを本体が管理する）。
 *
 * @param {object} cfg 設定
 * @param {object} hermes Hermes クライアント
 * @param {object} auth 認証（監査用）
 * @param {{kanban?: object}} [deps] 差し替え（テスト用）
 * @returns {object} 運用操作
 */
export function createOps(cfg, hermes, auth, deps = {}) {
  const startedAt = Number(cfg.startedAt ?? Date.now())
  const GATEWAY_ACTIONS = new Map([
    ['drain', '/api/gateway/drain'],
    ['restart', '/api/gateway/restart'],
    ['stop', '/api/gateway/stop?interrupt=true'],
    ['start', '/api/gateway/start'],
  ])

  /**
   * カンバン集計（自前メトリクス）。板が読めなくても落ちない。
   * @returns {{boards: number, running: number, blocked: number, ready: number, reviewWaiting: number}} 集計
   */
  function kanbanSummary() {
    const empty = { boards: 0, running: 0, blocked: 0, ready: 0, reviewWaiting: 0 }
    let boards = []
    try {
      boards = deps.kanban?.boards?.() ?? []
    } catch {
      boards = []
    }
    if (!Array.isArray(boards) || !boards.length) return empty
    const live = boards.filter((b) => b && !b.archived)
    const sum = (k) => live.reduce((n, b) => n + Number(b.counts?.[k] ?? 0), 0)
    const blocked = sum('blocked')
    return {
      boards: live.length,
      running: sum('running'),
      blocked,
      ready: sum('ready'),
      // 判断待ち（blocked）は人間の回答を待っている件数＝Review 待ち
      reviewWaiting: blocked,
    }
  }

  /** 画面のカード分をまとめて取る（片方が落ちても他は返す）。 */
  async function overview() {
    const [status, stats] = await Promise.allSettled([
      hermes.call('/api/status', { timeoutMs: 8000 }),
      hermes.call('/api/system/stats', { timeoutMs: 8000 }),
    ])
    const s = status.status === 'fulfilled' && status.value.status === 200 ? status.value.data : null
    const sys = stats.status === 'fulfilled' && stats.value.status === 200 ? stats.value.data : null
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
      /** ブリッジ自身の稼働状態（自前メトリクス） */
      bridge: {
        ok: Boolean(s),
        version: String(cfg.version ?? ''),
        port: Number(cfg.port ?? 0) || null,
        startedAt,
        uptimeSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      },
      /** カンバン集計（自前メトリクス） */
      kanban: kanbanSummary(),
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

  /**
   * 緊急停止（ESTOP）の状態。`~/.hermes/ESTOP` を読むだけ。
   * @returns {{engaged: boolean, reason: string|null, engagedAt: string|null}} 状態
   */
  function paused() {
    const p = path.join(cfg.hermesHome, 'ESTOP')
    try {
      if (!fs.existsSync(p)) return { engaged: false, reason: null, engagedAt: null }
      let raw = {}
      try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      } catch {
        raw = {}
      }
      return {
        engaged: true,
        reason: typeof raw?.reason === 'string' ? raw.reason : null,
        engagedAt: typeof raw?.engaged_at === 'string' ? raw.engaged_at : null,
      }
    } catch {
      return { engaged: false, reason: null, engagedAt: null }
    }
  }

  /**
   * 緊急停止（新規作業のみ停止。実行中は完走）。
   * CLI `hermes pause` を実行する（センチネルを自前で書かない）。
   * @param {string} reason 理由
   * @param {string} by 実行者
   * @returns {Promise<object>} 結果
   */
  async function pause(reason = 'mobile', by = 'mobile') {
    const res = await runHermes(['pause', '--reason', String(reason).slice(0, 200)])
    const state = paused()
    auth.audit({ kind: 'gateway.pause', ok: res.code === 0, by, reason, state })
    if (res.code !== 0) {
      throw Object.assign(new Error((res.out || 'pause に失敗しました').slice(0, 400)), { statusCode: 502 })
    }
    return { ok: true, action: 'pause', state, output: res.out.slice(0, 400), at: Date.now() }
  }

  /**
   * 緊急停止を解除する。
   * @param {string} by 実行者
   * @returns {Promise<object>} 結果
   */
  async function resume(by = 'mobile') {
    const res = await runHermes(['resume'])
    const state = paused()
    auth.audit({ kind: 'gateway.resume', ok: res.code === 0, by, state })
    if (res.code !== 0) {
      throw Object.assign(new Error((res.out || 'resume に失敗しました').slice(0, 400)), { statusCode: 502 })
    }
    return { ok: true, action: 'resume', state, output: res.out.slice(0, 400), at: Date.now() }
  }

  /** `hermes <args>` を実行する（シェルを介さない。テストでは runner を差し替え可）。 */
  function runHermes(args) {
    if (cfg.runner) return cfg.runner(args)
    return new Promise((resolve) => {
      execFile(
        cfg.hermesBin ?? 'hermes',
        args,
        { timeout: 20_000, maxBuffer: 1_000_000, env: { ...process.env } },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })
        },
      )
    })
  }

  return { overview, gateway, paused, pause, resume }
}
