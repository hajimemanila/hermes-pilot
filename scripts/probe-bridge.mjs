#!/usr/bin/env node
/**
 * ブリッジ経由のチャット疎通テスト（端末と同じ経路）。
 *
 *   node scripts/probe-bridge.mjs
 *
 * 検証:
 * 1. /healthz が 200
 * 2. /ws/chat に Cookie 無し・アプリトークンで接続できる
 * 3. gateway.ready が届く
 * 4. session.create → prompt.submit → message.delta → message.complete
 */
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.HM_BASE || 'http://127.0.0.1:4097'
const tokenPath = path.join(process.env.HOME, '.hermes/mobile-pwa/token')
const token = fs.readFileSync(tokenPath, 'utf8').trim()

const health = await fetch(`${BASE}/healthz`).then((r) => r.json())
console.log(`healthz=${JSON.stringify(health)}`)

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/chat?t=${encodeURIComponent(token)}`)
const frames = []
let nextId = 1
const waiters = new Map()

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  frames.push(msg)
  if (msg.id && waiters.has(msg.id)) {
    waiters.get(msg.id)(msg)
    waiters.delete(msg.id)
    return
  }
  const type = msg?.params?.type
  if (type && type !== 'sessions.changed') console.log(`NOTIF ${type} ${JSON.stringify(msg.params.payload ?? {}).slice(0, 120)}`)
})

function rpc(method, params = {}, timeoutMs = 20000) {
  const id = nextId++
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), timeoutMs)
    waiters.set(id, (m) => {
      clearTimeout(t)
      resolve(m)
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
  setTimeout(() => reject(new Error('ws open timeout')), 8000)
}).catch((e) => {
  console.log(`WS_FAIL ${e.message}`)
  process.exit(1)
})

await sleep(500)
const created = await rpc('session.create', { title: 'probe-bridge' })
const sid = created?.result?.session_id
console.log(`SESSION=${sid ?? 'none'} keys=${created?.result ? Object.keys(created.result).join(',') : '-'}`)
if (!sid) process.exit(1)

const acc = []
ws.on('message', (raw) => {
  try {
    const m = JSON.parse(raw.toString())
    const p = m?.params
    if (p?.session_id === sid && p.type === 'message.delta') acc.push(p.payload?.text ?? '')
  } catch {
    /* noop */
  }
})

const t0 = Date.now()
const submitted = await rpc('prompt.submit', { session_id: sid, text: 'Reply with exactly BRIDGE_OK and nothing else.' })
console.log(`SUBMIT=${JSON.stringify(submitted.result ?? submitted.error)}`)
await sleep(14000)
const done = frames.find((f) => f?.params?.type === 'message.complete' && f.params.session_id === sid)
console.log(`STREAMED=${JSON.stringify(acc.join('').slice(0, 80))}`)
console.log(`COMPLETE=${done ? JSON.stringify(done.params.payload?.text) : 'none'}`)
console.log(`ELAPSED_MS=${Date.now() - t0}`)
ws.close()
process.exit(done ? 0 : 2)
