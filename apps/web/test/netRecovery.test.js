/**
 * 通信断（Tailscale 未接続・移動中の回線切替）からの復帰ロジック検証。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_GET_TIMEOUT_MS,
  ERROR_TOAST_COOLDOWN_MS,
  OVERVIEW_TIMEOUT_MS,
  isConnectivityRecovery,
  isOfflineError,
  resolveTimeoutMs,
  shouldNotifyError,
} from '../src/lib/netRecovery.js'
import { api } from '../src/api.js'
import { demoSocket } from '../src/demo/sockets.js'
import { stripComments } from './helpers/stripComments.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src')
const readCode = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))

test('resolveTimeoutMs: GET は既定 15s、書込系は既定無効、明示値を優先', () => {
  assert.equal(resolveTimeoutMs(), DEFAULT_GET_TIMEOUT_MS)
  assert.equal(resolveTimeoutMs('GET'), DEFAULT_GET_TIMEOUT_MS)
  assert.equal(resolveTimeoutMs('POST'), 0)
  assert.equal(resolveTimeoutMs('PUT'), 0)
  assert.equal(resolveTimeoutMs('DELETE'), 0)
  assert.equal(resolveTimeoutMs('GET', OVERVIEW_TIMEOUT_MS), OVERVIEW_TIMEOUT_MS)
  assert.equal(resolveTimeoutMs('POST', 5000), 5000)
  assert.equal(resolveTimeoutMs('GET', 0), 0)
  assert.equal(resolveTimeoutMs('GET', null), 0)
})

test('isConnectivityRecovery: offline / error から ok への遷移だけを検知', () => {
  assert.equal(isConnectivityRecovery('offline', 'ok'), true)
  assert.equal(isConnectivityRecovery('error', 'ok'), true)
  assert.equal(isConnectivityRecovery('ok', 'ok'), false)
  assert.equal(isConnectivityRecovery('ok', 'offline'), false)
  assert.equal(isConnectivityRecovery('offline', 'error'), false)
})

test('isOfflineError: OFFLINE / TIMEOUT / timedOut / AbortError を識別', () => {
  assert.equal(isOfflineError({ code: 'OFFLINE' }), true)
  assert.equal(isOfflineError({ code: 'TIMEOUT' }), true)
  assert.equal(isOfflineError({ timedOut: true }), true)
  assert.equal(isOfflineError({ name: 'AbortError' }), true)
  assert.equal(isOfflineError({ name: 'TimeoutError' }), true)
  assert.equal(isOfflineError({ status: 500, code: 'INTERNAL' }), false)
  assert.equal(isOfflineError(null), false)
  assert.equal(isOfflineError('OFFLINE'), false)
})

test('shouldNotifyError: 手動操作は常時通知、背景オフラインは抑制・一般背景はクールダウン', () => {
  assert.equal(shouldNotifyError({ silent: false, offline: true }), true)
  assert.equal(shouldNotifyError({ silent: true, offline: true, lastAt: 0 }), false)
  assert.equal(shouldNotifyError({ silent: true, offline: false, lastAt: 0, now: 1000 }), true)
  assert.equal(
    shouldNotifyError({ silent: true, offline: false, lastAt: 1000, now: 1000 + ERROR_TOAST_COOLDOWN_MS - 1 }),
    false,
  )
  assert.equal(
    shouldNotifyError({ silent: true, offline: false, lastAt: 1000, now: 1000 + ERROR_TOAST_COOLDOWN_MS }),
    true,
  )
})

test('api(): GET タイムアウトで code=OFFLINE / timedOut=true を投げ、POST 既定は切らない', async () => {
  const prevFetch = globalThis.fetch
  const prevDemo = globalThis.__hmDemoFetch
  delete globalThis.__hmDemoFetch
  try {
    let seenSignal = null
    globalThis.fetch = (_url, init) => {
      seenSignal = init.signal
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }
    await assert.rejects(
      () => api('/api/overview', { timeoutMs: 20 }),
      (err) => err?.code === 'OFFLINE' && err?.timedOut === true,
    )
    assert.ok(seenSignal?.aborted, 'タイムアウトで AbortController が発火している')

    let postSignal = 'unset'
    globalThis.fetch = async (_url, init) => {
      postSignal = init.signal
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const postRes = await api('/api/specs/launch', { method: 'POST', body: {} })
    assert.deepEqual(postRes, { ok: true })
    assert.equal(postSignal, undefined, '書込系は既定では AbortSignal を付けない')
  } finally {
    globalThis.fetch = prevFetch
    if (prevDemo !== undefined) globalThis.__hmDemoFetch = prevDemo
  }
})

test('回線復帰の契約が App・全主要ペイン・WebSocket に入っている', () => {
  const app = readCode('App.jsx')
  assert.match(app, /isConnectivityRecovery\(connRef\.current,\s*'ok'\)/)
  assert.match(app, /syncAllBadges\(\{\s*force:\s*true,\s*skip:\s*refreshRef\.current\s*\}\)/)
  assert.match(app, /addEventListener\('pageshow',\s*onVis\)/)
  assert.match(app, /syncAllBadges\(\{\s*force:\s*true\s*\}\)/)

  const tasks = readCode('features/TasksPane.jsx')
  assert.match(tasks, /if\s*\(boardsFailedRef\.current\)\s*loadBoards\(\{\s*silent:\s*true\s*\}\)/)
  assert.match(tasks, /if\s*\(tasksBoardRef\.current\s*!==\s*slug\)\s*setTasks\(\[\]\)/)
  assert.match(tasks, /useWakeSync\(\(\)\s*=>/)

  const review = readCode('features/ReviewPane.jsx')
  assert.match(review, /items:\s*prev\.items/)
  assert.match(review, /useWakeSync\(\(\)\s*=>/)

  for (const rel of ['features/MemosPane.jsx', 'features/SettingsPane.jsx', 'features/PipelinePanel.jsx', 'features/ChatPane.jsx']) {
    assert.match(readCode(rel), /useWakeSync\(/, `${rel} が useWakeSync を使っていない`)
  }

  const chatSock = readCode('lib/useChatSocket.js')
  assert.match(chatSock, /if\s*\(wsRef\.current\s*!==\s*ws\)\s*return/)
  assert.match(chatSock, /rpc\('bridge\.ping',\s*\{\},\s*WS_PROBE_TIMEOUT_MS\)/)
  assert.match(chatSock, /onHmEvent\(HM_EVENTS\.WAKE_SYNC,\s*probeOrReconnect\)/)

  const term = readCode('features/TermPane.jsx')
  assert.match(term, /t:\s*'ping'/)
  assert.match(term, /msg\.t\s*===\s*'pong'/)
  assert.match(term, /onHmEvent\(HM_EVENTS\.WAKE_SYNC,\s*reconnectNow\)/)
})

test('demoSocket(/ws/term) は {t:"ping"} に {t:"pong"} を返す', async () => {
  const sock = demoSocket('/ws/term')
  const frames = []
  sock.onmessage = (ev) => frames.push(JSON.parse(ev.data))
  await new Promise((r) => setTimeout(r, 10))
  sock.send(JSON.stringify({ t: 'ping' }))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(frames.some((f) => f.t === 'pong'), true)
  sock.close()
})
