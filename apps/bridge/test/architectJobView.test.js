/**
 * Architect のジョブ表示（`jobsFor` / `publicJob` / `computePhase` / `isJobStalled` /
 * `findRecentSheet` / `findJobReviewTask` / `findJobSpec` / `dismiss` / ランナー設定）と
 * Review 検知のテスト。811 行だった 1 本を対象モジュール別に 3 分割したうちの 1 本。
 * 対象: `apps/bridge/src/architect/job-view.js`。
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


test('jobsFor は blocked の [review] タスクを awaiting_review として返す（D28）', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  let tasks = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      now: () => clock,
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch1"}', stderr: '' }),
      readTasks: () => tasks,
    },
  )

  await arch.seed(seedInput(repo))
  await settle()
  let job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.status, 'awaiting_spec', 'レビューが無い間は従来どおり')
  assert.equal(job.reviewTaskId, null)

  // Architect ワーカーが Round 1 のシートを blocked で起票した
  tasks = [{ id: 't_rev1', title: '[review] 通知まとめ: 決定 3 件', status: 'blocked', createdAt: clock + 1000 }]
  job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.status, 'awaiting_review')
  assert.equal(job.stage, 'awaiting_review')
  assert.equal(job.reviewTaskId, 't_rev1')
  assert.match(job.reviewTitle, /通知まとめ/)

  // 回答が返ってブロックが解けたら「仕様書執筆中」へ戻る
  tasks = [{ id: 't_rev1', title: '[review] 通知まとめ: 決定 3 件', status: 'ready', createdAt: clock + 1000 }]
  job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.status, 'awaiting_spec')
  assert.equal(job.reviewTaskId, null)
})

test('findJobReviewTask は [review] の blocked タスクだけを拾う（純関数）', () => {
  const job = { startedAt: 10_000, taskId: 't_arch' }
  assert.equal(findJobReviewTask(job, []), null)
  assert.equal(findJobReviewTask(job, [{ id: 'old', title: '[review] x', status: 'blocked', createdAt: 1000 }]), null)
  assert.equal(findJobReviewTask(job, [{ id: 'r1', title: '[review] x', status: 'ready', createdAt: 12_000 }]), null)
  assert.equal(findJobReviewTask(job, [{ id: 'r2', title: 'Q1', label: 'review', status: 'blocked', createdAt: 12_000 }]).taskId, 'r2')
  assert.equal(findJobReviewTask(job, [{ id: 'r3', title: 'Q1', body: '[review] 回答待ち', status: 'blocked', createdAt: 12_000 }]).taskId, 'r3')
  // job.taskId と一致するタスクは古くても見る（[ARCH] タスク自身が review 待ちで止まったケース）
  assert.equal(
    findJobReviewTask(job, [{ id: 't_arch', title: '[ARCH] x', body: '[review]', status: 'blocked', createdAt: 0 }])?.taskId,
    't_arch',
  )
})

test('ランナー設定は dataDir に保存され、壊れた JSON も未知の値も既定へ戻る', async () => {
  const repo = makeRepo()
  const dataDir = path.join(repo, 'data')
  const arch = createArchitect({ reviewDir: path.join(repo, 'review'), dataDir })
  assert.equal(arch.getConfig().runner, 'hermes')
  // 旧 Opt-in 名は受け付けない（400 相当）
  assert.deepEqual(arch.setConfig({ runner: 'antigravity' }), {
    ok: false,
    code: 'INVALID_RUNNER',
    error: 'Only the Hermes Native runner is supported',
  })
  // hermes は通り、0600 で保存される
  assert.deepEqual(arch.setConfig({ runner: 'hermes' }), { ok: true, runner: 'hermes' })
  assert.equal(arch.getConfig().runner, 'hermes')
  assert.equal(fs.statSync(path.join(dataDir, 'architect-config.json')).mode & 0o777, 0o600)

  // 保存ファイルに古い値が残っていても既定へ倒す（未知の値で起動しない）
  fs.writeFileSync(path.join(dataDir, 'architect-config.json'), '{"runner":"antigravity"}')
  assert.equal(arch.getConfig().runner, 'hermes')

  fs.writeFileSync(path.join(dataDir, 'architect-config.json'), '{not json')
  assert.equal(arch.getConfig().runner, 'hermes')
})

test('findJobSpec / pendingSpecs は猶予と既存タスクを見る', () => {
  const job = { startedAt: 10_000 }
  const specs = [
    { path: 'docs/OLD.md', mtime: 1000, batches: [{ id: 'A' }] },
    { path: 'docs/NEW.md', mtime: 12_000, batches: [{ id: 'B' }] },
    { path: 'docs/EMPTY.md', mtime: 13_000, batches: [] },
  ]
  assert.equal(findJobSpec(job, specs).path, 'docs/NEW.md')
  assert.equal(findJobSpec(job, specs, { taken: new Set(['docs/NEW.md']) }), null)
  // 秒ズレの猶予（5 秒）内なら拾う
  assert.equal(findJobSpec({ startedAt: 16_000 }, specs).path, 'docs/NEW.md')

  const pending = pendingSpecs(specs, [{ id: 't1', title: '[B] two', status: 'running', createdAt: 13_000 }])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].path, 'docs/OLD.md')
  assert.deepEqual(pending[0].pending, ['A'])

  // 完了済み（done）も「起票済み」に数える（二重起票を出さない）
  assert.deepEqual([...filedBatchIds([{ title: '[A] done batch', status: 'done' }])], ['A'])
  assert.deepEqual(
    pendingSpecs(specs, [{ id: 't1', title: '[A] done batch', status: 'done' }]).map((p) => [p.path, p.pending]),
    [['docs/NEW.md', ['B']]],
    'done の A は起票済み、B だけが未起票',
  )

  const free = pendingSpecs(specs, [])
  assert.deepEqual(
    free.map((p) => p.path),
    ['docs/NEW.md', 'docs/OLD.md'],
    'mtime の新しい順に並ぶ',
  )
  assert.equal(free[0].pendingCount, 1)

  // 別 SPEC に属する同名バッチ ID（C1 等）があっても別 SPEC 側は未起票のまま残る
  const colliding = pendingSpecs(
    [{ path: 'docs/SPEC-COHERENCE.md', mtime: 20_000, batches: [{ id: 'C1' }, { id: 'C2' }] }],
    [{ id: 't_cat', title: '[C1] Catalog', status: 'done', spec: 'docs/SPEC-CATALOG-ADMISSION.md' }],
  )
  assert.deepEqual(colliding[0].pending, ['C1', 'C2'])
})

test('publicJob は機密を落とし、種を 400 字で切る', () => {
  const job = publicJob({
    id: 'arch-1',
    board: 'demo',
    status: 'spec_ready',
    runner: 'hermes',
    seedText: 'x'.repeat(900),
    repoPath: '/secret/path',
    extra: 'nope',
  })
  assert.equal(job.seed.length, 400)
  assert.equal(job.repoPath, undefined)
  assert.equal(job.extra, undefined)
  assert.equal(job.runnerLabel, 'Hermes Native')
  // V6: ランナーのフォールバックと待機状態は公開表現に載る（非機密）
  assert.equal(job.stage, 'spec_ready')
  assert.equal(job.requestedRunner, 'hermes')
  assert.equal(job.fallbackFrom, null)
  assert.equal(job.fallbackReason, null)
  assert.equal(job.taskId, null)
  assert.equal(job.reviewTaskId, null)
  assert.equal(job.reviewTitle, null)
})

test('実行コードは OAuth クレデンシャルへ触れない（境界の機械検査）', () => {
  // 検査語は分割して組み立てる（リポジトリに literal を残さない = 受入条件の grep を汚さない）
  const needles = [['oauth', 'creds'].join('_'), ['.', 'gemini'].join(''), ['keychain', 'antigravity'].join('-')]
  for (const file of ['architect.js', 'capabilities.js']) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8')
    for (const needle of needles) {
      assert.equal(source.includes(needle), false, `${file} に ${needle} があってはいけない`)
    }
  }
})

// ---------------------------------------------------------------------------
// SPEC V7 §3.1 — 状態遷移修正・ジョブ破棄 API・実行方針受付
// ---------------------------------------------------------------------------


test('kanban.tasks は body を返し、findJobReviewTask が本文の [review] を検出できる（§3.1①）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kb-body-'))
  const { db } = makeKanbanBoard(dir)
  const ins = db.prepare(`INSERT INTO tasks (id, title, body, assignee, status, priority, created_at,
      started_at, completed_at, consecutive_failures) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  // 本文にだけ `[review]` があり、タイトルには無いタスク（本文が読めないと検出できない形）
  ins.run('t_arch', '[ARCH] 通知まとめ', 'Round 2 を書いています', 'mobile', 'running', 0, 1_700_000_000, 1_700_000_000, null, 0)
  ins.run('t_rev', '通知まとめ: 決定 3 件', '回答待ち\n[review] Q1: 通知はまとめる？', 'mobile', 'blocked', 0, 1_700_000_005, null, null, 0)
  db.close()

  const kb = createKanban({ kanbanRoot: path.join(dir, 'kanban'), kanbanDb: path.join(dir, 'kanban.db') })
  const tasks = kb.tasks('demo', { limit: 10 })
  assert.equal(tasks.length, 2)
  const rev = tasks.find((t) => t.id === 't_rev')
  assert.match(String(rev.body), /\[review\]/, 'SQLite の body 列が返る')
  assert.equal(tasks.find((t) => t.id === 't_arch').body, 'Round 2 を書いています')

  const job = { startedAt: 1_700_000_000_000, taskId: 't_arch' }
  assert.equal(findJobReviewTask(job, tasks)?.taskId, 't_rev', '本文の [review] から Review タスクを拾える')

  // 本文を落とした一覧（PWA のタスク一覧）では検出できない = body 列が効いている証拠
  const slim = kb.tasks('demo', { limit: 10, withBody: false })
  assert.equal(slim.every((t) => !('body' in t)), true)
  assert.equal(findJobReviewTask(job, slim), null)
})

test('親 [ARCH] が done / archived なら jobsFor は awaiting_spec で残さない（§3.1②）', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  /** @type {Array<object>} */
  let tasks = [{ id: 't_arch', title: '[ARCH] 通知まとめ', status: 'running', createdAt: clock }]
  const arch = createArchitect(
    {},
    {
      now: () => clock,
      readTasks: () => tasks,
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch"}', stderr: '' }),
    },
  )

  await arch.seed(seedInput(repo))
  await settle()
  let snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs.length, 1)
  assert.equal(snap.jobs[0].status, 'awaiting_spec')
  assert.equal(snap.jobs[0].queueState, 'running', '実行中は running')

  // ワーカーが着火待ち（ready）→ キュー待ちとして区別できる
  tasks = [{ id: 't_arch', title: '[ARCH] 通知まとめ', status: 'ready', createdAt: clock }]
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs[0].status, 'awaiting_spec')
  assert.equal(snap.jobs[0].queueState, 'queued', 'ready はキュー待ち')
  assert.equal(snap.jobs[0].stage, 'awaiting_spec', 'キュー待ちを実行中と偽らない')

  // 親が終端になったら進行バーから落ちる（「仕様書を書いています…」の残留を止める）
  for (const status of TERMINAL_TASK_STATUSES) {
    tasks = [{ id: 't_arch', title: '[ARCH] 通知まとめ', status, createdAt: clock }]
    snap = await arch.jobs({ board: 'demo' })
    assert.equal(snap.jobs.length, 0, `${status} はアクティブ一覧に残さない`)
    assert.equal(snap.jobs.some((j) => j.status === 'awaiting_spec'), false)
  }
})

test('dismiss は破棄を永続化し、再取得でも再起動でもアクティブ一覧に出さない（§3.1②）', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  const dataDir = path.join(repo, 'data')
  const make = () =>
    createArchitect(
      { dataDir },
      {
        now: () => clock,
        readTasks: () => [],
        runner: async () => ({ code: 0, stdout: '{"id":"t_arch"}', stderr: '' }),
      },
    )

  const arch = make()
  const seeded = await arch.seed(seedInput(repo))
  await settle()
  assert.equal((await arch.jobs({ board: 'demo' })).jobs.length, 1)

  // 不正・不明な ID は 4xx 相当のコードで返す（サーバーは 400 / 404 に写す）
  assert.equal(arch.dismiss('   ').code, 'INVALID_JOB_ID')
  assert.equal(arch.dismiss('arch-nope-0000').code, 'JOB_NOT_FOUND')

  const out = arch.dismiss(seeded.jobId)
  assert.deepEqual(out, { ok: true, jobId: seeded.jobId, persisted: true })
  assert.equal((await arch.jobs({ board: 'demo' })).jobs.length, 0, '破棄したジョブはアクティブ一覧に出ない')
  assert.equal(
    (await arch.jobs({ board: 'demo', includeDismissed: true })).jobs.filter((j) => j.dismissed).length,
    1,
    '監査用には includeDismissed で参照できる',
  )

  // 破棄 ID はデータストアに残る（0600）
  const file = path.join(dataDir, 'architect-dismissed.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids, [seeded.jobId])
  assert.ok(DISMISSED_MAX >= 100)

  // 再起動相当（同じ dataDir で作り直す）でも破棄は生きている
  const restarted = make()
  assert.equal(restarted.dismiss(seeded.jobId).ok, true, '永続ストアから復元されている')
  assert.equal(restarted.dismiss('arch-other-0000').code, 'JOB_NOT_FOUND', '未知の ID は通さない')

  // 壊れた JSON は空集合へ戻す（起動を止めない）
  fs.writeFileSync(file, '{not json')
  const broken = make()
  assert.equal(broken.dismiss(seeded.jobId).code, 'JOB_NOT_FOUND')
})

test('computePhase は status / reviewSeenOnce / sheetPath から phase を決める（D42）', () => {
  assert.deepEqual(ARCHITECT_PHASES, [
    'spawning',
    'round1_sheet',
    'awaiting_review',
    'round2_spec',
    'spec_ready',
    'launched',
    'failed',
  ])
  assert.equal(computePhase({ status: 'running' }), 'spawning')
  assert.equal(computePhase({ status: 'awaiting_spec' }), 'spawning')
  assert.equal(computePhase({ status: 'awaiting_spec', sheetPath: 'sheets/spec-a-1.json' }), 'round1_sheet')
  assert.equal(
    computePhase({ status: 'awaiting_review', sheetPath: 'sheets/spec-a-1.json' }),
    'awaiting_review',
    '回答待ちはシート有無より優先',
  )
  assert.equal(computePhase({ status: 'awaiting_spec', reviewSeenOnce: true, sheetPath: 'x' }), 'round2_spec')
  assert.equal(computePhase({ status: 'spec_ready' }), 'spec_ready')
  assert.equal(computePhase({ status: 'launched' }), 'launched')
  assert.equal(computePhase({ status: 'failed' }), 'failed')
  assert.equal(computePhase(null), 'spawning')
})

test('isJobStalled は 3 分無進展の running / awaiting_spec だけを停滞とみなす（D42）', () => {
  assert.equal(STALLED_AFTER_MS, 180_000)
  const base = { status: 'awaiting_spec', startedAt: 1_000_000 }
  assert.equal(isJobStalled(base, 1_000_000 + 179_999), false, '3 分未満はまだ待つ')
  assert.equal(isJobStalled(base, 1_000_000 + 180_000), true)
  assert.equal(isJobStalled({ ...base, status: 'running' }, 1_000_000 + 200_000), true)
  assert.equal(isJobStalled({ ...base, queueState: 'queued' }, 1_000_000 + 900_000), false, '着火待ちは停滞ではない')
  for (const status of ['awaiting_review', 'spec_ready', 'launched', 'failed', 'done', 'archived']) {
    assert.equal(isJobStalled({ ...base, status }, 1_000_000 + 900_000), false, `${status} は停滞にしない`)
  }
  assert.equal(isJobStalled({ status: 'awaiting_spec', createdAt: 1_000_000 }, 1_000_000 + 200_000), true, 'startedAt が無ければ createdAt')
  assert.equal(isJobStalled({ status: 'awaiting_spec' }, 1_000_000 + 900_000), false, '時刻が無ければ判定しない')
})

test('findRecentSheet は review/sheets の新しい spec-*.json だけを返す（D42）', () => {
  const repo = makeRepo()
  const reviewDir = path.join(repo, 'review')
  const sheets = path.join(reviewDir, 'sheets')
  fs.mkdirSync(sheets, { recursive: true })
  const startedAt = 1_700_000_000_000
  const write = (name, mtimeMs) => {
    const file = path.join(sheets, name)
    fs.writeFileSync(file, '{}')
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  }
  write('spec-old-1.json', startedAt - 60_000)
  assert.equal(findRecentSheet(reviewDir, { startedAt }), null, '猶予より古いシートは拾わない')
  write('spec-new-1.json', startedAt + 1_000)
  write('spec-newer-2.json', startedAt + 2_000)
  write('notes.json', startedAt + 3_000, 'spec- 以外は対象外')
  write('spec-new-1.html', startedAt + 4_000, 'HTML シートは対象外')
  assert.equal(findRecentSheet(reviewDir, { startedAt }), 'sheets/spec-newer-2.json')
  assert.equal(findRecentSheet(reviewDir, { startedAt: startedAt + 3_000 }), 'sheets/spec-newer-2.json')
  assert.equal(findRecentSheet(reviewDir, { startedAt: startedAt + 10_000 }), null)
  assert.equal(findRecentSheet(null, { startedAt }), null, 'reviewDir 未指定は安全に null')
  assert.equal(findRecentSheet(path.join(repo, 'nope'), { startedAt }), null, 'ディレクトリ不在も無害')
})

test('別ボード（hermes-pilot）で撒いた種でも mobile ボードの [review] を awaiting_review として拾う（D42）', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  /** @type {Record<string, Array<object>>} */
  const boards = {
    'hermes-pilot': [{ id: 't_arch', title: '[ARCH] 通知まとめ', status: 'running', createdAt: clock }],
    mobile: [],
  }
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      now: () => clock,
      readTasks: (slug) => boards[slug] ?? [],
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch"}', stderr: '' }),
    },
  )

  await arch.seed(seedInput(repo, { board: 'hermes-pilot' }))
  await settle()
  let job = (await arch.jobs({ board: 'hermes-pilot' })).jobs[0]
  assert.equal(job.status, 'awaiting_spec')
  assert.equal(job.reviewBoard, null)

  // Quick Review は既定で mobile ボードへ撒かれる
  boards.mobile = [{ id: 't_rev', title: '[review] 通知まとめ: 決定 3 件', status: 'blocked', createdAt: clock + 1_000 }]
  job = (await arch.jobs({ board: 'hermes-pilot' })).jobs[0]
  assert.equal(job.status, 'awaiting_review', 'his board だけ見ていると取りこぼす')
  assert.equal(job.reviewTaskId, 't_rev')
  assert.equal(job.reviewBoard, 'mobile', 'どのボードで拾ったかを返す')
  assert.equal(job.phase, 'awaiting_review')

  // 回答が返って blocked が解けたら Round 2（SPEC 執筆中）へ
  boards.mobile = [{ id: 't_rev', title: '[review] 通知まとめ: 決定 3 件', status: 'ready', createdAt: clock + 1_000 }]
  job = (await arch.jobs({ board: 'hermes-pilot' })).jobs[0]
  assert.equal(job.status, 'awaiting_spec')
  assert.equal(job.reviewTaskId, null)
  assert.equal(job.reviewBoard, null)
  assert.equal(job.phase, 'round2_spec', '一度 Review を通過したら Round 2 として見せる')
})

test('jobsFor は既定でボード横断のアクティブジョブを返し、strictBoard で従来どおり絞る（D42）', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  const arch = createArchitect(
    {},
    {
      now: () => clock,
      readTasks: () => [],
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  )

  await arch.seed(seedInput(repo, { board: 'other', seedText: '別ボードの種' }))
  await settle()

  const across = await arch.jobs({ board: 'demo' })
  assert.equal(across.jobs.length, 1, '別ボードで動いているジョブも進行バーに出す')
  assert.equal(across.jobs[0].board, 'other')

  const strict = await arch.jobs({ board: 'demo', strictBoard: true })
  assert.equal(strict.jobs.length, 0, 'strictBoard は従来の厳密一致')

  // 別リポジトリでもアクティブなら返す
  const otherRepo = makeRepo()
  await arch.seed(seedInput(otherRepo, { board: 'other', repoPath: otherRepo }))
  await settle()
  assert.equal((await arch.jobs({ board: 'demo' })).jobs.length, 2)
  assert.equal((await arch.jobs({ board: 'demo', repoPath: repo })).jobs.length, 2, 'アクティブはリポジトリを跨いで返す')

  // 破棄したジョブはボード横断でも返さない
  const first = (await arch.jobs({ board: 'demo' })).jobs[0]
  arch.dismiss(first.id)
  assert.equal((await arch.jobs({ board: 'demo' })).jobs.length, 1)
})

test('publicJob は phase / stalled / sheetPath / reviewBoard を返す（D42）', () => {
  const job = publicJob(
    {
      id: 'arch-1',
      board: 'demo',
      status: 'awaiting_spec',
      runner: 'hermes',
      startedAt: 1_000_000,
      reviewSeenOnce: true,
      reviewBoard: 'mobile',
      sheetPath: 'sheets/spec-a-1.json',
      seedText: '通知まとめ',
      repoPath: '/secret/path',
    },
    { at: 1_000_000 + 200_000 },
  )
  assert.equal(job.phase, 'round2_spec')
  assert.equal(job.stalled, true, '3 分無進展は停滞警告')
  assert.equal(job.sheetPath, 'sheets/spec-a-1.json')
  assert.equal(job.reviewBoard, 'mobile')
  assert.equal(job.repoPath, undefined, '機密は引き続き落とす')

  // 3 分未満は stalled=false（既定の publicJob 呼び出しでも壊れない）
  const fresh = publicJob({ id: 'arch-2', board: 'demo', status: 'running', startedAt: 1_000_000 }, { at: 1_000_010 })
  assert.equal(fresh.stalled, false)
  assert.equal(fresh.phase, 'spawning')
  assert.equal(fresh.sheetPath, null)
  assert.equal(fresh.reviewBoard, null)
})

test('親 [ARCH] が done でも別タスクの [review] が blocked / ready / running なら追い続ける', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  /** @type {Record<string, Array<object>>} */
  let byBoard = {
    demo: [{ id: 't_arch', title: '[ARCH] Relay fix', status: 'done', createdAt: clock }],
    mobile: [
      {
        id: 't_rev',
        title: '[review] Round 1 questions',
        body: '[review] label=spec-relay-01 round=1 mode=standard sheet=sheets/spec-relay-01-1.json',
        status: 'blocked',
        createdAt: clock + 1000,
      },
    ],
  }
  const arch = createArchitect(
    {},
    {
      now: () => clock,
      readTasks: (slug) => byBoard[slug] ?? [],
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch"}', stderr: '' }),
    },
  )

  await arch.seed(seedInput(repo))
  await settle()

  // 1) 親 [ARCH] が既に done でも、mobile 側の [review] が blocked の間は awaiting_review
  let snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs.length, 1)
  assert.equal(snap.jobs[0].status, 'awaiting_review')
  assert.equal(snap.jobs[0].reviewTaskId, 't_rev')
  assert.equal(snap.jobs[0].reviewBoard, 'mobile')

  // 2) 回答送信で [review] が ready（キュー待ち）になったら phase=round2_spec / queueState=queued
  byBoard.mobile[0].status = 'ready'
  assert.equal(findActiveJobReviewTask(snap.jobs[0], byBoard.mobile)?.taskId, 't_rev')
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs.length, 1)
  assert.equal(snap.jobs[0].status, 'awaiting_spec')
  assert.equal(snap.jobs[0].phase, 'round2_spec')
  assert.equal(snap.jobs[0].queueState, 'queued')

  // 3) ワーカーが動き出したら running（stage='running'）
  byBoard.mobile[0].status = 'running'
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs.length, 1)
  assert.equal(snap.jobs[0].status, 'awaiting_spec')
  assert.equal(snap.jobs[0].stage, 'running')
  assert.equal(snap.jobs[0].queueState, 'running')

  // 4) [review] タスクも完了（done）になれば、SPEC 未検知でも終端に落ちる
  byBoard.mobile[0].status = 'done'
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs.length, 0)
})
