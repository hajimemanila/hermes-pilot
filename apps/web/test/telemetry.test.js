/**
 * コックピット計器盤の表示ロジック（`apps/web/src/lib/telemetry.js`）。SPEC §5.5 / D15⑤
 *
 * ピルの数字は「0 のときは出さない」「押したら必ず何かが開く」の 2 点を機械的に固定する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { cachePercent, gwState, latestToolName, reviewJumpTarget, runningTotal } from '../src/lib/telemetry.js'

test('cachePercent は 0〜1 を % に丸め、不明は null', () => {
  assert.equal(cachePercent(0.984), 98)
  assert.equal(cachePercent(0.5), 50)
  assert.equal(cachePercent(0), 0)
  assert.equal(cachePercent(1), 100)
  assert.equal(cachePercent(1.4), 100, '1 を超えても 100 で止める')
  assert.equal(cachePercent(-0.2), 0)
  assert.equal(cachePercent(null), null)
  assert.equal(cachePercent(undefined), null)
  assert.equal(cachePercent('nope'), null)
})

test('latestToolName は実行中ターンのうち最新のツール名を返す', () => {
  assert.equal(
    latestToolName([
      { lastTool: { name: 'terminal', at: 100 } },
      { lastTool: { name: 'read_file', at: 300 } },
      { lastTool: { name: 'grep', at: 200 } },
    ]),
    'read_file',
  )
  assert.equal(latestToolName([{ lastTool: null }, {}]), null)
  assert.equal(latestToolName([]), null)
  assert.equal(latestToolName(null), null)
})

test('runningTotal は実行中タスクとターンを足し、負や不明は 0 扱い', () => {
  assert.equal(runningTotal({ tasksRunning: 2, turns: 1 }), 3)
  assert.equal(runningTotal({}), 0)
  assert.equal(runningTotal({ tasksRunning: -3, turns: 2 }), 2)
  assert.equal(runningTotal({ tasksRunning: 'x', turns: 4 }), 4)
})

test('runningTotal は Architect（仕様策定）ジョブも合算する（D43 / カンバンタスクを持たない agy ジョブ）', () => {
  assert.equal(runningTotal({ tasksRunning: 1, turns: 1, architectRunning: 2 }), 4)
  // 既存の 2 引数呼び出しは完全互換（第 3 項は 0 扱い）
  assert.equal(runningTotal({ tasksRunning: 1, turns: 1 }), 2)
  // agy ジョブだけが動いているときも ⚡ が出る
  assert.equal(runningTotal({ architectRunning: 1 }), 1)
  assert.equal(runningTotal({ tasksRunning: -1, turns: 1, architectRunning: -2 }), 1)
  assert.equal(runningTotal({ architectRunning: 'x' }), 0)
})

test('gwState は 接続と GW 本体の両方を見る', () => {
  assert.equal(gwState({ conn: 'ok', bridge: { ok: true } }), 'ok')
  assert.equal(gwState({ conn: 'ok', bridge: null }), 'ok', 'overview 未取得でも接続していれば正常')
  assert.equal(gwState({ conn: 'ok', bridge: { ok: false } }), 'error', 'GW が落ちていれば異常')
  assert.equal(gwState({ conn: 'offline' }), 'offline')
  assert.equal(gwState({ conn: 'error' }), 'error')
})

test('gwState は集約接続状態の語彙（transport.js / D96）を受ける', () => {
  assert.equal(gwState({ conn: 'ready' }), 'ok', 'ready だけが正常')
  assert.equal(gwState({ conn: 'recovering' }), 'error', '猶予中も異常として出す')
  assert.equal(gwState({ conn: 'connecting' }), 'error')
  assert.equal(gwState({ conn: 'auth' }), 'error')
  assert.equal(gwState({ conn: 'offline' }), 'offline')
  assert.equal(gwState({ conn: 'offline', bridge: { ok: false } }), 'offline', '接続断を優先する')
  assert.equal(gwState({ conn: 'ready', bridge: { ok: false } }), 'error')
})

test('reviewJumpTarget は判断待ち → 承認待ち → 何もしない の順に落ちる', () => {
  const waiting = { id: 't_1', status: 'blocked', review: { label: 'p3' } }
  const done = { id: 't_2', status: 'done', review: { label: 'p2' } }
  assert.deepEqual(reviewJumpTarget({ reviewItems: [done, waiting], inboxPending: 3 }), {
    kind: 'review',
    taskId: 't_1',
  })
  assert.deepEqual(reviewJumpTarget({ reviewItems: [done], inboxPending: 2 }), { kind: 'inbox' })
  assert.equal(reviewJumpTarget({ reviewItems: [done], inboxPending: 0 }), null)
  assert.equal(reviewJumpTarget({}), null)
})
