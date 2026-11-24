/**
 * WebSocket 半開き検知（ping/pong・bridge.ping・keepalive timeout）の単体テスト。
 * ポートは開かずモックソケットのみで検証する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { attachClientKeepalive, createWsHandlers } from '../src/server/ws-handlers.js'
import { createPtyGate } from '../src/server/ptyGate.js'

/** PTY を作れる環境を装う門番（/dev/ptmx を実際に触らない）。 */
const openGate = () => createPtyGate({ openImpl: () => 7, closeImpl: () => {} })

function mockSocket() {
  const ee = new EventEmitter()
  const sent = []
  let pings = 0
  let terminated = 0
  let closed = 0
  return {
    readyState: 1,
    sent,
    get pings() {
      return pings
    },
    get terminated() {
      return terminated
    },
    get closed() {
      return closed
    },
    on: ee.on.bind(ee),
    emit: ee.emit.bind(ee),
    send: (d) => sent.push(String(d)),
    ping: () => {
      pings += 1
    },
    terminate: () => {
      terminated += 1
      ee.emit('close')
    },
    close: () => {
      closed += 1
      ee.emit('close')
    },
  }
}

test('openTerm: {t:"ping"} は PTY へ書かず {t:"pong"} を返す', () => {
  const written = []
  let killed = 0
  const handlers = createWsHandlers({
    cfg: { hermesBase: 'http://127.0.0.1:8642' },
    hermes: { wsUrl: async () => '' },
    auth: { audit: () => {} },
    pty: {
      spawn: () => ({
        pid: 4242,
        onData: () => {},
        onExit: () => {},
        write: (d) => written.push(d),
        resize: () => {},
        kill: () => {
          killed += 1
        },
      }),
    },
    listProfiles: async () => [],
    checkFrame: (t) => ({ ok: true, text: t }),
    rejectionFrame: () => '',
    ptyGate: openGate(),
  })

  const ws = mockSocket()
  handlers.openTerm(ws)
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'ping' })))
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'in', d: 'ls\r' })))

  assert.deepEqual(written, ['ls\r'])
  assert.deepEqual(
    ws.sent.map((s) => JSON.parse(s)),
    [{ t: 'pong' }],
  )
  ws.close()
  assert.equal(killed, 1)
})

test('openTerm: WS が閉じたら destroy() で master fd を即返す（GC 任せにしない）', () => {
  let destroyed = 0
  let killed = 0
  const handlers = createWsHandlers({
    cfg: { hermesBase: 'http://127.0.0.1:8642' },
    hermes: { wsUrl: async () => '' },
    auth: { audit: () => {} },
    pty: {
      spawn: () => ({
        pid: 4343,
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        destroy: () => {
          destroyed += 1
        },
        kill: () => {
          killed += 1
        },
      }),
    },
    listProfiles: async () => [],
    checkFrame: (t) => ({ ok: true, text: t }),
    rejectionFrame: () => '',
    ptyGate: openGate(),
  })

  const ws = mockSocket()
  handlers.openTerm(ws)
  ws.close()
  // kill() だけでは node-pty の `_close()` が fd を閉じない（PTY 枯渇の一因）。destroy を優先する。
  assert.equal(destroyed, 1)
  assert.equal(killed, 0)
})

test('proxyChat: bridge.ping に上流へ流さず JSON-RPC ok で即応する', async () => {
  const audits = []
  let rejectUpstream = null
  const handlers = createWsHandlers({
    cfg: { hermesBase: 'http://127.0.0.1:8642' },
    hermes: {
      wsUrl: () =>
        new Promise((_resolve, reject) => {
          rejectUpstream = reject
        }),
    },
    auth: { audit: (e) => audits.push(e) },
    pty: null,
    listProfiles: async () => [],
    checkFrame: () => {
      throw new Error('bridge.ping は上流チェックを通さない')
    },
    rejectionFrame: () => '',
  })

  const client = mockSocket()
  const running = handlers.proxyChat(client)
  client.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'bridge.ping', params: {} })))

  assert.deepEqual(
    client.sent.map((s) => JSON.parse(s)),
    [{ jsonrpc: '2.0', id: 77, result: { ok: true } }],
  )
  assert.equal(audits.length, 0)

  client.close()
  rejectUpstream(new Error('test cleanup'))
  await running
})

test('attachClientKeepalive: 無応答なら terminate し、pong/message で延命する', async () => {
  const silent = mockSocket()
  const stopSilent = attachClientKeepalive(silent, { intervalMs: 12, timeoutMs: 28 })
  await new Promise((r) => setTimeout(r, 70))
  stopSilent()
  assert.ok(silent.pings >= 1)
  assert.equal(silent.terminated, 1)

  const alive = mockSocket()
  const stopAlive = attachClientKeepalive(alive, { intervalMs: 12, timeoutMs: 35 })
  const keeper = setInterval(() => alive.emit('pong'), 10)
  await new Promise((r) => setTimeout(r, 55))
  clearInterval(keeper)
  stopAlive()
  assert.equal(alive.terminated, 0)
  assert.ok(alive.pings >= 1)
})

test('proxyChat: client が wsUrl 解決前に閉じたら上流 WS を作らず安全終了する', async () => {
  let resolveUrl
  let ctorCalls = 0
  class CountingWs extends EventEmitter {
    static CONNECTING = 0
    static OPEN = 1
    constructor() {
      super()
      ctorCalls += 1
    }
  }
  const handlers = createWsHandlers({
    cfg: { hermesBase: 'http://127.0.0.1:8642' },
    hermes: { wsUrl: () => new Promise((r) => { resolveUrl = r }) },
    auth: { audit: () => {} },
    pty: null,
    listProfiles: async () => [],
    checkFrame: (t) => ({ ok: true, text: t }),
    rejectionFrame: () => '',
    WebSocket: CountingWs,
  })

  const client = mockSocket()
  const running = handlers.proxyChat(client)
  client.close()
  resolveUrl('ws://127.0.0.1:8642/api/ws')
  await running
  assert.equal(ctorCalls, 0, '既に閉じたクライアントのために上流 WS を作らない')
})

test('proxyChat: 上流が CONNECTING 中に client が閉じても Unhandled error で落ちない', async () => {
  let upstreamRef = null
  let terminated = 0
  class ConnectingRaceWs extends EventEmitter {
    static CONNECTING = 0
    static OPEN = 1
    constructor() {
      super()
      this.readyState = 0
      upstreamRef = this
    }
    terminate() {
      terminated += 1
      this.readyState = 3
      process.nextTick(() => this.emit('error', new Error('WebSocket was closed before the connection was established')))
    }
    close() {
      this.terminate()
    }
  }
  const handlers = createWsHandlers({
    cfg: { hermesBase: 'http://127.0.0.1:8642' },
    hermes: { wsUrl: async () => 'ws://127.0.0.1:8642/api/ws' },
    auth: { audit: () => {} },
    pty: null,
    listProfiles: async () => [],
    checkFrame: (t) => ({ ok: true, text: t }),
    rejectionFrame: () => '',
    WebSocket: ConnectingRaceWs,
  })

  const client = mockSocket()
  await handlers.proxyChat(client)
  assert.ok(upstreamRef)
  assert.ok(upstreamRef.listenerCount('error') >= 1, 'CONNECTING 中から同期で error リスナーが登録されている')

  // CONNECTING 中に client が閉じる（ws の terminate() は次 tick で error を emit する）
  client.close()
  await new Promise((r) => setImmediate(r))
  assert.equal(terminated, 1)
})
