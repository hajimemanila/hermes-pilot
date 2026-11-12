import test from 'node:test'
import assert from 'node:assert/strict'
import { checkFrame, isSafeProfileName, rejectionFrame, PROFILE_METHODS } from '../src/chat-profile.js'

const ALLOWED = ['default', 'mobile', 'nanokvm']
const frame = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params })

test('プロファイル名は英数・-・_ のみ（パス区切りと空白を弾く）', () => {
  assert.equal(isSafeProfileName('nanokvm'), true)
  assert.equal(isSafeProfileName('work-2'), true)
  assert.equal(isSafeProfileName('../etc'), false)
  assert.equal(isSafeProfileName('a/b'), false)
  assert.equal(isSafeProfileName(' with space'), false)
  assert.equal(isSafeProfileName(''), false)
  assert.equal(isSafeProfileName(null), false)
  assert.equal(isSafeProfileName('x'.repeat(65)), false)
})

test('profile 省略・空は上流の既定に任せる（後方互換）', () => {
  const plain = frame('session.resume', { session_id: 's1' })
  const a = checkFrame(plain, ALLOWED)
  assert.equal(a.ok, true)
  assert.equal(a.profile, null)
  assert.equal(a.text, plain) // 触らない

  const empty = checkFrame(frame('session.create', { title: 'x', profile: '' }), ALLOWED)
  assert.equal(empty.ok, true)
  assert.equal(empty.profile, null)
  assert.equal('profile' in JSON.parse(empty.text).params, false) // 明示的な空は落とす
})

test('serve 済みの名前はそのまま通る', () => {
  const r = checkFrame(frame('session.create', { title: 'x', profile: 'nanokvm' }, 7), ALLOWED)
  assert.equal(r.ok, true)
  assert.equal(r.profile, 'nanokvm')
  assert.equal(r.method, 'session.create')
  const sent = JSON.parse(r.text)
  assert.equal(sent.id, 7)
  assert.equal(sent.params.profile, 'nanokvm')
})

test('未知のプロファイル・注入は -32602 で止める', () => {
  for (const bad of ['../../etc', 'ghost', 'nanokvm ' /* 前後空白は trim される */]) {
    const r = checkFrame(frame('session.resume', { session_id: 's1', profile: bad }), ALLOWED)
    if (bad.trim() === 'nanokvm') {
      assert.equal(r.ok, true) // trim 後に既知なら通す
      continue
    }
    assert.equal(r.ok, false, bad)
    assert.match(r.message, /不明なプロファイル/)
    const err = JSON.parse(rejectionFrame(r.id, r.message))
    assert.equal(err.id, 1)
    assert.equal(err.error.code, -32602)
    assert.match(err.error.message, /^profile:/)
  }
})

test('プロファイル一覧が取れなくても default だけは通る（退避）', () => {
  const ok = checkFrame(frame('session.create', { title: 'x', profile: 'default' }), [])
  assert.equal(ok.ok, true)
  const ng = checkFrame(frame('session.create', { title: 'x', profile: 'nanokvm' }), [])
  assert.equal(ng.ok, false)
})

test('profile を持たない RPC と壊れたフレームは素通し（検証対象は2つだけ）', () => {
  assert.deepEqual([...PROFILE_METHODS].sort(), ['session.create', 'session.resume'])
  const submit = frame('prompt.submit', { session_id: 's1', text: 'hi' })
  assert.equal(checkFrame(submit, ALLOWED).text, submit)
  const broken = 'not json'
  assert.equal(checkFrame(broken, ALLOWED).ok, true)
  assert.equal(checkFrame(broken, ALLOWED).text, broken)

  // session.list は profile を受けるが、ここでは検証しない（送信系だけ守る）
  const list = frame('session.list', { profile: 'nanokvm' })
  assert.equal(checkFrame(list, ALLOWED).text, list)
})
