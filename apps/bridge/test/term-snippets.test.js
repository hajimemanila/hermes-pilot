import test from 'node:test'
import assert from 'node:assert/strict'
import { listTermSnippets, TERM_SNIPPETS } from '../src/term-snippets.js'

test('端末スニペット: id が一意で、バーは5〜8個', () => {
  const ids = new Set(TERM_SNIPPETS.map((s) => s.id))
  assert.equal(ids.size, TERM_SNIPPETS.length)
  const hot = TERM_SNIPPETS.filter((s) => s.hot)
  assert.ok(hot.length >= 5 && hot.length <= 8, `hot=${hot.length}`)
  for (const s of TERM_SNIPPETS) {
    assert.ok(s.label && s.text, s.id)
    assert.ok(!s.text.includes('\n'), `${s.id} に改行（Enter 相当）が入っている`)
  }
})

test('端末スニペット: 危険なコマンドを含まない', () => {
  const banned = [/rm\s+-rf?\s+[~/]/, /\brm\s+-r\b/, /\bpkill\b/, /\bkillall\b/, /\bsudo\b/, /diskutil/, /shutdown/, /reboot/]
  for (const s of TERM_SNIPPETS) {
    for (const b of banned) assert.ok(!b.test(s.text), `${s.id} が禁止パターン ${b} に一致: ${s.text}`)
  }
})

test('ドレイン解除は正しいマーカーを消す（再起動は含めない）', () => {
  const s = TERM_SNIPPETS.find((x) => x.id === 't-drain-clear')
  assert.ok(s)
  assert.match(s.text, /^rm -f ~\/\.hermes\/\.drain_request\.json && /)
  assert.ok(!/restart/.test(s.text))
  assert.equal(s.run, true)
})

test('解除+再起動は drain 削除と gateway restart を順に実行する', () => {
  const s = TERM_SNIPPETS.find((x) => x.id === 't-drain-restart')
  const rm = s.text.indexOf('rm -f ~/.hermes/.drain_request.json')
  const rs = s.text.indexOf('hermes gateway restart')
  assert.ok(rm >= 0 && rs > rm, s.text)
})

test('再起動系は CLI か launchctl の実在ラベルを使う', () => {
  const byId = Object.fromEntries(TERM_SNIPPETS.map((s) => [s.id, s.text]))
  assert.equal(byId['t-gw-restart'], 'hermes gateway restart')
  assert.match(byId['t-dash-restart'], /ai\.hermes\.dashboard$/)
  assert.match(byId['t-mobile-restart'], /ai\.hermes\.hermes-mobile$/)
  const labels = ['ai.hermes.dashboard', 'ai.hermes.hermes-mobile', 'ai.hermes.dsh-web']
  for (const l of labels) {
    assert.ok(TERM_SNIPPETS.some((s) => s.text.includes(l)), `${l} のスニペットがない`)
  }
})

test('listTermSnippets は run を真偽値で返し note を持つ', () => {
  const list = listTermSnippets()
  assert.equal(list.length, TERM_SNIPPETS.length)
  for (const s of list) {
    assert.equal(typeof s.run, 'boolean')
    assert.equal(typeof s.note, 'string')
    assert.ok(s.note.length > 0, `${s.id} に note がない`)
  }
})
