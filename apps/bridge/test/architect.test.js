/**
 * Architect ランナーの検証（SPEC V5 §3.2 / Batch V5-3 の受入条件）。
 *
 * 確かめること:
 *  1. `seed()` が入力を検証し、**待たずに** `jobId` を返す（202 の設計）
 *  2. モックランナーが書いた `docs/SPEC-*.md` を検知して `spec_ready` になる
 *  3. `autoStart` は**1 回だけ**起票する（冪等）。OFF なら起票しない
 *  4. ランナー異常終了は `failed` として理由が残る
 *  5. `antigravity` は `agy` が無い環境では選べない（Opt-in の境界）
 *  6. OAuth 認証ファイルへ触れるコードが**無い**（`scripts/check-oauth-boundary.mjs` も同じ境界を見る）
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
  BOARD_RE,
  DISMISSED_MAX,
  EXECUTION_POLICIES,
  RUNNER_LABELS,
  SPEC_LAUNCH_KIND,
  SPEC_READY_KIND,
  TERMINAL_TASK_STATUSES,
  buildArchitectTaskBody,
  buildArchitectTaskTitle,
  buildKanbanCreateArgs,
  buildSeedPrompt,
  createArchitect,
  createCliRunner,
  executionModeLabel,
  filedBatchIds,
  findJobReviewTask,
  findJobSpec,
  makeJobId,
  normalizeExecutionPolicy,
  normalizeSeed,
  pendingSpecs,
  publicJob,
  queueStateOf,
  runnerLabel,
  sanitizeRunner,
} from '../src/architect.js'
import { createKanban } from '../src/kanban.js'
import { parseCreatedTask } from '../src/specs.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

/** 一時リポジトリ（`docs/` 付き）。 */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-architect-'))
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  return root
}

/** SPEC を 1 枚書く（mtime を指定できる）。 */
function writeSpec(repo, name, text, mtimeMs) {
  const file = path.join(repo, 'docs', name)
  fs.writeFileSync(file, text)
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return `docs/${name}`
}

const SPEC_TEXT = [
  '# SPEC: Demo',
  '',
  '### Batch D-1: One',
  '',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 一つ目',
  '',
  '### Batch D-2: Two',
  '',
  '- **Execution Mode**: `[Mode: Visual Gate]`',
  '- **目的**: 二つ目',
  '',
].join('\n')

/** ランナー解決を待つ（`seed()` は待たない設計なので、テスト側だけ待つ）。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/** `seed` の定型入力。 */
function seedInput(repo, over = {}) {
  return { repoPath: repo, board: 'demo', seedText: '新機能の仕様化: 通知まとめ', ...over }
}

test('sanitizeRunner / runnerLabel / makeJobId / normalizeSeed', () => {
  assert.equal(sanitizeRunner('antigravity'), 'antigravity')
  assert.equal(sanitizeRunner('ANTIGRAVITY'), 'antigravity')
  assert.equal(sanitizeRunner('nope'), 'hermes')
  assert.equal(sanitizeRunner(undefined), 'hermes')
  assert.equal(runnerLabel('antigravity'), RUNNER_LABELS.antigravity)
  assert.equal(runnerLabel('hermes'), 'Hermes Native')

  const id = makeJobId(1_700_000_000_000, () => 0.5)
  assert.match(id, /^arch-[0-9a-z]+-[0-9a-z]{4}$/)

  assert.equal(normalizeSeed('  \n '), '')
  assert.equal(normalizeSeed('  a\r\nb  '), 'a\nb')
  assert.equal(normalizeSeed('x'.repeat(9000)).length, 4000)
  assert.match('demo', BOARD_RE)
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
        filed = input.batchIds.map((id) => ({ id: `t-${id}`, title: `[${id}] x`, status: 'ready' }))
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

  await arch.seed(seedInput(repo, { autoStart: true }))
  await settle()

  const first = await arch.jobs({ board: 'demo' })
  assert.equal(launches.length, 1, '1 周目で 1 回だけ起票')
  assert.deepEqual(launches[0].batchIds, ['D-1', 'D-2'])
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
        { id: 't1', title: '[D-1] one', status: 'running' },
        { id: 't2', title: '[D-2] two', status: 'running' },
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
    { runner: async () => ({ code: 2, stdout: '', stderr: 'agy: command not found' }) },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const snapshot = await arch.jobs({ board: 'demo' })
  assert.equal(snapshot.jobs[0].status, 'failed')
  assert.match(snapshot.jobs[0].error, /command not found/)
})

test('antigravity は agy がある時だけ選べる（Opt-in）', async () => {
  const repo = makeRepo()
  const seen = []
  const without = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    { hasAgyCli: () => false, runner: async () => ({ code: 0, stdout: '', stderr: '' }) },
  )
  const rejected = await without.seed(seedInput(repo, { runner: 'antigravity' }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'RUNNER_UNAVAILABLE')
  assert.deepEqual(without.setConfig({ runner: 'antigravity' }), {
    ok: false,
    code: 'RUNNER_UNAVAILABLE',
    error: 'agy CLI was not found on this machine',
  })

  const withAgy = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      hasAgyCli: () => true,
      runner: async (args) => {
        seen.push(args.runnerId)
        // agy が SPEC を書いたことにする（成果物があるのでフォールバックは起きない）
        writeSpec(repo, 'SPEC-AGY.md', SPEC_TEXT, Date.now())
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  const accepted = await withAgy.seed(seedInput(repo, { runner: 'antigravity' }))
  assert.equal(accepted.ok, true)
  await settle()
  assert.deepEqual(seen, ['antigravity'])
  const snapshot = await withAgy.jobs({ board: 'demo' })
  assert.equal(snapshot.capabilities.hasAgyCli, true)
  assert.equal(snapshot.jobs[0].runnerLabel, RUNNER_LABELS.antigravity)
})

/** 実行引数・cwd・PATH を書き出すダミー CLI（`#!/bin/sh`）。 */
function fakeCli(name = 'cli') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cli-'))
  const file = path.join(dir, name)
  const script = [
    '#!/bin/sh',
    'if [ -n "$HPA_FAKE_OUT" ]; then',
    '  printf "%s\\000" "$@" > "$HPA_FAKE_OUT.args"',
    '  printf "%s" "$PWD" > "$HPA_FAKE_OUT.pwd"',
    '  printf "%s" "$PATH" > "$HPA_FAKE_OUT.path"',
    'fi',
    'printf \'{"id":"t_archfake"}\'',
    'exit 0',
    '',
  ].join('\n')
  fs.writeFileSync(file, script, { mode: 0o755 })
  return file
}

/** ダミー CLI が書いた実行記録を読む。 */
function readFakeOut(out) {
  return {
    args: fs.readFileSync(`${out}.args`, 'utf8').split('\0').slice(0, -1),
    pwd: fs.readFileSync(`${out}.pwd`, 'utf8'),
    path: fs.readFileSync(`${out}.path`, 'utf8'),
  }
}

test('createCliRunner は agy に -p/--mode auto を渡し、cwd と拡張 PATH を整える（D28）', async () => {
  const repo = makeRepo()
  const out = path.join(repo, 'agy.out')
  const bin = fakeCli('agy')
  process.env.HPA_FAKE_OUT = out
  try {
    const run = createCliRunner({ agyBin: bin })
    const res = await run({ runnerId: 'antigravity', prompt: 'seed text', repoPath: repo, board: 'demo', jobId: 'arch-1' })
    assert.equal(res.code, 0)
    const seen = readFakeOut(out)
    assert.deepEqual(seen.args, ['-p', 'seed text', '--mode', 'auto'], '存在しない --workspace は渡さない')
    assert.equal(seen.pwd, fs.realpathSync(repo), 'cwd はリポジトリ')
    // launchd の狭い PATH でも ~/.local/bin など既知の置き場所が補われる
    assert.ok(seen.path.split(path.delimiter).includes(path.join(os.homedir(), '.local', 'bin')), seen.path)
  } finally {
    delete process.env.HPA_FAKE_OUT
  }
})

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
    const { args, pwd } = readFakeOut(out)
    assert.deepEqual(args.slice(0, 6), ['kanban', '--board', 'demo', 'create', '[ARCH] 通知まとめの仕様化', '--json'])
    assert.ok(args.includes('--assignee') && args.includes('mobile'))
    const body = args[args.indexOf('--body') + 1]
    assert.match(body, /spec-architect/)
    assert.match(body, /Execution Contract/)
    assert.equal(pwd, fs.realpathSync(repo))
    // 0 終了＋JSON からタスク ID が取れる
    assert.equal(parseCreatedTask(res.stdout).id, 't_archfake')
  } finally {
    delete process.env.HPA_FAKE_OUT
  }
})

test('agy が非0終了したら同一ジョブ内で自動フォールバックする（fallbackFrom/taskId）', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      hasAgyCli: () => true,
      runner: async (args) => {
        calls.push(args.runnerId)
        if (args.runnerId === 'antigravity') return { code: 1, stdout: '', stderr: 'agy: unknown flag --mode' }
        return { code: 0, stdout: '{"id":"t_arch1"}', stderr: '' }
      },
    },
  )

  assert.equal((await arch.seed(seedInput(repo, { runner: 'antigravity' }))).ok, true)
  await settle()
  const snapshot = await arch.jobs({ board: 'demo' })
  const job = snapshot.jobs[0]
  assert.deepEqual(calls, ['antigravity', 'hermes'], 'fail したら同じジョブ内でカンバン起票へ切り替える')
  assert.equal(job.status, 'awaiting_spec', '停止せず進行を継続する')
  assert.equal(job.runner, 'hermes')
  assert.equal(job.runnerLabel, 'Hermes Native')
  assert.equal(job.requestedRunner, 'antigravity')
  assert.equal(job.fallbackFrom, 'antigravity')
  assert.match(job.fallbackReason, /^exit-1/)
  assert.equal(job.taskId, 't_arch1')
})

test('agy が 0 終了でも SPEC も Review タスクも無ければフォールバックする（空振り）', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      hasAgyCli: () => true,
      runner: async (args) => {
        calls.push(args.runnerId)
        if (args.runnerId === 'antigravity') return { code: 0, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  await arch.seed(seedInput(repo, { runner: 'antigravity' }))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.deepEqual(calls, ['antigravity', 'hermes'])
  assert.match(job.fallbackReason, /^no-output/)
  assert.equal(job.fallbackFrom, 'antigravity')
})

test('agy が 0 終了で SPEC を書いていればフォールバックしない', async () => {
  const repo = makeRepo()
  const calls = []
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      hasAgyCli: () => true,
      runner: async (args) => {
        calls.push(args.runnerId)
        writeSpec(repo, 'SPEC-AGY-OK.md', SPEC_TEXT, Date.now())
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  await arch.seed(seedInput(repo, { runner: 'antigravity' }))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.deepEqual(calls, ['antigravity'])
  assert.equal(job.fallbackFrom, null)
  assert.equal(job.status, 'spec_ready')
})

test('フォールバック先のカンバン起票も失敗したときだけ failed にする', async () => {
  const repo = makeRepo()
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      hasAgyCli: () => true,
      runner: async (args) =>
        args.runnerId === 'antigravity'
          ? { code: 3, stdout: '', stderr: 'agy: not authenticated' }
          : { code: 1, stdout: '', stderr: 'kanban: board not found' },
    },
  )
  await arch.seed(seedInput(repo, { runner: 'antigravity' }))
  await settle()
  const job = (await arch.jobs({ board: 'demo' })).jobs[0]
  assert.equal(job.status, 'failed')
  assert.match(job.error, /board not found/)
  assert.equal(job.fallbackFrom, 'antigravity')
})

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

test('ランナー設定は dataDir に保存され、壊れた JSON は既定へ戻る', async () => {
  const repo = makeRepo()
  const dataDir = path.join(repo, 'data')
  const arch = createArchitect({ reviewDir: path.join(repo, 'review'), dataDir }, { hasAgyCli: () => true })
  assert.equal(arch.getConfig().runner, 'hermes')
  assert.deepEqual(arch.setConfig({ runner: 'antigravity' }), { ok: true, runner: 'antigravity' })
  assert.equal(arch.getConfig().runner, 'antigravity')
  assert.equal(fs.statSync(path.join(dataDir, 'architect-config.json')).mode & 0o777, 0o600)

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

  const pending = pendingSpecs(specs, [{ id: 't1', title: '[B] two', status: 'running' }])
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

/** `body` 列を持つ合成カンバン DB を作る（本番スキーマと同じ列名）。 */
function makeKanbanBoard(dir, slug = 'demo') {
  const boardDir = path.join(dir, 'kanban', 'boards', slug)
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug, name: 'Demo' }))
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, status TEXT,
      priority INTEGER, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
      workspace_path TEXT, branch_name TEXT, worker_pid INTEGER, last_heartbeat_at INTEGER,
      result TEXT, consecutive_failures INTEGER, session_id TEXT, current_step_key TEXT)
  `)
  return { db, boardDir }
}

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

test('queueStateOf は ready と実行中を分ける（純関数）', () => {
  assert.equal(queueStateOf('ready'), 'queued')
  assert.equal(queueStateOf('todo'), 'queued')
  assert.equal(queueStateOf('running'), 'running')
  assert.equal(queueStateOf('claimed'), 'running')
  assert.equal(queueStateOf('done'), null)
  assert.equal(queueStateOf(undefined), null)
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

