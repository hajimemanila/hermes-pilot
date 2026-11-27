import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * `hermes` CLI が入りやすいディレクトリ（PATH に載っていなくても見る）。
 *
 * 常駐（launchd / systemd）の PATH はログインシェルより狭いため、`hermes` が
 * `~/.hermes/hermes-agent/.hermes/bin` に入っている構成では `which` 相当の
 * 探索が失敗する。個人パスを焼き込まずに、よくある置き場所だけ補う。
 * @param {string} [home] ホーム
 * @returns {string[]} 候補ディレクトリ
 */
export function hermesCliDirs(home = os.homedir()) {
  return [
    path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

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
 * PATH 文字列（またはディレクトリ配列）をディレクトリ一覧にする。
 * @param {string|string[]} dirsOrPathEnv PATH 文字列かディレクトリ配列
 * @returns {string[]} ディレクトリ一覧（空要素は落とす）
 */
function toDirList(dirsOrPathEnv) {
  if (Array.isArray(dirsOrPathEnv)) return dirsOrPathEnv.map((d) => String(d ?? '')).filter(Boolean)
  return String(dirsOrPathEnv ?? '')
    .split(path.delimiter)
    .filter(Boolean)
}

/**
 * PATH（またはディレクトリ配列）から実行ファイルの**絶対パス**を返す。
 *
 * `hasBinary` の「あるか」に対して、こちらは「どこにあるか」を返す。
 * `launchd` のように PATH が狭い環境でも、見つけた実パスをそのまま
 * `execFile` に渡せるようにするための土台（シェルは介さない）。
 *
 * @param {string} name コマンド名（パス区切りを含むものは対象外）
 * @param {string|string[]} [dirsOrPathEnv] PATH 文字列かディレクトリ配列
 * @param {Function} [accessSync] 実行ビット確認の差し替え（テスト用）
 * @returns {string|null} 絶対パス（無ければ null）
 */
export function findBinaryPath(name, dirsOrPathEnv = process.env.PATH ?? '', accessSync = fs.accessSync) {
  const cmd = String(name ?? '').trim()
  if (!cmd || cmd.includes('/')) return null
  for (const dir of toDirList(dirsOrPathEnv)) {
    for (const candidate of [cmd, `${cmd}.exe`]) {
      const full = path.resolve(dir, candidate)
      try {
        accessSync(full, fs.constants.X_OK)
        return full
      } catch {
        /* 次のディレクトリへ */
      }
    }
  }
  return null
}

/**
 * 候補ディレクトリ群から実行ファイルを探す（`findBinaryPath` の薄い包み）。
 * @param {string} name コマンド名
 * @param {string[]} dirs 候補ディレクトリ
 * @param {object} [opts] 差し替え
 * @returns {string|null} 絶対パス（無ければ null）
 */
function findInDirs(name, dirs, { accessSync } = {}) {
  const find = accessSync ? (p) => findBinaryPath(name, [p], accessSync) : (p) => findBinaryPath(name, [p])
  for (const dir of dirs) {
    if (!dir) continue
    const hit = find(dir)
    if (hit) return hit
  }
  return null
}

/**
 * `hermes` CLI の実パスを解決する（PATH → 既知の置き場所 → 裸の名前）。
 *
 * 見つからなくても `'hermes'` を返す（既存の挙動を壊さない）。呼び出し側は
 * そのまま `execFile` に渡せる。
 * @param {object} [opts] 差し替え
 * @param {string} [opts.pathEnv] PATH
 * @param {string} [opts.home] ホーム（既知の置き場所の基準）
 * @param {Function} [opts.accessSync] 実行ビット確認の差し替え（テスト用）
 * @returns {string} 絶対パス、または `'hermes'`
 */
export function resolveHermesBin({ pathEnv = process.env.PATH ?? '', home = os.homedir(), accessSync } = {}) {
  const hit = findBinaryPath('hermes', pathEnv, accessSync ?? fs.accessSync) ?? findInDirs('hermes', hermesCliDirs(home), { accessSync })
  return hit ?? 'hermes'
}

/**
 * 子プロセスへ渡す `PATH` を作る（既存 PATH の末尾に既知の置き場所を足す）。
 *
 * 重複は落とし、元の PATH の順序は保つ（先頭の優先度を変えない）。
 * @param {object} [opts] 差し替え
 * @param {string} [opts.pathEnv] 元の PATH
 * @param {string} [opts.home] ホーム
 * @returns {string} 拡張した PATH
 */
export function buildAugmentedPath({ pathEnv = process.env.PATH ?? '', home = os.homedir() } = {}) {
  const out = []
  for (const dir of [...toDirList(pathEnv), ...hermesCliDirs(home)]) {
    if (dir && !out.includes(dir)) out.push(dir)
  }
  return out.join(path.delimiter)
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
 * @param {string} [opts.home] ホーム（`hermes` CLI の候補ディレクトリ用）
 * @param {Function} [opts.hasBinaryFn] 実行ファイル存在確認の差し替え（テスト用）
 * @returns {{os: string, serviceManager: string, hasTailscale: boolean, hasHermesCli: boolean, pilotServiceUnit: string}} 検出結果
 */
export function detectCapabilities({
  platform = process.platform,
  pathEnv = process.env.PATH ?? '',
  appExists,
  home,
  hasBinaryFn,
} = {}) {
  const serviceManager = serviceManagerFor(platform)
  const homeDir = home ?? os.homedir()
  const cliDirs = hermesCliDirs(homeDir)
  const find = typeof hasBinaryFn === 'function' ? hasBinaryFn : hasBinary
  return {
    os: platform,
    serviceManager,
    hasTailscale: detectTailscale({ pathEnv, appExists }),
    // PATH に無くても既知の置き場所（~/.hermes/hermes-agent/.hermes/bin 等）を見る
    hasHermesCli: find('hermes', pathEnv) || cliDirs.some((dir) => find('hermes', dir)),
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
