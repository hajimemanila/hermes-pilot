#!/usr/bin/env node
/**
 * 端末セッションを失効させる（トークンはそのまま）。
 *
 *   node scripts/revoke.mjs            … 全端末をログアウト
 *   node scripts/revoke.mjs --list     … 発行済みセッションの一覧
 *
 * トークン自体を変えたい場合は `rm ~/.hermes/mobile-pwa/token` してから
 * `launchctl kickstart -k gui/$(id -u)/ai.hermes.hermes-mobile`
 * （トークンが変わると過去のセッションは自動的に全失効する）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const dataDir = process.env.HM_DATA ?? path.join(process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'), 'mobile-pwa')
const file = path.join(dataDir, 'sessions.json')

let store = { version: 1, tokenFingerprint: '', sessions: {} }
try {
  store = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  console.log('[revoke] セッションはまだありません')
  process.exit(0)
}

const entries = Object.entries(store.sessions ?? {})
if (process.argv.includes('--list')) {
  if (!entries.length) console.log('[revoke] 有効な端末セッション: 0')
  for (const [k, v] of entries) {
    console.log(`  ${k.slice(0, 10)}…  created=${new Date(v.created).toISOString()}  lastSeen=${new Date(v.lastSeen ?? v.created).toISOString()}`)
  }
  process.exit(0)
}

store.sessions = {}
fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
console.log(`[revoke] ${entries.length} 台の端末セッションを失効させました（ブリッジの再起動は不要）`)
