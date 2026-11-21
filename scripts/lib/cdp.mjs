/**
 * 使い捨ての headless Chrome と CDP を立ち上げる小さな土台（npm 依存を足さない）。
 *
 * `scripts/audit-responsive.mjs` と同じやり方（`--headless=new --remote-debugging-port=0` の
 * stderr から `DevTools listening on ws://…` を読み、Node 22 標準の `WebSocket` で CDP に繋ぐ）。
 * 監査側は verify の本線なので**触らず**、新しい実測スクリプト（`check-term-enter.mjs` 等）だけが
 * ここを使う。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Chrome の探索候補（macOS の既定インストール先 → Linux のよくあるパス）。 */
export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** Chrome/Chromium の実行ファイルを探す（`CHROME_PATH` が最優先）。無ければ空文字。 */
export function findChrome() {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? ''
}

/** アプリトークンを探す（`--token` → 環境変数 → 既知の保存先）。値は決して出力しない。 */
export function resolveToken(explicit) {
  if (explicit) return explicit.trim()
  if (process.env.HERMES_PILOT_TOKEN) return String(process.env.HERMES_PILOT_TOKEN).trim()
  const home = os.homedir()
  const files = [
    path.join(home, '.hermes', 'plugin-data', 'hermes-pilot', 'token'),
    path.join(home, '.hermes', 'mobile-pwa', 'token'),
  ]
  for (const file of files) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      if (value) return value
    } catch {
      /* 無ければ次 */
    }
  }
  return ''
}

/** ブリッジが応答するか（3 秒で諦める）。 */
export async function bridgeReachable(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(3000) })
    return res.status > 0
  } catch {
    return false
  }
}

/** `ms` ミリ秒待つ。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** `check()` が真を返すまで待つ（タイムアウトで false）。 */
export async function waitFor(check, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

/** 最小の CDP クライアント（Node 標準 `WebSocket` のみ）。 */
export class Cdp {
  /** @param {WebSocket} socket ブラウザの DevTools WebSocket */
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    socket.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
      }
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP が切断された'))
      this.pending.clear()
    })
  }

  /** コマンドを送る（ページ系は `sessionId` 付き）。 */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP が切断された'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  /** ページで式を評価して値を返す（`returnByValue`）。 */
  async eval(expression, sessionId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '評価に失敗した')
    }
    return r.result?.value
  }
}

/**
 * headless Chrome を起動し、DevTools の WebSocket URL を返す。
 * @returns {Promise<{wsUrl: string, cleanup: () => void}>}
 */
export async function launchChrome(chrome) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-probe-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cleanup = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 既に終了 */
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 消せなくても致命的ではない */
    }
  }
  process.on('exit', cleanup)

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome の DevTools エンドポイントが出ない（10 秒）')), 10000)
    const onData = (chunk) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk))
      if (m) {
        clearTimeout(timer)
        child.stderr.off('data', onData)
        resolve(m[1])
      }
    }
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Chrome が起動直後に終了した (exit ${code})`))
    })
  })
  return { wsUrl, cleanup }
}
