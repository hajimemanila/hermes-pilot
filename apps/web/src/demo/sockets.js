/**
 * デモの WebSocket モック（JSON-RPC と端末フレーム）。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import { DEMO_SESSION } from './fixtures.js'

const DEMO_SESSIONS = [{ id: DEMO_SESSION, title: 'Demo — A2B pipeline in four steps', profile: 'demo', message_count: 6 }]

function rpcResult(method, params) {
  if (method === 'session.list') return { sessions: DEMO_SESSIONS }
  if (method === 'session.resume') {
    return {
      session_id: DEMO_SESSION,
      resumed: params?.session_id || DEMO_SESSION,
      info: { cwd: '/demo/hermes-pilot', model: 'demo' },
      messages: [],
    }
  }
  if (method === 'session.create') return { session_id: DEMO_SESSION, stored_session_id: DEMO_SESSION }
  if (method === 'prompt.submit') return { ok: true, session_id: params?.session_id || DEMO_SESSION }
  return { ok: true }
}

/**
 * 端末タブ（`/ws/term`）の擬似シェル。
 *
 * 本番は PTY を中継する（`{t:'in', d}` / `{t:'out', d}` / `{t:'resize'}` の 3 種だけ）。
 * デモは同じフレームで「読めるが何も起きない」端末を返す（デモから実ホストを触らせない）。
 *
 * @param {(payload: object) => void} emit 端末フレームを 1 つ流す関数
 * @returns {{send: (raw: string) => void}} 端末用の送信関数
 */
function termShell(emit) {
  /** コマンド行 → 擬似標準出力。 */
  const reply = (line) => {
    const cmd = String(line ?? '').trim()
    const head = cmd.split(/\s+/)[0] ?? ''
    if (!cmd) return ''
    if (head === 'help') {
      return [
        'Demo shell commands (nothing is executed):',
        '  hermes <status|gateway status|kanban list>',
        '  npx hermes-pilot <start|qr|service status>',
        '  npm run <verify|build|build:demo>',
        '  git <status|log>',
        '  ls | pwd | whoami | clear | help',
      ].join('\r\n')
    }
    if (head === 'hermes') {
      const tail = cmd.slice(head.length).trim()
      if (tail.startsWith('gateway status')) return 'gateway: running (pid 4242, uptime 1h 12m) — demo'
      if (tail.startsWith('kanban list')) {
        return [
          'mobile/t_demo_review   blocked  [DEMO-1] Interactive demo — three design decisions',
          'mobile/t_demo_done     done     [DEMO-0] Static demo shell builds with npm run build:demo',
        ].join('\r\n')
      }
      if (tail.startsWith('gateway')) return 'gateway: running (demo)'
      return 'hermes: demo shell — nothing is executed'
    }
    if (head === 'npx' && String(cmd).includes('hermes-pilot')) {
      const tail = cmd.slice(cmd.indexOf('hermes-pilot') + 'hermes-pilot'.length).trim()
      if (tail.startsWith('qr')) return 'Pairing QR (demo): https://demo.tailnet.ts.net:8444/?token=demo-only'
      if (tail.startsWith('service')) return 'Hermes Pilot (demo): running on 127.0.0.1:4097'
      return 'Hermes Pilot (demo) started — http://127.0.0.1:4097'
    }
    if (head === 'npm') {
      if (/\bverify\b/.test(cmd)) return 'verify: 812 tests, 0 fail — build ok — demo (not a real run)'
      if (/build:demo/.test(cmd)) return 'dist-demo written: google-sites-embed.html (demo)'
      if (/\bbuild\b/.test(cmd)) return 'vite build (demo) — dist/ written'
      return 'npm (demo) — nothing is executed'
    }
    if (head === 'git') {
      if (/log/.test(cmd)) return 'd3m0a1b feat(demo): static demo shell builds with npm run build:demo'
      return 'On branch main\r\nnothing to commit, working tree clean (demo)'
    }
    if (head === 'ls') return 'apps  docs  package.json  plugin.json  scripts  skills'
    if (head === 'pwd') return '/demo/hermes-pilot'
    if (head === 'whoami') return 'demo'
    if (head === 'clear') return '\x1b[2J\x1b[H'
    if (head === 'echo') return cmd.slice(5)
    return `zsh: command not found: ${head} (demo shell)`
  }
  let buffer = ''
  return {
    send(raw) {
      let msg = null
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (!msg || msg.t !== 'in') return
      const data = String(msg.d ?? '')
      buffer += data
      if (!/[\r\n]/.test(data)) return
      const line = buffer.replace(/[\r\n]+$/, '')
      buffer = ''
      // 入力のエコー → コマンド出力 → 次のプロンプト（本物の端末と同じ並び）
      const out = `${data.replace(/\r/g, '')}${reply(line)}\r\n$ `
      setTimeout(() => emit({ t: 'out', d: out }), 0)
    },
  }
}

/**
 * `openSocket()` のデモ実装。`WebSocket` と同じ形（`readyState` / `send` / `close` / `onopen` 等）で、
 * 接続すると `gateway.ready` を 1 回だけ流す（本物のゲートウェイと同じ合図）。
 *
 * V10 §3.3 / D47: `path` が `/ws/term` のときは端末プロトコル（`{t:'out', d}`）で応答する。
 *
 * @param {string} [path] 接続先（`/ws/chat` 既定）
 * @returns {object} 擬似ソケット
 */
export function demoSocket(path = '/ws/chat') {
  const isTerm = String(path ?? '').startsWith('/ws/term')
  if (isTerm) {
    const sock = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(raw) {
        shell.send(raw)
      },
      close() {
        sock.readyState = 3
        sock.onclose?.({})
      },
      addEventListener(type, fn) {
        if (type === 'open') sock.onopen = fn
        if (type === 'message') sock.onmessage = fn
        if (type === 'close') sock.onclose = fn
        if (type === 'error') sock.onerror = fn
      },
      removeEventListener() {},
    }
    const shell = termShell((payload) => sock.onmessage?.({ data: JSON.stringify(payload) }))
    // 端末のバナーは `socket.onmessage` を張った後に届ける（張る前に流すと捨てられる）
    setTimeout(() => {
      sock.readyState = 1
      sock.onopen?.({})
      sock.onmessage?.({
        data: JSON.stringify({
          t: 'out',
          d: '\r\n\x1b[36mHermes Pilot Demo Shell (read-only simulation)\x1b[0m\r\n$ ',
        }),
      })
    }, 0)
    return sock
  }
  const sock = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(raw) {
      let msg = null
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (!msg || msg.id == null) return
      const reply = { jsonrpc: '2.0', id: msg.id, result: rpcResult(msg.method, msg.params) }
      setTimeout(() => sock.onmessage?.({ data: JSON.stringify(reply) }), 0)
    },
    close() {
      sock.readyState = 3
      sock.onclose?.({})
    },
    addEventListener(type, fn) {
      if (type === 'open') sock.onopen = fn
      if (type === 'message') sock.onmessage = fn
      if (type === 'close') sock.onclose = fn
      if (type === 'error') sock.onerror = fn
    },
    removeEventListener() {},
  }
  setTimeout(() => {
    sock.readyState = 1
    sock.onopen?.({})
    sock.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'gateway.ready', params: { type: 'gateway.ready' } }) })
  }, 0)
  return sock
}
