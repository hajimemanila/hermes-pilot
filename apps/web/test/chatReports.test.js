import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_CHAT_KEY,
  LATEST_REPORT_ID,
  LAST_CHAT_KEY,
  REPORT_LINES,
  SEEN_MAP_LIMIT,
  followUpPromptFor,
  isPipelineReport,
  markAllReportsSeenMap,
  maxReportAtFor,
  mergeTimeline,
  newerThan,
  otherUnreadReports,
  readActiveChatId,
  readSeenMap,
  reportIdsFor,
  reportLines,
  reportSummaryLine,
  setSeen,
  toEpochMs,
  unreadSessions,
} from '../src/lib/chatReports.js'

/** 監視 cron が書く 1 行（`/api/review/chat-reports` の items）。 */
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
    { key: 't1:1500', at: 1500, text: 'レビュー完了' },
    { key: 't2:3000', at: 3000, text: '最新のレビュー完了' },
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

test('maxReportAtFor はその会話の最新 at だけを返す（時計スキュー対策の材料）', () => {
  const items = [
    rep('2026-11-13T01:00:00Z', 'a', 't1'),
    rep('2026-11-13T01:05:00Z', 'a', 't2'),
    rep('2026-11-13T09:00:00Z', 'b', 't3'),
  ]
  assert.equal(maxReportAtFor(items, 'a'), Date.parse('2026-11-13T01:05:00Z'))
  assert.equal(maxReportAtFor(items, ['nope', 'b']), Date.parse('2026-11-13T09:00:00Z'), 'ID 配列も受ける')
  assert.equal(maxReportAtFor(items, 'z'), 0, '報告の無い会話は 0')
  assert.equal(maxReportAtFor(items, ''), 0)
  assert.equal(maxReportAtFor(null, 'a'), 0)
})

test('markReportsSeen 相当（max(at, now)）で未来時刻の報告も既読になる（時計スキュー）', () => {
  const now = Date.parse('2026-11-13T01:00:00Z')
  const future = Date.parse('2026-11-13T01:10:00Z') // 端末時計より 10 分先
  const items = [rep('2026-11-13T01:10:00Z', 'a', 't1')]
  const map = setSeen({}, 'a', Math.max(now, maxReportAtFor(items, 'a')))
  assert.equal(map.a, future, '未来の at を既読時刻として採用する')
  assert.deepEqual(unreadSessions(items, map), [], '端末時刻だけを書くとここが残る（I9③）')
  assert.deepEqual(newerThan(items, map.a), [], '未読件数も 0 になる')
})

test('markAllReportsSeenMap は全会話を一括既読にする（未来時刻でも残らない）', () => {
  const now = Date.parse('2026-11-13T01:00:00Z')
  const items = [
    rep('2026-11-13T01:02:00Z', 'a', 't1'),
    rep('2026-11-13T01:10:00Z', 'a', 't2'), // 未来（スキュー）
    rep('2026-11-13T01:03:00Z', 'b', 't3'),
  ]
  const map = markAllReportsSeenMap({ old: 5 }, items, now)
  assert.equal(map.a, Date.parse('2026-11-13T01:10:00Z'), 'a は最大 at で既読')
  assert.equal(map.b, Date.parse('2026-11-13T01:03:00Z'), 'now より新しい報告は at を採用')
  assert.equal(map.old, 5, '既存の記録は残す')
  assert.deepEqual(unreadSessions(items, map), [], '一括既読後は未読 0')
  assert.deepEqual(otherUnreadReports(items, map, []), [], 'バナーにも出ない')

  assert.deepEqual(markAllReportsSeenMap({}, null, now), readSeenMap({}), 'items が無ければ既読を増やさない')
})

/* ---------------------------------------------------------------------------
 * パイプライン統合レポート（SPEC-PILOT-V4 §3.3 ①② / D20）
 * ------------------------------------------------------------------------- */

/** ブリッジが書く統合レポート 1 行（`kind: 'pipeline'`）。 */
const pipe = (at, sessionId, extra = {}) => ({
  at: Date.parse(at),
  sessionId,
  taskId: 't_pipe',
  label: null,
  text: '',
  kind: 'pipeline',
  status: 'done',
  board: 'hermes-pilot',
  spec: 'docs/SPEC-PILOT-V4.md',
  repoPath: '/Users/x/projects/hermes-mobile-pwa',
  markdown: '# 🎉 パイプライン完了報告\n\n- V4-1 完了\n- V4-2 完了\n',
  followUpPrompt: '残りのバッチを起票して',
  counts: { done: 4, blocked: 0 },
  ...extra,
})

test('isPipelineReport は kind=pipeline だけを統合レポートとして扱う', () => {
  assert.equal(isPipelineReport(pipe('2026-11-15T10:00:00Z', 'a')), true)
  assert.equal(isPipelineReport(rep('2026-11-15T10:00:00Z', 'a', 't1')), false, '既存のレビュー完了 1 行')
  assert.equal(isPipelineReport(null), false)
})

test('reportLines は統合レポートの markdown / followUpPrompt / board を引き継ぐ', () => {
  const items = [pipe('2026-11-15T10:00:00Z', 'a')]
  const out = reportLines(items, 'a')
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'pipeline')
  assert.equal(out[0].status, 'done')
  assert.equal(out[0].board, 'hermes-pilot')
  assert.equal(out[0].repoPath, '/Users/x/projects/hermes-mobile-pwa')
  assert.match(out[0].markdown, /V4-1 完了/)
  assert.equal(out[0].followUpPrompt, '残りのバッチを起票して')
  assert.deepEqual(out[0].counts, { done: 4, blocked: 0 })
  // 既存のレビュー完了 1 行には追加キーが生えない（後方互換）
  assert.deepEqual(Object.keys(reportLines([rep('2026-11-15T10:00:00Z', 'a', 't1')], 'a')[0]).sort(), [
    'at',
    'key',
    'label',
    'taskId',
    'text',
  ])
})

test('reportIdsFor は repo 一致の __latest__ だけを合流させる', () => {
  const items = [pipe('2026-11-15T10:00:00Z', LATEST_REPORT_ID)]
  assert.deepEqual(reportIdsFor(['chat-1'], items, '/Users/x/projects/hermes-mobile-pwa'), [
    'chat-1',
    LATEST_REPORT_ID,
  ])
  assert.deepEqual(reportIdsFor(['chat-1'], items, '/Users/x/projects/other-repo'), ['chat-1'], '別リポジトリは混ぜない')
  assert.deepEqual(reportIdsFor(['chat-1'], items, ''), ['chat-1'], 'repo 不明なら合流させない')
  assert.deepEqual(
    reportIdsFor(['chat-1'], [pipe('2026-11-15T10:00:00Z', 'chat-2')], '/Users/x/projects/hermes-mobile-pwa'),
    ['chat-1'],
    '__latest__ 以外の宛先は増やさない',
  )
  assert.deepEqual(
    reportIdsFor([LATEST_REPORT_ID], items, '/Users/x/projects/hermes-mobile-pwa'),
    [LATEST_REPORT_ID],
    '重複しない',
  )
})

test('reportSummaryLine は Markdown 記号を落とした 1 行を返す（長すぎるときは …）', () => {
  const md = '# 🎉 完了\n\n## 次にやること\n- V4-3 を起票'
  assert.equal(reportSummaryLine({ markdown: md }), '🎉 完了', '最初の非空行')
  assert.equal(reportSummaryLine({ markdown: '\n\n- [docs](https://example.com) を読む' }), 'docs を読む')
  assert.equal(reportSummaryLine({ markdown: `# ${'あ'.repeat(200)}`, }, 20), `${'あ'.repeat(19)}…`)
  assert.equal(reportSummaryLine(null), '')
})

test('followUpPromptFor はレポートの相談文を優先し、無ければ訳文に落とす', () => {
  assert.equal(followUpPromptFor({ followUpPrompt: ' 次は？ ' }, 'fallback'), '次は？')
  assert.equal(followUpPromptFor({}, 'fallback'), 'fallback')
  assert.equal(followUpPromptFor(null, 'fallback'), 'fallback')
})

test('otherUnreadReports は __latest__ バナー用に board / repoPath / followUpPrompt を運ぶ', () => {
  const items = [pipe('2026-11-15T10:00:00Z', LATEST_REPORT_ID)]
  const others = otherUnreadReports(items, {}, ['chat-cur'])
  assert.equal(others.length, 1)
  assert.equal(others[0].sessionId, LATEST_REPORT_ID)
  assert.equal(others[0].repoPath, '/Users/x/projects/hermes-mobile-pwa')
  assert.equal(others[0].board, 'hermes-pilot')
  assert.equal(others[0].followUpPrompt, '残りのバッチを起票して')
  // `__latest__` も通常の ID と同じく既読にできる
  const seen = setSeen({}, LATEST_REPORT_ID, Date.parse('2026-11-15T10:05:00Z'))
  assert.deepEqual(otherUnreadReports(items, seen, ['chat-cur']), [])
})
