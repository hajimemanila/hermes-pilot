/**
 * インメモリの簡易レート制限（`server.js` から切り出し）。プロセス内の状態だけを持つ。
 *
 * 3 系統を混ぜない: 書き込み（アプリ操作）/ ペアリング（ログイン）/ 読み取り（機能別バケット）。
 * 混ぜると通常操作がログイン試行で詰まる。
 */

/** 書き込み系の簡易レート制限。 */
const writes = []
export function writeAllowed(max = 60, windowMs = 60_000) {
  const now = Date.now()
  while (writes.length && now - writes[0] > windowMs) writes.shift()
  if (writes.length >= max) return false
  writes.push(now)
  return true
}

/**
 * ペアリング（`POST /api/auth/login`）専用の簡易レート制限。
 * アプリの書き込み枠と混ぜない（混ぜると通常操作が 10 回で詰まる）。
 */
const loginAttempts = []
export function loginAllowed(max = 12, windowMs = 60_000) {
  const now = Date.now()
  while (loginAttempts.length && now - loginAttempts[0] > windowMs) loginAttempts.shift()
  if (loginAttempts.length >= max) return false
  loginAttempts.push(now)
  return true
}

/** 読み取り系の簡易レート制限（機能別バケットで分離）。書き込みとは枠を分ける。 */
const readBuckets = new Map()
export function readAllowed(bucket = 'default', max = 240, windowMs = 60_000) {
  const now = Date.now()
  let arr = readBuckets.get(bucket)
  if (!arr) {
    arr = []
    readBuckets.set(bucket, arr)
  }
  while (arr.length && now - arr[0] > windowMs) arr.shift()
  if (arr.length >= max) return false
  arr.push(now)
  return true
}
