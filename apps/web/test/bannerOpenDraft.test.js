/**
 * SPEC-enter-enter-discuss-next-ste Q3 = A の機械検証。
 *
 * 不具合: レポートバナーの `Open` が「移動」と「次の一手の相談文を入力欄へ置く」の 2 つをしていた。
 * ラベルは移動しか名乗っていないので、着地した直後に入力欄が勝手に埋まる（初回は特に驚く）。
 *
 * 契約: `Open` は移動だけ。相談文を置くのは到着先のレポートカードの
 * 「💬 次の一手を相談」= `discussReport` だけ。
 *
 * JSX のハンドラは inline なので、純関数に切り出さず**ソースの該当ブロックを読んで**固定する
 * （振る舞いを消したのにテストが緑、を防ぐのが目的。ブロックが動いたらこのテストが落ちる）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../src/features/ChatPane.jsx'), 'utf8')

/** バナーの `Open` ボタン（className からラベルまで）のソース。 */
function openButtonBlock() {
  const at = SRC.indexOf('className="chat-report-btn primary"')
  assert.ok(at > 0, 'バナーの Open ボタン（.chat-report-btn primary）が見つからない')
  const end = SRC.indexOf("{t('chat.open')}", at)
  assert.ok(end > at, 'Open ボタンのラベル（chat.open）が見つからない')
  return SRC.slice(at, end)
}

/** レポートカードの「💬 次の一手を相談」のコールバック本体。 */
function discussCallbackBlock() {
  const at = SRC.indexOf('const discussReport = useCallback(')
  assert.ok(at > 0, 'discussReport が見つからない')
  const end = SRC.indexOf('[prefillComposer],', at)
  assert.ok(end > at, 'discussReport の依存配列が見つからない')
  return SRC.slice(at, end)
}

test('バナーの Open は移動だけで、相談文を入力欄へ置かない', () => {
  const block = openButtonBlock()
  assert.doesNotMatch(block, /prefillComposer/, 'Open が入力欄を埋めている（ラベルは移動しか名乗っていない）')
  // 移動そのものは残っていること（prefill を消すついでに導線まで消していないか）
  assert.match(block, /openSessionSafe|startSession/, 'Open から移動の処理まで消えている')
})

test('相談文を置くのは「💬 次の一手を相談」側だけ', () => {
  assert.match(
    discussCallbackBlock(),
    /prefillComposer\(\s*followUpPromptFor\(/,
    'discussReport が相談文を作らなくなっている（Open から外した文面の行き先が無い）',
  )
})

test('バナーに相談導線を戻すなら、ラベルも一緒に変える（同じ 1 タップを 2 か所に置かない）', () => {
  const block = openButtonBlock()
  // ここが緑のまま prefill が戻ったら、ラベルを「開いて相談文を置く」に変える判断が必要になる。
  assert.doesNotMatch(block, /followUpPromptFor/, 'Open が相談文を組み立てている')
})
