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
  buildKanbanCreateArgs,
  buildSeedPrompt,
  computePhase,
  createArchitect,
  createCliRunner,
  executionModeLabel,
  filedBatchIds,
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
} from '../src/architect.js'
import { createKanban } from '../src/kanban.js'
import { parseCreatedTask } from '../src/specs.js'
import { LANGUAGE_RULE_EN, LANGUAGE_RULE_JA, LANGUAGE_RULE_MARKER } from '../src/language-rule.js'

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

test('buildArchitectTaskBody は Round 1 を JSON ファーストにし、既定でブラウザ撮影をさせない', () => {
  const body = buildArchitectTaskBody({ prompt: 'P', board: 'demo', repoPath: '/tmp/x', jobId: 'arch-1' })
  // Round 1 の主成果物は review/sheets/ 配下の JSON シート
  assert.match(body, /Round 1/)
  assert.match(body, /review\/sheets\//)
  assert.match(body, /spec-<slug>-1\.json/)
  assert.match(body, /"mode": "standard"/)
  assert.match(body, /mode=standard sheet=sheets\/spec-<slug>-1\.json/)
  // 手書き HTML・ヘッドレスブラウザ撮影は視覚比較が主題のときだけ
  assert.match(body, /bespoke HTML/)
  assert.match(body, /browser_exec/)
  assert.match(body, /visual UI layout comparison/)
  // 既存契約は維持される
  assert.match(body, /Round 2/)
  assert.match(body, /Mode: zero-stop/)
  assert.match(body, /Execution Policy: /)
  assert.match(body, /Board: demo/)
  assert.match(body, /Repository: \/tmp\/x/)
  assert.match(body, /### Batch <ID>: <Title>/)
  // 既定は en（SPEC-i18n-gen §3.1）。ja の見出しは lang='ja' のときだけ（下部の GEN-3 テスト）
  assert.match(body, /\*\*Objective\*\*.*\*\*Files\*\*.*\*\*Verify\*\*/)
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
