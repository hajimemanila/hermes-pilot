#!/usr/bin/env node
/**
 * `hermes-pilot` CLI（SPEC §8.1 / D9）。
 *
 * ```text
 * hermes-pilot init                                    初回セットアップ＋ペアリング QR
 * hermes-pilot start [--port 4097] [--host 127.0.0.1]   ブリッジを起動
 * hermes-pilot qr   [--port 4097]                      ペアリング URL と QR を表示
 * hermes-pilot service install|uninstall|restart|status 常駐化（launchd / systemd --user）
 * hermes-pilot migrate                                旧 akapen / mobile-pwa からの移行
 * ```
 *
 * 設計メモ:
 * - **依存ゼロ**。QR は `apps/bridge/src/qr.js`（自作エンコーダ）、サービス定義は文字列生成。
 * - データ先は `~/.hermes/plugin-data/hermes-pilot/`（`HP_DATA_DIR` / `HM_DATA` で上書き可）。
 * - 旧 `ai.hermes.hermes-mobile` は**止めない**。新ラベル `ai.hermes.pilot` を併設し、
 *   README の移行手順で切り替える（HEADS-UP）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectPairing, qrSvg, qrTerminal, tailscaleCommandCandidates } from '../apps/bridge/src/qr.js'

/** リポジトリのルート（このファイルは `bin/` の下）。 */
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** macOS の launchd ラベル（旧 `ai.hermes.hermes-mobile` とは別物）。 */
export const SERVICE_LABEL = 'ai.hermes.pilot'

/** Linux の systemd --user ユニット名。 */
export const SYSTEMD_UNIT = 'hermes-pilot.service'

/** 既定の待受。 */
export const DEFAULT_PORT = 4097
export const DEFAULT_HOST = '127.0.0.1'

/** 同梱スキル（`hermes-pilot init` で `~/.hermes/skills/` へ配置する）。 */
export const BUNDLED_SKILLS = ['quick-review', 'annotation']

/**
 * `HERMES_HOME` の補正（`scripts/migrate-to-hermes-pilot.mjs` の同名関数と同じ規則）。
 *
 * worker / cron からは `HERMES_HOME` がプロファイルディレクトリ
 * （`~/.hermes/profiles/<name>`）を指すことがある。その時は 2 つ上を Hermes ホームとして扱う。
 * ここで重複定義しているのは、`node:sqlite` を使う migrate モジュールを
 * `--help` / `qr` / `service status` のたびに読み込まない（ExperimentalWarning を出さない）ため。
 * @param {string} raw 生のパス
 * @param {string} home ホーム
 * @returns {string} 正規化した Hermes ホーム
 */
export function resolveHermesHome(raw, home = os.homedir()) {
  const abs = path.resolve(String(raw).replace(/^~/, home))
  if (path.basename(path.dirname(abs)) === 'profiles') return path.dirname(path.dirname(abs))
  return abs
}

/**
 * データ先の解決（`apps/bridge/src/config.js` と同じ規則 + プロファイル補正）。
 * @param {object} [env] 環境変数
 * @returns {{home: string, hermesHome: string, pluginDataDir: string, dataDir: string, tokenPath: string, reviewDir: string, configPath: string, skillsDir: string, logDir: string}} パス
 */
export function resolvePaths(env = process.env) {
  const home = env.HOME ?? os.homedir()
  const hermesHome = resolveHermesHome(env.HERMES_HOME ?? path.join(home, '.hermes'), home)
  const pluginDataDir = env.HP_DATA_DIR ?? path.join(hermesHome, 'plugin-data', 'hermes-pilot')
  const dataDir = env.HM_DATA ?? pluginDataDir
  return {
    home,
    hermesHome,
    pluginDataDir,
    dataDir,
    tokenPath: path.join(dataDir, 'token'),
    configPath: path.join(dataDir, 'config.json'),
    reviewDir: path.join(pluginDataDir, 'review'),
    skillsDir: path.join(hermesHome, 'skills'),
    logDir: path.join(hermesHome, 'logs'),
  }
}

/**
 * 引数を `{ command, flags, rest }` に分解する（`--key value` と `--key=value` の両方）。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{command: string, sub: string|null, flags: Record<string, string|boolean>, rest: string[]}} 解析結果
 */
export function parseArgv(argv = []) {
  const args = argv.filter((a) => typeof a === 'string')
  const flags = {}
  const rest = []
  let command = ''
  let sub = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
      } else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-') && ['port', 'host', 'tls-port', 'home'].includes(body)) {
          flags[body] = next
          i++
        } else {
          flags[body] = true
        }
      }
      continue
    }
    if (!command) {
      command = a
      continue
    }
    if (!sub) {
      sub = a
      continue
    }
    rest.push(a)
  }
  return { command, sub, flags, rest }
}

/** ヘルプ。 */
export function helpText() {
  return [
    'hermes-pilot — control your Hermes Agent from your phone or tablet',
    '',
    'Usage:',
    '  hermes-pilot init                        First-run setup: data dirs, token, skills, pairing QR',
    '  hermes-pilot start [--port 4097] [--host 127.0.0.1] [--tls-port 8444]',
    '                                           Build the UI if needed and run the bridge',
    '  hermes-pilot qr [--port 4097] [--tls-port 8444]',
    '                                           Print the pairing URL and a terminal QR',
    '  hermes-pilot service install|uninstall|restart|status [--dry-run]',
    '                                           Keep the bridge running (launchd / systemd --user)',
    '  hermes-pilot migrate                     Copy data from the old akapen / mobile-pwa layout',
    '  hermes-pilot --help                      Show this help',
    '',
    '環境 / Environment:',
    '  HERMES_HOME   Hermes home (default ~/.hermes)',
    '  HP_DATA_DIR   Plugin data dir (default ~/.hermes/plugin-data/hermes-pilot)',
    '',
    'データ先 / Data: ~/.hermes/plugin-data/hermes-pilot/',
    '既存の ai.hermes.hermes-mobile は止めません（新ラベル ai.hermes.pilot を併設）。',
  ].join('\n')
}

/**
 * トークンを用意する（無ければ 256-bit hex を 0600 で作る）。
 * @param {string} tokenPath トークンファイル
 * @param {object} [opts] オプション
 * @param {boolean} [opts.create] 無いときに作るか
 * @returns {{token: string|null, created: boolean}} 結果
 */
export function ensureToken(tokenPath, { create = true } = {}) {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing) return { token: existing, created: false }
  } catch {
    /* 初回 */
  }
  if (!create) return { token: null, created: false }
  const token = crypto.randomBytes(32).toString('hex') // 256-bit
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  try {
    fs.chmodSync(tokenPath, 0o600)
  } catch {
    /* 既に 0600 でない FS でも続ける */
  }
  return { token, created: true }
}

/**
 * `tailscale status --json` を読む（無い環境では null）。CLI では同期で十分。
 * @returns {string|null} 生 JSON
 */
export function readTailscaleStatus() {
  for (const bin of tailscaleCommandCandidates()) {
    try {
      const text = String(
        execFileSync(bin, ['status', '--json'], { timeout: 1500, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }),
      )
      if (text.trim()) return text
    } catch {
      /* 次の候補（PATH に無い macOS アプリ版など）へ */
    }
  }
  return null
}

/**
 * 設定ファイル（`config.json`）を読む。無ければ既定。
 * @param {string} configPath パス
 * @returns {{lang: string, scanDirs: string[], servicePort: number, tlsPort: number|null, tailscaleDns: string|null}} 設定
 */
export function readConfig(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return {
      lang: typeof raw?.lang === 'string' ? raw.lang : 'en',
      scanDirs: Array.isArray(raw?.scanDirs) ? raw.scanDirs : ['~/Projects', '~/projects'],
      servicePort: Number(raw?.servicePort) || DEFAULT_PORT,
      // Tailscale serve が 443 以外に出す構成（`tailscale serve --https=8444` 等）向け
      tlsPort: Number(raw?.tlsPort) || null,
      // 常駐（launchd）からアプリ版 Tailscale を叩けない環境の控え
      tailscaleDns: typeof raw?.tailscaleDns === 'string' && raw.tailscaleDns.trim() ? raw.tailscaleDns.trim() : null,
    }
  } catch {
    return { lang: 'en', scanDirs: ['~/Projects', '~/projects'], servicePort: DEFAULT_PORT, tlsPort: null, tailscaleDns: null }
  }
}

/**
 * launchd の plist を組み立てる（macOS）。
 * @param {object} opts 入力
 * @param {string} opts.label ラベル
 * @param {string} opts.node node の実行パス
 * @param {string} opts.cli CLI の絶対パス
 * @param {number} opts.port 待受ポート
 * @param {string} opts.host 待受ホスト
 * @param {string} opts.hermesHome HERMES_HOME
 * @param {string} opts.logDir ログ出力先
 * @param {string} opts.workdir 作業ディレクトリ
 * @returns {string} plist XML
 */
export function buildLaunchdPlist({ label, node, cli, port, host, hermesHome, logDir, workdir }) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(cli)}</string>
    <string>start</string>
    <string>--port</string>
    <string>${esc(port)}</string>
    <string>--host</string>
    <string>${esc(host)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${esc(workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERMES_HOME</key>
    <string>${esc(hermesHome)}</string>
    <key>PATH</key>
    <string>${esc(path.join(hermesHome, 'hermes-agent', '.hermes', 'bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(path.join(logDir, 'pilot.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(logDir, 'pilot.err.log'))}</string>
</dict>
</plist>
`
}

/**
 * systemd --user のユニットを組み立てる（Linux）。
 * @param {object} opts 入力（`buildLaunchdPlist` と同じ項目）
 * @returns {string} unit ファイル
 */
export function buildSystemdUnit({ node, cli, port, host, hermesHome, workdir }) {
  return `[Unit]
Description=Hermes Pilot bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=${workdir}
Environment=HERMES_HOME=${hermesHome}
ExecStart=${node} ${cli} start --port ${port} --host ${host}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`
}

/** 配列を改行付きで出力する。 */
function out(...lines) {
  console.log(lines.join('\n'))
}

/**
 * ペアリング情報をまとめて表示用にする。
 * @param {object} opts 入力
 * @param {string} opts.token トークン
 * @param {number} opts.port ポート
 * @returns {{targets: Array<object>, best: object|null, dnsName: string|null, lanIp: string|null}} 情報
 */
export function pairingInfo({ token, port, tlsPort = null, dnsName = null }) {
  return collectPairing({ token, port, tlsPort, dnsName, tailscaleJson: readTailscaleStatus() })
}

/**
 * ペアリング URL と QR を表示する。
 * @param {object} opts 入力
 * @param {string} opts.token トークン
 * @param {number} opts.port ポート
 * @param {boolean} [opts.svg] SVG も 1 行で出す
 */
function printPairing({ token, port, tlsPort = null, dnsName = null, svg = false }) {
  const info = pairingInfo({ token, port, tlsPort, dnsName })
  out('', '接続先候補 / Pairing targets:')
  for (const t of info.targets) out(`  - ${t.label}: ${t.url}`)
  if (!info.best) {
    out('', '到達可能なアドレスがありません（Tailscale か LAN を確認してください）。')
    return
  }
  out('', `QR（${info.best.label}）— カメラで読み取ってください:`, '')
  out(qrTerminal(info.best.url))
  if (svg) out('', qrSvg(info.best.url))
}

/**
 * 旧環境が残っているか（自動 migrate の判定）。
 * @param {object} p `resolvePaths()` の結果
 * @returns {boolean} 残っていれば true
 */
function hasLegacyEnv(p) {
  return [
    path.join(p.home, 'Projects', 'akapen'),
    path.join(p.home, 'projects', 'akapen'),
    path.join(p.hermesHome, 'mobile-pwa'),
    path.join(p.hermesHome, 'plugin-data', 'akapen'),
  ].some((dir) => fs.existsSync(dir))
}

/**
 * `init` の本体（冪等）。
 * @param {object} p `resolvePaths()` の結果
 * @param {number} port ポート
 * @returns {{created: boolean, migrated: boolean, skills: string[]}} 結果
 */
export async function runInit(p, port, { tlsPort = null } = {}) {
  fs.mkdirSync(p.dataDir, { recursive: true, mode: 0o700 })
  for (const sub of ['sheets', 'shots', 'library']) {
    fs.mkdirSync(path.join(p.reviewDir, sub), { recursive: true })
  }
  fs.mkdirSync(p.logDir, { recursive: true })
  if (!fs.existsSync(p.configPath)) {
    fs.writeFileSync(p.configPath, `${JSON.stringify({ lang: 'en', scanDirs: ['~/Projects', '~/projects'], servicePort: port }, null, 2)}\n`)
  }
  const { created } = ensureToken(p.tokenPath)

  let migrated = false
  if (hasLegacyEnv(p)) {
    const { migrate, formatReport } = await loadMigrate()
    const report = migrate({ home: p.home, hermesHome: p.hermesHome, pluginDataDir: p.pluginDataDir })
    out('旧環境が見つかったので移行しました / Migrated legacy data:', '', formatReport(report))
    migrated = true
  }

  const installed = []
  for (const name of BUNDLED_SKILLS) {
    const src = path.join(ROOT, 'skills', name)
    const dest = path.join(p.skillsDir, name)
    if (!fs.existsSync(src)) continue
    try {
      fs.cpSync(src, dest, { recursive: true, force: false, preserveTimestamps: true })
      installed.push(dest)
    } catch (err) {
      out(`  ! skill ${name}: ${err?.message ?? err}`)
    }
  }
  out(
    '',
    'hermes-pilot init 完了 / done',
    `  データ / data : ${p.dataDir}`,
    `  トークン / token: ${p.tokenPath}${created ? '（新規作成 0600）' : '（既存）'}`,
    `  スキル / skills: ${installed.length ? installed.join(', ') : '（既に配置済み）'}`,
    `  移行 / migrate: ${migrated ? '実行' : '不要'}`,
  )
  printPairing({ token: ensureToken(p.tokenPath).token, port, tlsPort })
  return { created, migrated, skills: installed }
}

// migrate モジュールは CLI 実行時にだけ遅延ロードする（テストの import を軽くする）
let migrateModule = {}
const loadMigrate = async () => {
  if (!migrateModule.migrate) migrateModule = await import('../scripts/migrate-to-hermes-pilot.mjs')
  return migrateModule
}

/** launchd の状態（`launchctl print` の終了コード）。 */
function launchdLoaded(label) {
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${label}`], { encoding: 'utf8' })
  return { loaded: r.status === 0, code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/**
 * `service` サブコマンド。
 * @param {string|null} sub install|uninstall|restart|status
 * @param {object} opts 入力
 * @param {object} opts.paths `resolvePaths()`
 * @param {number} opts.port ポート
 * @param {string} opts.host ホスト
 * @param {boolean} opts.dryRun 書き込まない
 * @returns {number} 終了コード
 */
export function runService(sub, { paths, port, host, dryRun = false }) {
  const platform = process.platform
  if (platform === 'darwin') {
    const plistPath = path.join(paths.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    const uid = process.getuid?.() ?? 501
    const domain = `gui/${uid}`
    if (sub === 'install') {
      const body = buildLaunchdPlist({
        label: SERVICE_LABEL,
        node: process.execPath,
        cli: path.join(ROOT, 'bin', 'hermes-pilot.mjs'),
        port,
        host,
        hermesHome: paths.hermesHome,
        logDir: paths.logDir,
        workdir: ROOT,
      })
      out(`plist: ${plistPath}`)
      if (dryRun) {
        out(body)
        return 0
      }
      fs.mkdirSync(path.dirname(plistPath), { recursive: true })
      fs.mkdirSync(paths.logDir, { recursive: true })
      fs.writeFileSync(plistPath, body, { mode: 0o644 })
      const boot = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
      if (boot.status !== 0) {
        // 既に読み込まれている場合は kickstart で反映する
        const kick = spawnSync('launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`], { encoding: 'utf8' })
        out(`launchctl bootstrap: ${(boot.stderr || boot.stdout || '').trim() || 'already loaded'}`)
        out(`launchctl kickstart: exit ${kick.status}`)
      } else {
        out(`launchctl bootstrap: ok（${domain}）`)
      }
      out(`常駐を開始しました / service installed: ${SERVICE_LABEL}`)
      return 0
    }
    if (sub === 'uninstall') {
      out(`plist: ${plistPath}`)
      if (dryRun) return 0
      const r = spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { encoding: 'utf8' })
      out(`launchctl bootout: exit ${r.status}`)
      try {
        fs.rmSync(plistPath, { force: true })
        out('plist を削除しました')
      } catch (err) {
        out(`plist の削除に失敗: ${err?.message ?? err}`)
      }
      out('旧 ai.hermes.hermes-mobile はそのままです（必要なら手動で bootout）。')
      return 0
    }
    if (sub === 'restart') {
      if (dryRun) {
        out(`launchctl kickstart -k ${domain}/${SERVICE_LABEL}`)
        return 0
      }
      const r = spawnSync('launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`], { encoding: 'utf8' })
      out(`launchctl kickstart: exit ${r.status}${r.stderr ? ` (${r.stderr.trim()})` : ''}`)
      return r.status === 0 ? 0 : 1
    }
    if (sub === 'status' || !sub) {
      const st = launchdLoaded(SERVICE_LABEL)
      out(`service: ${SERVICE_LABEL}`)
      out(`plist: ${plistPath}${fs.existsSync(plistPath) ? '（あり）' : '（なし）'}`)
      out(st.loaded ? '状態 / state: running' : '状態 / state: not installed（hermes-pilot service install）')
      return 0
    }
    out(`unknown service subcommand: ${sub}`)
    return 2
  }

  // Linux / その他は systemd --user
  const unitDir = path.join(paths.home, '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, SYSTEMD_UNIT)
  const sys = (args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
  if (sub === 'install') {
    const body = buildSystemdUnit({
      node: process.execPath,
      cli: path.join(ROOT, 'bin', 'hermes-pilot.mjs'),
      port,
      host,
      hermesHome: paths.hermesHome,
      workdir: ROOT,
    })
    out(`unit: ${unitPath}`)
    if (dryRun) {
      out(body)
      return 0
    }
    fs.mkdirSync(unitDir, { recursive: true })
    fs.mkdirSync(paths.logDir, { recursive: true })
    fs.writeFileSync(unitPath, body)
    const daemon = sys(['daemon-reload'])
    const enable = sys(['enable', '--now', SYSTEMD_UNIT])
    out(`systemctl --user daemon-reload: exit ${daemon.status}`)
    out(`systemctl --user enable --now: exit ${enable.status}`)
    return enable.status === 0 ? 0 : 1
  }
  if (sub === 'uninstall') {
    if (dryRun) {
      out(`systemctl --user disable --now ${SYSTEMD_UNIT} && rm ${unitPath}`)
      return 0
    }
    const r = sys(['disable', '--now', SYSTEMD_UNIT])
    out(`systemctl --user disable --now: exit ${r.status}`)
    try {
      fs.rmSync(unitPath, { force: true })
    } catch {
      /* 既に無い */
    }
    return 0
  }
  if (sub === 'restart') {
    if (dryRun) {
      out(`systemctl --user restart ${SYSTEMD_UNIT}`)
      return 0
    }
    const r = sys(['restart', SYSTEMD_UNIT])
    out(`systemctl --user restart: exit ${r.status}`)
    return r.status === 0 ? 0 : 1
  }
  if (sub === 'status' || !sub) {
    const r = sys(['is-active', SYSTEMD_UNIT])
    out(`service: ${SYSTEMD_UNIT}`)
    out(`unit: ${unitPath}${fs.existsSync(unitPath) ? '（あり）' : '（なし）'}`)
    out(`状態 / state: ${String(r.stdout ?? '').trim() || 'unknown'}（exit ${r.status}）`)
    return 0
  }
  out(`unknown service subcommand: ${sub}`)
  return 2
}

/**
 * `start` の本体。UI が無ければビルドし、ブリッジを起動する。
 * @param {object} opts 入力
 * @param {object} opts.paths `resolvePaths()`
 * @param {number} opts.port ポート
 * @param {string} opts.host ホスト
 * @param {boolean} [opts.noQr] QR を出さない
 * @returns {Promise<void>}
 */
export async function runStart({ paths, port, host, tlsPort = null, dnsName = null, noQr = false }) {
  const index = path.join(ROOT, 'apps', 'web', 'dist', 'index.html')
  if (!fs.existsSync(index)) {
    out('UI が未ビルドなのでビルドします / building the UI…')
    const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (build.status !== 0) {
      out('ビルドに失敗しました / build failed')
      process.exit(1)
    }
  }
  const { token } = ensureToken(paths.tokenPath)
  if (!noQr) printPairing({ token, port, tlsPort, dnsName })
  process.env.HM_PORT = String(port)
  process.env.HM_HOST = host
  if (!process.env.HERMES_HOME) process.env.HERMES_HOME = paths.hermesHome
  await import(path.join(ROOT, 'apps', 'bridge', 'src', 'server.js'))
}

/**
 * CLI のエントリ。
 * @param {string[]} [argv] 引数（テスト用）
 * @returns {Promise<number>} 終了コード
 */
export async function main(argv = process.argv.slice(2)) {
  const { command, sub, flags } = parseArgv(argv)
  const paths = resolvePaths(process.env)
  const cfg = readConfig(paths.configPath)
  const port = Number(flags.port) || cfg.servicePort || DEFAULT_PORT
  const tlsPort = Number(flags['tls-port']) || cfg.tlsPort || null
  const dnsName = cfg.tailscaleDns || null
  const host = typeof flags.host === 'string' ? flags.host : DEFAULT_HOST
  const dryRun = Boolean(flags['dry-run'])

  if (!command || command === 'help' || flags.help || flags.h) {
    out(helpText())
    return 0
  }

  if (command === 'init') {
    await runInit(paths, port, { tlsPort })
    return 0
  }

  if (command === 'qr') {
    const { token, created } = ensureToken(paths.tokenPath)
    if (created) out(`トークンを新規作成しました / token created: ${paths.tokenPath}`)
    printPairing({ token, port, tlsPort, dnsName, svg: Boolean(flags.svg) })
    return 0
  }

  if (command === 'start') {
    await runStart({ paths, port, host, tlsPort, dnsName, noQr: Boolean(flags['no-qr']) })
    return 0
  }

  if (command === 'service') {
    return runService(sub, { paths, port, host, dryRun })
  }

  if (command === 'migrate') {
    const mod = await loadMigrate()
    const report = mod.migrate({ home: paths.home, hermesHome: paths.hermesHome, pluginDataDir: paths.pluginDataDir })
    out(mod.formatReport(report))
    return 0
  }

  out(`unknown command: ${command}`, '', helpText())
  return 2
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main()
    .then((code) => {
      if (code) process.exit(code)
    })
    .catch((err) => {
      console.error(`[hermes-pilot] ${err?.stack ?? err}`)
      process.exit(1)
    })
}

