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
import readline from 'node:readline'
import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectPairing, qrPng, qrSvg, qrTerminal, tailscaleCommandCandidates } from '../apps/bridge/src/qr.js'
import { createPairCodes } from '../apps/bridge/src/pair-codes.js'

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
export const BUNDLED_SKILLS = ['quick-review', 'annotation', 'spec-architect']

/** 標準ダッシュボード（:9119）に出すタブのプラグイン名。 */
export const DASHBOARD_PLUGIN = 'hermes-pilot'

/**
 * ダッシュボード・プラグインの配置表（リポジトリ内 → `~/.hermes/plugins/hermes-pilot/`）。
 *
 * 標準ダッシュボードは `<plugins>/<name>/dashboard/manifest.json` を走査し、
 * `manifest.json` の `entry` / `css` を `dashboard/` からの相対パスとして配信する
 * （`hermes_cli/web_server_dashboard.py`）。リポジトリでは編集しやすいよう
 * `apps/dashboard/` 直下に置き、`init` が `dashboard/` と `dist/` の形へ写す。
 */
export const DASHBOARD_FILES = [
  { from: 'plugin.yaml', to: 'plugin.yaml' },
  // ユーザープラグインの dashboard バックエンドは「本物の・有効なプラグイン」でないと
  // マウントされない（`hermes_cli/web_server_dashboard.py` → `_plugin_api_mount_skip_reason`）。
  // `hermes plugins enable hermes-pilot` が名前を解決できるよう、no-op の `register` を置く。
  { from: 'apps/dashboard/plugin_init.py', to: '__init__.py' },
  { from: 'apps/dashboard/manifest.json', to: 'dashboard/manifest.json' },
  { from: 'apps/dashboard/plugin_api.py', to: 'dashboard/plugin_api.py' },
  { from: 'apps/dashboard/pilot_dashboard.py', to: 'dashboard/pilot_dashboard.py' },
  { from: 'apps/dashboard/index.js', to: 'dashboard/dist/index.js' },
  { from: 'apps/dashboard/style.css', to: 'dashboard/dist/style.css' },
]

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
        if (next !== undefined && !next.startsWith('-') && ['port', 'host', 'tls-port', 'home', 'target-dir'].includes(body)) {
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
    '  hermes-pilot init [--force] [--target-dir <plugin dir>] [--yes]',
    '                                           First-run setup: data dirs, token, skills, dashboard tab, pairing QR',
    '                                           --target-dir: where `hermes plugins install` unpacked this repo',
    '                                           --yes: migrate legacy akapen/mobile-pwa data without asking',
    '  hermes-pilot start [--port 4097] [--host 127.0.0.1] [--tls-port 8444]',
    '                                           Build the UI if needed and run the bridge',
    '  hermes-pilot qr [--port 4097] [--tls-port 8444] [--png <path>]',
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
        execFileSync(bin, ['status', '--json'], {
          timeout: 1500,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
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
 * ワンタイム・ペアリングコードを発行して注意書きを出す。
 *
 * 本トークン（64 文字）を URL に載せると QR が高密度になり、端末 80x24 では
 * 行が溢れてカメラが読めない。短いコード（8 文字）で QR を粗くする。
 * @param {string} dataDir データ先（`pair-codes.json` を置く）
 * @returns {string} 発行したコード
 */
export function mintPairCode(dataDir) {
  const { code, expiresAt } = createPairCodes({ dataDir }).mint()
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000))
  out('', `ワンタイムコード / one-time code: ${code}（${minutes} 分有効・1 回限り）`)
  return code
}

/**
 * ペアリング URL と QR を表示する。
 * @param {object} opts 入力
 * @param {string} opts.token トークン
 * @param {number} opts.port ポート
 * @param {boolean} [opts.svg] SVG も 1 行で出す
 */
function printPairing({ token, port, tlsPort = null, dnsName = null, svg = false, pngPath = null }) {
  const info = pairingInfo({ token, port, tlsPort, dnsName })
  out('', '接続先候補 / Pairing targets:')
  for (const t of info.targets) out(`  - ${t.label}: ${t.url}`)
  if (!info.best) {
    out('', '到達可能なアドレスがありません（Tailscale か LAN を確認してください）。')
    return
  }
  // 端末の半角ブロックは行間が塗られず、カメラから見ると暗い横縞が QR を横切るため
  // 読み取れない（実測: 別端末のスキャナも無反応）。PNG を書いて**画像として**出す。
  if (pngPath) {
    try {
      const png = qrPng(info.best.url)
      fs.mkdirSync(path.dirname(pngPath), { recursive: true })
      fs.writeFileSync(pngPath, png, { mode: 0o600 })
      out('', `QR 画像 / PNG: ${pngPath}`, `  → これを大きく開いてカメラで読み取ってください（${png.length} bytes）。`)
    } catch (err) {
      out('', `QR 画像を書けませんでした: ${err?.message ?? err}`)
    }
  }
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  // 端末に収まらない QR を出すと、行が折り返すか上にスクロールして欠けたコードになる（実測:
  // 64 文字トークンの URL は 27 行になり 80x24 で読めなかった）。収まる候補を選び、
  // どれも収まらないときは PNG の案内だけにする。
  const dims = (s) => {
    const lines = s.split('\n')
    return { width: lines[0].replace(/\x1b\[[0-9;]*m/g, '').length, height: lines.length }
  }
  const fits = (s) => {
    const d = dims(s)
    return d.width <= cols - 2 && d.height <= rows - 6
  }
  let pick = info.targets[0]
  let qr = qrTerminal(pick.url)
  if (!fits(qr)) {
    // 短い候補（LAN など）なら端末に収まる
    for (const t of info.targets) {
      const candidate = qrTerminal(t.url)
      if (fits(candidate)) {
        pick = t
        qr = candidate
        break
      }
    }
  }
  if (!fits(qr)) {
    const d = dims(qrTerminal(info.best.url))
    out(
      '',
      `端末 QR はこの端末（${cols}x${rows}）に収まらないため省略しました（${d.width} 桁 x ${d.height} 行）。`,
      '  → 上の PNG を開いて読み取るか、PC のブラウザで「設定 → ペアリング QR」を大きく表示してください。',
    )
    if (svg) out('', qrSvg(info.best.url))
    return
  }
  out('', `端末表示の QR（${pick.label}・参考）— 読み取れないときは上の PNG を使ってください:`, '')
  out(qr)
  if (svg) out('', qrSvg(info.best.url))
}

/**
 * 旧環境があるときに `init` がどう振る舞うかを決める（D55: 無言の自動移行をやめる）。
 *
 * - 旧環境が無い → `skip`
 * - `--yes` → `migrate`（明示同意とみなす）
 * - TTY → `ask`（`y/N`。既定は N）
 * - 非 TTY かつ `--yes` 無し（cron / CI / パイプ） → `manual`（移行せずコマンドを案内）
 *
 * @param {{hasLegacy?: boolean, yes?: boolean, isTTY?: boolean}} [opts]
 * @returns {'skip'|'migrate'|'ask'|'manual'}
 */
export function migrationDecision({ hasLegacy = false, yes = false, isTTY = false } = {}) {
  if (!hasLegacy) return 'skip'
  if (yes) return 'migrate'
  return isTTY ? 'ask' : 'manual'
}

/**
 * TTY で `y/N` を聞く（既定 N。Enter だけなら移行しない）。
 * @param {object} [opts]
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 * @param {string} [opts.question]
 * @returns {Promise<boolean>} 移行するなら true
 */
export function askMigrate({ input = process.stdin, output = process.stdout, question } = {}) {
  const q =
    question ??
    '旧環境（akapen / mobile-pwa）が見つかりました。今すぐ移行しますか? / Migrate legacy data now? [y/N]: '
  const rl = readline.createInterface({ input, output })
  return new Promise((resolve) => {
    let answered = false
    rl.question(q, (answer) => {
      answered = true
      rl.close()
      resolve(/^y(es)?$/i.test(String(answer).trim()))
    })
    // Ctrl-D / EOF は「いいえ」として扱う（無言で移行しない）
    rl.on('close', () => {
      if (!answered) resolve(false)
    })
  })
}

/**
 * 旧環境が残っているか（`init` の移行判定）。
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
 * 標準ダッシュボード用タブの配置先を返す（`installDashboardPlugin` の `root`）。
 *
 * 通常は `~/.hermes/plugins/hermes-pilot/`。`hermes plugins install` が**リポジトリ
 * ルート自体**をプラグインディレクトリとして展開した場合はプラグインのベースが
 * 別の場所になるので、`HERMES_PLUGINS_DIR`（ベース）か `targetDir`（完全パス）で
 * 上書きできる。D56 の「`targetDir === ROOT` のときは自己上書きしない」判定はここで得た
 * パスを :func:`sameDir` で `ROOT` と比べて行う。
 * @param {object} p `resolvePaths()` の結果
 * @param {object} [opts] オプション
 * @param {string|null} [opts.targetDir] 完全パスで指定する場合
 * @param {object} [opts.env] 環境変数
 * @returns {string} プラグインのディレクトリ
 */
export function resolveDashboardTarget(p, { targetDir = null, env = process.env } = {}) {
  const expand = (value) => path.resolve(String(value).replace(/^~(?=$|\/)/, p.home ?? os.homedir()))
  if (targetDir) return expand(targetDir)
  const base = env.HERMES_PLUGINS_DIR ? expand(env.HERMES_PLUGINS_DIR) : path.join(p.hermesHome, 'plugins')
  return path.join(base, DASHBOARD_PLUGIN)
}

/**
 * 2 つのパスが同じディレクトリを指すか（symlink を解決する）。
 *
 * `hermes plugins install` はクローン先を symlink にすることがあり、文字列比較だけだと
 * 「リポジトリルートに直接インストールされた」ケースを取り逃がして自己上書きする。
 * @param {string} a パス
 * @param {string} b パス
 * @returns {boolean} 同じ実体なら true
 */
export function sameDir(a, b) {
  const real = (dir) => {
    try {
      return fs.realpathSync(dir)
    } catch {
      return null
    }
  }
  const ra = real(a)
  const rb = real(b)
  if (ra && rb) return ra === rb
  return path.resolve(a) === path.resolve(b)
}

/**
 * 標準ダッシュボード用タブを `~/.hermes/plugins/hermes-pilot/` へ**冪等に**配置する。
 *
 * - 既にあるファイルは `force` が真のときだけ上書きする（`skills` 配置と同じ流儀）。
 * - あわせて `dashboard.json`（CLI の絶対パス・node・リポジトリ根）をデータ先へ書き、
 *   ダッシュボードの「サービス」操作がこれを spawn できるようにする。
 * - **自己上書きの回避（D56）**: 配置先がリポジトリルート自身（`targetDir === ROOT`）の
 *   ときはコピーを行わない。ルートには `__init__.py` / `dashboard/` が既にコミット済みで、
 *   写し元（`apps/dashboard/`）と写し先が同一ツリーになるため、コピーは無意味か
 *   破壊的（`apps/dashboard/` → `dashboard/` の逆向き同期事故）になりうる。
 *   この場合はスキル・データ初期化だけを完了させ、`selfHosted: true` で返す。
 * @param {object} p `resolvePaths()` の結果
 * @param {object} [opts] オプション
 * @param {boolean} [opts.force] 既存ファイルも上書きする
 * @param {string|null} [opts.targetDir] 配置先を明示する（省略時は `~/.hermes/plugins/hermes-pilot`）
 * @returns {{root: string, installed: string[], skipped: string[], selfHosted: boolean}} 結果
 */
export function installDashboardPlugin(p, { force = false, targetDir = null } = {}) {
  const root = resolveDashboardTarget(p, { targetDir })
  const selfHosted = sameDir(root, ROOT)
  const installed = []
  const skipped = []
  if (!selfHosted) {
    for (const file of DASHBOARD_FILES) {
      const src = path.join(ROOT, file.from)
      const dest = path.join(root, file.to)
      if (!fs.existsSync(src)) continue
      if (fs.existsSync(dest) && !force) {
        skipped.push(dest)
        continue
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      installed.push(dest)
    }
  }
  // サービス操作は CLI を spawn する。常駐・worker からも辿れるよう絶対パスで残す。
  fs.mkdirSync(p.dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(p.dataDir, 'dashboard.json'),
    `${JSON.stringify(
      {
        version: 1,
        plugin: DASHBOARD_PLUGIN,
        root: ROOT,
        cli: path.join(ROOT, 'bin', 'hermes-pilot.mjs'),
        node: process.execPath,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return { root, installed, skipped, selfHosted }
}

/**
 * `init` の本体（冪等）。
 * @param {object} p `resolvePaths()` の結果
 * @param {number} port ポート
 * @param {object} [opts] オプション
 * @param {number|null} [opts.tlsPort] TLS ポート
 * @param {boolean} [opts.force] ダッシュボード・プラグインを上書きする
 * @param {string|null} [opts.targetDir] ダッシュボード・プラグインの配置先（`hermes plugins install` の展開先）
 * @param {boolean} [opts.yes] 旧環境の移行を確認なしで実行する（`--yes` / D55）
 * @param {() => Promise<boolean>} [opts.confirm] 移行確認関数（テスト用 DI。既定は `askMigrate`）
 * @param {boolean|null} [opts.isTTY] TTY 判定の上書き（テスト用。既定は stdin+stdout の TTY）
 * @returns {{created: boolean, migrated: boolean, migration: string, skills: string[], dashboard: object}} 結果
 */
export async function runInit(
  p,
  port,
  { tlsPort = null, force = false, targetDir = null, yes = false, confirm = null, isTTY = null } = {},
) {
  fs.mkdirSync(p.dataDir, { recursive: true, mode: 0o700 })
  for (const sub of ['sheets', 'shots', 'library']) {
    fs.mkdirSync(path.join(p.reviewDir, sub), { recursive: true })
  }
  fs.mkdirSync(p.logDir, { recursive: true })
  if (!fs.existsSync(p.configPath)) {
    fs.writeFileSync(p.configPath, `${JSON.stringify({ lang: 'en', scanDirs: ['~/Projects', '~/projects'], servicePort: port }, null, 2)}\n`)
  }
  const { created } = ensureToken(p.tokenPath)

  // D55: 旧環境の移行は **明示同意**（`--yes` / TTY での y / `migrate` サブコマンド）でのみ実行する。
  // 無言の自動移行は Hermes state を勝手に書き換えるので廃止した。
  const tty = isTTY === null ? Boolean(process.stdin.isTTY && process.stdout.isTTY) : Boolean(isTTY)
  const decision = migrationDecision({ hasLegacy: hasLegacyEnv(p), yes, isTTY: tty })
  let migrated = false
  let migration = decision
  if (decision === 'migrate' || decision === 'ask') {
    const proceed = decision === 'migrate' ? true : await (confirm ?? askMigrate)()
    if (proceed) {
      const { migrate, formatReport } = await loadMigrate()
      const report = migrate({ home: p.home, hermesHome: p.hermesHome, pluginDataDir: p.pluginDataDir })
      out('旧環境が見つかったので移行しました / Migrated legacy data:', '', formatReport(report))
      migrated = true
      migration = 'migrate'
    } else {
      migration = 'manual'
    }
  }
  if (migration === 'manual') {
    out(
      '旧環境（akapen / mobile-pwa）はまだ残っていますが、移行していません / legacy data found; not migrated',
      '  → 移行するには: node bin/hermes-pilot.mjs migrate',
      '    （確認を省略する場合は init --yes）',
    )
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
  // 標準ダッシュボードのタブ（冪等）。`--force` で既存ファイルも上書きする。
  const dashboard = installDashboardPlugin(p, { force, targetDir })
  out(
    '',
    'hermes-pilot init 完了 / done',
    `  データ / data : ${p.dataDir}`,
    `  トークン / token: ${p.tokenPath}${created ? '（新規作成 0600）' : '（既存）'}`,
    `  スキル / skills: ${installed.length ? installed.join(', ') : '（既に配置済み）'}`,
    `  移行 / migrate: ${migrated ? '実行' : migration === 'manual' ? '未実行（migrate サブコマンドで実行）' : '不要'}`,
  )
  if (dashboard.selfHosted) {
    // リポジトリルート自体がプラグインディレクトリ（`hermes plugins install` 直後の形）。
    // ルートに `__init__.py` / `dashboard/` がコミット済みなのでコピーはしない。
    out(
      `  ダッシュボード / dashboard tab: ${dashboard.root}`,
      '    リポジトリルートがプラグインディレクトリなのでコピーは省略（自己上書きの回避）。',
      '    / plugin dir == repo root: nothing to copy, the layout is already committed.',
      '    → 初回は `hermes plugins enable hermes-pilot` とダッシュボードの再起動が必要です。',
    )
  } else {
    out(
      `  ダッシュボード / dashboard tab: ${dashboard.root}`,
      `    ${dashboard.installed.length} ファイル配置${dashboard.installed.length ? '' : '（既に配置済み。--force で上書き）'}`,
      '    → Hermes ダッシュボード（:9119）の「Hermes Pilot」タブに出ます。初回は `hermes plugins enable hermes-pilot` とダッシュボードの再起動が必要です。',
    )
  }
  printPairing({ token: mintPairCode(p.dataDir), port, tlsPort, pngPath: path.join(p.dataDir, 'pair-qr.png') })
  return { created, migrated, migration, skills: installed, dashboard }
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
        out(`launchctl bootout + bootstrap ${domain}/${SERVICE_LABEL}`)
        return 0
      }
      // kickstart -k は読み込み済みのジョブ定義を使い回すので、plist の
      // EnvironmentVariables（PATH など）を直しても反映されない（実測: PATH に
      // hermes が無いままブリッジが起動し、レビュー回答の comment/unblock が全滅した）。
      // bootout → bootstrap で plist を読み直し、失敗したときだけ kickstart に落とす。
      const off = spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { encoding: 'utf8' })
      out(`launchctl bootout: exit ${off.status}`)
      if (!fs.existsSync(plistPath)) {
        out(`plist がありません（先に service install を実行してください）: ${plistPath}`)
        return 1
      }
      // bootout 直後の bootstrap は "Input/output error (5)" で失敗することがある
      // （実測: アンロードが終わる前）。数百 ms 待って数回だけ試す。
      let on = { status: 1, stderr: '' }
      for (let i = 0; i < 4; i++) {
        spawnSync('sleep', ['0.4'], { encoding: 'utf8' })
        on = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
        if (on.status === 0) break
      }
      if (on.status === 0) {
        out('launchctl bootstrap: ok（plist を読み直した）')
        return 0
      }
      out(`launchctl bootstrap: exit ${on.status}${on.stderr ? ` (${on.stderr.trim()})` : ''}`)
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
  ensureToken(paths.tokenPath)
  if (!noQr) printPairing({ token: mintPairCode(paths.dataDir), port, tlsPort, dnsName, pngPath: path.join(paths.dataDir, 'pair-qr.png') })
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
    await runInit(paths, port, {
      tlsPort,
      force: Boolean(flags.force),
      targetDir: typeof flags['target-dir'] === 'string' ? flags['target-dir'] : null,
      yes: Boolean(flags.yes || flags.y),
    })
    return 0
  }

  if (command === 'qr') {
    const { created } = ensureToken(paths.tokenPath)
    if (created) out(`トークンを新規作成しました / token created: ${paths.tokenPath}`)
    printPairing({
      token: mintPairCode(paths.dataDir),
      port,
      tlsPort,
      dnsName,
      svg: Boolean(flags.svg),
      pngPath: typeof flags.png === 'string' ? flags.png : path.join(paths.dataDir, 'pair-qr.png'),
    })
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

/**
 * このファイルが「直接実行された」か。
 *
 * `npm i -g hermes-pilot` / `npx hermes-pilot` は `node_modules/.bin/hermes-pilot` という
 * **シンボリックリンク**経由で起動する。素の `path.resolve(argv[1])` 比較だと、リンク側の
 * パスと実体（`bin/hermes-pilot.mjs`）が一致せず **main() が呼ばれずに無言で exit 0** する
 * （実測: npm から入れた 0.2.2 で `hermes-pilot --help` が何も出力しない）。
 * 実体パスに解決してから比べる。
 */
function invokedDirectly() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(path.resolve(self))
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self)
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      if (code) process.exit(code)
    })
    .catch((err) => {
      console.error(`[hermes-pilot] ${err?.stack ?? err}`)
      process.exit(1)
    })
}

