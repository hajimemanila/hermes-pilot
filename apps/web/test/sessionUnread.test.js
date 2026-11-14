/**
 * セッション別の未読（返信新着）と会話一覧の行バッジの自動検証（SPEC-PILOT-V3 §3.1 / D16）。
 *
 * 壊れやすいのはこの 3 点なので固定する:
 *  1. 初回読み込みで全会話が一斉に未読にならない（`bootstrapSessionSeen`）
 *  2. 表示中の会話は新着扱いにしない（`sessionRowBadges` の `isActive`）
 *  3. 数字の出し分け（完了報告 = 件数、返信 = NEW / +N、実行中 = ドット）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_SEEN_LIMIT,
  bootstrapSessionSeen,
  drawerUnreadCount,
  markSessionSeen,
  pruneSessionSeen,
  readSessionSeen,
  serializeSessionSeen,
  sessionRowBadges,
  unreadRepliesLabel,
} from '../src/lib/sessionUnread.js'

/** `/api/sessions` の 1 件。 */
const sess = (id, message_count, extra = {}) => ({ id, message_count, ...extra })

test('bootstrapSessionSeen は初見の会話を現在のメッセージ数でベースライン登録する', () => {
  const now = 1_700_000_000_000
  const map = bootstrapSessionSeen({}, [sess('a', 12), sess('b', 0)], now)
  assert.deepEqual(map, { a: { count: 12, at: now }, b: { count: 0, at: now } })
})

test('bootstrapSessionSeen は初回に全会話が未読にならない（返信新着 0 件）', () => {
  const now = 1_700_000_000_000
  const sessions = [sess('a', 12), sess('b', 4), sess('c', 1)]
  const map = bootstrapSessionSeen({}, sessions, now)
  for (const s of sessions) {
    const b = sessionRowBadges({ session: s, seenMap: map, activeDrawerSid: 'a' })
    assert.equal(b.unreadReplies, 0, `${s.id} が初回から未読になっている`)
  }
})

test('bootstrapSessionSeen は記録済みの会話を上書きしない（増分だけが新着になる）', () => {
  const prev = { a: { count: 3, at: 1 } }
  const map = bootstrapSessionSeen(prev, [sess('a', 9), sess('b', 2)], 2)
  assert.equal(map.a.count, 3, '記録済みは据え置き')
  assert.equal(map.a.at, 1)
  assert.deepEqual(map.b, { count: 2, at: 2 }, '初見だけ登録')
})

test('sessionRowBadges: 別会話でメッセージが増えたときだけ unreadReplies が出る', () => {
  const seen = { a: { count: 5, at: 1 }, b: { count: 5, at: 1 } }
  const a = sessionRowBadges({ session: sess('a', 9), seenMap: seen, activeDrawerSid: 'a' })
  assert.equal(a.unreadReplies, 0, '表示中の会話は新着にしない')

  const b = sessionRowBadges({ session: sess('b', 9), seenMap: seen, activeDrawerSid: 'a' })
  assert.equal(b.unreadReplies, 4, '+4 の新着')

  const b2 = sessionRowBadges({ session: sess('b', 5), seenMap: seen, activeDrawerSid: 'a' })
  assert.equal(b2.unreadReplies, 0, '増えていなければ出さない')

  const b3 = sessionRowBadges({ session: sess('b', 2), seenMap: seen, activeDrawerSid: 'a' })
  assert.equal(b3.unreadReplies, 0, '減っていても出さない（未来の新着を作らない）')
})

test('sessionRowBadges: 記録が無い会話は新着と言い切らない（bootstrap 前提）', () => {
  const b = sessionRowBadges({ session: sess('x', 7), seenMap: {}, activeDrawerSid: 'a' })
  assert.equal(b.unreadReplies, 0)
})

test('sessionRowBadges: 未読の完了報告は件数で返る（map / 配列 / Map のどれでも）', () => {
  const session = sess('s1', 3)
  assert.equal(sessionRowBadges({ session, unreadReportMap: { s1: 2 }, seenMap: {} }).unreadReports, 2)
  assert.equal(
    sessionRowBadges({ session, unreadReportMap: [{ sessionId: 's1' }, { sessionId: 's1' }, { sessionId: 's2' }] })
      .unreadReports,
    2,
  )
  assert.equal(
    sessionRowBadges({ session, unreadReportMap: new Map([['s1', 3]]) }).unreadReports,
    3,
  )
  assert.equal(sessionRowBadges({ session, unreadReportMap: { s2: 5 } }).unreadReports, 0, '別会話の分は数えない')
})

test('sessionRowBadges: 実行中は is_active と liveSessionIds の両方で拾う', () => {
  const base = { unreadReportMap: {}, seenMap: {}, activeDrawerSid: null }
  assert.equal(sessionRowBadges({ ...base, session: sess('a', 0, { is_active: true }) }).isRunning, true)
  assert.equal(sessionRowBadges({ ...base, session: sess('a', 0), liveSessionIds: new Set(['a']) }).isRunning, true)
  assert.equal(sessionRowBadges({ ...base, session: sess('a', 0), liveSessionIds: ['a'] }).isRunning, true)
  assert.equal(sessionRowBadges({ ...base, session: sess('a', 0), liveSessionIds: new Set(['b']) }).isRunning, false)
})

test('sessionRowBadges: isActive は表示中の会話だけ（readonly 閲覧中の隔離）', () => {
  const seen = { parent: { count: 1, at: 1 }, worker: { count: 1, at: 1 } }
  const parent = sessionRowBadges({ session: sess('parent', 1), seenMap: seen, activeDrawerSid: 'worker' })
  const worker = sessionRowBadges({ session: sess('worker', 1), seenMap: seen, activeDrawerSid: 'worker' })
  assert.equal(parent.isActive, false)
  assert.equal(worker.isActive, true)
})

test('sessionRowBadges は欠けた入力で落ちない', () => {
  assert.deepEqual(sessionRowBadges(), { isActive: false, isRunning: false, unreadReports: 0, unreadReplies: 0 })
  assert.deepEqual(sessionRowBadges({ session: null }), {
    isActive: false,
    isRunning: false,
    unreadReports: 0,
    unreadReplies: 0,
  })
})

test('markSessionSeen はメッセージ数を記録し、未読を消す', () => {
  const now = 1_700_000_000_123
  const map = markSessionSeen({ a: { count: 2, at: 1 } }, 'a', 7, now)
  assert.deepEqual(map.a, { count: 7, at: now })
  const b = sessionRowBadges({ session: sess('a', 7), seenMap: map, activeDrawerSid: 'other' })
  assert.equal(b.unreadReplies, 0)
})

test('markSessionSeen は既知の件数が無くても記録を壊さない', () => {
  const map = markSessionSeen({ a: { count: 4, at: 1 } }, 'a', undefined, 5)
  assert.equal(map.a.count, 4, '件数が読めないときは前の値を保つ')
  assert.equal(map.a.at, 5, '時刻は更新する')
  assert.deepEqual(markSessionSeen({}, '', 3, 5), {}, 'ID が無ければ何もしない')
})

test('pruneSessionSeen / readSessionSeen / serializeSessionSeen: 上限と壊れた値', () => {
  const big = {}
  for (let i = 0; i < SESSION_SEEN_LIMIT + 20; i += 1) big[`s${i}`] = { count: i, at: i + 1 }
  const pruned = pruneSessionSeen(big)
  assert.equal(Object.keys(pruned).length, SESSION_SEEN_LIMIT, '上限まで間引く')
  assert.equal(pruned.s0, undefined, '古い順に捨てる')
  assert.ok(pruned[`s${SESSION_SEEN_LIMIT + 19}`], '新しいものは残る')

  assert.deepEqual(readSessionSeen(null), {})
  assert.deepEqual(readSessionSeen('not json'), {})
  assert.deepEqual(readSessionSeen('[]'), {})
  assert.deepEqual(readSessionSeen({ a: { count: 'x', at: 1 } }), {}, '数値でない count は捨てる')
  assert.deepEqual(readSessionSeen('{"a":{"count":2,"at":3}}'), { a: { count: 2, at: 3 } })

  const text = serializeSessionSeen(pruned)
  assert.deepEqual(readSessionSeen(text), pruned, '書いて読んで元に戻る')
})

test('drawerUnreadCount は未読のある会話だけ数える（点の数を丸に出す）', () => {
  assert.equal(
    drawerUnreadCount([
      { unreadReports: 1, unreadReplies: 0 },
      { unreadReports: 0, unreadReplies: 2 },
      { unreadReports: 0, unreadReplies: 0 },
    ]),
    2,
  )
  assert.equal(drawerUnreadCount([]), 0)
  assert.equal(drawerUnreadCount(null), 0)
})

test('unreadRepliesLabel は 1 件を NEW、2 件以上を +N にする', () => {
  assert.equal(unreadRepliesLabel(0), '')
  assert.equal(unreadRepliesLabel(1), 'NEW')
  assert.equal(unreadRepliesLabel(3), '+3')
  assert.equal(unreadRepliesLabel(null), '')
})
