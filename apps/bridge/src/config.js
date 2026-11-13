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
  // 公開プラグインのデータ先（D1 / §3.2）。token・audit・snippets・repos.json はここへ一本化する。
  const pluginDataDir =
    process.env.HP_DATA_DIR ?? path.join(hermesHome, 'plugin-data', 'hermes-pilot')
  // 旧 `mobile-pwa` を指したい検証用に HM_DATA も受けるが、既定は hermes-pilot。
  const dataDir = process.env.HM_DATA ?? pluginDataDir
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
    /** 会話ログ（セッション横断検索の対象。読取専用で開く） */
    stateDb: process.env.HM_STATE_DB ?? path.join(hermesHome, 'state.db'),
    logDir: path.join(hermesHome, 'logs'),
    dataDir,
    pluginDataDir,
    /** レビューワークスペース（sheets / shots / library / feed.jsonl 等） */
    reviewDir: path.join(pluginDataDir, 'review'),
    /** リポジトリ設定（scanDirs / pinned / hidden / custom） */
    reposPath: process.env.HP_REPOS_JSON ?? path.join(pluginDataDir, 'repos.json'),
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
