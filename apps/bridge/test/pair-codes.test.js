import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPairCodes } from '../src/pair-codes.js'
import { createAuth } from '../src/auth.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pair-'))

test('pair-codes: 8 文字のコードを発行し、1 回だけ使える', () => {
  const cfg = { dataDir: tmp() }
  const codes = createPairCodes(cfg)
  const { code, expiresAt } = codes.mint()
  assert.equal(code.length, 8)
  assert.match(code, /^[A-Z2-9]{8}$/)
  assert.ok(expiresAt > Date.now())
  assert.equal(codes.consume(code), true, '1 回目は通る')
  assert.equal(codes.consume(code), false, '2 回目は通らない（使い捨て）')
})

test('pair-codes: 小文字・前後の空白を許し、期限切れは通さない', () => {
  let now = 1_000_000
  const cfg = { dataDir: tmp() }
  const codes = createPairCodes(cfg, { ttlMs: 1000, now: () => now })
  const a = codes.mint()
  assert.equal(codes.consume(` ${a.code.toLowerCase()} `), true)

  const b = codes.mint()
  now += 1001
  assert.equal(codes.consume(b.code), false, 'TTL を過ぎたら失効')
})

test('pair-codes: 平文コードをディスクに残さない（ハッシュのみ・0600）', () => {
  const cfg = { dataDir: tmp() }
  const codes = createPairCodes(cfg)
  const { code } = codes.mint()
  const file = path.join(cfg.dataDir, 'pair-codes.json')
  const raw = fs.readFileSync(file, 'utf8')
  assert.equal(raw.includes(code), false, '平文コードが保存されている')
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
})

test('pair-codes: 同時保持は上限で頭切りし、古いものから消える', () => {
  let now = 5_000_000
  const cfg = { dataDir: tmp() }
  const codes = createPairCodes(cfg, { max: 3, now: () => now })
  const minted = []
  for (let i = 0; i < 5; i += 1) {
    minted.push(codes.mint().code)
    now += 10
  }
  assert.ok(codes.pending() <= 3)
  assert.equal(codes.consume(minted[0]), false, '古いコードは落ちている')
  assert.equal(codes.consume(minted[4]), true, '最新は生きている')
})

test('auth: ワンタイムコードをセッション Cookie に交換できる（本トークンも従来どおり）', () => {
  const dir = tmp()
  const cfg = {
    dataDir: dir,
    tokenPath: path.join(dir, 'token'),
    auditPath: path.join(dir, 'audit.jsonl'),
    cookieName: 'hm_session',
    sessionTtlMs: 60_000,
  }
  fs.writeFileSync(cfg.tokenPath, 'a'.repeat(64))
  const pairCodes = createPairCodes(cfg)
  const auth = createAuth(cfg, { pairCodes })

  const { code } = pairCodes.mint()
  const cookie = auth.exchange(code)
  assert.ok(cookie, 'コードでログインできる')
  assert.equal(auth.exchange(code), null, '同じコードは 2 回使えない')

  assert.ok(auth.exchange('a'.repeat(64)), '本トークンは従来どおり通る')
  assert.equal(auth.exchange('BOGUSCODE'), null, '無効なコードは弾く')
})
