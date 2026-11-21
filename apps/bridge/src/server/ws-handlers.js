/**
 * WebSocket ハンドラ（チャット中継 / 実 PTY 端末）。`server.js` から分割（挙動は変えない）。
 * アップグレードの可否判定と `wss` の生成は `server.js` 側に残す。
 */
import { WebSocket } from 'ws'

export function createWsHandlers(ctx = {}) {
  const { cfg, hermes, auth, pty, listProfiles, checkFrame, rejectionFrame } = ctx

/**
 * チャット WS を Hermes の /api/ws へ中継する（プロトコルは素通し）。
 * 端末からは JSON-RPC がそのまま見えるので、探針テストと同じ経路になる。
 * @param {WebSocket} client 端末側
 */
async function proxyChat(client) {
  let upstream
  const started = Date.now()
  // この接続で送ってよいプロファイル名（serve 済み）。取れなければ default のみ。
  // **listener より先に await しない**: 待つ間に届いた端末フレームは listener が無いと捨てられる
  // （実測: 最初の session.list が消えて 20 秒タイムアウトした）。解決までは hold に溜める。
  let allowed = []
  let allowedReady = false
  const hold = []
  /** @type {string[]} */
  const queue = []
  listProfiles()
    .then((list) => {
      allowed = (list ?? []).map((p) => p.name).filter(Boolean)
    })
    .catch(() => {})
    .finally(() => {
      allowedReady = true
      for (const t of hold.splice(0)) forward(t)
    })

  /** 1 フレームを検証して上流へ流す（プロファイル検証はここだけ）。 */
  function forward(text) {
    const checked = checkFrame(text, allowed)
    if (!checked.ok) {
      // 上流には流さない。端末には JSON-RPC エラーとして返す（SPEC-PROFILE-CHAT 決定 D1）
      if (client.readyState === WebSocket.OPEN) client.send(rejectionFrame(checked.id, checked.message))
      auth.audit({ kind: 'chat.profile', method: checked.method, profile: checked.profile, blocked: true })
      return
    }
    if (checked.profile) auth.audit({ kind: 'chat.profile', method: checked.method, profile: checked.profile })
    const out = checked.text
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(out)
    else queue.push(out)
  }

  try {
    // 端末が繋ぐたびにトークンを取り直す（gateway 再起動後の 403 を自己回復）
    upstream = new WebSocket(await hermes.wsUrl('/api/ws', { fresh: true }), { headers: { Origin: cfg.hermesBase } })
  } catch (err) {
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.error', payload: { message: String(err?.message ?? err) } } }))
    client.close(1011)
    return
  }
  client.on('message', (raw) => {
    const text = raw.toString()
    if (!allowedReady) {
      hold.push(text)
      return
    }
    forward(text)
  })
  // 上流は無音で切ることがある（実測: code=1005 が散発）。25秒ごとに ping して
  // 「応答が来ないまま画面が止まる」を防ぐ。pong が90秒来なければ張り直す。
  let ka = null
  let lastPong = Date.now()

  upstream.on('open', () => {
    for (const q of queue.splice(0)) upstream.send(q)
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.ready', payload: {} } }))
    console.log(`[chat] upstream open (${Date.now() - started}ms)`)
    lastPong = Date.now()
    ka = setInterval(() => {
      if (upstream?.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPong > 90_000) {
        console.log('[chat] upstream silent 90s → close')
        try {
          upstream.terminate()
        } catch {}
        return
      }
      try {
        upstream.ping()
      } catch {}
    }, 25_000)
  })
  upstream.on('pong', () => {
    lastPong = Date.now()
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
  upstream.on('close', (code) => {
    if (ka) clearInterval(ka)
    console.log(`[chat] upstream closed code=${code} after ${Date.now() - started}ms`)
    closeBoth(code === 1000 ? 1000 : 1011, `upstream ${code}`)
  })
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
    ws.send(JSON.stringify({ t: 'out', d: '\r\n[bridge] node-pty failed to load\r\n' }))
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
    ws.send(JSON.stringify({ t: 'out', d: `\r\n[bridge] Failed to start PTY: ${err?.message ?? err}\r\n` }))
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

  return { proxyChat, openTerm }
}
