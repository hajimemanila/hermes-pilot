/**
 * Architect のタスク生成（タイトル / 本文 / カンバン起票引数 / 種プロンプト /
 * 実行方針の正規化）のテスト。811 行だった 1 本を対象モジュール別に
 * 3 分割したうちの 1 本。対象: `apps/bridge/src/architect/task.js`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  ACTIVE_JOB_STATUSES,
  ARCHITECT_PHASES,
  DEFAULT_REVIEW_BOARD,
  DISMISSED_MAX,
  EXECUTION_POLICIES,
  STALLED_AFTER_MS,
  TERMINAL_TASK_STATUSES,
  batchIdPrefixForSlug,
  batchIdPrefixOf,
  buildArchitectTaskBody,
  buildArchitectTaskTitle,
  buildKanbanCreateArgs,
  buildSeedPrompt,
  computePhase,
  createArchitect,
  executionModeLabel,
  filedBatchIds,
  filedBatchIdsForSpec,
  findActiveJobReviewTask,
  findJobReviewTask,
  findJobSpec,
  findRecentSheet,
  isJobStalled,
  normalizeExecutionPolicy,
  pendingSpecs,
  publicJob,
  queueStateOf,
  reviewBoardsFor,
  usedBatchIdPrefixes,
} from '../src/architect.js'
import { createKanban } from '../src/kanban.js'
import { parseCreatedTask } from '../src/specs.js'
import { LANGUAGE_RULE_EN, LANGUAGE_RULE_JA, LANGUAGE_RULE_MARKER } from '../src/language-rule.js'
import {
  SPEC_TEXT,
  makeKanbanBoard,
  makeRepo,
  seedInput,
  settle,
  writeSpec,
} from './helpers/architectFixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')


test('buildArchitectTaskTitle / buildKanbanCreateArgs / findJobReviewTask の境界', () => {
  assert.equal(buildArchitectTaskTitle({ seedText: '\n\n  通知まとめ  \n次の行' }), '[ARCH] 通知まとめ')
  assert.equal(buildArchitectTaskTitle({ seedText: 'x'.repeat(200) }).length, '[ARCH] '.length + 80)
  assert.deepEqual(buildKanbanCreateArgs({ board: 'demo', title: 'T', body: 'B' }), [
    'kanban',
    '--board',
    'demo',
    'create',
    'T',
    '--json',
    '--body',
    'B',
    '--assignee',
    'mobile',
  ])
  assert.match(buildArchitectTaskBody({ prompt: 'P', board: 'demo', repoPath: '/tmp/x', jobId: 'arch-1' }), /Round 2/)
})

test('buildArchitectTaskBody は Round 1 を JSON ファーストにし、既定でブラウザ撮影をさせない', () => {
  const body = buildArchitectTaskBody({ prompt: 'P', board: 'demo', repoPath: '/tmp/x', jobId: 'arch-1' })
  // Round 1 の主成果物は review/sheets/ 配下の JSON シート
  assert.match(body, /Round 1/)
  assert.match(body, /review\/sheets\//)
  assert.match(body, /spec-<slug>-1\.json/)
  assert.match(body, /"mode": "standard"/)
  assert.match(body, /--idempotency-key\s+review:spec-<slug>:round-1/)
  assert.match(body, /mode=standard sheet=sheets\/spec-<slug>-1\.json/)
  // 手書き HTML・ヘッドレスブラウザ撮影は視覚比較が主題のときだけ
  assert.match(body, /bespoke HTML/)
  assert.match(body, /headless browser/)
  assert.match(body, /visual UI layout comparison/)
  // 既存契約は維持される
  assert.match(body, /Round 2/)
  assert.match(body, /Mode: zero-stop/)
  assert.match(body, /Execution Policy: /)
  assert.match(body, /Board: demo/)
  assert.match(body, /Repository: \/tmp\/x/)
  assert.match(body, /### Batch [A-Z]+-<n>: <Title>/)
  // D91: 大文字スラッグ前置 ID と、使用済み接頭辞の注意書きを必ず入れる
  assert.match(body, /Batch ID rule: every batch heading MUST read/)
  assert.match(body, /Batch ID prefixes already used by active SPECs:/)
  // 既定は en（SPEC-i18n-gen §3.1）。ja の見出しは lang='ja' のときだけ（下部の GEN-3 テスト）
  assert.match(body, /\*\*Objective\*\*.*\*\*Files\*\*.*\*\*Verify\*\*/)
})

test('buildSeedPrompt / buildArchitectTaskBody は使用済み接頭辞を渡して ID 衝突を防ぐ（D91）', () => {
  const seed = buildSeedPrompt({
    jobId: 'arch-1',
    seedText: 's',
    board: 'demo',
    repoPath: '/tmp/x',
    suggestedSlug: 'reliability-guard',
    usedBatchPrefixes: ['COH'],
  })
  assert.match(seed, /### Batch RG-<n>: <Title>/)
  assert.match(seed, /Batch ID rule: every batch heading MUST read/)
  assert.match(seed, /Batch ID prefixes already used by active SPECs: COH/)

  const body = buildArchitectTaskBody({
    prompt: 'P',
    board: 'demo',
    repoPath: '/tmp/x',
    jobId: 'arch-1',
    suggestedSlug: 'coherence',
    usedBatchPrefixes: [],
  })
  assert.match(body, /### Batch COH-<n>: <Title>/)
  assert.match(body, /none \(the COH prefix above is free\)/)
  // `specs.BATCH_ID_RE` の 16 文字制限に収まる長さに保つ
  assert.ok(batchIdPrefixForSlug('reliability-guard').length <= 4)
})

test('executionPolicy は zero-stop 既定で正規化され、プロンプトと公開ジョブに載る（§3.1③）', async () => {
  assert.deepEqual(EXECUTION_POLICIES, ['zero-stop', 'visual-gate'])
  assert.equal(normalizeExecutionPolicy(undefined), 'zero-stop')
  assert.equal(normalizeExecutionPolicy('VISUAL-GATE'), 'visual-gate')
  assert.equal(normalizeExecutionPolicy('visual_gate'), 'visual-gate')
  assert.equal(normalizeExecutionPolicy('nope'), 'zero-stop')
  assert.equal(executionModeLabel('visual-gate'), '[Mode: Visual Gate]')
  assert.equal(executionModeLabel(undefined), '[Mode: Zero-Stop]')

  const base = { jobId: 'arch-1', seedText: '通知をまとめる', board: 'demo', repoPath: '/tmp/x' }
  const zero = buildSeedPrompt(base)
  assert.match(zero, /Round 1 Quick Review interview is mandatory under both policies/)
  assert.match(zero, /Execution policy chosen by the user: `zero-stop`/)
  assert.match(zero, /\[Mode: Zero-Stop\]/)

  const gate = buildSeedPrompt({ ...base, executionPolicy: 'visual-gate' })
  assert.match(gate, /Round 1 Quick Review interview is mandatory under both policies/, '両方針ともインタビューは維持')
  assert.match(gate, /Execution policy chosen by the user: `visual-gate`/)
  assert.match(gate, /\[Mode: Visual Gate\]/)
  assert.doesNotMatch(gate, /\[Mode: Zero-Stop\]/, 'バッチ既定は Visual Gate に切り替わる')

  // [ARCH] タスク本文（カンバン起票）にも方針が載る
  const bodyArgs = { prompt: 'P', board: 'demo', repoPath: '/tmp/x', jobId: 'arch-1' }
  assert.match(buildArchitectTaskBody(bodyArgs), /Execution Policy: zero-stop/)
  assert.match(buildArchitectTaskBody({ ...bodyArgs, executionPolicy: 'visual-gate' }), /\[Mode: Visual Gate\]/)

  // seed → ランナー → 公開ジョブまで通しで保持される
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    {},
    {
      now: () => 1_700_000_000_000,
      readTasks: () => [],
      runner: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '{"id":"t_arch"}', stderr: '' }
      },
    },
  )
  const seeded = await arch.seed(seedInput(repo, { executionPolicy: 'visual-gate' }))
  assert.equal(seeded.executionPolicy, 'visual-gate')
  await settle()
  assert.equal(calls[0].executionPolicy, 'visual-gate', 'ランナーへ渡る')
  assert.match(String(calls[0].prompt), /\[Mode: Visual Gate\]/)
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.executionPolicy, 'visual-gate')
  assert.equal(job.id, seeded.jobId)

  // 未指定は既定（zero-stop）に正規化される
  const plain = await arch.seed(seedInput(repo, { executionPolicy: 'bogus' }))
  assert.equal(plain.executionPolicy, 'zero-stop')
  assert.equal(publicJob({ id: 'x', board: 'demo', status: 'running' }).executionPolicy, 'zero-stop')
})

// ── 出力言語の規則（SPEC-i18n-gen §3.4 / Batch GEN-3） ──────────────────────

test('buildSeedPrompt は lang に合った言語規則を差し込み、Round 2 の見出しを切り替える', () => {
  const base = { jobId: 'arch-1', seedText: '通知をまとめる', board: 'demo', repoPath: '/tmp/x' }

  const en = buildSeedPrompt({ ...base, lang: 'en' })
  assert.ok(en.includes(LANGUAGE_RULE_MARKER), 'en の seed プロンプトに marker が無い（「その言語で書け」が抜けている）')
  assert.ok(en.includes(LANGUAGE_RULE_EN), 'en は EN 規則の全文を持つ')
  assert.match(en, /UI language: en/)
  assert.match(en, /- \*\*Objective\*\*: one paragraph of intent/)
  assert.doesNotMatch(en, /\*\*目的\*\*/, 'en に ja の見出しが残っている')

  const ja = buildSeedPrompt({ ...base, lang: 'ja' })
  assert.ok(ja.includes(LANGUAGE_RULE_JA), 'ja の seed プロンプトに JA 規則文が無い')
  assert.match(ja, /UI language: ja/)
  assert.match(ja, /- \*\*目的\*\*: /)
  // JA 規則文は機械トークンの一覧（**Objective** 等）を保つので、見出し行だけで判定する
  assert.doesNotMatch(ja, /- \*\*Objective\*\*: one paragraph/, 'ja に en の見出しが混ざっている')

  // 未指定は既定 en（ja へは戻さない・§3.1）
  const fallback = buildSeedPrompt(base)
  assert.ok(fallback.includes(LANGUAGE_RULE_EN))
  assert.doesNotMatch(fallback, /\*\*目的\*\*/)
})

test('[ARCH] タスク本文も lang で Round 2 の見出しを切り替える', () => {
  const base = { prompt: 'P', board: 'demo', repoPath: '/tmp/x', jobId: 'arch-1' }
  assert.match(
    buildArchitectTaskBody({ ...base, lang: 'en' }),
    /\*\*Execution Mode\*\* \/ \*\*Objective\*\* \/ \*\*Files\*\* \/ \*\*Verify\*\*/,
  )
  assert.match(
    buildArchitectTaskBody({ ...base, lang: 'ja' }),
    /\*\*目的\*\* \/ \*\*変更・新規ファイル\*\* \/ \*\*受入条件（Verify）\*\*/,
  )
})
