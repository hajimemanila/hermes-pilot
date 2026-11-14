/**
 * 1 タップ指示スタンプの純関数テスト（SPEC-PILOT-V5 §3.3 ② / D26）。
 *
 * ここで固定したいのは 3 点:
 *  1. **既存ストロークへの紐づけ**（最後の 1 本に付き、入力配列は壊さない）
 *  2. **ストローク未描画時の自動ボックス生成**（中央 0.35..0.65 の矩形）
 *  3. **送信テキスト・JSON 変換**（`marks[].stamp` と `note` の自動合成）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_BOX,
  STAMPS,
  STAMP_NOTE_HEADER,
  applyStampToStrokes,
  composeNote,
  lastStampId,
  stampById,
  stampMeta,
  stampNoteLines,
  stampPills,
  strokesToMarks,
} from '../src/lib/annotationStamps.js'

const penStroke = (x = 10, y = 20) => ({ tool: 'pen', points: [[x, y], [x + 30, y + 10]] })

test('スタンプは仕様どおり 6 種で、id と絵文字と英語指示を持つ', () => {
  assert.deepEqual(
    STAMPS.map((s) => s.id),
    ['overlap', 'spacing', 'overflow', 'contrast', 'shift_up', 'remove'],
  )
  assert.deepEqual(
    STAMPS.map((s) => s.emoji),
    ['💥', '📏', '✂️', '🎨', '🔼', '🗑️'],
  )
  for (const s of STAMPS) {
    assert.equal(s.key, `annot.stamp.${s.id}`)
    assert.match(s.instruction, /\.$/, `${s.id} の指示文は英文 1 文で終わる`)
    // ワーカーへ渡す指示文に日本語が混ざると解釈がぶれる（UI 文言は i18n 側）
    assert.equal(/[\u3040-\u30ff\u4e00-\u9fff]/.test(s.instruction), false, `${s.id} は英語のみ`)
  }
  assert.equal(stampById('overlap').instruction, 'Fix element overlap around this marked area.')
  assert.equal(stampById('shift_up').instruction, 'Shift this element up to clear the bottom bar.')
  assert.equal(stampById('nope'), null)
})

test('stampMeta は送信 JSON と同じ形を返す', () => {
  assert.deepEqual(stampMeta('overflow'), {
    id: 'overflow',
    label: 'annot.stamp.overflow',
    instruction: 'Fix horizontal overflow or truncated text here.',
  })
  assert.equal(stampMeta('nope'), null)
})

test('既存ストロークがある場合は最後の 1 本に紐づく（入力は変更しない）', () => {
  const first = penStroke(0, 0)
  const second = penStroke(100, 50)
  const strokes = [first, second]
  const res = applyStampToStrokes(strokes, 'overlap', { w: 390, h: 600 })

  assert.equal(res.created, false)
  assert.equal(res.strokes.length, 2)
  assert.equal(res.stroke, res.strokes[1])
  assert.deepEqual(res.strokes[1].stamp, stampMeta('overlap'))
  // 先頭のストロークには付かない
  assert.equal(res.strokes[0].stamp, undefined)
  // 入力配列と元の要素は不変（React の ref を壊さない）
  assert.equal(strokes[1], second)
  assert.equal(second.stamp, undefined)
  assert.notEqual(res.strokes, strokes)
  // 座標はそのまま引き継ぐ
  assert.deepEqual(res.strokes[1].points, second.points)
})

test('既存ストロークへの押し直しは置き換え（同じ 1 本に 1 スタンプ）', () => {
  const once = applyStampToStrokes([penStroke()], 'overlap')
  const twice = applyStampToStrokes(once.strokes, 'contrast')
  assert.equal(twice.strokes.length, 1)
  assert.equal(twice.strokes[0].stamp.id, 'contrast')
  assert.equal(lastStampId(twice.strokes), 'contrast')
})

test('ストローク未描画なら中央 0.35..0.65 の矩形を自動生成して紐づける', () => {
  const res = applyStampToStrokes([], 'spacing', { w: 400, h: 800 })

  assert.equal(res.created, true)
  assert.equal(res.strokes.length, 1)
  const stroke = res.strokes[0]
  assert.equal(stroke.tool, 'rect')
  assert.equal(stroke.auto, true)
  assert.deepEqual(stroke.stamp, stampMeta('spacing'))
  // 自動ボックスは仕様の割合どおり（CSS px に換算される）
  assert.deepEqual(stroke.points, [
    [Math.round(AUTO_BOX.x0 * 400 * 10) / 10, Math.round(AUTO_BOX.y0 * 800 * 10) / 10],
    [Math.round(AUTO_BOX.x1 * 400 * 10) / 10, Math.round(AUTO_BOX.y1 * 800 * 10) / 10],
  ])
  assert.deepEqual(stroke.points[0], [140, 280])
  assert.deepEqual(stroke.points[1], [260, 520])
})

test('レイアウト未確定（サイズ 0 / 未指定）でも自動ボックスは潰れない', () => {
  for (const box of [null, undefined, { w: 0, h: 0 }]) {
    const stroke = applyStampToStrokes([], 'remove', box).strokes[0]
    const [[x0, y0], [x1, y1]] = stroke.points
    assert.ok(x1 > x0, '幅がある')
    assert.ok(y1 > y0, '高さがある')
  }
})

test('未知のスタンプ id は何も変えない', () => {
  const strokes = [penStroke()]
  const res = applyStampToStrokes(strokes, 'nope', { w: 390, h: 600 })
  assert.equal(res.stamp, null)
  assert.equal(res.stroke, null)
  assert.equal(res.created, false)
  assert.equal(res.strokes, strokes)
})

test('strokesToMarks は 0..1 に正規化し、スタンプ付きだけ stamp を載せる', () => {
  const strokes = [
    { tool: 'pen', points: [[0, 0], [195, 300]] },
    { tool: 'rect', points: [[39, 60], [117, 180]], stamp: stampMeta('contrast') },
  ]
  const marks = strokesToMarks(strokes, { width: 390, height: 600 })

  assert.equal(marks.length, 2)
  assert.deepEqual(marks[0], { tool: 'pen', points: [[0, 0], [0.5, 0.5]] })
  assert.equal(marks[0].stamp, undefined)
  assert.deepEqual(marks[1].points, [[0.1, 0.1], [0.3, 0.3]])
  assert.deepEqual(marks[1].stamp, stampMeta('contrast'))
  // 小数は 3 桁まで（bridge / Vision レーンが読む JSON を太らせない）
  const one = strokesToMarks([{ tool: 'pen', points: [[1, 2]] }], { width: 3, height: 7 })
  assert.deepEqual(one[0].points, [[0.333, 0.286]])
})

test('自動ボックスの mark は auto 印つきで 0.35..0.65 に収まる', () => {
  const res = applyStampToStrokes([], 'overflow', { w: 390, h: 600 })
  const marks = strokesToMarks(res.strokes, { width: 390, height: 600 })
  assert.equal(marks.length, 1)
  assert.equal(marks[0].auto, true)
  assert.equal(marks[0].tool, 'rect')
  assert.deepEqual(marks[0].points, [[0.35, 0.35], [0.65, 0.65]])
  assert.equal(marks[0].stamp.id, 'overflow')
})

test('stampPills は 1 始まりの連番と絵文字を返す', () => {
  const strokes = [
    { tool: 'pen', points: [[0, 0], [1, 1]], stamp: stampMeta('overlap') },
    { tool: 'pen', points: [[2, 2], [3, 3]] },
    { tool: 'rect', points: [[4, 4], [5, 5]], stamp: stampMeta('remove') },
  ]
  const pills = stampPills(strokes)
  assert.deepEqual(
    pills.map((p) => [p.index, p.emoji, p.stamp.id]),
    [
      [1, '💥', 'overlap'],
      [2, '🗑️', 'remove'],
    ],
  )
  assert.deepEqual(stampNoteLines(strokes), [
    '#1 💥 Fix element overlap around this marked area.',
    '#2 🗑️ Remove or hide this element.',
  ])
})

test('composeNote はユーザーのメモの後ろにスタンプ一覧を足す', () => {
  const strokes = [{ tool: 'pen', points: [[0, 0], [1, 1]], stamp: stampMeta('shift_up') }]
  assert.equal(
    composeNote('  ここだけ  ', strokes),
    [
      'ここだけ',
      STAMP_NOTE_HEADER,
      '#1 🔼 Shift this element up to clear the bottom bar.',
    ].join('\n'),
  )
  // メモ無しならスタンプ一覧だけ（＝キーボード入力 0 文字で送信できる）
  assert.equal(
    composeNote('', strokes),
    [STAMP_NOTE_HEADER, '#1 🔼 Shift this element up to clear the bottom bar.'].join('\n'),
  )
})

test('スタンプが無ければ note はユーザー入力のまま（前後の空白だけ落とす）', () => {
  assert.equal(composeNote('  そのまま  ', []), 'そのまま')
  assert.equal(composeNote('', [penStroke()]), '')
  assert.equal(composeNote(undefined, undefined), '')
})

test('スタンプだけ押して送信しても marks と note が両方成立する（入力 0 文字）', () => {
  const applied = applyStampToStrokes([], 'contrast', { w: 390, h: 600 })
  const marks = strokesToMarks(applied.strokes, { width: 390, height: 600 })
  const note = composeNote('', applied.strokes)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].stamp.id, 'contrast')
  assert.match(note, /Improve text\/background contrast ratio here\./)
  assert.equal(lastStampId(applied.strokes), 'contrast')
})
