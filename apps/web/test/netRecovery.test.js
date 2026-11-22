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
  WAKE_THROTTLE_MS,
  WS_PROBE_TIMEOUT_MS,
  isConnectivityRecovery,
  isOfflineError,
  resolveTimeoutMs,
  shouldNotifyError,
  shouldReconnectToast,
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

test('isOfflineError: OFFLINE / TIMEOUT / timedOut / AbortError とコード無し 502/503/504 を識別', () => {
  assert.equal(isOfflineError({ code: 'OFFLINE' }), true)
  assert.equal(isOfflineError({ code: 'TIMEOUT' }), true)
  assert.equal(isOfflineError({ timedOut: true }), true)
  assert.equal(isOfflineError({ name: 'AbortError' }), true)
  assert.equal(isOfflineError({ name: 'TimeoutError' }), true)
  assert.equal(isOfflineError({ status: 502 }), true, 'プロキシ／回線起因の 502 は瞬断扱い')
  assert.equal(isOfflineError({ status: 503, code: null }), true)
  assert.equal(isOfflineError({ status: 504 }), true)
  assert.equal(isOfflineError({ status: 502, code: 'CLI_FAILED' }), false, 'アプリコード付き 502 は通常エラーのまま')
  assert.equal(isOfflineError({ status: 500, code: 'INTERNAL' }), false)
  assert.equal(isOfflineError({ status: 500 }), false)
  assert.equal(isOfflineError(null), false)
  assert.equal(isOfflineError('OFFLINE'), false)
})

test('shouldReconnectToast と定数: 非表示・短瞬断では再接続トーストを出さず WS/Wake 定数も過剰でない', () => {
  assert.equal(shouldReconnectToast({ active: true, wasOffline: true }), true)
  assert.equal(shouldReconnectToast({ active: false, wasOffline: true }), false, '裏タブでは通知しない')
  assert.equal(shouldReconnectToast({ active: true, wasOffline: false }), false, '赤帯未満の瞬断では通知しない')
  assert.equal(shouldReconnectToast(), false)
  assert.ok(WS_PROBE_TIMEOUT_MS >= 8_000)
  assert.ok(WAKE_THROTTLE_MS >= 2_000)
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
  // 復帰時の 1 周は表のスケジューラに集約し、シグナル連打は WAKE_THROTTLE_MS で束ねる
  assert.match(app, /scheduler\.wake\(\{\s*skip:\s*'overview',\s*minGapMs:\s*WAKE_THROTTLE_MS\s*\}\)/)
  assert.match(app, /scheduler\.wake\(\{\s*minGapMs:\s*WAKE_THROTTLE_MS\s*\}\)/)
  assert.match(app, /shouldShowBanner\(httpConn\)/)
  assert.match(app, /scheduler\.tickVisible\(\)/)
  assert.equal((app.match(/addEventListener\(HM_EVENTS\.REVIEW_ITEMS\b/g) ?? []).length, 1, 'REVIEW_ITEMS の二重購読を残さない')
  assert.match(app, /addEventListener\('pageshow',\s*onVis\)/)
  assert.match(app, /createSyncScheduler\(/)
  assert.match(app, /scheduler\.forceAll\(\)/)

  const tasks = readCode('features/TasksPane.jsx')
  assert.match(tasks, /if\s*\(boardsFailedRef\.current\)\s*loadBoards\(\{\s*silent:\s*true\s*\}\)/)
  assert.match(tasks, /if\s*\(tasksBoardRef\.current\s*!==\s*slug\)\s*setTasks\(\[\]\)/)
  assert.match(tasks, /if\s*\(archBoardRef\.current\s*!==\s*board\)\s*setArchitectJobs\(null\)/)
  assert.match(tasks, /if\s*\(specsBoardRef\.current\s*!==\s*slug\)\s*setSpecsInfo\(null\)/)
  assert.match(tasks, /if\s*\(cohBoardRef\.current\s*!==\s*slug\)\s*setCoherenceReport\(null\)/)
  assert.match(tasks, /reportBoardRef\.current\s*!==\s*board\)\s*setLatestReport\(null\)/)
  assert.match(tasks, /useWakeSync\(\(\)\s*=>/)

  const review = readCode('features/ReviewPane.jsx')
  assert.match(review, /items:\s*prev\.items/)
  assert.match(review, /useWakeSync\(\(\)\s*=>/)

  for (const rel of ['features/MemosPane.jsx', 'features/SettingsPane.jsx', 'features/PipelinePanel.jsx', 'features/ChatPane.jsx']) {
    assert.match(readCode(rel), /useWakeSync\(/, `${rel} が useWakeSync を使っていない`)
  }
  const chatPane = readCode('features/ChatPane.jsx')
  assert.match(chatPane, /shouldReconnectToast\(/)

  const chatSock = readCode('lib/useChatSocket.js')
  assert.match(chatSock, /if\s*\(wsRef\.current\s*!==\s*ws\)\s*return/)
  assert.match(chatSock, /shouldShowBanner\(state\)/)
  assert.doesNotMatch(chatSock, /state\s*===\s*'recovering'\s*\|\|\s*state\s*===\s*'offline'/)
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
