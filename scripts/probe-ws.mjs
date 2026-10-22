#!/usr/bin/env node
/**
 * Hermes dashboard の /api/ws（JSON-RPC 2.0）プロトコル探針。
 *
 *   node scripts/probe-ws.mjs            … セッション作成→送信→数フレーム観察
 *   node scripts/probe-ws.mjs --list     … session.list だけ
 *
 * 目的:
 * - ブリッジが依存する最低限のメソッド名と引数、通知名を実物から確定する
 * - ダッシュボード更新でプロトコルが変わったら即座に検知する（V1 の生命線）
 */
import WebSocket from 'ws'

const BASE = process.env.HERMES_BASE || 'http://127.0.0.1:9119'
const ONLY_LIST = process.argv.includes('--list')

/** ダッシュボードの SPA HTML からセッショントークンを拾う。 */
async function resolveToken() {
  if (process.env.HERMES_DASHBOARD_SESSION_TOKEN) return process.env.HERMES_DASHBOARD_SESSION_TOKEN
  const res = await fetch(`${BASE}/`)
  const html = await res.text()
  const m = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/.exec(html)
  if (!m) throw new Error('session token not found in SPA HTML')
  return m[1]
}

const token = await resolveToken()
const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`
const ws = new WebSocket(wsUrl, { headers: { Origin: BASE } })

const frames = []
let nextId = 1
const waiters = new Map()

ws.on('open', () => console.log(`OPEN ${wsUrl.replace(token, '<token>')}`))
ws.on('close', (code, reason) => console.log(`CLOSE ${code} ${reason?.toString?.() ?? ''}`))
ws.on('error', (err) => console.log(`ERROR ${err.message}`))
ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    console.log(`RAW ${raw.toString().slice(0, 120)}`)
    return
  }
  frames.push(msg)
  if (msg.id && waiters.has(msg.id)) {
    waiters.get(msg.id)(msg)
    waiters.delete(msg.id)
    return
  }
  const method = msg.method ?? msg.params?.type ?? '?'
  const brief = JSON.stringify(msg).slice(0, 240)
  console.log(`NOTIF ${method} ${brief}`)
})

/** JSON-RPC を 1 回投げて応答を待つ。 */
function rpc(method, params = {}, timeoutMs = 15000) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, params }
  console.log(`→ ${method} ${JSON.stringify(params).slice(0, 200)}`)
  ws.send(JSON.stringify(payload))
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), timeoutMs)
    waiters.set(id, (m) => {
      clearTimeout(t)
      console.log(`← ${JSON.stringify(m).slice(0, 300)}`)
      resolve(m)
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(600)
const list = await rpc('session.list', {})
if (ONLY_LIST) {
  ws.close()
  process.exit(0)
}

const created = await rpc('session.create', { title: 'probe-mobile' })
const sid =
  created.result?.session_id ?? created.result?.id ?? created.result?.session?.id ?? created.result?.sid
console.log(`SID=${sid ?? '(unknown)'} keys=${created.result ? Object.keys(created.result).join(',') : '-'}`)

if (sid) {
  await rpc('prompt.submit', {
    session_id: sid,
    text: 'Reply with exactly the token MOBILE_OK and nothing else.',
  })
  await sleep(12000)
}

const methods = [...new Set(frames.map((f) => f.method ?? f.params?.type).filter(Boolean))]
console.log(`FRAMES=${frames.length} NOTIFS=${methods.join(',')}`)
ws.close()
process.exit(0)
