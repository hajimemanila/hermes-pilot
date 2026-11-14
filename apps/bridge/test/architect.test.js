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
import { fileURLToPath } from 'node:url'
import {
  BOARD_RE,
  RUNNER_LABELS,
  SPEC_LAUNCH_KIND,
  SPEC_READY_KIND,
  buildSeedPrompt,
  createArchitect,
  findJobSpec,
  makeJobId,
  normalizeSeed,
  pendingSpecs,
  publicJob,
  runnerLabel,
  sanitizeRunner,
} from '../src/architect.js'

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
