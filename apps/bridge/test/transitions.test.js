/**
 * `review/transitions.js`（D99）の契約テスト。
 *
 * 表（`TRANSITION_TABLE`）と単一実行関数 `apply()` の 4 規則を固定する。DB も CLI も使わず、
 * `runKanban` / `bodyOf` / `now` をすべて注入して呼び出し回数と引数だけを見る。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { APPROVE_METADATA, TRANSITION_TABLE, createReviewTransitions } from '../src/review/transitions.js'

/**
 * 偽の CLI と `bodyOf`。`calls` に渡された引数を全部残す。
 *
 * @param {{status?: string|null, complete?: {code: number, out: string}, unblock?: {code: number, out: string}, now?: () => string}} [cfg]
 */
function fake(cfg = {}) {
  const calls = []
  const state = { status: cfg.status === undefined ? 'blocked' : cfg.status }
  const transitions = createReviewTransitions({
    runKanban: async (args) => {
      calls.push(args)
      if (args[0] === 'complete') return cfg.complete ?? { code: 0, out: 'Completed' }
      if (args[0] === 'unblock') return cfg.unblock ?? { code: 0, out: 'Unblocked' }
      if (args[0] === 'request-changes') return cfg.requestChanges ?? { code: 0, out: 'Changes requested' }
      return { code: 0, out: 'ok' }
    },
    bodyOf: () => (state.status === null ? null : { status: state.status }),
    now: cfg.now ?? (() => '2026-11-22T00:00:00.000Z'),
  })
  return { calls, state, transitions }
}

const kinds = (calls) => calls.map((c) => c[0])

test('遷移表: 9 経路の単一正本を持ち、approve だけが complete-then-unblock を使う', () => {
  assert.deepEqual(Object.keys(TRANSITION_TABLE).sort(), [
    'annotation.again',
    'annotation.fresh',
    'answer.again',
    'answer.fresh',
    'approve',
    'close.cancel',
    'close.done',
    'reopen',
    'unblock',
  ])
  for (const [name, spec] of Object.entries(TRANSITION_TABLE)) {
    assert.ok(
      ['unblock', 'complete', 'complete-then-unblock', 'comment-then-archive', 'request-changes'].includes(spec.kind),
      `${name} の kind`,
    )
  }
  assert.deepEqual(TRANSITION_TABLE.approve.from, ['blocked'])
  assert.equal(TRANSITION_TABLE.approve.kind, 'complete-then-unblock')
  assert.equal(TRANSITION_TABLE.approve.result, 'Visual check passed')
  assert.equal(TRANSITION_TABLE['answer.again'].kind, 'unblock', '再送は unblock だけ（complete を試さない）')
  assert.equal(TRANSITION_TABLE['annotation.again'].kind, 'unblock')
  assert.deepEqual(TRANSITION_TABLE['close.done'].noop, ['done'])
  assert.deepEqual(TRANSITION_TABLE['close.cancel'].noop, ['archived'])
  assert.deepEqual(TRANSITION_TABLE.unblock.noop, ['ready', 'running'])
  // D109: reopen は状態を問わず動き、archived だけは CLI を呼ばない（from を狭めない）
  assert.equal(TRANSITION_TABLE.reopen.from, '*')
  assert.deepEqual(TRANSITION_TABLE.reopen.noop, ['archived'])
  assert.equal(TRANSITION_TABLE.reopen.kind, 'request-changes')
})

test('① blocked + approve で complete 成功 → moved:done、unblock は 0 回', async () => {
  const { calls, transitions } = fake({ status: 'blocked' })
  const r = await transitions.apply('approve', { id: 't_a1', reason: 'looks good' })

  assert.deepEqual(kinds(calls), ['complete'], 'unblock を呼ばない')
  assert.equal(r.code, 0)
  assert.equal(r.status, 'done')
  assert.equal(r.moved, 'done')
  assert.equal(r.skipped, undefined)

  const args = calls[0]
  assert.equal(args[1], 't_a1')
  assert.equal(args[args.indexOf('--result') + 1], 'Visual check passed')
  const meta = JSON.parse(args[args.indexOf('--metadata') + 1])
  assert.deepEqual(meta, { ...APPROVE_METADATA, approved_at: '2026-11-22T00:00:00.000Z' })
})

test('② complete 失敗 → unblock 1 回・moved:ready、complete は 1 回だけ', async () => {
  const { calls, transitions } = fake({
    status: 'blocked',
    complete: { code: 1, out: 'task is running' },
  })
  const r = await transitions.apply('approve', { id: 't_a2', reason: 'visual check passed (resend)' })

  assert.deepEqual(kinds(calls), ['complete', 'unblock'], 'complete が 1 回、unblock が 1 回')
  assert.deepEqual(calls[1].slice(0, 4), ['unblock', 't_a2', '--reason', 'visual check passed (resend)'])
  assert.equal(r.code, 0)
  assert.equal(r.status, 'ready')
  assert.equal(r.moved, 'ready')
  assert.match(r.out, /task is running/, 'complete の出力も返す（原因が読める）')
})

test('② 派生: unblock も失敗したら moved:null・status は元のまま・code は失敗側', async () => {
  const { calls, transitions } = fake({
    status: 'blocked',
    complete: { code: 1, out: 'task is running' },
    unblock: { code: 2, out: 'database is locked' },
  })
  const r = await transitions.apply('approve', { id: 't_a3', reason: 'x' })

  assert.deepEqual(kinds(calls), ['complete', 'unblock'])
  assert.equal(r.code, 2)
  assert.equal(r.status, 'blocked')
  assert.equal(r.moved, null)
})

test('③ from に無い status は CLI を 1 回も呼ばず skipped:not-in-from', async () => {
  const { calls, transitions } = fake({ status: 'ready' })
  const r = await transitions.apply('approve', { id: 't_b1', reason: 'x' })

  assert.deepEqual(calls, [], 'CLI 呼び出し 0 回')
  assert.equal(r.code, 0)
  assert.equal(r.moved, null)
  assert.equal(r.status, 'ready')
  assert.equal(r.skipped, 'not-in-from')

  // 冪等: 2 回送っても同じ（no-op が積み上がらない）
  const again = await transitions.apply('approve', { id: 't_b1', reason: 'x' })
  assert.deepEqual(calls, [])
  assert.equal(again.skipped, 'not-in-from')
})

test('③ 派生: タスク行が無い（bodyOf が null）ときも CLI を呼ばない', async () => {
  const { calls, transitions } = fake({ status: null })
  const r = await transitions.apply('answer.fresh', { id: 't_missing', reason: 'x' })
  assert.deepEqual(calls, [])
  assert.equal(r.skipped, 'not-in-from')
  assert.equal(r.status, null)
  assert.equal(r.moved, null)
})

test('④ answer.again は complete を試さず unblock 1 回だけ（回答は保存済み・遷移だけ未了）', async () => {
  const { calls, transitions } = fake({ status: 'blocked' })
  const r = await transitions.apply('answer.again', { id: 't_c1', reason: 'Review answers received (resend)' })

  assert.deepEqual(kinds(calls), ['unblock'])
  assert.equal(calls[0][3], 'Review answers received (resend)')
  assert.equal(r.code, 0)
  assert.equal(r.status, 'ready')
  assert.equal(r.moved, 'ready')

  // answer.fresh（本処理）も同じく unblock だけ
  const fresh = fake({ status: 'blocked' })
  await fresh.transitions.apply('answer.fresh', { id: 't_c2', reason: 'Review answers received' })
  assert.deepEqual(kinds(fresh.calls), ['unblock'])
})

test('⑤ annotation.* も同じ（再送は unblock だけ・fresh も unblock だけ）', async () => {
  const again = fake({ status: 'blocked' })
  const r1 = await again.transitions.apply('annotation.again', { id: 't_d1', reason: 'Annotation received (resend)' })
  assert.deepEqual(kinds(again.calls), ['unblock'])
  assert.equal(r1.moved, 'ready')

  const fresh = fake({ status: 'blocked' })
  const r2 = await fresh.transitions.apply('annotation.fresh', { id: 't_d2', reason: 'Annotation received' })
  assert.deepEqual(kinds(fresh.calls), ['unblock'])
  assert.equal(r2.moved, 'ready')

  // unblock が失敗したら status は blocked のまま（呼び出し側は ok:false を返す）
  const bad = fake({ status: 'blocked', unblock: { code: 1, out: 'database is locked' } })
  const r3 = await bad.transitions.apply('annotation.fresh', { id: 't_d3', reason: 'x' })
  assert.equal(r3.code, 1)
  assert.equal(r3.status, 'blocked')
  assert.equal(r3.moved, null)
})

test('⑥ now() 注入で approved_at が固定できる（既定は現在時刻）', async () => {
  const fixed = fake({ status: 'blocked', now: () => '2030-01-02T03:04:05.000Z' })
  await fixed.transitions.apply('approve', { id: 't_e1', reason: 'x' })
  const meta = JSON.parse(fixed.calls[0][fixed.calls[0].indexOf('--metadata') + 1])
  assert.equal(meta.approved_at, '2030-01-02T03:04:05.000Z')

  // Date を返す now でも ISO 文字列に正規化する
  const asDate = fake({ status: 'blocked', now: () => new Date('2031-05-06T07:08:09.000Z') })
  await asDate.transitions.apply('approve', { id: 't_e2', reason: 'x' })
  const meta2 = JSON.parse(asDate.calls[0][asDate.calls[0].indexOf('--metadata') + 1])
  assert.equal(meta2.approved_at, '2031-05-06T07:08:09.000Z')

  // 注入なし（既定）でも ISO 文字列が入る
  const calls = []
  const plain = createReviewTransitions({
    runKanban: async (args) => {
      calls.push(args)
      return { code: 0, out: 'ok' }
    },
    bodyOf: () => ({ status: 'blocked' }),
  })
  await plain.apply('approve', { id: 't_e3', reason: 'x' })
  const meta3 = JSON.parse(calls[0][calls[0].indexOf('--metadata') + 1])
  assert.match(meta3.approved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('canApply は表と同じ判定（純関数・CLI を呼ばない）', () => {
  const { calls, transitions } = fake({ status: 'blocked' })
  assert.equal(transitions.canApply('approve', 'blocked'), true)
  assert.equal(transitions.canApply('approve', 'ready'), false)
  assert.equal(transitions.canApply('answer.again', 'blocked'), true)
  assert.equal(transitions.canApply('nope', 'blocked'), false)
  assert.equal(transitions.table, TRANSITION_TABLE)
  assert.deepEqual(calls, [])
})

test('未知の遷移名は例外（typo を黙って no-op にしない）', async () => {
  const { calls, transitions } = fake({ status: 'blocked' })
  await assert.rejects(() => transitions.apply('aproove', { id: 't_f1', reason: 'x' }), /unknown transition/)
  assert.deepEqual(calls, [])
})

test('apply は毎回 bodyOf を読み直す（呼び出し側の古い status に依存しない）', async () => {
  const calls = []
  let status = 'blocked'
  const transitions = createReviewTransitions({
    runKanban: async (args) => {
      calls.push(args)
      if (args[0] === 'complete') status = 'done'
      return { code: 0, out: 'ok' }
    },
    bodyOf: () => ({ status }),
    now: () => '2026-11-22T00:00:00.000Z',
  })

  const first = await transitions.apply('approve', { id: 't_g1', reason: 'x' })
  assert.equal(first.moved, 'done')

  // 完了済みの再送は CLI を呼ばない（同じ検収を二度流さない）
  const second = await transitions.apply('approve', { id: 't_g1', reason: 'x' })
  assert.deepEqual(kinds(calls), ['complete'])
  assert.equal(second.skipped, 'not-in-from')
  assert.equal(second.moved, null)
})

import { TRANSITION_OWNER_FILES, transitionOwnerProblems } from '../../../scripts/check-coherence.mjs'

test('D104: close.done / close.cancel / unblock と isNoop() / noop', async () => {
  // noop: 既に目的の状態なら CLI を呼ばず skipped:'noop', noop:true
  const doneNoop = fake({ status: 'done' })
  assert.equal(doneNoop.transitions.isNoop('close.done', 'done'), true)
  const rDoneNoop = await doneNoop.transitions.apply('close.done', { id: 't_n1', result: 'ok' })
  assert.equal(rDoneNoop.noop, true)
  assert.equal(rDoneNoop.skipped, 'noop')
  assert.deepEqual(doneNoop.calls, [])

  const cancelNoop = fake({ status: 'archived' })
  assert.equal(cancelNoop.transitions.isNoop('close.cancel', 'archived'), true)
  const rCancelNoop = await cancelNoop.transitions.apply('close.cancel', { id: 't_n2', comment: 'c' })
  assert.equal(rCancelNoop.noop, true)
  assert.deepEqual(cancelNoop.calls, [])

  const unblockReady = fake({ status: 'ready' })
  assert.equal(unblockReady.transitions.isNoop('unblock', 'ready'), true)
  assert.equal(unblockReady.transitions.isNoop('unblock', 'running'), true)
  const rUnblockNoop = await unblockReady.transitions.apply('unblock', { id: 't_n3', reason: 'go' })
  assert.equal(rUnblockNoop.noop, true)
  assert.deepEqual(unblockReady.calls, [])

  // close.done: running 以外の非 done を complete 1 回で閉じる
  const closeDone = fake({ status: 'blocked' })
  const rClosed = await closeDone.transitions.apply('close.done', { id: 't_d1', result: 'Done from PWA' })
  assert.deepEqual(kinds(closeDone.calls), ['complete'])
  assert.equal(rClosed.moved, 'done')

  // close.cancel: コメント付きなら comment -> archive
  const closeCancel = fake({ status: 'ready' })
  const rCancelled = await closeCancel.transitions.apply('close.cancel', {
    id: 't_c3',
    comment: 'Cancelled',
    author: 'mobile',
  })
  assert.deepEqual(kinds(closeCancel.calls), ['comment', 'archive'])
  assert.equal(rCancelled.moved, 'archived')

  // unblock: blocked から unblock 1 回で ready へ
  const unblockBlocked = fake({ status: 'blocked' })
  const rUnblocked = await unblockBlocked.transitions.apply('unblock', { id: 't_u1', reason: 'Resume' })
  assert.deepEqual(kinds(unblockBlocked.calls), ['unblock'])
  assert.equal(rUnblocked.moved, 'ready')
})

test('D104: TRANSITION_OWNER_FILES に inbox.js が含まれ、直接 CLI 配列を検知する', () => {
  assert.ok(TRANSITION_OWNER_FILES.includes('apps/bridge/src/inbox.js'))
  const directComplete = "await run(cfg, ['kanban', '--board', b, 'complete', tid])"
  const problems = transitionOwnerProblems('apps/bridge/src/inbox.js', directComplete)
  assert.equal(problems.length, 1)
  assert.match(problems[0].reason, /complete/)
})

test('D109: reopen は request-changes を 1 回だけ・archived は CLI 0 回・done は review へ戻る', async () => {
  // done → review（request-changes は 1 回だけ・理由はそのまま載る）
  const done = fake({ status: 'done' })
  const r = await done.transitions.apply('reopen', { id: 't_r1', reason: 'Please fix the header spacing' })
  assert.deepEqual(kinds(done.calls), ['request-changes'], 'CLI は 1 回だけ')
  assert.deepEqual(done.calls[0], ['request-changes', 't_r1', 'Please fix the header spacing'])
  assert.equal(r.code, 0)
  assert.equal(r.moved, 'review')
  assert.equal(r.status, 'review')

  // from='*': blocked / running / ready / review のどれからでも review へ戻る（現行挙動の保存）
  for (const status of ['blocked', 'running', 'ready', 'review']) {
    const any = fake({ status })
    const out = await any.transitions.apply('reopen', { id: `t_r_${status}`, reason: 'x' })
    assert.deepEqual(kinds(any.calls), ['request-changes'], `${status} から 1 回だけ`)
    assert.equal(out.moved, 'review')
    assert.equal(any.transitions.canApply('reopen', status), true)
  }

  // archived は no-op（CLI を 1 回も呼ばない）
  const archived = fake({ status: 'archived' })
  assert.equal(archived.transitions.isNoop('reopen', 'archived'), true)
  assert.equal(archived.transitions.canApply('reopen', 'archived'), false)
  const skip = await archived.transitions.apply('reopen', { id: 't_r2', reason: 'x' })
  assert.deepEqual(archived.calls, [], 'archived は CLI 0 回')
  assert.equal(skip.skipped, 'noop')
  assert.equal(skip.moved, null)
  assert.equal(skip.status, 'archived')

  // 失敗したら status は元のまま・moved:null・code は失敗側
  const bad = fake({ status: 'done', requestChanges: { code: 1, out: 'task is running' } })
  const failed = await bad.transitions.apply('reopen', { id: 't_r3', reason: 'x' })
  assert.equal(failed.code, 1)
  assert.equal(failed.status, 'done')
  assert.equal(failed.moved, null)
  assert.match(failed.out, /task is running/)

  // 理由が空でも CLI には理由を載せる（request-changes は理由必須）
  const empty = fake({ status: 'done' })
  await empty.transitions.apply('reopen', { id: 't_r4' })
  assert.ok(empty.calls[0][2].length > 0, '理由なしで CLI を呼ばない')
})

test("D109: review.js の reopen() は transitions.apply('reopen') を 1 回だけ呼び、request-changes を直叩きしない", async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/review.js', import.meta.url), 'utf8')
  const start = src.indexOf('async function reopen(')
  assert.ok(start > 0, 'review.js に reopen() がある')
  const body = src.slice(start, src.indexOf('\n  /**', start))
  assert.equal(body.match(/transitions\.apply\('reopen'/g)?.length, 1, "apply('reopen') は 1 回だけ")
  assert.equal(body.includes("runKanban(['request-changes'"), false, 'request-changes を直叩きしない')
  // 互換形（{ ok, status, output }）を返す — 呼び出し側は変えない
  assert.match(body, /return \{ ok: .*status: b\.status, output:/)
})
