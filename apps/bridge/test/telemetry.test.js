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
  sameSpec,
  summarizeAudit,
  summarizeTasks,
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

test('estimateSavedUsd は保守的単価で丸め、キャッシュ読みが無ければ null', () => {
  assert.equal(estimateSavedUsd({ cacheRead: 1_000_000 }), 0.2)
  assert.equal(estimateSavedUsd({ cacheRead: 2_500_000 }), 0.5)
  assert.equal(estimateSavedUsd({ cacheRead: 0 }), null)
  assert.equal(estimateSavedUsd(null), null)
  assert.equal(estimateSavedUsd({ cacheRead: 1_000_000 }, { usdPerMTok: 1 }), 1)
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

test('summarizeTasks は done 件数と所要時間（分）を出す', () => {
  const t0 = Date.parse('2026-11-15T00:00:00Z')
  const s = summarizeTasks([
    { status: 'done', startedAt: t0, completedAt: t0 + 30 * 60000 },
    { status: 'done', startedAt: t0 + 5 * 60000, completedAt: t0 + 90 * 60000 },
    { status: 'running', startedAt: t0 + 10 * 60000 },
  ])
  assert.equal(s.batchesDone, 2)
  assert.equal(s.batchesTotal, 3)
  assert.equal(s.durationMin, 90, '最短開始〜最遅完了')
  assert.deepEqual(summarizeTasks(null), { batchesDone: 0, batchesTotal: 0, durationMin: null })
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
  const r = buildReceipt({
    board: 'mobile',
    spec: 'docs/SPEC-PILOT-V5.md',
    label: 'V5 batch',
    generatedAt: Date.parse('2026-11-15T12:00:00Z'),
    hours: 24,
    usage: { totals: { input: 1000, output: 500, cacheRead: 9000, cost: 1.08, tools: 120, sessions: 4 }, models: [] },
    report: { status: 'done', markdown: '402 tests passed', counts: { done: 5, total: 5 } },
    tasks: [
      { status: 'done', startedAt: Date.parse('2026-11-15T10:00:00Z'), completedAt: Date.parse('2026-11-15T11:02:00Z') },
    ],
    ops: { humanTaps: 34, redlines: 2, typedChars: 0 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.kpi.costUsd, 1.08)
  assert.equal(r.kpi.cachePct, 90)
  assert.equal(r.kpi.savedUsd, 0.0018, '9000 トークン × $0.20/M（保守的概算）')
  assert.equal(r.kpi.zeroTypingScore, 100)
  assert.equal(r.kpi.batchesDone, 5, 'レポート counts を優先する')
  assert.equal(r.kpi.batchesTotal, 5)
  assert.equal(r.kpi.tests, 402)
  assert.equal(r.kpi.durationMin, 62)
  assert.equal(r.generatedAt, Date.parse('2026-11-15T12:00:00Z'))

  const empty = buildReceipt({ generatedAt: 1, missing: ['usage', 'audit'] })
  assert.equal(empty.ok, true, '空データでも 200 で返す')
  assert.equal(empty.kpi.costUsd, null)
  assert.equal(empty.kpi.cachePct, null)
  assert.equal(empty.kpi.zeroTypingScore, null)
  assert.equal(empty.kpi.batchesDone, 0)
  assert.deepEqual(empty.missing, ['usage', 'audit'])
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
