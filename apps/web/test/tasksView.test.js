/**
 * タスク詳細シートのイベント折りたたみ（SPEC-PILOT-V8 §V8-B3）の検証。
 *
 * `kanban.task()` の `events` は**新しい順**（`ORDER BY id DESC`）。worker は 1 ターンで
 * 何度も heartbeat を打つので、そのまま並べるとタイムラインが heartbeat だけで埋まる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  archivedTaskCount,
  archivableTasks,
  bulkArchivePayload,
  collapseTaskEvents,
  coherenceBannerView,
  coherenceDismissRecord,
  coherenceSignature,
  eventKind,
  isArchivedTask,
  normalizeCoherenceAlert,
  organizeRowView,
  parseCoherenceDismissed,
  selectableBrokenTasks,
  specPickerList,
  splitSpecsByArchive,
  visibleTasks,
} from '../src/lib/tasksView.js'

/** 新しい順のイベント列を作る（`at` は降順）。 */
const ev = (kind, at) => ({ kind, at, payload: {} })

test('collapseTaskEvents は連続する heartbeat を 1 件にまとめる', () => {
  const events = [
    ev('heartbeat', 5000),
    ev('heartbeat', 4000),
    ev('heartbeat', 3000),
    ev('claimed', 2000),
    ev('created', 1000),
  ]
  const out = collapseTaskEvents(events)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { kind: 'heartbeat', count: 3, at: 5000, firstAt: 3000 })
  assert.equal(out[1].kind, 'claimed')
  assert.equal(out[2].kind, 'created')
  // 元の配列は書き換えない
  assert.equal(events.length, 5)
  assert.equal(events[0].count, undefined)
})

test('collapseTaskEvents は別種イベントを跨いで合算しない', () => {
  const events = [
    ev('heartbeat', 9000),
    ev('heartbeat', 8000),
    ev('comment', 7000),
    ev('heartbeat', 6000),
    ev('heartbeat', 5000),
    ev('heartbeat', 4000),
  ]
  const out = collapseTaskEvents(events)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((e) => e.kind), ['heartbeat', 'comment', 'heartbeat'])
  assert.equal(out[0].count, 2)
  assert.equal(out[0].at, 9000)
  assert.equal(out[0].firstAt, 8000)
  assert.equal(out[2].count, 3)
  assert.equal(out[2].at, 6000)
  assert.equal(out[2].firstAt, 4000)
})

test('collapseTaskEvents は空配列・未指定で空配列を返す', () => {
  assert.deepEqual(collapseTaskEvents([]), [])
  assert.deepEqual(collapseTaskEvents(), [])
})

test('collapseTaskEvents は 1 件だけの heartbeat も count=1 で返す', () => {
  const out = collapseTaskEvents([ev('heartbeat', 1234)])
  assert.deepEqual(out, [{ kind: 'heartbeat', count: 1, at: 1234, firstAt: 1234 }])
})

test('collapseTaskEvents は heartbeat 以外をそのまま（同一参照で）通す', () => {
  const claimed = { kind: 'claimed', at: 10, payload: { run_id: 1 } }
  const out = collapseTaskEvents([claimed])
  assert.equal(out[0], claimed)
})

test('collapseTaskEvents は壊れた要素を落とす', () => {
  const out = collapseTaskEvents([null, ev('heartbeat', 5), undefined])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'heartbeat')
})

test('eventKind は kind が無ければ空文字を返す', () => {
  assert.equal(eventKind({ kind: 'claimed' }), 'claimed')
  assert.equal(eventKind({}), '')
  assert.equal(eventKind(null), '')
})

/* --- Coherence 提案バナー（SPEC-COHERENCE §3.6 / D83） --------------------- */

test('normalizeCoherenceAlert は閾値超過だけ alert=true（3 条件のどれか 1 つ）', () => {
  const none = normalizeCoherenceAlert({ summary: { hardFailCount: 0, softSignalCount: 2, hotspotCount: 0 } })
  assert.equal(none.alert, false)

  assert.equal(normalizeCoherenceAlert({ summary: { hardFailCount: 1 } }).alert, true)
  assert.equal(normalizeCoherenceAlert({ summary: { hotspotCount: 1 } }).alert, true)
  assert.equal(normalizeCoherenceAlert({ summary: { softSignalCount: 3 } }).alert, true)
  // 壊れた入力は出さない
  assert.equal(normalizeCoherenceAlert(null).alert, false)
  assert.equal(normalizeCoherenceAlert({ summary: { softSignalCount: 'x' } }).alert, false)
})

test('normalizeCoherenceAlert は完走レポートの coherence_alert 形も読む', () => {
  const report = {
    at: 123,
    markdown: '# done',
    coherence_alert: {
      summary: { hardFailCount: 2, softSignalCount: 4, hotspotCount: 1 },
      recommendedSweep: 'contracts',
      highlights: ['api parity is broken', 'styles.css grew', '  ', 'x', 'y'],
    },
  }
  const alert = normalizeCoherenceAlert(report)
  assert.equal(alert.alert, true)
  assert.deepEqual(alert.summary, { hardFailCount: 2, softSignalCount: 4, hotspotCount: 1 })
  assert.equal(alert.recommendedSweep, 'contracts')
  // 空文字は落とし、最大 3 件まで
  assert.deepEqual(alert.highlights, ['api parity is broken', 'styles.css grew', 'x'])
})

test('coherenceSignature は件数か推奨スイープが変わると別の署名になる', () => {
  const a = normalizeCoherenceAlert({ summary: { hardFailCount: 0, softSignalCount: 3, hotspotCount: 1 } })
  const b = normalizeCoherenceAlert({ summary: { hardFailCount: 0, softSignalCount: 4, hotspotCount: 1 } })
  assert.notEqual(coherenceSignature(a), coherenceSignature(b))
  assert.equal(coherenceSignature(a), coherenceSignature({ ...a }))
})

test('parseCoherenceDismissed は壊れた値を null に落とす', () => {
  assert.equal(parseCoherenceDismissed(null), null)
  assert.equal(parseCoherenceDismissed(''), null)
  assert.equal(parseCoherenceDismissed('not json'), null)
  assert.equal(parseCoherenceDismissed('{}'), null)
  assert.deepEqual(parseCoherenceDismissed(JSON.stringify({ signature: '0:3:1:hotspots', at: 5 })), {
    signature: '0:3:1:hotspots',
    at: 5,
  })
})

test('coherenceBannerView は閉じた記録と同じ署名なら隠し、署名が変われば出し直す', () => {
  const report = { summary: { hardFailCount: 0, softSignalCount: 3, hotspotCount: 1 }, recommendedSweep: 'hotspots' }
  const first = coherenceBannerView(report, null)
  assert.equal(first.show, true)
  assert.equal(first.dismissed, false)
  assert.equal(first.recommendedSweep, 'hotspots')

  const raw = JSON.stringify(coherenceDismissRecord(first.signature, 1000))
  const closed = coherenceBannerView(report, raw)
  assert.equal(closed.show, false)
  assert.equal(closed.dismissed, true)

  // 悪化（soft 3 → 5）したら署名が変わるので再表示する
  const worse = coherenceBannerView({ ...report, summary: { ...report.summary, softSignalCount: 5 } }, raw)
  assert.equal(worse.show, true)

  // 閾値未満は閉じた記録に関係なく出さない
  const quiet = coherenceBannerView({ summary: { softSignalCount: 1 } }, null)
  assert.equal(quiet.show, false)
  assert.equal(quiet.alert, false)
})

test('specPickerList は既定でアクティブだけ、ON で mtime の新しい順に混ぜる', () => {
  const parts = {
    active: [
      { path: 'docs/SPEC-A.md', mtime: 300 },
      { path: 'docs/SPEC-B.md', mtime: 100 },
    ],
    archived: [
      { path: 'docs/SPEC-OLD.md', mtime: 200, archived: true },
      { path: 'docs/archive/SPEC-OLD2.md', mtime: 400, archived: true },
    ],
  }
  assert.deepEqual(
    specPickerList(parts).map((s) => s.path),
    ['docs/SPEC-A.md', 'docs/SPEC-B.md'],
  )
  assert.deepEqual(
    specPickerList(parts, true).map((s) => s.path),
    ['docs/archive/SPEC-OLD2.md', 'docs/SPEC-A.md', 'docs/SPEC-OLD.md', 'docs/SPEC-B.md'],
  )
  assert.deepEqual(specPickerList(null, true), [])
})

test('splitSpecsByArchive は archived フラグで分け、順序を保つ', () => {
  const { active, archived } = splitSpecsByArchive([
    { path: 'a' },
    { path: 'b', archived: true },
    { path: 'c', archived: false },
  ])
  assert.deepEqual(active.map((s) => s.path), ['a', 'c'])
  assert.deepEqual(archived.map((s) => s.path), ['b'])
  assert.deepEqual(splitSpecsByArchive(undefined), { active: [], archived: [] })
})

test('TasksPane のタスク詳細ドロワーは非実行・未完了タスクにも CloseActions（完了/破棄）を出す', () => {
  // 分割後: 詳細ドロワー本体は features/tasks/TaskDetailSheet.jsx が持つ（TasksPane は対象を渡すだけ）
  const src = fs.readFileSync(new URL('../src/features/tasks/TaskDetailSheet.jsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ CloseActions \} from ['"]\.\.\/\.\.\/components\/CloseActions\.jsx['"]/)
  assert.match(src, /detail\.status && detail\.status !== 'done' && detail\.status !== 'archived'[\s\S]*?<CloseActions/)
})

test('normalizeCoherenceAlert は生の /api/coherence/report の hardFails/softSignals からも highlights を補完する', () => {
  const view = coherenceBannerView(
    {
      summary: { hardFailCount: 1, softSignalCount: 2, hotspotCount: 0 },
      hardFails: [{ rule: 'api-parity', message: 'missing /api/demo route' }],
      softSignals: [
        { rule: 'file-bloat', message: 'src/big.js is 900 lines (limit 800)' },
        { rule: 'git-hotspot', message: 'src/hot.js changed 6 times' },
        { rule: 'spec-sprawl', message: '7 active SPEC files' },
      ],
      recommendedSweep: 'contracts',
    },
    null,
  )
  assert.equal(view.show, true)
  assert.deepEqual(view.highlights, [
    'missing /api/demo route',
    'src/big.js is 900 lines (limit 800)',
    'src/hot.js changed 6 times',
  ])
})

test('TasksPane は WAKE_SYNC・REFRESH_REPORTS・fresh 取得で Coherence バナーを再同期する', () => {
  const src = fs.readFileSync(new URL('../src/features/TasksPane.jsx', import.meta.url), 'utf8')
  assert.match(src, /loadCoherence\(board,\s*\{\s*fresh:\s*true\s*\}\)/)
  assert.match(src, /HM_EVENTS\.REFRESH_REPORTS/)
})

/* ------------------------------------------------------------------ *
 * D92 / RG-3: ゴミタスク整理の表示（純関数）
 * ------------------------------------------------------------------ */

const TASKS = [
  { id: 't_1', status: 'running', failures: 0 },
  { id: 't_2', status: 'blocked', failures: 0 },
  { id: 't_3', status: 'failed', failures: 2 },
  { id: 't_4', status: 'done', failures: 0 },
  { id: 't_5', status: 'archived', failures: 0 },
  { id: 't_6', status: 'ready', failures: 1 },
]

test('visibleTasks は既定でアーカイブを隠し、showArchived で戻す（順序は保つ）', () => {
  assert.deepEqual(visibleTasks(TASKS).map((t) => t.id), ['t_1', 't_2', 't_3', 't_4', 't_6'])
  assert.deepEqual(visibleTasks(TASKS, true).map((t) => t.id), TASKS.map((t) => t.id))
  assert.deepEqual(visibleTasks(null), [])
  // 元の配列は書き換えない
  assert.equal(TASKS.length, 6)
})

test('isArchivedTask / archivedTaskCount は status とサーバ件数を見る', () => {
  assert.equal(isArchivedTask({ status: 'archived' }), true)
  assert.equal(isArchivedTask({ status: 'done' }), false)
  assert.equal(isArchivedTask(null), false)
  // サーバの件数（一覧の LIMIT で落ちた分も数えている）を優先する
  assert.equal(archivedTaskCount(TASKS, 12), 12)
  assert.equal(archivedTaskCount(TASKS, 0), 0)
  // 旧ブリッジ（archivedCount 無し）は一覧から数える
  assert.equal(archivedTaskCount(TASKS, null), 1)
})

test('archivableTasks は実行中とアーカイブ済みを選択肢から外す', () => {
  assert.deepEqual(archivableTasks(TASKS).map((t) => t.id), ['t_2', 't_3', 't_4', 't_6'])
})

test('selectableBrokenTasks は失敗・停止のオープンだけを選ぶ（done は既定で外す）', () => {
  assert.deepEqual(selectableBrokenTasks(TASKS), ['t_2', 't_3', 't_6'])
  assert.deepEqual(selectableBrokenTasks(TASKS, { includeDone: true }), ['t_2', 't_3', 't_4', 't_6'])
  // 実行中は failures>0 でも選ばない（止めずにアーカイブはできない）
  assert.deepEqual(selectableBrokenTasks([{ id: 't_9', status: 'running', failures: 3 }]), [])
})

test('bulkArchivePayload は選択可能な ID だけを重複なく上限まで返す', () => {
  assert.deepEqual(bulkArchivePayload(['t_1', 't_2', 't_2', 't_5', 't_3'], TASKS), ['t_2', 't_3'])
  assert.deepEqual(bulkArchivePayload([], TASKS), [])
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `t_b${i}`, status: 'ready' }))
  const picked = bulkArchivePayload(many.map((t) => t.id), many)
  assert.equal(picked.length, 50, 'サーバの上限（50 件）で切る')
})

test('organizeRowView は選択状態と「押せない理由」を返す', () => {
  assert.deepEqual(organizeRowView(TASKS[1], ['t_2']), { archivable: true, selected: true, reason: null })
  assert.deepEqual(organizeRowView(TASKS[1], new Set()), { archivable: true, selected: false, reason: null })
  assert.deepEqual(organizeRowView(TASKS[0], []), { archivable: false, selected: false, reason: 'running' })
  assert.deepEqual(organizeRowView(TASKS[4], []), { archivable: false, selected: false, reason: 'archived' })
})

test('coherenceBannerView: 作業中 (busy:true) はアラートを抑止し、完了後に復帰する（問題④）', () => {
  const alertReport = {
    summary: { hardFailCount: 1, softSignalCount: 3, hotspotCount: 0 },
    recommendedSweep: 'quick-scan',
    highlights: ['stale drift'],
  }
  const duringWork = coherenceBannerView(alertReport, null, { busy: true })
  assert.equal(duringWork.show, false)
  assert.equal(duringWork.alert, true)
  assert.equal(duringWork.suppressedByWork, true)

  const afterWork = coherenceBannerView(alertReport, null, { busy: false })
  assert.equal(afterWork.show, true)
  assert.equal(afterWork.suppressedByWork, false)

  // 非アラート時は suppressedByWork も false
  const clean = coherenceBannerView({ summary: { hardFailCount: 0, softSignalCount: 1, hotspotCount: 0 } }, null, { busy: true })
  assert.equal(clean.show, false)
  assert.equal(clean.suppressedByWork, false)
})

test('TasksPane は workActive 中に Coherence バナー抑止・停止→idle で fresh 再取得を行う', () => {
  const src = fs.readFileSync(new URL('../src/features/TasksPane.jsx', import.meta.url), 'utf8')
  assert.match(src, /coherenceBannerView\([^)]*\{\s*busy:\s*workActive\s*\}/)
  assert.match(src, /workActiveRef\.current/)
  assert.match(src, /prevWorkActiveRef\.current/)
  assert.match(src, /wasActive\s*&&\s*!workActive/)
})
