/**
 * Architect のバッチ ID（接頭辞 / 起票済み判定 / 未起票 SPEC / キュー状態 /
 * Review ボード候補）と `spec-architect` SKILL.md の文言検査。811 行だった 1 本を
 * 対象モジュール別に 3 分割したうちの 1 本。対象: `apps/bridge/src/architect/batch.js`。
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


test('batchIdPrefixForSlug / batchIdPrefixOf / usedBatchIdPrefixes は大文字スラッグ接頭辞を揃える（D91）', () => {
  assert.equal(batchIdPrefixForSlug('reliability-guard'), 'RG')
  assert.equal(batchIdPrefixForSlug('coherence'), 'COH')
  assert.equal(batchIdPrefixForSlug('v5'), 'V5')
  assert.equal(batchIdPrefixForSlug(''), 'B')
  assert.equal(batchIdPrefixOf('RG-1'), 'RG')
  assert.equal(batchIdPrefixOf('C1'), 'C')
  assert.equal(batchIdPrefixOf(''), '')

  const specs = [
    { path: 'docs/SPEC-RELIABILITY-GUARD.md', archived: false, batches: [{ id: 'RG-1' }, { id: 'RG-2' }] },
    { path: 'docs/SPEC-COHERENCE.md', archived: false, batches: [{ id: 'COH-1' }] },
    { path: 'docs/SPEC-OLD.md', archived: true, batches: [{ id: 'ZZ-1' }] },
  ]
  // 退避済み SPEC の接頭辞は数えない（再び使える）
  assert.deepEqual(usedBatchIdPrefixes(specs), ['COH', 'RG'])
})

test('filedBatchIdsForSpec は archived を未起票に戻し、無印タスクに時刻ガードを掛ける（D91/D92）', () => {
  const specMtime = 1_700_000_000_000
  const tasks = [
    { id: 't1', title: '[RG-1] done', status: 'done', spec: 'docs/SPEC-RG.md' },
    { id: 't2', title: '[RG-2] archived', status: 'archived', spec: 'docs/SPEC-RG.md' },
    { id: 't3', title: '[RG-3] legacy old', status: 'running', createdAt: specMtime - 600_000 },
    { id: 't4', title: '[RG-4] legacy fresh', status: 'running', createdAt: specMtime - 1000 },
    { id: 't5', title: '[RG-5] other spec', status: 'running', spec: 'docs/SPEC-OTHER.md' },
  ]
  assert.deepEqual([...filedBatchIdsForSpec(tasks, 'docs/SPEC-RG.md', { specMtime })].sort(), ['RG-1', 'RG-4'])
  // specMtime を渡さなければ無印は従来どおり（後方互換）
  assert.deepEqual([...filedBatchIdsForSpec(tasks, 'docs/SPEC-RG.md')].sort(), ['RG-1', 'RG-3', 'RG-4'])
  // 未スコープは archived だけを除外する
  assert.deepEqual([...filedBatchIds(tasks)].sort(), ['RG-1', 'RG-3', 'RG-4', 'RG-5'])
  // archived バッチは未起票に戻る＝再起票できる
  const pending = pendingSpecs(
    [{ path: 'docs/SPEC-RG.md', mtime: specMtime, batches: [{ id: 'RG-1' }, { id: 'RG-2' }] }],
    tasks,
  )
  assert.deepEqual(pending[0].pending, ['RG-2'])
})

test('queueStateOf は ready と実行中を分ける（純関数）', () => {
  assert.equal(queueStateOf('ready'), 'queued')
  assert.equal(queueStateOf('todo'), 'queued')
  assert.equal(queueStateOf('running'), 'running')
  assert.equal(queueStateOf('claimed'), 'running')
  assert.equal(queueStateOf('done'), null)
  assert.equal(queueStateOf(undefined), null)
})


// ---------------------------------------------------------------------------
// SPEC V9 D41 / D42 — Agy Opt-in の重複起票防止とボード横断 Review・フェーズ検知
// ---------------------------------------------------------------------------

test('reviewBoardsFor は [job.board, mobile] を重複除去して返す（D42）', () => {
  assert.equal(DEFAULT_REVIEW_BOARD, 'mobile')
  assert.deepEqual(reviewBoardsFor('hermes-pilot'), ['hermes-pilot', 'mobile'])
  assert.deepEqual(reviewBoardsFor('mobile'), ['mobile'], '重複させない')
  assert.deepEqual(reviewBoardsFor('  demo  '), ['demo', 'mobile'])
  assert.deepEqual(reviewBoardsFor(''), ['mobile'])
  assert.deepEqual(reviewBoardsFor(undefined), ['mobile'])
  assert.deepEqual(ACTIVE_JOB_STATUSES, ['running', 'awaiting_spec', 'awaiting_review', 'failed'])
})

test('pendingSpecs は archived: true の過去 SPEC を mtime が新しくても未起票通知に出さない', () => {
  const specs = [
    {
      path: 'docs/SPEC-PILOT-V9.md',
      title: 'Pilot V9',
      mtime: 50_000,
      archived: true,
      batches: [{ id: 'D42' }],
    },
    {
      path: 'docs/SPEC-ACTIVE.md',
      title: 'Active Spec',
      mtime: 40_000,
      archived: false,
      batches: [{ id: 'ACT-1' }],
    },
  ]
  const tasks = [{ id: 't_old', title: '[D42] Old legacy task', status: 'done', createdAt: 10_000 }]
  const out = pendingSpecs(specs, tasks)
  assert.deepEqual(
    out.map((s) => s.path),
    ['docs/SPEC-ACTIVE.md'],
  )
})

test('spec-architect SKILL.md はモバイル可読性・冪等キー・Round 2 自己点検を含む', () => {
  const skill = fs.readFileSync(path.resolve(import.meta.dirname, '../../../skills/spec-architect/SKILL.md'), 'utf8')
  assert.match(skill, /--idempotency-key\s+"?review:spec-<slug>:round-1"?/)
  assert.match(skill, /Round 2 self-check/)
  assert.match(skill, /Guard scope/)
  assert.match(skill, /Line-count baselines/)
  assert.match(skill, /mobile readability/)
  assert.match(skill, /Fast intermediate Verify/)
})
