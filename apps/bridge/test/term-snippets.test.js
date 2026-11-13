import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTermSnippets, listTermSnippets, TERM_SNIPPETS } from '../src/term-snippets.js'

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

test('再起動系は CLI か、Capability で分岐したサービス管理コマンドを使う', () => {
  const mac = buildTermSnippets({ serviceManager: 'launchd', pilotServiceUnit: 'ai.hermes.pilot' })
  const linux = buildTermSnippets({ serviceManager: 'systemd', pilotServiceUnit: 'hermes-pilot.service' })
  assert.equal(mac.find((s) => s.id === 't-gw-restart').text, 'hermes gateway restart')
  assert.equal(
    mac.find((s) => s.id === 't-pilot-restart').text,
    'launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot',
  )
  assert.equal(
    linux.find((s) => s.id === 't-pilot-restart').text,
    'systemctl --user restart hermes-pilot.service',
  )
  assert.match(linux.find((s) => s.id === 't-pilot-status').text, /systemctl --user status hermes-pilot\.service/)
  assert.notEqual(
    mac.find((s) => s.id === 't-list').text,
    linux.find((s) => s.id === 't-list').text,
    '一覧コマンドもサービス管理方式で分岐する',
  )
})

test('スニペットは個人環境のサービス名・ポートを含まない（公開プラグインの条件）', () => {
  for (const caps of [
    { serviceManager: 'launchd', pilotServiceUnit: 'ai.hermes.pilot' },
    { serviceManager: 'systemd', pilotServiceUnit: 'hermes-pilot.service' },
  ]) {
    const text = buildTermSnippets(caps)
      .map((s) => `${s.text} ${s.note}`)
      .join('\n')
    assert.ok(!/\b(8787|dsh|system-ops|git-ops|nanokvm)\b/i.test(text), `個人環境の依存が残っている:\n${text}`)
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
