/**
 * `bin/hermes-pilot.mjs` の自動検証（SPEC §8.1 / Batch T6 受入条件）。
 *
 * 受入条件の 3 コマンド（`--help` / `qr` / `service status`）を **実際に子プロセスで走らせて**
 * 終了コードと出力を見る。`init` は一時 HOME に作らせ、`token` の 0600・256-bit hex・
 * 同梱スキルの配置まで確かめる。サービス登録は `--dry-run` で書き込みなしに留める
 * （このホストの本物の LaunchAgents を触らないため）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILLS,
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  buildLaunchdPlist,
  buildSystemdUnit,
  ensureToken,
  helpText,
  parseArgv,
  readConfig,
  resolveHermesHome,
  resolvePaths,
} from '../../../bin/hermes-pilot.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI = path.join(ROOT, 'bin', 'hermes-pilot.mjs')

/**
 * 一時 HOME を用意して CLI を実行する。
 * @param {string[]} args 引数
 * @param {string} home 一時 HOME
 * @returns {{status: number, out: string}} 実行結果
 */
function runCli(args, home) {
  const env = { ...process.env, HOME: home, HERMES_HOME: path.join(home, '.hermes') }
  // 開発用の上書きが残っていると一時 HOME を無視してしまうので落とす
  delete env.HM_DATA
  delete env.HP_DATA_DIR
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** 一時 HOME を作る。 */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cli-'))
}

test('parseArgv: サブコマンドと --key value / --key=value を分解する', () => {
  assert.deepEqual(parseArgv(['--help']), { command: '', sub: null, flags: { help: true }, rest: [] })
  assert.deepEqual(parseArgv(['qr', '--port', '5000']), { command: 'qr', sub: null, flags: { port: '5000' }, rest: [] })
  assert.deepEqual(parseArgv(['start', '--port=4100', '--host', '0.0.0.0']), {
    command: 'start',
    sub: null,
    flags: { port: '4100', host: '0.0.0.0' },
    rest: [],
  })
  assert.deepEqual(parseArgv(['service', 'install', '--dry-run']), {
    command: 'service',
    sub: 'install',
    flags: { 'dry-run': true },
    rest: [],
  })
  // 値を取らないフラグが次のサブコマンドを食わないこと
  assert.deepEqual(parseArgv(['qr', '--svg']).flags, { svg: true })
})

test('helpText: 5 つのサブコマンドと移行の注意を含む', () => {
  const text = helpText()
  for (const word of ['init', 'start', 'qr', 'service', 'migrate', 'ai.hermes.pilot']) {
    assert.ok(text.includes(word), `help に ${word} が無い`)
  }
})

test('node bin/hermes-pilot.mjs --help は exit 0 で使い方を出す（受入条件）', () => {
  const home = tempHome()
  try {
    const r = runCli(['--help'], home)
    assert.equal(r.status, 0)
    assert.match(r.out, /Usage:/)
    assert.match(r.out, /hermes-pilot init/)
    assert.match(r.out, /hermes-pilot service install\|uninstall\|restart\|status/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('init: データ先・0600 の 256-bit hex トークン・同梱スキル・config.json を作る', () => {
  const home = tempHome()
  try {
    const r = runCli(['init'], home)
    assert.equal(r.status, 0, r.out)
    const data = path.join(home, '.hermes', 'plugin-data', 'hermes-pilot')
    const tokenPath = path.join(data, 'token')
    assert.ok(fs.existsSync(tokenPath), 'token が無い')
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    assert.match(token, /^[0-9a-f]{64}$/, '256-bit hex ではない')
    const mode = fs.statSync(tokenPath).mode & 0o777
    assert.equal(mode, 0o600, `token のパーミッションが 0600 でない: ${mode.toString(8)}`)
    for (const sub of ['sheets', 'shots', 'library']) {
      assert.ok(fs.existsSync(path.join(data, 'review', sub)), `review/${sub} が無い`)
    }
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'))
    assert.equal(cfg.servicePort, 4097)
    assert.deepEqual(cfg.scanDirs, ['~/Projects', '~/projects'])
    for (const skill of BUNDLED_SKILLS) {
      assert.ok(fs.existsSync(path.join(home, '.hermes', 'skills', skill, 'SKILL.md')), `${skill} が配置されていない`)
    }
    // 2 回目はトークンを変えない（冪等）
    const again = runCli(['init'], home)
    assert.equal(again.status, 0, again.out)
    assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), token, '2 回目でトークンが変わった')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('node bin/hermes-pilot.mjs qr はペアリング URL と QR を出す（受入条件）', () => {
  const home = tempHome()
  try {
    assert.equal(runCli(['init'], home).status, 0)
    const token = fs.readFileSync(path.join(home, '.hermes', 'plugin-data', 'hermes-pilot', 'token'), 'utf8').trim()
    const r = runCli(['qr', '--port', '4097'], home)
    assert.equal(r.status, 0, r.out)
    assert.ok(r.out.includes(`?token=${token}`), 'QR の URL にトークンが入っていない')
    assert.match(r.out, /Pairing targets/)
    assert.match(r.out, /[█▀▄]/, 'ターミナル QR（ブロック文字）が出ていない')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('qr: トークンが無ければ作ってから出す（初回でも詰まらない）', () => {
  const home = tempHome()
  try {
    const r = runCli(['qr'], home)
    assert.equal(r.status, 0, r.out)
    const tokenPath = path.join(home, '.hermes', 'plugin-data', 'hermes-pilot', 'token')
    assert.ok(fs.existsSync(tokenPath), 'token が作られていない')
    assert.match(fs.readFileSync(tokenPath, 'utf8').trim(), /^[0-9a-f]{64}$/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('node bin/hermes-pilot.mjs service status は exit 0 で状態を出す（受入条件）', () => {
  const home = tempHome()
  try {
    const r = runCli(['service', 'status'], home)
    assert.equal(r.status, 0, r.out)
    const unit = process.platform === 'darwin' ? SERVICE_LABEL : SYSTEMD_UNIT
    assert.ok(r.out.includes(unit), `ユニット名 ${unit} が出ていない`)
    assert.match(r.out, /state|状態/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('service install --dry-run は plist（または unit）を出すだけで書き込まない', () => {
  const home = tempHome()
  try {
    const r = runCli(['service', 'install', '--dry-run'], home)
    assert.equal(r.status, 0, r.out)
    if (process.platform === 'darwin') {
      assert.match(r.out, /<key>KeepAlive<\/key>/)
      assert.match(r.out, new RegExp(`<string>${SERVICE_LABEL}</string>`))
      assert.match(r.out, /<key>HERMES_HOME<\/key>/)
      assert.equal(
        fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)),
        false,
        'dry-run なのに plist が書かれた',
      )
    } else {
      assert.match(r.out, /ExecStart=.*hermes-pilot/)
      assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)), false)
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('buildLaunchdPlist: 新ラベル・start サブコマンド・ログ先を持つ', () => {
  const xml = buildLaunchdPlist({
    label: SERVICE_LABEL,
    node: '/usr/local/bin/node',
    cli: '/repo/bin/hermes-pilot.mjs',
    port: 4097,
    host: '127.0.0.1',
    hermesHome: '/Users/x/.hermes',
    logDir: '/Users/x/.hermes/logs',
    workdir: '/repo',
  })
  assert.match(xml, /<string>ai\.hermes\.pilot<\/string>/)
  assert.match(xml, /<string>start<\/string>/)
  assert.match(xml, /<string>--port<\/string>\s*<string>4097<\/string>/)
  assert.match(xml, /pilot\.out\.log/)
  assert.match(xml, /<key>RunAtLoad<\/key>/)
  // 常駐の PATH はログインシェルより狭い。hermes CLI の置き場所を PATH に含める（SPEC §5.3）
  assert.match(xml, /\/Users\/x\/\.hermes\/hermes-agent\/\.hermes\/bin/)
  // 旧ラベルを混ぜない（移行時に両方が動き続ける事故を防ぐ）
  assert.equal(xml.includes('ai.hermes.hermes-mobile'), false)
})

test('readConfig: tailscaleDns と tlsPort を読む（常駐から CLI を叩けない環境の控え）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cfg-'))
  const p = path.join(dir, 'config.json')
  fs.writeFileSync(p, JSON.stringify({ lang: 'ja', scanDirs: ['~/Projects'], servicePort: 4097, tlsPort: 8444, tailscaleDns: 'mini.tail1.ts.net' }))
  const cfg = readConfig(p)
  assert.equal(cfg.tlsPort, 8444)
  assert.equal(cfg.tailscaleDns, 'mini.tail1.ts.net')
  assert.equal(cfg.lang, 'ja')
  // 欠損・壊れた JSON でも既定に落ちる
  const missing = readConfig(path.join(dir, 'nope.json'))
  assert.equal(missing.tlsPort, null)
  assert.equal(missing.tailscaleDns, null)
})

test('buildSystemdUnit: ExecStart と WantedBy を持つ', () => {
  const unit = buildSystemdUnit({
    node: '/usr/bin/node',
    cli: '/repo/bin/hermes-pilot.mjs',
    port: 4097,
    host: '127.0.0.1',
    hermesHome: '/home/x/.hermes',
    workdir: '/repo',
  })
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/repo\/bin\/hermes-pilot\.mjs start --port 4097 --host 127\.0\.0\.1/)
  assert.match(unit, /Environment=HERMES_HOME=\/home\/x\/\.hermes/)
  assert.match(unit, /WantedBy=default\.target/)
})

test('ensureToken: 既存を尊重し、無いときだけ 0600 で作る', () => {
  const home = tempHome()
  try {
    const tokenPath = path.join(home, 'token')
    const first = ensureToken(tokenPath)
    assert.equal(first.created, true)
    assert.match(first.token, /^[0-9a-f]{64}$/)
    const second = ensureToken(tokenPath)
    assert.equal(second.created, false)
    assert.equal(second.token, first.token)
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveHermesHome: プロファイルディレクトリを指す HERMES_HOME を ~/.hermes に正す', () => {
  assert.equal(resolveHermesHome('/Users/x/.hermes/profiles/mobile', '/Users/x'), '/Users/x/.hermes')
  assert.equal(resolveHermesHome('/Users/x/.hermes', '/Users/x'), '/Users/x/.hermes')
  assert.equal(resolveHermesHome('~/.hermes', '/Users/x'), '/Users/x/.hermes')
})

test('resolvePaths: データ先とスキル先が SPEC §3.2 の配置になる', () => {
  const p = resolvePaths({ HOME: '/Users/x', HERMES_HOME: '/Users/x/.hermes/profiles/mobile' })
  assert.equal(p.hermesHome, '/Users/x/.hermes')
  assert.equal(p.pluginDataDir, '/Users/x/.hermes/plugin-data/hermes-pilot')
  assert.equal(p.dataDir, '/Users/x/.hermes/plugin-data/hermes-pilot')
  assert.equal(p.reviewDir, '/Users/x/.hermes/plugin-data/hermes-pilot/review')
  assert.equal(p.skillsDir, '/Users/x/.hermes/skills')
  const overridden = resolvePaths({ HOME: '/Users/x', HP_DATA_DIR: '/tmp/pilot-data' })
  assert.equal(overridden.dataDir, '/tmp/pilot-data')
})
