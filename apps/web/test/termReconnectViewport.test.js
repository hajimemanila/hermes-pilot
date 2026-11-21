/**
 * 端末の自動再接続と、ソフトキーボードに隠れないトースト（2026-11 実測の退行防止）。
 *
 * 症状: ブリッジ再起動（`launchctl kickstart -k …`）で `/ws/term` が切れると「未接続」のまま戻らず、
 * 押しても出るトーストはキーボードの裏で見えなかった。タブを切り替えてもペインは
 * `visibility:hidden + inert` で生かしたままなので再マウントされず、復帰しない。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { reconnectDelay, RECONNECT_MAX_MS } from '../src/lib/termReconnect.js'
import { keyboardInset, applyViewportVars, KB_MIN_INSET } from '../src/lib/viewport.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src')

test('reconnectDelay: 1s → 2s → 4s … で上限 15s に張り付く', () => {
  assert.equal(reconnectDelay(1), 1000)
  assert.equal(reconnectDelay(2), 2000)
  assert.equal(reconnectDelay(3), 4000)
  assert.equal(reconnectDelay(4), 8000)
  assert.equal(reconnectDelay(5), RECONNECT_MAX_MS)
  assert.equal(reconnectDelay(99), RECONNECT_MAX_MS)
})

test('reconnectDelay: 0 / 負 / 非数の試行回数でも base から始める（即時連打しない）', () => {
  for (const bad of [0, -3, NaN, undefined, null, 'x']) {
    assert.equal(reconnectDelay(bad), 1000, `attempt=${String(bad)}`)
  }
})

test('keyboardInset: visualViewport が無ければ 0（非対応ブラウザで従来どおり）', () => {
  assert.equal(keyboardInset({ innerHeight: 844 }), 0)
  assert.equal(keyboardInset({}), 0)
  assert.equal(keyboardInset(null), 0)
})

test('keyboardInset: 縮んだ分をキーボードとみなす（844 のうち 460 見えている → 384）', () => {
  const win = { innerHeight: 844, visualViewport: { height: 460, offsetTop: 0 } }
  assert.equal(keyboardInset(win), 384)
})

test('keyboardInset: URL バー／ツールバーの伸縮（閾値未満）は 0 のまま', () => {
  const win = { innerHeight: 844, visualViewport: { height: 844 - (KB_MIN_INSET - 1), offsetTop: 0 } }
  assert.equal(keyboardInset(win), 0)
  const edge = { innerHeight: 844, visualViewport: { height: 844 - KB_MIN_INSET, offsetTop: 0 } }
  assert.equal(keyboardInset(edge), KB_MIN_INSET)
})

test('keyboardInset: ページが上へずれている分（offsetTop）も引く', () => {
  const win = { innerHeight: 844, visualViewport: { height: 500, offsetTop: 44 } }
  assert.equal(keyboardInset(win), 300)
})

test('applyViewportVars: --kb-inset と data-kb を html に書く / 消えれば 0px に戻す', () => {
  const props = new Map()
  const root = { style: { setProperty: (k, v) => props.set(k, v) }, dataset: {} }
  const win = { innerHeight: 844, document: { documentElement: root }, visualViewport: { height: 460, offsetTop: 0 } }
  assert.equal(applyViewportVars(win), 384)
  assert.equal(props.get('--kb-inset'), '384px')
  assert.equal(root.dataset.kb, '1')

  win.visualViewport.height = 844
  assert.equal(applyViewportVars(win), 0)
  assert.equal(props.get('--kb-inset'), '0px')
  assert.equal(root.dataset.kb, '0')
})

test('TermPane: 切断でバックオフ再接続し、復帰系イベントでも繋ぎ直す', () => {
  const src = fs.readFileSync(path.join(SRC, 'features/TermPane.jsx'), 'utf8')
  // onclose で待ち時間を計算して connect を張り直す（1 回きりの接続に戻ったらここで落ちる）
  assert.match(src, /onclose = \(\) => \{[\s\S]{0,600}?reconnectDelay\(retryRef\.current\)/)
  assert.match(src, /reconnectTimer\.current = setTimeout\(connect,/)
  assert.match(src, /if \(wsRef\.current !== ws\) return/)
  // 復帰の入り口（画面復帰・回線復旧・タブ復帰・ページ復元）
  for (const ev of ['visibilitychange', 'online', 'pageshow']) {
    assert.match(src, new RegExp(`addEventListener\\('${ev}'`), `${ev} の再開ハンドラが無い`)
  }
  assert.match(src, /if \(wsRef\.current\?\.readyState !== WebSocket\.OPEN\) \{[\s\S]{0,200}?connectRef\.current\?\.\(\)/)
})

test('main.jsx: 起動時に viewport 変数の追従を入れる', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8')
  assert.match(src, /installViewportVars\(\)/)
})

test('styles.css: キーボード表示中は --kb-inset 基準でトーストを置く', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  assert.match(css, /html\[data-kb='1'\] \.toast \{[\s\S]{0,120}?--kb-inset/)
  assert.match(css, /html\[data-kb='1'\] \.toast\.chat,[\s\S]{0,80}?--kb-inset/)
})
