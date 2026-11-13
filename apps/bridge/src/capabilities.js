import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 実行環境の Capability（能力）検出。
 *
 * 公開プラグインとして「どこでも単体で動く」ために、個人環境の前提
 * （macOS の launchd 固定・Tailscale 常備・`hermes` CLI の存在）を
 * **ハードコードせず、起動時に測って分岐する**ための土台。
 *
 * 返す形（`GET /api/capabilities`）:
 * ```json
 * { "os": "darwin", "serviceManager": "launchd", "hasTailscale": true,
 *   "hasHermesCli": true, "pilotServiceUnit": "ai.hermes.pilot" }
 * ```
 */

/** OS ごとの常駐ユニット名（D9 のサービス登録名と一致させる）。 */
export const PILOT_UNITS = {
  darwin: 'ai.hermes.pilot',
  linux: 'hermes-pilot.service',
}

/** サービス管理系の既定ユニット名。 */
export const DEFAULT_PILOT_UNIT = 'hermes-pilot.service'

/**
 * OS → サービス管理方式。
 * @param {string} [platform] `process.platform`
 * @returns {'launchd'|'systemd'|'none'} 方式
 */
export function serviceManagerFor(platform = process.platform) {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux') return 'systemd'
  return 'none'
}

/**
 * PATH 上の実行ファイルの存在確認（`which` を spawn しない）。
 * @param {string} name コマンド名
 * @param {string} [pathEnv] PATH 文字列
 * @returns {boolean} 見つかれば true
 */
export function hasBinary(name, pathEnv = process.env.PATH ?? '') {
  const cmd = String(name ?? '').trim()
  if (!cmd || cmd.includes('/')) return false
  for (const dir of String(pathEnv).split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of [cmd, `${cmd}.exe`]) {
      try {
        fs.accessSync(path.join(dir, candidate), fs.constants.X_OK)
        return true
      } catch {
        /* 次のディレクトリへ */
      }
    }
  }
  return false
}

/**
 * Tailscale の有無（CLI か macOS アプリのどちらか）。
 * @param {object} [opts] 差し替え（テスト用）
 * @param {string} [opts.pathEnv] PATH
 * @param {boolean} [opts.appExists] アプリの存在を上書き
 * @returns {boolean} あれば true
 */
export function detectTailscale({ pathEnv = process.env.PATH ?? '', appExists } = {}) {
  if (hasBinary('tailscale', pathEnv)) return true
  const appPaths = [
    '/Applications/Tailscale.app',
    path.join(os.homedir(), 'Applications/Tailscale.app'),
  ]
  const exists = typeof appExists === 'function' ? appExists : (p) => fs.existsSync(p)
  return appPaths.some((p) => exists(p))
}

/**
 * サービス再起動・状態確認コマンド（`term-snippets.js` が使う）。
 * 個人環境のサービスラベルは使わない。
 * @param {{serviceManager?: string, pilotServiceUnit?: string}} caps Capability
 * @returns {{restart: string, status: string, list: string}} コマンド
 */
export function serviceCommands(caps = {}) {
  const unit = String(caps.pilotServiceUnit || DEFAULT_PILOT_UNIT)
  if (caps.serviceManager === 'launchd') {
    return {
      restart: `launchctl kickstart -k gui/$(id -u)/${unit}`,
      status: `launchctl print gui/$(id -u)/${unit} | head -20`,
      list: 'launchctl list | grep -i hermes',
    }
  }
  return {
    restart: `systemctl --user restart ${unit}`,
    status: `systemctl --user status ${unit} --no-pager | head -20`,
    list: "systemctl --user list-units 'hermes*' --no-pager",
  }
}

/**
 * Capability を検出する（純粋に近い。テストでは引数で固定する）。
 * @param {object} [opts] 差し替え
 * @param {string} [opts.platform] `process.platform`
 * @param {string} [opts.pathEnv] PATH
 * @param {Function} [opts.appExists] アプリ存在確認
 * @returns {{os: string, serviceManager: string, hasTailscale: boolean, hasHermesCli: boolean, pilotServiceUnit: string}} 検出結果
 */
export function detectCapabilities({ platform = process.platform, pathEnv = process.env.PATH ?? '', appExists } = {}) {
  const serviceManager = serviceManagerFor(platform)
  return {
    os: platform,
    serviceManager,
    hasTailscale: detectTailscale({ pathEnv, appExists }),
    hasHermesCli: hasBinary('hermes', pathEnv),
    pilotServiceUnit: PILOT_UNITS[platform] ?? DEFAULT_PILOT_UNIT,
  }
}

let cached = null

/**
 * 起動時に 1 度だけ検出してキャッシュする（`GET /api/capabilities` 用）。
 * @param {object} [opts] 差し替え（テスト用）
 * @returns {object} Capability
 */
export function getCapabilities(opts) {
  if (!cached || opts) cached = detectCapabilities(opts)
  return cached
}

/** テスト用にキャッシュを捨てる。 */
export function resetCapabilitiesCache() {
  cached = null
}
