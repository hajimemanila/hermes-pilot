/**
 * 起動ログのトークン非露出（SPEC-CATALOG-ADMISSION D58 / Batch C4）。
 *
 * 受入条件は「`apps/bridge/src/server.js` 内に `auth.token` を `console.log` /
 * `console.error` へ出力する箇所が存在しないこと」なので、二手で確かめる。
 *
 * 1. ソース走査: `console.*` の行に `auth.token` が現れないこと（機械ゲート）。
 * 2. 実起動: 一時データディレクトリ・自動割当ポートで `server.js` を子プロセスで起動し、
 *    **実際の stdout/stderr に生トークンが出ないこと**と、トークンファイルのパスが出ることを見る。
 *
 * 2 は「行を消したから通った」を防ぐための実測。トークンは起動時に `auth.js` が
 * 0600 で書き出すので、ファイルの実値と突き合わせて判定する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const SERVER = path.join(ROOT, 'apps', 'bridge', 'src', 'server.js')
import { readServerSource } from './helpers/moduleSource.js'

/** 検査語は分割して組み立てる（受入条件の grep をこのファイル自身が汚さないため）。 */
const TOKEN_REF = ['auth', 'token'].join('.')

const CONSOLE_CALL = /\bconsole\.(log|error|warn|info|debug)\s*\(/

/** CJK（かな・カナ・漢字・全角形）。ログ出力に出てはいけない（SPEC-EN-ZERO-LEAK D71）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/

/**
 * ソースから `console.*` 呼び出しの行だけを取り出す。
 * @param {string} source ソース全文
 * @returns {{line: number, text: string}[]} 該当行
 */
function consoleLines(source) {
  const out = []
  source.split('\n').forEach((text, i) => {
    if (CONSOLE_CALL.test(text)) out.push({ line: i + 1, text })
  })
  return out
}

/**
 * OS に空きポートを 1 つ割り当ててもらう。
 * @returns {Promise<number>} ポート番号
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 一時環境でブリッジを起動し、listen ログ（または即時終了）まで待つ。
 * @param {string} dir 一時ディレクトリ
 * @param {number} port 待ち受けポート
 * @returns {Promise<{log: string, code: number|null}>} 出力と終了コード（起動継続中は null）
 */
function bootBridge(dir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        HOME: dir,
        HERMES_HOME: path.join(dir, 'hermes'),
        HM_DATA: path.join(dir, 'data'),
        HM_STATE_DB: path.join(dir, 'state.db'),
        HM_HOST: '127.0.0.1',
        HM_PORT: String(port),
        // 上流は死んだポート。ensureToken は即座に失敗し、起動ログの検証には影響しない。
        HERMES_BASE: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve({ log, code })
    }
    const timer = setTimeout(() => finish(null), 10_000)
    const onData = (buf) => {
      log += buf.toString()
      // 1 行目〜4 行目の listen ログが出たら十分（以降はウォッチャー起動ログ）
      if (log.includes('/auth')) setTimeout(() => finish(null), 300)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code) => finish(code))
  })
}

test('起動ログは auth.token の生値を出さない（ソース走査）', () => {
  const source = readServerSource()
  const offenders = consoleLines(source).filter((l) => l.text.includes(TOKEN_REF))
  assert.deepEqual(
    offenders.map((l) => `${l.line}: ${l.text.trim()}`),
    [],
    'auth.token を console.* へ流している行がある',
  )
  // 管理画面 URL はトークン無しで出し、代わりにトークンファイルのパスを案内する
  assert.match(source, /\[bridge\] Token file: \$\{cfg\.tokenPath\}/)
  assert.match(source, /\[bridge\] Auth page: http:\/\/\$\{cfg\.host\}:\$\{cfg\.port\}\/auth`/)
})

test('起動・PTY・500 のログは標準英語（日本語の直書きが無い）', () => {
  const source = readServerSource()
  // 実出力になる文字列（ログ・端末へ送る行）が英語であること（D71）。
  assert.match(source, /\[bridge\] Port \$\{cfg\.port\} is already in use/)
  assert.match(source, /\[bridge\] Server error:/)
  assert.match(source, /\[api\] failed:/)
  assert.match(source, /\[bridge\] node-pty failed to load/)
  // PTY を起動できないときの端末向け 1 行（`server/ptyGate.js` の英語文面）。
  // 枯渇時は spawn を呼ばずに理由だけ返す（呼ぶと master fd が漏れる）。
  assert.match(source, /PTY unavailable/)
  assert.match(source, /ptyGate\.attempt\(\)/)
  assert.match(source, /\[bridge\] Upstream: \$\{cfg\.hermesBase\}/)
  assert.match(source, /\[bridge\] Hermes session token: resolved/)
  assert.match(source, /\[bridge\] Failed to resolve session token \(is the dashboard stopped\?\)/)
  // 機械ゲート: `server.js` の console.* 行に日本語が 1 行も無い
  const bad = consoleLines(source).filter((l) => CJK.test(l.text)).map((l) => `${l.line}: ${l.text.trim()}`)
  assert.deepEqual(bad, [], 'console.* に日本語が残っている（D71）')
})

test('ログイン案内はトークンファイルを指す（起動ログではない）', () => {
  // ログイン画面の文言は `http/login-page.js` に切り出してある（無ければ server.js 側を読む）
  const loginPage = path.resolve(HERE, '../src/http/login-page.js')
  const source =
    fs.readFileSync(SERVER, 'utf8') + (fs.existsSync(loginPage) ? fs.readFileSync(loginPage, 'utf8') : '')
  assert.equal(source.includes('起動ログにあります'), false, '旧文言（起動ログ案内）が残っている')
  // EN（英語既定）と JA の両方がトークンファイルを指す（D71 / §3.2-5）。
  assert.match(source, /hint: 'Find the token in <code>~\/\.hermes\/plugin-data\/hermes-pilot\/token<\/code>\.'/)
  assert.match(
    source,
    /hint: 'トークンは <code>~\/\.hermes\/plugin-data\/hermes-pilot\/token<\/code>（トークンファイル）を確認してください。'/,
  )
})

test('実起動した stdout/stderr に生トークンが出ない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-startup-log-'))
  try {
    let boot = await bootBridge(dir, await freePort())
    // ポート競合（終了コード 75）だけは 1 回やり直す
    if (boot.code === 75) boot = await bootBridge(dir, await freePort())
    const tokenFile = path.join(dir, 'data', 'token')
    assert.equal(fs.existsSync(tokenFile), true, 'トークンファイルが作られていない')
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    assert.ok(token.length >= 16, 'トークンが短すぎる（検証にならない）')

    assert.equal(boot.log.includes(token), false, '起動ログに生トークンが出ている')
    assert.equal(/\?t=/.test(boot.log), false, '起動ログに /auth?t=… の URL が出ている')
    assert.ok(
      boot.log.includes(`[bridge] Token file: ${tokenFile}`),
      `トークンファイルのパスが起動ログに無い: ${boot.log}`,
    )
    // 英語環境のゼロ CJK（D71）。ログビューアに日本語が 1 行でも出れば落ちる。
    assert.equal(CJK.test(boot.log), false, `起動ログに日本語が残っている: ${boot.log}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
