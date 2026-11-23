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
