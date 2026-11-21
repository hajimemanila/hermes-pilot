import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { DEFAULT_PILOT_PROFILE, sanitizePilotProfile } from './pipeline-optimizer.js'

export const VERSION = '0.1.0'

/**
 * `config.json` から Pilot / A2B パイプライン専用のプロファイル名を読む。
 * 未設定時は `HP_PILOT_PROFILE` → `HP_REVIEW_ASSIGNEE` → `'mobile'`。
 * @param {string} configPath config.json のパス
 * @returns {string} プロファイル名
 */
export function readPilotProfile(configPath) {
  let rawProfile = null
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (typeof raw?.pilotProfile === 'string' && raw.pilotProfile.trim()) {
      rawProfile = raw.pilotProfile
    }
  } catch {
    /* 不在・壊れた JSON は環境変数／既定へ */
  }
  if (rawProfile) return sanitizePilotProfile(rawProfile)
  const fromEnv = process.env.HP_PILOT_PROFILE ?? process.env.HP_REVIEW_ASSIGNEE
  if (typeof fromEnv === 'string' && fromEnv.trim()) return sanitizePilotProfile(fromEnv)
  return DEFAULT_PILOT_PROFILE
}

/**
 * `config.json` の `pilotProfile` を非破壊で保存する（他キーは維持）。
 * @param {string} configPath config.json のパス
 * @param {unknown} profile 保存したいプロファイル名
 * @returns {string} 保存されたプロファイル名
 */
export function writePilotProfile(configPath, profile) {
  const next = sanitizePilotProfile(profile)
  let current = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
  } catch {
    current = {}
  }
  const merged = { ...current, pilotProfile: next }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
  const tmp = `${configPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, configPath)
  return next
}

/**
 * `config.json`（CLI が書く設定）からペアリング用の値だけ拾う。
 *
 * `tailscaleDns` / `tlsPort` は、常駐プロセスから Tailscale CLI を叩けない環境
 * （macOS アプリ版は launchd から実行すると GUI 起動に失敗する）で
 * ペアリング URL を正しく出すための控え。壊れていても起動は止めない。
 * @param {string} configPath config.json のパス
 * @returns {{tailscaleDns: string|null, tlsPort: number|null}} 値
 */
export function readPairingConfig(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const dns = typeof raw?.tailscaleDns === 'string' ? raw.tailscaleDns.trim().replace(/\.$/, '') : ''
    const tlsPort = Number(raw?.tlsPort)
    return { tailscaleDns: dns || null, tlsPort: Number.isFinite(tlsPort) && tlsPort > 0 ? tlsPort : null }
  } catch {
    return { tailscaleDns: null, tlsPort: null }
  }
}

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
  const configPath = path.join(pluginDataDir, 'config.json')
  const pairing = readPairingConfig(configPath)
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
    /** CLI が書く設定（lang / scanDirs / servicePort / tlsPort / tailscaleDns） */
    configPath,
    /** ペアリング URL の控え（Tailscale CLI を叩けない常駐環境向け, SPEC §8.2） */
    pairing,
    cookieName: 'hm_session',
    /** 端末セッションの有効期間（30日） */
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    distDir: path.resolve(import.meta.dirname, '../../web/dist'),
    /** ポーリング前提の軽量 API なので素直に制限する */
    rate: { windowMs: 60_000, maxWrites: 60 },
  }
}
