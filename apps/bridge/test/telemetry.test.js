import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TYPED_CHARS_PER_ACTION,
  buildReceipt,
  cacheHitRate,
  createTelemetry,
  estimateSavedUsd,
  extractTestCounts,
  mergeIntervals,
  pickSpecRun,
  sameSpec,
  selectSpecTasks,
  summarizeAudit,
  summarizeTasks,
  usageKpis,
  zeroTypingScore,
} from '../src/telemetry.js'

/** audit.jsonl の 1 行（`at` は ISO）。 */
const auditRow = (iso, kind, extra = {}) => ({ at: iso, kind, ...extra })

test('cacheHitRate は cacheRead / (input + cacheRead)、0 割りは null', () => {
  assert.equal(cacheHitRate({ input: 1000, cacheRead: 9000 }), 0.9)
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0 }), null)
  assert.equal(cacheHitRate(null), null)
  assert.equal(cacheHitRate({ input: 500 }), 0, '入力だけなら 0%（null と区別する）')
})

test('estimateSavedUsd は実コスト×キャッシュ率×割引率で保守的に見積もる', () => {
  // cost 1 × cache 率 0.9 × 割引 0.9 = 0.81（実コストは超えない）
  assert.equal(estimateSavedUsd({ cost: 1, input: 100, cacheRead: 900 }), 0.81)
  assert.equal(estimateSavedUsd({ cost: 1, input: 100, cacheRead: 900 }, { ratio: 0.5 }), 0.45)
  assert.equal(estimateSavedUsd({ cost: 2, input: 0, cacheRead: 1000 }), 1.8)
  assert.equal(estimateSavedUsd({ cost: 1, input: 1000, cacheRead: 0 }), null, 'キャッシュ無しは節約 0 ではなく null')
  assert.equal(estimateSavedUsd({ cost: 0, input: 1, cacheRead: 9 }), null)
  assert.equal(estimateSavedUsd(null), null)
})

test('zeroTypingScore は入力 40 文字をタップ 1 回と換算する', () => {
  assert.equal(zeroTypingScore({ humanTaps: 20, redlines: 2, typedChars: 0 }), 100)
  assert.equal(zeroTypingScore({ humanTaps: 1, redlines: 0, typedChars: 0 }), 100)
  // タップ 20 + 赤入れ 0 / 入力 40 文字（=1 アクション）→ 20/21 = 95%
  assert.equal(zeroTypingScore({ humanTaps: 20, typedChars: TYPED_CHARS_PER_ACTION }), 95)
  // 入力だけ → 0%（ゼロタイピングではない）
  assert.equal(zeroTypingScore({ humanTaps: 0, typedChars: 80 }), 0)
  assert.equal(zeroTypingScore({}), null, '操作が 1 つも無ければ「度合い」は出さない')
})

test('summarizeAudit はタップ・赤入れ・入力文字数を数える', () => {
  const lines = [
    JSON.stringify(auditRow('2026-11-15T00:00:00+08:00', 'review.answer', { choiceCount: 3, ok: true })),
    JSON.stringify(auditRow('2026-11-15T00:01:00+08:00', 'review.approve', { ok: true })),
    JSON.stringify(auditRow('2026-11-15T00:02:00+08:00', 'review.annotation', { marks: 2, ok: true })),
    JSON.stringify(auditRow('2026-11-15T00:03:00+08:00', 'kanban.comment', { chars: 42 })),
    JSON.stringify(auditRow('2026-11-15T00:04:00+08:00', 'kanban.create', {})),
    JSON.stringify(auditRow('2026-11-15T00:05:00+08:00', 'repos.scan', {})),
    '{壊れた行',
    '',
  ]
  const ops = summarizeAudit(lines)
  assert.equal(ops.humanTaps, 5, '回答 3 + 検収 1 + 赤入れ 1')
  assert.equal(ops.redlines, 1)
  assert.equal(ops.typedChars, 42)
  assert.equal(ops.entries, 6, '壊れた行・空行は数えない')
})

test('summarizeAudit は窓（since）より古い行を落とす', () => {
  const ops = summarizeAudit(
    [
      auditRow('2026-11-13T00:00:00+08:00', 'review.answer', { choiceCount: 2 }),
      auditRow('2026-11-15T00:00:00+08:00', 'review.answer', { choiceCount: 1 }),
    ],
    { since: Date.parse('2026-11-14T00:00:00+08:00') },
  )
  assert.equal(ops.humanTaps, 1)
  assert.equal(ops.entries, 1)
})

test('sameSpec は相対/絶対パスを同一視し、空の要求は全一致', () => {
  assert.equal(sameSpec('docs/SPEC-PILOT-V5.md', 'docs/SPEC-PILOT-V5.md'), true)
  assert.equal(sameSpec('/Users/me/repo/docs/SPEC-PILOT-V5.md', 'docs/SPEC-PILOT-V5.md'), true)
  assert.equal(sameSpec('./docs/SPEC-PILOT-V5.md', 'docs/SPEC-PILOT-V5.md'), true)
  assert.equal(sameSpec('docs/SPEC-PILOT-V4.md', 'docs/SPEC-PILOT-V5.md'), false)
  assert.equal(sameSpec(null, ''), true)
  assert.equal(sameSpec(null, 'docs/X.md'), false)
})

test('summarizeTasks は done 件数と、重複区間をマージした実稼働時間を返す', () => {
  const t0 = Date.parse('2026-11-15T00:00:00Z')
  const s = summarizeTasks([
    { status: 'done', startedAt: t0, completedAt: t0 + 30 * 60000 },
    { status: 'done', startedAt: t0 + 5 * 60000, completedAt: t0 + 90 * 60000 },
    { status: 'running', startedAt: t0 + 10 * 60000 },
  ])
  assert.equal(s.batchesDone, 2)
  assert.equal(s.batchesTotal, 3)
  assert.equal(s.durationMin, 90, '並列の重なりは 1 本にマージ（30+85 ではなく 90）')
  assert.equal(s.wallDurationMin, 90, '経過時間は min(start)〜max(end)')
  assert.equal(s.intervalCount, 1)

  // 実行中タスクは now を渡したときだけ now で閉じる（渡さないと際限なく伸びる）
  assert.equal(summarizeTasks([{ status: 'running', startedAt: t0 }]).durationMin, null)
  assert.equal(summarizeTasks([{ status: 'running', startedAt: t0 }], { now: t0 + 20 * 60000 }).durationMin, 20)

  // 離れた区間は 2 本のまま合算する
  const split = summarizeTasks(
    [
      { status: 'done', startedAt: t0, completedAt: t0 + 10 * 60000 },
      { status: 'done', startedAt: t0 + 60 * 60000, completedAt: t0 + 80 * 60000 },
    ],
    { now: t0 + 80 * 60000 },
  )
  assert.equal(split.durationMin, 30, '10 + 20')
  assert.equal(split.wallDurationMin, 80)
  assert.equal(split.intervalCount, 2)

  const empty = summarizeTasks(null)
  assert.equal(empty.batchesDone, 0)
  assert.equal(empty.batchesTotal, 0)
  assert.equal(empty.durationMin, null)
  assert.equal(empty.wallDurationMin, null)
  assert.equal(empty.durationCapped, false)
  assert.equal(empty.scoped, false)

  // 窓より前に始まったタスクは窓の開始へ切り上げる（33,000 分のような数字を出さない）
  const bounded = summarizeTasks(
    [
      { status: 'done', startedAt: t0 - 3 * 86400000, completedAt: t0 + 60 * 60000 },
      { status: 'archived', startedAt: t0 - 5 * 86400000, completedAt: t0 - 4 * 86400000 },
    ],
    { since: t0 },
  )
  assert.equal(bounded.durationMin, 60, '窓内の完了分だけを見る')
  assert.equal(bounded.durationCapped, true, '窓より前に始まった作業を含む＝24h 以上と出す')
  assert.equal(s.durationCapped, false)
  assert.equal(bounded.batchesDone, 1, 'done のみ数える（archived は含めない）')

  // カンバン DB の秒（snake_case）も受ける
  const secs = summarizeTasks([{ status: 'done', started_at: t0 / 1000, completed_at: t0 / 1000 + 600 }])
  assert.equal(secs.durationMin, 10)
})

test('mergeIntervals は重なり・接する区間をマージし、不正な区間は捨てる', () => {
  assert.deepEqual(
    mergeIntervals([
      [0, 60000],
      [30000, 90000],
      [600000, 660000],
    ]),
    [
      [0, 90000],
      [600000, 660000],
    ],
  )
  assert.deepEqual(
    mergeIntervals([
      [5000, 5000],
      [6000, 3000],
      null,
    ]),
    [],
    'ゼロ幅・負区間は無効',
  )
  assert.deepEqual(mergeIntervals(null), [])
})

test('selectSpecTasks は Spec / Run に無関係なタスクを落とし、0 件なら補完しない', () => {
  const tasks = [
    { id: 'a', title: '[V7-2] x', spec: 'docs/SPEC-PILOT-V7.md' },
    { id: 'b', title: '[V6-1] y' },
    { id: 'c', title: '別件のタスク' },
  ]
  assert.equal(selectSpecTasks(tasks, {}).tasks.length, 3, 'スコープ未指定ならボード全体')
  assert.deepEqual(
    selectSpecTasks(tasks, { spec: 'docs/SPEC-PILOT-V7.md' }).tasks.map((t) => t.id),
    ['a'],
  )
  assert.deepEqual(
    selectSpecTasks(tasks, { spec: '/Users/me/repo/docs/SPEC-PILOT-V7.md' }).tasks.map((t) => t.id),
    ['a'],
    '絶対パスでも同一視する',
  )
  assert.deepEqual(selectSpecTasks(tasks, { taskIds: ['b'] }).tasks.map((t) => t.id), ['b'])
  assert.deepEqual(selectSpecTasks(tasks, { batchIds: ['V6-1'] }).tasks.map((t) => t.id), ['b'])
  assert.equal(
    selectSpecTasks(tasks, { spec: 'docs/SPEC-PILOT-NONE.md' }).tasks.length,
    0,
    '該当 0 件なら別タスクで補完しない',
  )
})

test('pickSpecRun は spec 一致 → taskIds 一致の順で最新ランを選ぶ', () => {
  const runs = [
    { id: 'r1', board: 'mobile', specRelPath: 'docs/SPEC-PILOT-V6.md', taskIds: ['a'], createdAt: 1 },
    { id: 'r2', board: 'mobile', specRelPath: 'docs/SPEC-PILOT-V7.md', taskIds: ['b'], createdAt: 2 },
    { id: 'r3', board: 'mobile', specRelPath: 'docs/SPEC-PILOT-V7.md', taskIds: ['c'], createdAt: 3 },
  ]
  assert.equal(pickSpecRun(runs, { spec: 'docs/SPEC-PILOT-V7.md' }).id, 'r3', '最新優先')
  assert.equal(pickSpecRun(runs, { tasks: [{ id: 'a' }] }).id, 'r1', 'spec が無ければ taskIds 一致')
  assert.equal(pickSpecRun(runs, { spec: 'docs/SPEC-PILOT-V5.md' }), null)
  assert.equal(pickSpecRun([], { spec: 'x' }), null)
})

test('usageKpis は合計トークンを input+output+cacheRead+cacheWrite で出す', () => {
  assert.deepEqual(usageKpis(null), { apiCalls: null, totalTokens: null, sessions: null })
  assert.deepEqual(usageKpis({ ok: false }), { apiCalls: null, totalTokens: null, sessions: null })
  assert.deepEqual(
    usageKpis({ ok: true, totals: { calls: 12, input: 1000, output: 200, cacheRead: 9000, cacheWrite: 5, sessions: 3 } }),
    { apiCalls: 12, totalTokens: 10205, sessions: 3 },
  )
  assert.deepEqual(usageKpis({ ok: true, apiCalls: 4, totalTokens: 99, totals: { sessions: 1 } }), {
    apiCalls: 4,
    totalTokens: 99,
    sessions: 1,
  })
})

test('extractTestCounts は result / Markdown からテスト件数を拾う', () => {
  assert.deepEqual(extractTestCounts(['npm test -> 402 tests passed']), { tests: 402, pwaChecks: null })
  assert.equal(extractTestCounts(['テスト 128 件合格']).tests, 128)
  assert.equal(extractTestCounts(['tests: 37']).tests, 37)
  assert.equal(extractTestCounts(['check:pwa 0 violations → PWA checks 12']).pwaChecks, 12)
  assert.deepEqual(extractTestCounts([]), { tests: null, pwaChecks: null })
  assert.deepEqual(extractTestCounts([null, undefined]), { tests: null, pwaChecks: null })
})

test('buildReceipt は KPI を組み立て、空データでも優雅に 0/null を返す', () => {
  const t0 = Date.parse('2026-11-15T12:00:00Z')
  const r = buildReceipt({
    board: 'mobile',
    spec: 'docs/SPEC-PILOT-V5.md',
    label: 'V5 batch',
    generatedAt: t0,
    hours: 24,
    taskIds: ['t1'],
    batchIds: ['V5-2'],
    usage: { totals: { input: 1000, output: 500, cacheRead: 9000, cost: 1.08, tools: 120, sessions: 4 }, models: [] },
    usageScope: {
      ok: true,
      apiCalls: 42,
      totalTokens: 1234567,
      totals: { sessions: 2, input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, calls: 42 },
      scope: { sessionIds: 2, sinceMs: null, untilMs: null, fallback: false },
    },
    report: { status: 'done', markdown: '402 tests passed', counts: { done: 5, total: 5 } },
    tasks: [
      { id: 't1', status: 'done', startedAt: Date.parse('2026-11-15T10:00:00Z'), completedAt: Date.parse('2026-11-15T11:02:00Z') },
      // 対象 Run ではないタスク（以前はこれで 14 時間と出ていた）
      { id: 'zzz', status: 'done', startedAt: Date.parse('2026-11-14T20:00:00Z'), completedAt: Date.parse('2026-11-14T23:00:00Z') },
    ],
    ops: { humanTaps: 34, redlines: 2, typedChars: 0 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.kpi.costUsd, 1.08)
  assert.equal(r.kpi.cachePct, 90)
  assert.equal(r.kpi.savedUsd, 0.8748, 'cost 1.08 × cache 率 0.9 × 割引 0.9（実コストを超えない概算）')
  assert.equal(r.kpi.zeroTypingScore, 100)
  assert.equal(r.kpi.batchesDone, 5, 'レポート counts を優先する')
  assert.equal(r.kpi.batchesTotal, 5)
  assert.equal(r.kpi.tests, 402)
  assert.equal(r.kpi.durationMin, 62, '対象 Run のタスクだけ（他タスクの区間を混ぜない）')
  assert.equal(r.kpi.activeDurationMin, 62)
  assert.equal(r.kpi.wallDurationMin, 62)
  assert.equal(r.kpi.apiCalls, 42, 'スコープ集計の API コール数')
  assert.equal(r.kpi.totalTokens, 1234567, 'スコープ集計の合計トークン')
  assert.equal(r.scope.scoped, true)
  assert.deepEqual(r.scope.taskIds, ['t1'])
  assert.deepEqual(r.scope.batchIds, ['V5-2'])
  assert.equal(r.scope.usageScoped, true)
  assert.equal(r.generatedAt, t0)

  const empty = buildReceipt({ generatedAt: 1, missing: ['usage', 'audit'] })
  assert.equal(empty.ok, true, '空データでも 200 で返す')
  assert.equal(empty.kpi.costUsd, null)
  assert.equal(empty.kpi.cachePct, null)
  assert.equal(empty.kpi.zeroTypingScore, null)
  assert.equal(empty.kpi.batchesDone, 0)
  assert.equal(empty.kpi.apiCalls, null, 'usage が読めなければ 0 ではなく null（—）')
  assert.equal(empty.kpi.totalTokens, null)
  assert.equal(empty.kpi.durationMin, null)
  assert.deepEqual(empty.missing, ['usage', 'audit'])
})

test('createTelemetry は Spec / Run スコープの実稼働時間と API コール・トークンを返す', () => {
  const now = Date.parse('2026-11-15T12:00:00Z')
  const s0 = Date.parse('2026-11-15T10:00:00Z')
  const seen = []
  const t = createTelemetry(
    { reviewDir: '/nonexistent/review', auditPath: '/nonexistent/audit.jsonl' },
    {
      now: () => now,
      runs: () => [
        {
          id: 'run_1',
          board: 'mobile',
          specRelPath: 'docs/SPEC-PILOT-V7.md',
          taskIds: ['a', 'b'],
          batchIds: ['V7-1', 'V7-2'],
          createdAt: 1,
        },
      ],
      usage: {
        summary: () => ({ ok: true, totals: { input: 10, cacheRead: 90, cost: 0.5, calls: 99, sessions: 1 } }),
        scoped: (o) => {
          seen.push(o)
          return {
            ok: true,
            apiCalls: 7,
            totalTokens: 1234,
            totals: { sessions: o.sessionIds.length, input: 1000, output: 200, cacheRead: 34, cacheWrite: 0, calls: 7 },
            scope: { sessionIds: o.sessionIds.length, sinceMs: o.sinceMs, untilMs: o.untilMs, fallback: !o.sessionIds.length },
          }
        },
      },
      reports: () => [],
      tasks: () => [
        { id: 'a', status: 'done', startedAt: s0, completedAt: s0 + 40 * 60000, sessionId: 's1' },
        { id: 'b', status: 'done', startedAt: s0 + 20 * 60000, completedAt: s0 + 60 * 60000, sessionId: 's2' },
        // 同じボードの無関係なタスク（マージ前はこれで時間が膨らんでいた）
        { id: 'zzz', status: 'done', startedAt: s0 - 10 * 3600000, completedAt: s0 - 5 * 3600000, sessionId: 's9' },
      ],
    },
  )
  const r = t.receipt({ board: 'mobile', spec: 'docs/SPEC-PILOT-V7.md' })
  assert.equal(r.kpi.durationMin, 60, '40 + 40 ではなくマージした 60 分')
  assert.equal(r.kpi.wallDurationMin, 60)
  assert.equal(r.kpi.batchesDone, 2, '無関係なボードタスクを数えない')
  assert.equal(r.kpi.batchesTotal, 2)
  assert.equal(r.kpi.apiCalls, 7)
  assert.equal(r.kpi.totalTokens, 1234)
  assert.deepEqual(seen[0].sessionIds, ['s1', 's2'], '対象タスクのセッション群だけを渡す')
  assert.equal(r.scope.usageScoped, true)

  // Spec 未指定（ボード全体）はランに寄せず、ボード全体を集計する
  seen.length = 0
  const boardWide = t.receipt({ board: 'mobile' })
  assert.equal(boardWide.scope.scoped, false, 'ボード全体は絞り込まない')
  assert.equal(boardWide.scope.taskIds.length, 0)
  assert.equal(boardWide.kpi.batchesTotal, 3, '同じボードのタスクは全部数える')
  assert.equal(boardWide.kpi.durationMin, 60 + 300, '10h→5h と 10h→11h の 2 区間（マージ前の総和）')
})

test('createTelemetry はスコープ集計が失敗しても 500 にせず missing に積む', () => {
  const t = createTelemetry(
    { reviewDir: '/nonexistent/review', auditPath: '/nonexistent/audit.jsonl' },
    {
      now: () => Date.parse('2026-11-15T12:00:00Z'),
      runs: () => [],
      usage: {
        summary: () => ({ ok: true, totals: { input: 1, cacheRead: 1, cost: 0.1, calls: 5, sessions: 1 } }),
        scoped: () => ({ ok: false, reason: 'state.db が見つかりません' }),
      },
      reports: () => [],
      tasks: () => [],
    },
  )
  const r = t.receipt({ board: 'mobile', spec: 'docs/SPEC-PILOT-V7.md' })
  assert.equal(r.ok, true)
  assert.ok(r.missing.includes('usageScope'))
  assert.equal(r.kpi.apiCalls, 5, 'スコープが取れないときは窓合算へフォールバック')
  assert.equal(r.kpi.totalTokens, 2)
  assert.equal(r.kpi.durationMin, null, '該当タスク 0 件なら別タスクで補完しない')
})

test('createTelemetry は欠損ファイルでも落ちず、missing に理由を積む', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-telemetry-'))
  const t = createTelemetry(
    { reviewDir: path.join(dir, 'review'), auditPath: path.join(dir, 'audit.jsonl') },
    {
      now: () => Date.parse('2026-11-15T12:00:00Z'),
      usage: { summary: () => ({ ok: false, reason: 'state.db が見つかりません' }) },
      reports: () => [],
      tasks: () => {
        throw new Error('db locked')
      },
    },
  )
  const r = t.receipt({ board: 'mobile', spec: 'docs/SPEC-PILOT-V5.md' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing.sort(), ['audit', 'report', 'tasks', 'usage'])
  assert.equal(r.kpi.costUsd, null)
})

test('createTelemetry は実ファイル（audit.jsonl）からタップ数を拾う', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-telemetry-'))
  const audit = path.join(dir, 'audit.jsonl')
  const now = Date.parse('2026-11-15T12:00:00Z')
  fs.writeFileSync(
    audit,
    [
      JSON.stringify({ at: new Date(now - 3600_000).toISOString(), kind: 'review.answer', choiceCount: 2, ok: true }),
      JSON.stringify({ at: new Date(now - 7200_000).toISOString(), kind: 'review.annotation', marks: 1, ok: true }),
      JSON.stringify({ at: new Date(now - 40 * 3600_000).toISOString(), kind: 'review.answer', choiceCount: 9, ok: true }),
    ].join('\n') + '\n',
  )
  const t = createTelemetry(
    { reviewDir: dir, auditPath: audit },
    {
      now: () => now,
      usage: { summary: () => ({ ok: true, totals: { input: 10, cacheRead: 90, cost: 0.5 }, cacheHitRate: 0.9 }) },
      reports: () => [
        { spec: 'docs/SPEC-PILOT-V5.md', status: 'done', label: 'V5', markdown: '128 tests green', counts: { done: 6, total: 6 } },
        { spec: 'docs/SPEC-PILOT-V4.md', status: 'done', label: 'V4', markdown: '1 tests' },
      ],
      tasks: () => [],
    },
  )
  const r = t.receipt({ board: 'mobile', spec: 'docs/SPEC-PILOT-V5.md' })
  assert.equal(r.label, 'V5', 'spec が一致するレポートを選ぶ')
  assert.equal(r.kpi.humanTaps, 3, '24h 窓内の 2 + 1 のみ（40h 前は落とす）')
  assert.equal(r.kpi.redlines, 1)
  assert.equal(r.kpi.tests, 128)
  assert.equal(r.missing.includes('audit'), false)
  assert.equal(r.missing.includes('usage'), false)
})
