import path from 'node:path'
import os from 'node:os'

export const VERSION = '0.1.0'

/**
 * ブリッジの設定。既存の Hermes ダッシュボード（9119）は変更しない前提。
 * @returns {object} 設定
 */
export function loadConfig() {
  const home = process.env.HOME ?? os.homedir()
  const hermesHome = process.env.HERMES_HOME ?? path.join(home, '.hermes')
  const dataDir = process.env.HM_DATA ?? path.join(hermesHome, 'mobile-pwa')
  return {
    version: VERSION,
    home,
    host: process.env.HM_HOST ?? '127.0.0.1',
    port: Number(process.env.HM_PORT ?? 4097),
    /** 変更しない既存サーバ */
    hermesBase: process.env.HERMES_BASE ?? 'http://127.0.0.1:9119',
    hermesHome,
    kanbanRoot: path.join(hermesHome, 'kanban'),
    kanbanDb: path.join(hermesHome, 'kanban.db'),
    logDir: path.join(hermesHome, 'logs'),
    dataDir,
    tokenPath: path.join(dataDir, 'token'),
    auditPath: path.join(dataDir, 'audit.jsonl'),
    cookieName: 'hm_session',
    /** 端末セッションの有効期間（30日） */
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    distDir: path.resolve(import.meta.dirname, '../../web/dist'),
    /** ポーリング前提の軽量 API なので素直に制限する */
    rate: { windowMs: 60_000, maxWrites: 60 },
  }
}
