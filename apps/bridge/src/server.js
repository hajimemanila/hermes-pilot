import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { createRequire } from 'node:module'
import { loadConfig, VERSION } from './config.js'
import { createAuth } from './auth.js'
import { createHermesClient } from './hermes.js'
import { createKanban } from './kanban.js'
import { createOps } from './ops.js'

const require = createRequire(import.meta.url)
const pty = safeRequire('node-pty')

/**
 * node-pty はネイティブモジュール。無くても他は動かす。
 * @param {string} name モジュール名
 * @returns {any|null} モジュール
 */
function safeRequire(name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

const cfg = loadConfig()
const auth = createAuth(cfg)
const hermes = createHermesClient(cfg)
const kanban = createKanban(cfg)
const ops = createOps(cfg, hermes, auth)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/** @param {import('node:http').ServerResponse} res 応答 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 本文を JSON として読む（上限 1MB）。 */
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** 書き込み系の簡易レート制限。 */
const writes = []
function writeAllowed(max = 60, windowMs = 60_000) {
  const now = Date.now()
  while (writes.length && now - writes[0] > windowMs) writes.shift()
  if (writes.length >= max) return false
  writes.push(now)
  return true
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Mobile — ログイン</title>
<style>body{background:#07171b;color:#e6f4f1;font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh}
form{background:#0d242a;padding:24px;border-radius:16px;border:1px solid #1d3a41;width:min(88vw,360px)}
h1{font-size:16px;margin:0 0 12px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #24515a;background:#081e23;color:#e6f4f1;font-size:15px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;background:#13807f;color:#fff;font-size:15px}
p{color:#7fa6a3;font-size:12px;margin:10px 0 0}</style>
<form method="get" action="/auth"><h1>Hermes Mobile</h1>
<input name="t" placeholder="アプリトークン" autocomplete="off" autocapitalize="off" spellcheck="false">
<button>入る</button>
<p>トークンは <code>~/.hermes/mobile-pwa/token</code> またはブリッジの起動ログにあります。</p></form>`

/** 静的配信（SPA フォールバック付き）。 */
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  const file = path.join(cfg.distDir, rel)
  if (!file.startsWith(cfg.distDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (path.extname(rel)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
      fs.readFile(path.join(cfg.distDir, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('UI 未ビルド（npm run build）')
          return
        }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(html)
      })
      return
    }
    const ext = path.extname(file)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=604800, immutable',
    })
    res.end(buf)
  })
}

/** ログの末尾を返す。 */
function tailLog(name, lines = 200) {
  const safe = String(name ?? 'gateway').replace(/[^a-z0-9._-]/gi, '')
  const file = path.join(cfg.logDir, safe.endsWith('.log') ? safe : `${safe}.log`)
  if (!file.startsWith(cfg.logDir)) throw Object.assign(new Error('invalid log'), { statusCode: 400 })
  const text = fs.readFileSync(file, 'utf8')
  return text.split('\n').slice(-Math.min(lines, 1000)).join('\n')
}

/** API のルーティング。 */
async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const [, a, b, c, d, e] = seg

  if (a === 'me') return sendJson(res, 200, { ok: true, version: VERSION })

  if (a === 'overview') {
    const data = await ops.overview()
    // 実行中タスク数（アプリバッジ用）
    try {
      data.runningTasks = kanban
        .boards()
        .reduce((n, b) => n + Number(b.counts?.running ?? 0), 0)
    } catch {
      data.runningTasks = 0
    }
    return sendJson(res, 200, data)
  }

  if (a === 'boards') {
    // /api/boards                                        … ボード一覧
    // /api/boards/:slug/tasks                            … タスク一覧
    // /api/boards/:slug/tasks/:id                        … タスク詳細
    // POST /api/boards/:slug/tasks/:id/abort             … 実行中タスクの中断
    if (!b) return sendJson(res, 200, { boards: kanban.boards() })
    if (b && c === 'tasks' && !d) {
      return sendJson(res, 200, { tasks: kanban.tasks(b, { limit: Number(url.searchParams.get('limit') ?? 60) }) })
    }
    if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
      }
      const body = await readJson(req)
      const reason = String(body?.reason ?? 'mobile kill switch').slice(0, 200)
      const out = await kanban.abort(b, d, reason)
      auth.audit({ kind: 'kanban.abort', board: b, task: d, reason, result: out })
      return sendJson(res, 200, out)
    }
    if (b && c === 'tasks' && d) return sendJson(res, 200, kanban.task(b, d))
    return sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}` } })
  }

  if (a === 'gateway' && b && req.method === 'POST') {
    if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
    const body = await readJson(req)
    const out = await ops.gateway(b, body?.confirm, String(body?.by ?? 'mobile'))
    return sendJson(res, 200, out)
  }

  if (a === 'sessions') {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const r = await hermes.call('/api/sessions', { timeoutMs: 10000 })
    if (r.status !== 200) return sendJson(res, 502, { error: { message: `Hermes: HTTP ${r.status}` } })
    const sessions = (r.data?.sessions ?? []).slice(0, limit).map((s) => ({
      id: s.id,
      title: s.title ?? s.display_name ?? s.session_key ?? s.id,
      source: s.source,
      model: s.model,
      active: Boolean(s.is_active),
      lastActivity: s.last_activity_description ?? null,
      lastActive: s.last_active ? Number(s.last_active) * 1000 : null,
      messages: s.message_count ?? 0,
      tools: s.tool_call_count ?? 0,
      cost: s.estimated_cost_usd ?? null,
      preview: s.preview ?? null,
    }))
    return sendJson(res, 200, { sessions })
  }

  if (a === 'logs') {
    const name = url.searchParams.get('file') ?? 'gateway'
    const lines = Number(url.searchParams.get('lines') ?? 200)
    return sendJson(res, 200, { file: name, text: tailLog(name, lines) })
  }

  if (a === 'audit') {
    let text = ''
    try {
      text = fs.readFileSync(cfg.auditPath, 'utf8')
    } catch {
      text = ''
    }
    const lines = text.split('\n').filter(Boolean).slice(-Number(url.searchParams.get('lines') ?? 100))
    return sendJson(res, 200, { lines: lines.map((l) => JSON.parse(l)) })
  }

  sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}` } })
}

/**
 * 認証不要で配るパス（アプリの殻）。
 *
 * WebAPK の生成は **Google のサーバーが認証なしで** manifest / アイコン / start_url を
 * 取得するため、ここを Cookie の内側に置くと Android で
 * 「This app cannot be installed」になる（実測）。データ（/api, /ws）は必ず認証の内側。
 * @param {string} pathname パス
 * @returns {boolean} 公開してよいか
 */
function isPublicPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return true
  if (pathname === '/healthz' || pathname === '/auth') return true
  if (pathname === '/manifest.webmanifest' || pathname === '/sw.js' || pathname === '/favicon.ico') return true
  if (pathname.startsWith('/assets/')) return true
  if (/^\/icon-[a-z0-9-]+\.(png|svg)$/i.test(pathname)) return true
  return false
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION })

  // 認証（/auth はトークン交換のみ）
  if (url.pathname === '/auth') {
    const value = auth.exchange(url.searchParams.get('t'))
    if (!value) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_HTML)
      return
    }
    res.writeHead(302, { 'set-cookie': auth.cookieHeader(value), location: '/' }).end()
    return
  }

  if (!isPublicPath(url.pathname) && !auth.authorized(req)) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: { message: 'unauthorized', code: 'AUTH_REQUIRED' } })
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_HTML)
    return
  }

  // 殻は公開、API は認証必須（殻の中の /api/* 呼び出しで 401 を受けたら UI がログインを出す）
  if (url.pathname.startsWith('/api/') && !auth.authorized(req)) {
    return sendJson(res, 401, { error: { message: 'unauthorized', code: 'AUTH_REQUIRED' } })
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return serveStatic(req, res, url.pathname)
  } catch (err) {
    const status = err?.statusCode ?? 500
    if (status >= 500) console.error('[api] 失敗:', err)
    sendJson(res, status, { error: { message: err?.message ?? 'internal error' } })
  }
})

// --- WebSocket -------------------------------------------------------------

const wssChat = new WebSocketServer({ noServer: true })
const wssTerm = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!auth.authorized(req) && url.searchParams.get('t') !== auth.token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  if (url.pathname === '/ws/chat') {
    wssChat.handleUpgrade(req, socket, head, (ws) => proxyChat(ws))
    return
  }
  if (url.pathname === '/ws/term') {
    wssTerm.handleUpgrade(req, socket, head, (ws) => openTerm(ws))
    return
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
  socket.destroy()
})

/**
 * チャット WS を Hermes の /api/ws へ中継する（プロトコルは素通し）。
 * 端末からは JSON-RPC がそのまま見えるので、探針テストと同じ経路になる。
 * @param {WebSocket} client 端末側
 */
async function proxyChat(client) {
  let upstream
  try {
    upstream = new WebSocket(await hermes.wsUrl('/api/ws'), { headers: { Origin: cfg.hermesBase } })
  } catch (err) {
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.error', payload: { message: String(err?.message ?? err) } } }))
    client.close(1011)
    return
  }
  /** @type {string[]} */
  const queue = []
  client.on('message', (raw) => {
    const text = raw.toString()
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text)
    else queue.push(text)
  })
  upstream.on('open', () => {
    for (const q of queue.splice(0)) upstream.send(q)
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.ready', payload: {} } }))
  })
  upstream.on('message', (raw) => {
    if (client.readyState === WebSocket.OPEN) client.send(raw.toString())
  })
  const closeBoth = (code = 1000, reason = '') => {
    try {
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
    } catch {
      /* noop */
    }
    try {
      upstream.close()
    } catch {
      /* noop */
    }
  }
  upstream.on('close', (code) => closeBoth(code === 1000 ? 1000 : 1011, `upstream ${code}`))
  upstream.on('error', () => closeBoth(1011, 'upstream error'))
  client.on('close', () => {
    try {
      upstream.close()
    } catch {
      /* noop */
    }
  })
}

/**
 * 端末（実 PTY）。Hermes 側に汎用シェルの口が無いためブリッジが PTY を持つ。
 * @param {WebSocket} ws 端末
 */
function openTerm(ws) {
  if (!pty) {
    ws.send(JSON.stringify({ t: 'out', d: '\r\n[bridge] node-pty が読み込めません\r\n' }))
    ws.close(1011)
    return
  }
  const shell = process.env.SHELL || '/bin/zsh'
  /** @type {any} */
  let proc
  try {
    proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
  } catch (err) {
    // ここで例外を投げるとプロセスごと落ちる（実測: spawn-helper の実行権限欠落）
    auth.audit({ kind: 'term.error', message: String(err?.message ?? err) })
    ws.send(JSON.stringify({ t: 'out', d: `\r\n[bridge] PTY を起動できません: ${err?.message ?? err}\r\n` }))
    ws.close(1011)
    return
  }
  auth.audit({ kind: 'term.open', pid: proc.pid, shell })
  proc.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'out', d }))
  })
  proc.onExit(({ exitCode }) => {
    auth.audit({ kind: 'term.exit', pid: proc.pid, exitCode })
    try {
      ws.close(1000, 'exit')
    } catch {
      /* noop */
    }
  })
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      proc.write(raw.toString())
      return
    }
    if (msg?.t === 'in') proc.write(String(msg.d ?? ''))
    else if (msg?.t === 'resize') proc.resize(Math.max(20, Number(msg.c) || 80), Math.max(5, Number(msg.r) || 24))
  })
  ws.on('close', () => {
    auth.audit({ kind: 'term.close', pid: proc.pid })
    try {
      proc.kill()
    } catch {
      /* noop */
    }
  })
}

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[bridge] ポート ${cfg.port} は使用中です（別のブリッジが動いていませんか）`)
    process.exit(75)
  }
  console.error('[bridge] サーバエラー:', err)
  process.exit(1)
})

server.listen(cfg.port, cfg.host, async () => {
  console.log(`[bridge] Hermes Mobile PWA: http://${cfg.host}:${cfg.port}`)
  console.log(`[bridge] 上流: ${cfg.hermesBase}`)
  console.log(`[bridge] 管理画面: http://${cfg.host}:${cfg.port}/auth?t=${auth.token}`)
  try {
    await hermes.ensureToken()
    console.log('[bridge] Hermes セッショントークン: 解決済み')
  } catch (err) {
    console.warn(`[bridge] トークン解決に失敗（ダッシュボード停止？）: ${err?.message}`)
  }
})
