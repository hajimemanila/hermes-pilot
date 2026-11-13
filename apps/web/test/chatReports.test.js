import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_CHAT_KEY,
  LAST_CHAT_KEY,
  REPORT_LINES,
  SEEN_MAP_LIMIT,
  mergeTimeline,
  newerThan,
  otherUnreadReports,
  readActiveChatId,
  readSeenMap,
  reportLines,
  setSeen,
  toEpochMs,
  unreadSessions,
} from '../src/lib/chatReports.js'

/** 監視 cron が書く 1 行（`/api/akapen/chat-reports` の items）。 */
const rep = (at, sessionId, taskId, text = '完了') => ({
  at: Date.parse(at),
  sessionId,
  taskId,
  label: null,
  text,
})

test('newerThan は既読より新しい報告だけを残す（未読の点の判定）', () => {
  const items = [rep('2026-11-13T02:10:00+08:00', 'a', 't1'), rep('2026-11-13T02:12:00+08:00', 'a', 't2')]
  assert.equal(newerThan(items, 0).length, 2, '既読 0 なら全部が未読（初回起動で取りこぼさない）')
  assert.deepEqual(newerThan(items, Date.parse('2026-11-13T02:11:00+08:00')).map((i) => i.taskId), ['t2'])
  assert.equal(newerThan(items, Date.parse('2026-11-13T02:12:00+08:00')).length, 0, '同じ時刻は既読')
  assert.deepEqual(newerThan(null, 0), [])
  assert.deepEqual(newerThan([{ at: 'x' }], 0), [], 'at が数値でない行は捨てる')
})

test('unreadSessions は会話ごとの未読を重複なしで返す（行の点）', () => {
  const items = [
    rep('2026-11-13T02:10:00+08:00', 'a', 't1'),
    rep('2026-11-13T02:11:00+08:00', 'b', 't2'),
    rep('2026-11-13T02:12:00+08:00', 'a', 't3'),
  ]
  assert.deepEqual(unreadSessions(items, {}), ['a', 'b'], '既読を持たない会話は未読・初出順')
  assert.deepEqual(unreadSessions(items, { a: Date.parse('2026-11-13T02:12:00+08:00') }), ['b'], '既読の会話は外す')
  const after = Date.parse('2026-11-13T02:13:00+08:00')
  assert.deepEqual(unreadSessions(items, { a: after, b: after }), [], '全部既読なら点は出ない')
  assert.deepEqual(unreadSessions(null, {}), [])
  assert.deepEqual(unreadSessions([{ at: 1, sessionId: '' }], {}), [], '宛先の無い行は無視')
})

test('reportLines はその会話の直近だけを古い順で返す（会話の末尾に出す 1 行）', () => {
  const items = [
    rep('2026-11-13T02:10:00+08:00', 'a', 't1', '1'),
    rep('2026-11-13T02:11:00+08:00', 'b', 't2', '2'),
    rep('2026-11-13T02:12:00+08:00', 'a', 't3', '3'),
    rep('2026-11-13T02:13:00+08:00', 'a', 't4', '4'),
  ]
  const mine = reportLines(items, 'a')
  assert.equal(mine.length, REPORT_LINES, '既定は直近 3 行')
  assert.deepEqual(mine.map((r) => r.text), ['1', '3', '4'])
  assert.equal(mine[0].key, `t1:${Date.parse('2026-11-13T02:10:00+08:00')}`)

  assert.deepEqual(reportLines(items, 'a', 1).map((r) => r.text), ['4'], 'limit は末尾 N 件')
  assert.deepEqual(reportLines(items, 'z'), [], '知らない会話は空')
  assert.deepEqual(reportLines(items, ''), [], '宛先が無ければ空')
})

test('readSeenMap は壊れた値でも空で返す（点が消えない事故を起こさない）', () => {
  assert.deepEqual(readSeenMap(null), {})
  assert.deepEqual(readSeenMap(''), {})
  assert.deepEqual(readSeenMap('not json'), {})
  assert.deepEqual(readSeenMap('[1,2]'), {})
  assert.deepEqual(readSeenMap('{"a":"x","b":123}'), { b: 123 }, '数値になる値だけ残す')
  assert.deepEqual(readSeenMap({ a: 1 }), { a: 1 }, 'object も受ける')
})

test('setSeen は 1 会話ぶんを立て、古いものから捨てる', () => {
  const first = setSeen({}, 'a', 1000)
  assert.deepEqual(first, { a: 1000 })
  assert.deepEqual(setSeen(first, 'b', 2000), { a: 1000, b: 2000 })
  assert.deepEqual(setSeen(first, 'a', 3000), { a: 3000 }, '同じ会話は上書き')

  let map = {}
  for (let i = 1; i <= SEEN_MAP_LIMIT + 5; i += 1) map = setSeen(map, `s${i}`, i)
  assert.equal(Object.keys(map).length, SEEN_MAP_LIMIT, '上限まで')
  assert.equal(map['s1'], undefined, '古い会話から捨てる')
  assert.equal(map[`s${SEEN_MAP_LIMIT + 5}`], SEEN_MAP_LIMIT + 5, '新しい会話は残る')

  assert.deepEqual(setSeen({ a: 1 }, '', 100), { a: 1 }, '宛先が空なら変えない')
  assert.deepEqual(setSeen({ a: 1 }, 'b', NaN), { a: 1 }, '時刻が不正なら変えない')
})

test('toEpochMs は秒・ミリ秒・ISO文字列を epoch ms に揃える', () => {
  assert.equal(toEpochMs(1700000000), 1700000000000)
  assert.equal(toEpochMs(1700000000123), 1700000000123)
  assert.equal(toEpochMs('1700000000'), 1700000000000)
  assert.equal(toEpochMs('2026-11-13T10:00:00Z'), Date.parse('2026-11-13T10:00:00Z'))
  assert.equal(toEpochMs(null), null)
  assert.equal(toEpochMs('invalid'), null)
})

test('mergeTimeline は報告より後の会話ブロックがあるとき報告をその手前に配置する', () => {
  const blocks = [
    { role: 'user', text: '古い質問' }, // 時刻なし（resume由来など）
    { role: 'assistant', text: '古い回答' },
    { role: 'user', text: '新しい質問', at: 2000 },
    { role: 'assistant', text: '新しい回答', at: 2100 },
  ]
  const reports = [
    { key: 't1:1500', at: 1500, text: '赤ペン完了' },
    { key: 't2:3000', at: 3000, text: '最新の赤ペン完了' },
  ]
  const merged = mergeTimeline(blocks, reports)
  assert.deepEqual(
    merged.map((x) => (x.kind === 'report' ? `R:${x.report.key}` : `B:${x.block.text}`)),
    ['B:古い質問', 'B:古い回答', 'R:t1:1500', 'B:新しい質問', 'B:新しい回答', 'R:t2:3000'],
  )
})

test('reportLines は複数 ID 配列を受け取り taskId/label も返す', () => {
  const items = [
    rep('2026-11-13T01:00:00Z', 'stored-1', 't_1', '報告1'),
    rep('2026-11-13T01:01:00Z', 'runtime-1', 't_2', '報告2'),
    rep('2026-11-13T01:02:00Z', 'other-1', 't_3', '他会話'),
  ]
  const out = reportLines(items, ['stored-1', 'runtime-1'])
  assert.deepEqual(out.map((x) => x.taskId), ['t_1', 't_2'])
})

test('otherUnreadReports と readActiveChatId が現在以外・新規未送信時の紐づけを扱う', () => {
  const items = [
    rep('2026-11-13T01:00:00Z', 'chat-cur', 't_1', '現在の会話'),
    rep('2026-11-13T01:01:00Z', 'chat-other-1', 't_2', '別会話1-旧'),
    rep('2026-11-13T01:05:00Z', 'chat-other-1', 't_3', '別会話1-新'),
    rep('2026-11-13T01:03:00Z', 'chat-other-2', 't_4', '別会話2'),
  ]
  const seen = { 'chat-other-2': Date.parse('2026-11-13T01:04:00Z') }
  const others = otherUnreadReports(items, seen, ['chat-cur'])
  assert.equal(others.length, 1, '既読の別会話と現在の会話は除く')
  assert.equal(others[0].sessionId, 'chat-other-1')
  assert.equal(others[0].taskId, 't_3', '同一会話の最新1件を返す')

  const fakeStorage = {
    getItem: (k) => (k === LAST_CHAT_KEY ? 'prev_chat' : k === ACTIVE_CHAT_KEY ? '' : null),
  }
  assert.equal(readActiveChatId(fakeStorage), 'prev_chat', '新規会話未送信でも直前の会話を引き継ぐ')
})
