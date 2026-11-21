/**
 * Architect ランナーの検証（SPEC V5 §3.2 / Batch V5-3 の受入条件）。
 *
 * 確かめること:
 *  1. `seed()` が入力を検証し、**待たずに** `jobId` を返す（202 の設計）
 *  2. モックランナーが書いた `docs/SPEC-*.md` を検知して `spec_ready` になる
 *  3. `autoStart` は**1 回だけ**起票する（冪等）。OFF なら起票しない
 *  4. ランナー異常終了は `failed` として理由が残る
 *  5. ランナーは `Hermes Native`（`hermes`）の 1 本だけで、旧 Opt-in 名は INVALID_RUNNER で弾く
 *  6. OAuth 認証ファイルへ触れるコードが**無い**（`scripts/check-oauth-boundary.mjs` も同じ境界を見る）
 *  7. 仕様策定プロンプトに推奨スラッグと既存 SPEC 一覧、Round 1 高速化制約が入る（SPEC V11 D54）
 *
 * 実 CLI は起動しない（すべて DI モック）。一時ディレクトリだけを使う。
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
  BOARD_RE,
  DEFAULT_REVIEW_BOARD,
  DEFAULT_RUNNER,
  DISMISSED_MAX,
  EXECUTION_POLICIES,
  EXISTING_SPECS_MAX,
  RUNNER_LABELS,
  RUNNERS,
  SPEC_LAUNCH_KIND,
  SPEC_READY_KIND,
  SPEC_SLUG_MAX,
  STALLED_AFTER_MS,
  TERMINAL_TASK_STATUSES,
  buildArchitectTaskBody,
  buildArchitectTaskTitle,
  batchIdPrefixForSlug,
  batchIdPrefixOf,
  buildKanbanCreateArgs,
  buildSeedPrompt,
  computePhase,
  createArchitect,
  createCliRunner,
  executionModeLabel,
  filedBatchIds,
  filedBatchIdsForSpec,
  findActiveJobReviewTask,
  findJobReviewTask,
  findJobSpec,
  findRecentSheet,
  isJobStalled,
  isSupportedRunner,
  makeJobId,
  normalizeExecutionPolicy,
  normalizeSeed,
  pendingSpecs,
  publicJob,
  queueStateOf,
  recentSpecPaths,
  reviewBoardsFor,
  runnerLabel,
  sanitizeRunner,
  suggestSpecSlug,
  usedBatchIdPrefixes,
} from '../src/architect.js'
import { createKanban } from '../src/kanban.js'
import { parseCreatedTask } from '../src/specs.js'
import { LANGUAGE_RULE_EN, LANGUAGE_RULE_JA, LANGUAGE_RULE_MARKER } from '../src/language-rule.js'
import { SPEC_TEXT, fakeCli, makeRepo, readFakeOut, seedInput, settle, writeSpec } from './helpers/architectFixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')
/** 一時リポジトリ（`docs/` 付き）。 */
test('sanitizeRunner / runnerLabel / makeJobId / normalizeSeed', () => {
  // SPEC V11 D50: ランナーは 1 本だけ（未知の値は既定へ倒す）
  assert.deepEqual(RUNNERS, ['hermes'])
  assert.equal(DEFAULT_RUNNER, 'hermes')
  assert.equal(sanitizeRunner('hermes'), 'hermes')
  assert.equal(sanitizeRunner('antigravity'), 'hermes')
  assert.equal(sanitizeRunner(undefined), 'hermes')
  assert.equal(isSupportedRunner('hermes'), true)
  assert.equal(isSupportedRunner('HERMES'), true)
  assert.equal(isSupportedRunner(''), true, '未指定は既定として許す')
  assert.equal(isSupportedRunner(undefined), true)
  assert.equal(isSupportedRunner('antigravity'), false)
  assert.equal(runnerLabel('hermes'), 'Hermes Native')
  assert.equal(runnerLabel('antigravity'), RUNNER_LABELS.hermes)

  const id = makeJobId(1_700_000_000_000, () => 0.5)
  assert.match(id, /^arch-[0-9a-z]+-[0-9a-z]{4}$/)

  assert.equal(normalizeSeed('  \n '), '')
  assert.equal(normalizeSeed('  a\r\nb  '), 'a\nb')
  assert.equal(normalizeSeed('x'.repeat(9000)).length, 4000)
  assert.match('demo', BOARD_RE)
})

test('suggestSpecSlug は ASCII から推奨スラッグを作り、無ければ jobId 末尾を使う（D54）', () => {
  assert.equal(SPEC_SLUG_MAX, 28)
  assert.equal(suggestSpecSlug('Notification digest: group them', 'arch-1'), 'notification-digest-group-th', '28 文字で切る')
  assert.equal(suggestSpecSlug('Notification digest', 'arch-1'), 'notification-digest')
  assert.equal(suggestSpecSlug('通知まとめを仕様化', 'arch-mf3k-0a1b'), '0a1b', 'ASCII が無ければ jobId 末尾')
  assert.equal(suggestSpecSlug('', 'arch-x'), 'x')
  assert.equal(suggestSpecSlug('', ''), 'spec', '決め手が無くても空にはしない')
  // 記号はハイフンに畳まれ、先頭・末尾のハイフンは落ちる
  assert.equal(suggestSpecSlug('  --Fix: the   Bug!! --', 'arch-1'), 'fix-the-bug')
  // 28 文字を超えない（末尾にハイフンを残さない）
  const long = suggestSpecSlug('alpha beta gamma delta epsilon zeta', 'arch-1')
  assert.ok(long.length <= SPEC_SLUG_MAX, long)
  assert.equal(/-$/.test(long), false, long)
})

test('recentSpecPaths は既存 SPEC の相対パスを直近順に最大 6 件返す（D54）', () => {
  assert.equal(EXISTING_SPECS_MAX, 6)
  const specs = Array.from({ length: 9 }, (_, i) => ({ path: `docs/SPEC-${i}.md`, mtime: i }))
  const out = recentSpecPaths(() => specs, '/repo')
  assert.equal(out.length, 6)
  assert.equal(out[0], 'docs/SPEC-8.md', 'mtime の新しい順')
  assert.deepEqual(recentSpecPaths(() => [], '/repo'), [])
  assert.deepEqual(
    recentSpecPaths(() => {
      throw new Error('boom')
    }, '/repo'),
    [],
    '走査に失敗しても起票は止めない',
  )
  assert.deepEqual(recentSpecPaths(() => [{ path: '' }, null, { path: 'docs/SPEC-A.md', mtime: 1 }], '/repo'), [
    'docs/SPEC-A.md',
  ])
})

test('buildSeedPrompt は Round 1 を JSON ファースト（mode=standard）にして HTML 生成とブラウザ撮影を抑止する', () => {
  const text = buildSeedPrompt({
    jobId: 'arch-1',
    seedText: '通知をまとめる',
    board: 'demo',
    repoPath: '/tmp/x',
    suggestedSlug: 'notify',
  })
  // 主成果物は構造化 JSON シート（推奨スラッグ入りの具体名）
  assert.match(text, /review\/sheets\/spec-notify-1\.json/)
  assert.match(text, /"mode": "standard"/)
  assert.match(text, /mode=standard sheet=sheets\/spec-notify-1\.json/)
  // 手書き HTML とヘッドレスブラウザ撮影は「見た目の比較が論点のときだけ」任意
  assert.match(text, /do NOT hand-write/)
  assert.match(text, /headless browser/)
  assert.match(text, /visual UI-layout comparison/)
  assert.match(text, /optional/)
  // 既存契約は維持される
  assert.match(text, /spec-architect/)
  assert.match(text, /Round 1/)
  assert.match(text, /Round 2/)
  assert.match(text, /review\/sheets\//)
  assert.match(text, /Execution Mode/)
  assert.match(text, /Zero-Stop \| Fast-Track Review \| Visual Gate/)
  assert.match(text, /通知をまとめる/)
  assert.match(text, /Do not file anything yet/)
})

test('buildSeedPrompt は推奨スラッグ・既存 SPEC 一覧・Round 1 高速化制約を注入する（D54）', () => {
  const text = buildSeedPrompt({
    jobId: 'arch-abc-0001',
    seedText: '通知まとめを仕様化',
    board: 'demo',
    repoPath: '/tmp/x',
    existingSpecs: ['docs/SPEC-PILOT-V10.md', 'docs/SPEC-PILOT-V11.md'],
  })
  assert.match(text, /Suggested slug: 0001/, 'ASCII が無い種は jobId 末尾を推奨にする')
  assert.match(text, /Existing specs: docs\/SPEC-PILOT-V10\.md, docs\/SPEC-PILOT-V11\.md/)
  assert.match(text, /Round 1 speed rule/)
  assert.match(text, /do NOT run npm test \/ npm run verify/)
  assert.match(text, /write the sheet and block immediately/)

  // 既存 SPEC が無いときは「無い」と明示する（探索させない）
  assert.match(
    buildSeedPrompt({ jobId: 'arch-1', seedText: 'seed', board: 'demo', repoPath: '/tmp/x' }),
    /Existing specs: none in docs\/ yet/,
  )
  // 明示したスラッグはそのまま使う
  assert.match(
    buildSeedPrompt({ jobId: 'arch-1', seedText: 'seed', board: 'demo', repoPath: '/tmp/x', suggestedSlug: 'abc' }),
    /Suggested slug: abc/,
  )
})

test('buildSeedPrompt は spec-architect の Round 1/2 と Execution Mode を要求する', () => {
  const text = buildSeedPrompt({ jobId: 'arch-1', seedText: '通知をまとめる', board: 'demo', repoPath: '/tmp/x' })
  assert.match(text, /spec-architect/)
  assert.match(text, /Round 1/)
  assert.match(text, /review\/sheets\//)
  assert.match(text, /Execution Mode/)
  assert.match(text, /Zero-Stop \| Fast-Track Review \| Visual Gate/)
  assert.match(text, /通知をまとめる/)
  // autoStart の有無で「起票するのは誰か」が変わる
  assert.match(text, /Do not file anything yet/)
  assert.match(
    buildSeedPrompt({ jobId: 'a', seedText: 's', board: 'b', repoPath: '/tmp/x', autoStart: true }),
    /file the batches automatically/,
  )
})

test('seed は入力を弾き、正しい入力では即座に jobId を返す', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      runner: async (args) => {
        calls.push(args)
        return { code: 0, stdout: 'ok', stderr: '' }
      },
      now: () => 1_700_000_000_000,
    },
  )

  assert.equal((await arch.seed(seedInput(repo, { seedText: '   ' }))).code, 'INVALID_SEED')
  assert.equal((await arch.seed(seedInput(repo, { board: 'bad board' }))).code, 'INVALID_BOARD')
  assert.equal((await arch.seed(seedInput(repo, { repoPath: 'relative/dir' }))).code, 'INVALID_REPO')
  assert.equal((await arch.seed(seedInput(path.join(repo, 'nope')))).code, 'INVALID_REPO')
  assert.equal(calls.length, 0, '検証に落ちたらランナーは起動しない')

  const ok = await arch.seed(seedInput(repo))
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 'running')
  assert.equal(ok.runner, 'hermes')
  assert.equal(ok.autoStart, false)
  assert.match(ok.jobId, /^arch-/)

  await settle()
  assert.equal(calls.length, 1, 'ランナーは背後で 1 回だけ起動する')
  assert.equal(calls[0].runnerId, 'hermes')
  assert.equal(calls[0].repoPath, repo)

  const snapshot = await arch.jobs({ board: 'demo' })
  assert.equal(snapshot.jobs.length, 1)
  assert.equal(snapshot.jobs[0].status, 'awaiting_spec')
  assert.equal(snapshot.jobs[0].id, ok.jobId)
})

test('完成した SPEC を検知して spec_ready になり chat-reports.jsonl へ 1 行書く', async () => {
  const repo = makeRepo()
  const review = path.join(repo, 'review')
  let clock = 1_700_000_000_000
  const arch = createArchitect(
    { reviewDir: review },
    {
      now: () => clock,
      runner: async () => {
        // Architect が書いたことにする（mtime はジョブ開始より後）
        clock += 1000
        writeSpec(repo, 'SPEC-DEMO.md', SPEC_TEXT, clock)
        return { code: 0, stdout: 'done', stderr: '' }
      },
    },
  )

  await arch.seed(seedInput(repo))
  await settle()

  const snapshot = await arch.jobs({ board: 'demo' })
  const job = snapshot.jobs[0]
  assert.equal(job.status, 'spec_ready')
  assert.equal(job.spec, 'docs/SPEC-DEMO.md')
  assert.equal(job.completedSpec.batchCount, 2)
  assert.deepEqual(
    job.completedSpec.batches.map((b) => b.id),
    ['D-1', 'D-2'],
  )
  assert.equal(snapshot.specReady.length, 1)
  assert.equal(snapshot.specReady[0].batchCount, 2)
  assert.equal(snapshot.pending.length, 1)
  assert.equal(snapshot.pending[0].pendingCount, 2, 'まだ起票していないので 2 バッチが未起票')

  const rows = fs
    .readFileSync(path.join(review, 'chat-reports.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, SPEC_READY_KIND)
  assert.equal(rows[0].spec, 'docs/SPEC-DEMO.md')
  assert.equal(rows[0].batchCount, 2)
})

test('autoStart は未起票バッチを 1 回だけ起票する（2 周目は何もしない）', async () => {
  const repo = makeRepo()
  const review = path.join(repo, 'review')
  let clock = 1_700_000_000_000
  const launches = []
  let filed = []
  const arch = createArchitect(
    { reviewDir: review },
    {
      now: () => clock,
      runner: async () => {
        clock += 1000
        writeSpec(repo, 'SPEC-AUTO.md', SPEC_TEXT, clock)
        return { code: 0, stdout: 'done', stderr: '' }
      },
      readTasks: () => filed,
      launchSpec: async (input) => {
        launches.push(input)
        // 本物の launchSpec は本文へ `Spec:` を書く（無印にしない）。同じ形で返す。
        filed = input.batchIds.map((id) => ({
          id: `t-${id}`,
          title: `[${id}] x`,
          status: 'ready',
          spec: 'docs/SPEC-AUTO.md',
          createdAt: clock,
        }))
        return {
          ok: true,
          runId: 'run-1',
          created: input.batchIds.map((id) => ({ id, taskId: `t-${id}` })),
          skipped: [],
          failed: [],
        }
      },
    },
  )

  await arch.seed(seedInput(repo, { autoStart: true, lang: 'en' }))
  await settle()

  const first = await arch.jobs({ board: 'demo' })
  assert.equal(launches.length, 1, '1 周目で 1 回だけ起票')
  assert.deepEqual(launches[0].batchIds, ['D-1', 'D-2'])
  // ジョブの言語は起票時のタスク本文へ引き継ぐ（SPEC-EN-ZERO-LEAK D73）
  assert.equal(launches[0].lang, 'en', 'autoStart が job.lang を launchSpec に渡していない')
  assert.equal(first.jobs[0].status, 'launched')
  assert.equal(first.jobs[0].launched.ok, true)
  assert.equal(first.jobs[0].launched.created.length, 2)
  assert.equal(first.specReady[0].launched, true)

  const second = await arch.jobs({ board: 'demo' })
  assert.equal(launches.length, 1, '2 周目は起票しない（冪等）')
  assert.equal(second.jobs[0].launched.created.length, 2)
  assert.equal(second.pending.length, 0, '起票済みなら未起票カードは出ない')

  const rows = fs
    .readFileSync(path.join(review, 'chat-reports.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    rows.map((r) => r.kind),
    [SPEC_READY_KIND, SPEC_LAUNCH_KIND],
  )
  assert.equal(rows[1].created, 2)
})

test('autoStart が OFF なら起票しない（ハイブリッドの既定）', async () => {
  const repo = makeRepo()
  let clock = 1_700_000_000_000
  const launches = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      now: () => clock,
      runner: async () => {
        clock += 1000
        writeSpec(repo, 'SPEC-MANUAL.md', SPEC_TEXT, clock)
        return { code: 0, stdout: 'done', stderr: '' }
      },
      readTasks: () => [],
      launchSpec: async (input) => {
        launches.push(input)
        return { ok: true, created: [], skipped: [], failed: [] }
      },
    },
  )

  await arch.seed(seedInput(repo))
  await settle()
  const snapshot = await arch.jobs({ board: 'demo' })
  assert.equal(launches.length, 0, 'チェック OFF では自動起票しない')
  assert.equal(snapshot.jobs[0].status, 'spec_ready')
  assert.equal(snapshot.pending[0].pendingCount, 2, '人が 1 タップで起票できる材料を返す')
})

test('既に全バッチが起票済みなら autoStart は起票せず launched で閉じる', async () => {
  const repo = makeRepo()
  let clock = 1_700_000_000_000
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      now: () => clock,
      runner: async () => {
        clock += 1000
        writeSpec(repo, 'SPEC-DONE.md', SPEC_TEXT, clock)
        return { code: 0, stdout: 'done', stderr: '' }
      },
      readTasks: () => [
        { id: 't1', title: '[D-1] one', status: 'running', spec: 'docs/SPEC-DONE.md' },
        { id: 't2', title: '[D-2] two', status: 'running', spec: 'docs/SPEC-DONE.md' },
      ],
      launchSpec: async () => {
        throw new Error('起票してはいけない')
      },
    },
  )

  await arch.seed(seedInput(repo, { autoStart: true }))
  await settle()
  const snapshot = await arch.jobs({ board: 'demo' })
  assert.equal(snapshot.jobs[0].status, 'launched')
  assert.equal(snapshot.jobs[0].launched.reason, 'nothing-pending')
  assert.equal(snapshot.pending.length, 0)
})

test('ランナー異常終了は failed として理由を残す', async () => {
  const repo = makeRepo()
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    { runner: async () => ({ code: 2, stdout: '', stderr: 'hermes: command not found' }) },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const snapshot = await arch.jobs({ board: 'demo' })
  assert.equal(snapshot.jobs[0].status, 'failed')
  assert.match(snapshot.jobs[0].error, /command not found/)
})

test('ランナーは hermes 固定: 旧 Opt-in 名は INVALID_RUNNER で弾く（D50）', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      runner: async (args) => {
        calls.push(args.runnerId)
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )

  const rejected = await arch.seed(seedInput(repo, { runner: 'antigravity' }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'INVALID_RUNNER')
  assert.equal(calls.length, 0, '受け付けない値ではランナーを起動しない')

  assert.deepEqual(arch.setConfig({ runner: 'antigravity' }), {
    ok: false,
    code: 'INVALID_RUNNER',
    error: 'Only the Hermes Native runner is supported',
  })

  // hermes（既定）は通り、公開ジョブのラベルも 1 本に揃う
  const accepted = await arch.seed(seedInput(repo))
  assert.equal(accepted.ok, true)
  assert.equal(accepted.runner, 'hermes')
  await settle()
  assert.deepEqual(calls, ['hermes'])
  const snapshot = await arch.jobs({ board: 'demo' })
  assert.equal('capabilities' in snapshot, false, '外部 CLI の可否はもう返さない')
  assert.equal(snapshot.runner, 'hermes')
  assert.equal(snapshot.jobs[0].runnerLabel, 'Hermes Native')
})

/** 実行引数・cwd・PATH を書き出すダミー CLI（`#!/bin/sh`）。 */

test('createCliRunner の hermes は kanban create で [ARCH] タスクを起票する（正規ルート）', async () => {
  const repo = makeRepo()
  const out = path.join(repo, 'hermes.out')
  const bin = fakeCli('hermes')
  process.env.HPA_FAKE_OUT = out
  try {
    const run = createCliRunner({ hermesBin: bin })
    const res = await run({
      runnerId: 'hermes',
      prompt: 'PROMPT LINE 1\nline2',
      repoPath: repo,
      board: 'demo',
      seedText: '通知まとめの仕様化\n二行目',
      jobId: 'arch-1',
    })
    assert.equal(res.code, 0)
    const { args, pwd, path: childPath } = readFakeOut(out)
    assert.deepEqual(args.slice(0, 6), ['kanban', '--board', 'demo', 'create', '[ARCH] 通知まとめの仕様化', '--json'])
    assert.ok(args.includes('--assignee') && args.includes('mobile'))
    const body = args[args.indexOf('--body') + 1]
    assert.match(body, /spec-architect/)
    assert.match(body, /Execution Contract/)
    assert.match(body, /Suggested slug: /, '推奨スラッグを本文へ注入する（D54）')
    assert.match(body, /Existing specs: /)
    assert.equal(pwd, fs.realpathSync(repo))
    // launchd の狭い PATH でも ~/.local/bin など既知の置き場所が補われる
    assert.ok(childPath.split(path.delimiter).includes(path.join(os.homedir(), '.local', 'bin')), childPath)
    // 0 終了＋JSON からタスク ID が取れる
    assert.equal(parseCreatedTask(res.stdout).id, 't_archfake')
  } finally {
    delete process.env.HPA_FAKE_OUT
  }
})

test('seed は推奨スラッグと既存 SPEC 一覧をランナーへ渡す（D54）', async () => {
  const repo = makeRepo()
  writeSpec(repo, 'SPEC-PILOT-V10.md', SPEC_TEXT, 1_700_000_000_000)
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      now: () => 1_700_000_100_000,
      runner: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '{"id":"t_arch1"}', stderr: '' }
      },
    },
  )
  await arch.seed(seedInput(repo, { seedText: 'Notification digest: group them' }))
  await settle()
  assert.equal(calls.length, 1)
  assert.match(calls[0].suggestedSlug, /^notification/)
  assert.deepEqual(calls[0].existingSpecs, ['docs/SPEC-PILOT-V10.md'])
  assert.match(String(calls[0].prompt), /Existing specs: docs\/SPEC-PILOT-V10\.md/)
})

test('ランナーの失敗理由は 600 字以内で failed に残る', async () => {
  const repo = makeRepo()
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    { runner: async () => ({ code: 3, stdout: '', stderr: `hermes: ${'x'.repeat(2000)}` }) },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.status, 'failed')
  assert.equal(job.error.length, 600)
})

test('ランナーが exit 0 でタスク ID を返さなくても failed にせず awaiting_spec で待つ', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      runner: async (args) => {
        calls.push(args.runnerId)
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.deepEqual(calls, ['hermes'])
  assert.equal(job.status, 'awaiting_spec', '成果物（SPEC / [review]）の検知を待つ')
  assert.equal(job.runner, 'hermes')
  assert.equal(job.taskId, null)
  assert.equal(job.fallbackFrom, null)
  assert.equal(job.phase, 'spawning')
})

test('ランナーが 0 終了で SPEC を書いていれば spec_ready になる', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      runner: async (args) => {
        calls.push(args.runnerId)
        writeSpec(repo, 'SPEC-NATIVE-OK.md', SPEC_TEXT, Date.now())
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.deepEqual(calls, ['hermes'])
  assert.equal(job.fallbackFrom, null)
  assert.equal(job.status, 'spec_ready')
  assert.equal(job.phase, 'spec_ready')
})

test('ランナーが review/sheets に JSON シートを書いていれば中間シートとして検知する（D42）', async () => {
  const repo = makeRepo()
  const reviewDir = path.join(repo, 'review')
  const sheets = path.join(reviewDir, 'sheets')
  fs.mkdirSync(sheets, { recursive: true })
  const clock = 1_700_000_000_000
  const arch = createArchitect(
    { reviewDir },
    {
      now: () => clock,
      readTasks: () => [],
      runner: async (args) => {
        if (args.runnerId === 'hermes') {
          fs.writeFileSync(path.join(sheets, 'spec-notify-1.json'), '{"mode":"standard"}')
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.status, 'awaiting_spec', 'カンバン起票の完了を待つ')
  assert.equal(job.runner, 'hermes')
  assert.equal(job.sheetPath, 'sheets/spec-notify-1.json', '中間シートのパスを返す')
  assert.equal(job.phase, 'round1_sheet')
})

