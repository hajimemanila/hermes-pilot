/**
 * ワンタップ QR ペアリング（SPEC §8.2）の自動検証。
 *
 * - `?token=` / `#token=` / `?pair=` を読む
 * - トークンを Cookie に交換したら `history.replaceState` で URL から消す
 * - 失敗したら URL はそのまま（打ち直せる）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { consumePairToken, loginWithToken, readPairToken, stripPairToken, PAIR_KEYS } from '../src/lib/pairing.js'

/**
 * `window.location` 相当のスタブを作る。
 * @param {string} href URL
 * @returns {object} location 風オブジェクト
 */
function loc(href) {
  const u = new URL(href)
  return { href: u.href, search: u.search, hash: u.hash, pathname: u.pathname, origin: u.origin }
}

/** `history.replaceState` を記録するスタブ。 */
function hist() {
  const calls = []
  return { calls, replaceState: (state, title, url) => calls.push({ state, title, url }) }
}

test('readPairToken: ?token= / ?pair= / #token= / #<hex> を読む', () => {
  assert.equal(readPairToken(loc('https://h.ts.net/?token=abc123')), 'abc123')
  assert.equal(readPairToken(loc('https://h.ts.net/?pair=xyz789')), 'xyz789')
  assert.equal(readPairToken(loc('https://h.ts.net/#token=hash1')), 'hash1')
  assert.equal(readPairToken(loc('https://h.ts.net/#pair=hash2')), 'hash2')
  assert.equal(
    readPairToken(loc(`https://h.ts.net/#${'a'.repeat(64)}`)),
    'a'.repeat(64),
    '素のハッシュ（hex）もトークンとして扱う',
  )
  // 別のパラメータやデープリンクを誤爆しない
  assert.equal(readPairToken(loc('https://h.ts.net/?other=1')), null)
  assert.equal(readPairToken(loc('https://h.ts.net/#inbox:t_1')), null)
  assert.equal(readPairToken(loc(`https://h.ts.net/#${'z'.repeat(64)}`)), null)
  assert.equal(readPairToken(loc('https://h.ts.net/')), null)
  assert.deepEqual(PAIR_KEYS, ['token', 'pair'])
})

test('stripPairToken: クエリのトークンだけ消し、他のパラメータとパスは残す', () => {
  const location = loc('https://h.ts.net/some/path?token=secret&tab=review#inbox')
  const history = hist()
  assert.equal(stripPairToken(location, history), true)
  assert.equal(history.calls.length, 1)
  assert.equal(history.calls[0].url, '/some/path?tab=review#inbox')
})

test('stripPairToken: ハッシュのトークンを消し、他のハッシュは残す', () => {
  const h1 = hist()
  assert.equal(stripPairToken(loc('https://h.ts.net/?topic=1#token=secret'), h1), true)
  assert.equal(h1.calls[0].url, '/?topic=1')

  const h2 = hist()
  assert.equal(stripPairToken(loc(`https://h.ts.net/#${'b'.repeat(64)}`), h2), true)
  assert.equal(h2.calls[0].url, '/')

  const h3 = hist()
  assert.equal(stripPairToken(loc('https://h.ts.net/#token=secret&keep=1'), h3), true)
  assert.equal(h3.calls[0].url, '/#keep=1')
})

test('stripPairToken: トークンが無ければ何もしない', () => {
  const history = hist()
  assert.equal(stripPairToken(loc('https://h.ts.net/#inbox'), history), false)
  assert.equal(history.calls.length, 0)
})

test('loginWithToken: POST /api/auth/login にトークンを送る', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200 }
  }
  const r = await loginWithToken('tok', fetchImpl)
  assert.deepEqual(r, { ok: true, status: 200 })
  assert.equal(calls[0].url, '/api/auth/login')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { token: 'tok' })
  assert.equal(calls[0].opts.headers['x-client'], 'mobile')
})

test('loginWithToken: 401 と通信不能を区別して返す', async () => {
  assert.deepEqual(await loginWithToken('bad', async () => ({ ok: false, status: 401 })), {
    ok: false,
    status: 401,
    error: 'REJECTED',
  })
  assert.deepEqual(
    await loginWithToken('tok', async () => {
      throw new Error('offline')
    }),
    { ok: false, error: 'OFFLINE' },
  )
  assert.deepEqual(await loginWithToken('', async () => ({ ok: true })), { ok: false, error: 'EMPTY_TOKEN' })
})

test('consumePairToken: 成功したら Cookie を確立して URL からトークンを消す', async () => {
  const location = loc('https://h.ts.net/?token=good&tab=chat')
  const history = hist()
  const r = await consumePairToken({
    loc: location,
    historyObj: history,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.deepEqual(r, { handled: true, ok: true })
  assert.equal(history.calls[0].url, '/?tab=chat')
})

test('consumePairToken: 失敗したら URL を残す（打ち直せるように）', async () => {
  const location = loc('https://h.ts.net/?token=bad')
  const history = hist()
  const r = await consumePairToken({
    loc: location,
    historyObj: history,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.deepEqual(r, { handled: true, ok: false, error: 'REJECTED' })
  assert.equal(history.calls.length, 0)
})

test('consumePairToken: トークンが無ければ何もしない（通常起動に影響しない）', async () => {
  let called = false
  const r = await consumePairToken({
    loc: loc('https://h.ts.net/'),
    historyObj: hist(),
    fetchImpl: async () => {
      called = true
      return { ok: true }
    },
  })
  assert.deepEqual(r, { handled: false, ok: false })
  assert.equal(called, false)
})
