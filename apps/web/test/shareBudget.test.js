/**
 * X 加重（twitter-text）予算の単体テスト（SPEC-SHARE280 §3 Batch 1 の受入条件）。
 *
 * 数え方は SPEC §1.1 の規則をそのまま固定する:
 * 既定 2、`U+0000–U+10FF` / `U+2000–U+200D` / `U+2010–U+201F` / `U+2032–U+2037` だけ 1。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { X_WEIGHT_LIMIT, fitBlocks, truncateToWeight, xWeight } from '../src/lib/shareBudget.js'
import { buildShareTextDetailed } from '../src/lib/receiptCanvas.js'

/** `receipt.test.js` と同じ固定データ（`/api/telemetry/receipt` の応答に近い形）。 */
const receipt = {
  ok: true,
  board: 'hermes-pilot',
  spec: 'docs/SPEC-PILOT-V5.md',
  label: 'V5 batch',
  windowHours: 24,
  kpi: {
    costUsd: 1.08,
    cachePct: 99,
    savedUsd: 3.25,
    savedRatio: 0.9,
    humanTaps: 34,
    redlines: 2,
    typedChars: 0,
    zeroTypingScore: 100,
    batchesDone: 5,
    batchesTotal: 5,
    durationMin: 62,
    wallDurationMin: 95,
    durationCapped: false,
    apiCalls: 128,
    totalTokens: 12448000,
    tests: 402,
  },
}

test('xWeight は X の加重（既定 2 / ASCII ほかは 1）で数える', () => {
  assert.equal(X_WEIGHT_LIMIT, 280, 'X の現行上限（1 箇所だけ直せば済む）')
  assert.equal(xWeight(''), 0)
  assert.equal(xWeight('abc'), 3)
  assert.equal(xWeight('\n'), 1, '改行は 1')
  assert.equal(xWeight('—'), 1, 'em dash U+2014 は 1')
  assert.equal(xWeight('–'), 1, 'en dash U+2013 は 1')
  assert.equal(xWeight('·'), 1, '中黒 U+00B7 は 1')
  assert.equal(xWeight('（'), 2, '全角括弧 U+FF08 は 2')
  assert.equal(xWeight('🏆'), 2, '絵文字はサロゲートペアでも 1 符号位置ぶん 2')
  assert.equal(xWeight('あ'), 2, 'ひらがなは 2')
  assert.equal(xWeight('🏆 完了レシート — V5 batch'), 26, 'SPEC §1.2 の L1（JA）')
  assert.equal(xWeight('— V5 batch'), 10)
})

test('xWeight は base fixture の 5 行連結で 310（JA）/ 289（EN）（SPEC §1.2）', () => {
  // limit を十分大きくすると段が 1 つも適用されず、原文の 5 行がそのまま返る
  for (const [lang, expected] of [['ja', 310], ['en', 289]]) {
    const raw = buildShareTextDetailed(receipt, { lang, limit: 100000 })
    assert.deepEqual(raw.applied, [], '原文は 280 を超えるので段が要る')
    assert.equal(raw.text.split('\n').length, 5)
    assert.equal(xWeight(raw.text), expected, `${lang} の原文加重`)
  }
})

test('truncateToWeight は必ず budget 以下にし、切ったときは … で終わる', () => {
  assert.equal(truncateToWeight('abc', 10), 'abc', '収まるときは原文のまま')
  assert.equal(truncateToWeight('abc', 3), 'abc', 'ちょうどは切らない')

  const long = 'A'.repeat(200)
  const cut = truncateToWeight(long, 50)
  assert.ok(xWeight(cut) <= 50, `<= 50 (${xWeight(cut)})`)
  assert.ok(cut.endsWith('…'), '切ったら … で終わる')
  assert.equal(xWeight(cut), 50, '余りは使い切る（280 ちょうどまで使う決定 Q1=A）')

  // 絵文字を割らない（サロゲートペアの途中で切らない）
  const emoji = truncateToWeight('🏆🏆🏆', 5)
  assert.ok(xWeight(emoji) <= 5)
  assert.equal(emoji, '🏆…', '2 個ぶん（4）＋ … （2）は 5 を超えるので 1 個で止める')

  // 極小予算では空文字（空行は呼び出し側で落とす）
  assert.equal(truncateToWeight('abcdef', 0), '')
  assert.equal(truncateToWeight('abcdef', 1), '', '… すら入らない')
  assert.equal(truncateToWeight('abcdef', 2), '…', '… だけ入る')

  // どんな入力でも <= budget（性質）
  for (const budget of [1, 2, 3, 7, 13, 40, 279, 280]) {
    for (const text of ['', 'a', '日本語のとても長い見出しです。', '🏆 完了レシート — ' + 'X'.repeat(500)]) {
      assert.ok(xWeight(truncateToWeight(text, budget)) <= budget, `${budget} / ${text.slice(0, 12)}`)
    }
  }
})

test('fitBlocks は drop / set / truncate / cutAt を順に適用し、収まった段で止まる', () => {
  const blocks = ['HEAD — TITLE', 'L2 ' + 'x'.repeat(20), 'L3 ' + 'y'.repeat(20), 'L4', 'FOOTER']

  // 収まっているなら何も適用しない
  const fits = fitBlocks(blocks, { limit: 1000 })
  assert.deepEqual(fits.applied, [])
  assert.equal(fits.text, blocks.join('\n'))

  // 1 段目（フッター落とし）で収まるなら、そこで止まる
  const dropOne = fitBlocks(blocks, { limit: 63, steps: [{ drop: 4 }, { drop: 3 }] })
  assert.deepEqual(dropOne.applied, [0], '収まったら残りの段は適用しない')
  assert.equal(dropOne.text.split('\n').length, 4)
  assert.equal(dropOne.text.includes('FOOTER'), false)
  assert.equal(dropOne.text.includes('\n\n'), false, '落とした block の空行は残さない')
  assert.equal(dropOne.text.endsWith('\n'), false)

  // 途中の block を落としても空行は残らない
  const middle = fitBlocks(['A', 'B', 'C'], { limit: 2, steps: [{ drop: 1 }] })
  assert.equal(middle.text, 'A\nC')
  assert.deepEqual(middle.applied, [0])

  // set は差し替える（空文字なら実質「親を外す」）
  const replaced = fitBlocks(['A', 'B long tail', 'C'], {
    limit: 10,
    steps: [{ set: [1, 'B'] }],
  })
  assert.equal(replaced.text, 'A\nB\nC')
  assert.deepEqual(replaced.applied, [0])

  // truncate は他の block のぶんを引いた残予算で詰める
  const truncated = fitBlocks(['HEAD ' + 'z'.repeat(80), 'tail'], {
    limit: 32,
    steps: [{ truncate: 0 }],
  })
  assert.ok(xWeight(truncated.text) <= 32, `<= 32 (${xWeight(truncated.text)})`)
  assert.ok(truncated.text.endsWith('…\ntail'), '見出しだけを詰める（数値の行は触らない）')
  assert.deepEqual(truncated.applied, [0])

  // cutAt は sep の最後の出現より前で切る
  const cut = fitBlocks(['🏆 TITLE — very long report name here', 'tail'], {
    limit: 20,
    steps: [{ cutAt: [0, ' — '] }],
  })
  assert.equal(cut.text.split('\n')[0], '🏆 TITLE')
  assert.deepEqual(cut.applied, [0])

  // 4 種を混ぜたときの適用順（SPEC §2.2 の 6 段と同じ形）
  const mixed = fitBlocks(['🏆 T — ' + 'w'.repeat(300), 'L2', 'L3', 'L4', 'L5'], {
    limit: 40,
    steps: [{ drop: 4 }, { drop: 3 }, { drop: 2 }, { cutAt: [0, ' — '] }],
  })
  assert.deepEqual(mixed.applied, [0, 1, 2, 3])
  assert.equal(mixed.text, '🏆 T\nL2', '残るのは見出しと L2 だけ')

  // 未知の step は無視する（前方互換）
  const unknown = fitBlocks(['A'], { limit: 0, steps: [{ bogus: true }, { drop: 0 }] })
  assert.deepEqual(unknown.applied, [1])
  assert.equal(unknown.text, '')
})
