/**
 * PTY の門番（`server/ptyGate.js`）と、`openTerm` が枯渇時に **spawn を呼ばない**ことの単体テスト。
 *
 * 実測の症状: `/dev/ptmx` が ENXIO のとき `pty.spawn` は `posix_spawnp failed.` で落ち、
 * その失敗経路は master fd を解放しない（node-pty 1.1.0）。呼ぶたびに 1 本漏れるので、
 * 再接続の嵐で枯渇が自己増殖した（6 時間で 312 本 / 上限 511）。
 * ここでは「spawn を呼ばない」ことを固定する（実デバイスは触らない）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPtyGate, ptyUnavailableLine, PTMX_PATH } from '../src/server/ptyGate.js'
import { createWsHandlers } from '../src/server/ws-handlers.js'

/** 開けない /dev/ptmx。 */
const enxio = () => {
  const err = new Error('Device not configured')
  err.code = 'ENXIO'
  throw err
}

function mockSocket() {
  const ee = new EventEmitter()
  const sent = []
  let closed = 0
  return {
    readyState: 1,
    sent,
    get closed() {
      return closed
    },
    on: ee.on.bind(ee),
    emit: ee.emit.bind(ee),
    send: (d) => sent.push(String(d)),
    close: () => {
      closed += 1
      ee.emit('close')
    },
  }
}

test('ptyGate: /dev/ptmx が開けなければ attempt は ptmx で止まり、クールダウン中は再試行しない', () => {
  let now = 1000
  let opens = 0
  const gate = createPtyGate({
    openImpl: (path) => {
      opens += 1
      assert.equal(path, PTMX_PATH)
      return enxio()
    },
    now: () => now,
    cooldownMs: 5000,
  })

  const first = gate.attempt()
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'ptmx')
  assert.equal(first.code, 'ENXIO')

  // クールダウン中は /dev/ptmx を開きにいかない（＝試行が増えない）
  now += 1000
  const second = gate.attempt()
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'cooldown')
  assert.equal(opens, 1)

  // クールダウン明けはまた下見する
  now += 5000
  gate.attempt()
  assert.equal(opens, 2)
})

test('ptyGate: 開けたら ok、spawn 失敗の failed() でクールダウンに入り ok() で解除される', () => {
  let now = 0
  let closedFds = 0
  const gate = createPtyGate({
    openImpl: () => 42,
    closeImpl: (fd) => {
      assert.equal(fd, 42)
      closedFds += 1
    },
    now: () => now,
    cooldownMs: 1000,
  })

  assert.equal(gate.attempt().ok, true)
  assert.equal(closedFds, 1, '下見で開いた fd は必ず閉じる（master を残さない）')

  gate.failed(new Error('posix_spawnp failed.'))
  now += 10
  const cooling = gate.attempt()
  assert.equal(cooling.ok, false)
  assert.equal(cooling.reason, 'cooldown')
  assert.match(cooling.message, /posix_spawnp/)

  now += 1000
  gate.ok()
  assert.equal(gate.attempt().ok, true)
  assert.equal(gate.state.cooldownUntil, 0)
})

test('openTerm: 枯渇時は pty.spawn を呼ばず、理由を端末へ 1 行出して閉じる', () => {
  let spawns = 0
  const audits = []
  const handlers = createWsHandlers({
    cfg: { hermesBase: 'http://127.0.0.1:8642' },
    hermes: { wsUrl: async () => '' },
    auth: { audit: (e) => audits.push(e) },
    pty: {
      spawn: () => {
        spawns += 1
        throw new Error('should not be called')
      },
    },
    listProfiles: async () => [],
    checkFrame: (t) => ({ ok: true, text: t }),
    rejectionFrame: () => '',
    ptyGate: createPtyGate({ openImpl: () => enxio(), now: () => 0, cooldownMs: 1000 }),
  })

  const ws = mockSocket()
  handlers.openTerm(ws)

  assert.equal(spawns, 0, 'onTerm は spawn を呼ばない（呼ぶと master fd が漏れる）')
  assert.equal(ws.closed, 1)
  const frames = ws.sent.map((s) => JSON.parse(s))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].t, 'out')
  assert.match(frames[0].d, /PTY unavailable/)
  assert.match(frames[0].d, /ENXIO/)
  assert.deepEqual(
    audits.map((a) => a.kind),
    ['term.error'],
  )
})

test('ptyUnavailableLine: 枯渇と spawn 失敗で次の一手が変わる（端末へ流す行は英語 = D71）', () => {
  const exhausted = ptyUnavailableLine({ reason: 'ptmx', code: 'ENXIO', message: 'Device not configured' })
  assert.match(exhausted, /PTY unavailable/)
  assert.match(exhausted, /restart the bridge/)
  const spawnFailed = ptyUnavailableLine({ reason: 'cooldown', message: 'posix_spawnp failed.' })
  assert.match(spawnFailed, /Retrying shortly/)
  // 実行時出力に CJK を混ぜない（SPEC-EN-ZERO-LEAK D71）
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/
  assert.equal(CJK.test(exhausted + spawnFailed), false)
})
