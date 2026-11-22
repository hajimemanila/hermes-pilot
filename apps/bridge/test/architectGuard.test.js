/**
 * 実機バグハント由来の Architect / SPEC 状態遷移ガード（問題②・③・⑤ + D105）の回帰テスト。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createArchitect, makeJobId, seedHashOf } from '../src/architect.js'
import { SPEC_TEXT, makeRepo, seedInput, settle, writeSpec } from './helpers/architectFixtures.js'

const FIVE_BATCH_SPEC = [
  '# SPEC: Full 5 Batches',
  '',
  '### Batch FB-1: First',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 1',
  '',
  '### Batch FB-2: Second',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 2',
  '',
  '### Batch FB-3: Third',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 3',
  '',
  '### Batch FB-4: Fourth',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 4',
  '',
  '### Batch FB-5: Fifth',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 5',
  '',
].join('\n')

test('問題②: sheet= の [review] タスクでも実シート JSON 不在や非 mobile ボードでは awaiting_review にしない', async () => {
  const repo = makeRepo()
  const reviewDir = path.join(repo, 'review')
  const sheetsDir = path.join(reviewDir, 'sheets')
  fs.mkdirSync(sheetsDir, { recursive: true })
  const clock = 1_700_000_000_000
  let tasksByBoard = { demo: [], mobile: [] }
  const arch = createArchitect(
    { reviewDir },
    {
      now: () => clock,
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch_p2"}', stderr: '' }),
      readTasks: (b) => tasksByBoard[b] ?? [],
    },
  )

  await arch.seed(seedInput(repo))
  await settle()

  // [ARCH] 本文に `[review]` 文字列を含み blocked になっても false-positive しない + sheet 不在の blocked でも出さない
  tasksByBoard = {
    demo: [
      {
        id: 't_arch_p2',
        title: '[ARCH] Test',
        body: '[hermes-pilot:architect job=arch-1]\n[review] prompt mention',
        status: 'blocked',
        createdAt: clock,
      },
      {
        id: 't_rev_wrong_board',
        title: '[review] Wrong board',
        body: '[review] label=demo-01 round=1 mode=standard sheet=sheets/demo-01-1.html',
        status: 'blocked',
        createdAt: clock + 1000,
      },
    ],
    mobile: [
      {
        id: 't_rev_premature',
        title: '[review] Early blocked',
        body: '[review] label=demo-01 round=1 mode=standard sheet=sheets/demo-01-1.html',
        status: 'blocked',
        createdAt: clock + 1000,
      },
    ],
  }
  let snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs[0].status, 'awaiting_spec', '実シート未生成の間は awaiting_review に進めない')

  // 実シート JSON を書き出すと mobile ボード上の [review] が awaiting_review になる
  fs.writeFileSync(
    path.join(sheetsDir, 'demo-01-1.json'),
    JSON.stringify({ title: 'Q', questions: [{ id: 'q1', text: '?', options: [{ id: 'A', label: 'A' }] }] }),
  )
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs[0].status, 'awaiting_review')
  assert.equal(snap.jobs[0].reviewTaskId, 't_rev_premature')
})

test('問題⑤: Round 2 執筆中（[ARCH] または [review] ワーカー稼働中）は途中保存 SPEC を spec_ready/pending に出さない', async () => {
  const repo = makeRepo()
  const reviewDir = path.join(repo, 'review')
  const sheetsDir = path.join(reviewDir, 'sheets')
  fs.mkdirSync(sheetsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sheetsDir, 'r2-1.json'),
    JSON.stringify({ title: 'Q', questions: [{ id: 'q1', text: '?', options: [{ id: 'A', label: 'A' }] }] }),
  )
  const clock = 1_700_000_000_000
  let tasksByBoard = {
    demo: [{ id: 't_arch_r2', title: '[ARCH] Writer', status: 'done', createdAt: clock }],
    mobile: [
      {
        id: 't_rev_r2',
        title: '[review] Round 2 writing',
        body: '[review] label=r2 round=1 mode=standard sheet=sheets/r2-1.html',
        status: 'blocked',
        createdAt: clock + 1000,
      },
    ],
  }
  const arch = createArchitect(
    { reviewDir },
    {
      now: () => clock,
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch_r2"}', stderr: '' }),
      readTasks: (b) => tasksByBoard[b] ?? [],
    },
  )

  await arch.seed(seedInput(repo, { seedText: 'Round2 test feature' }))
  await settle()
  await arch.jobs({ board: 'demo' }) // awaiting_review を一度観測（reviewSeenOnce=true）

  // 回答後、Round 2 ワーカーが running 中に 2 バッチだけ書きかけの SPEC が保存された
  tasksByBoard.mobile[0].status = 'running'
  const specRel = writeSpec(repo, 'SPEC-round2.md', SPEC_TEXT, clock + 5000)

  let snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs[0].status, 'awaiting_spec', '執筆中の書きかけ SPEC はフライング確定しない')
  assert.equal(snap.specReady.length, 0)
  assert.equal(snap.pending.length, 0)

  // 執筆ワーカーが 5 バッチまで書き終えて done になると全 5 バッチで確定する
  writeSpec(repo, 'SPEC-round2.md', FIVE_BATCH_SPEC, clock + 9000)
  tasksByBoard.mobile[0].status = 'done'
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs[0].status, 'spec_ready')
  assert.equal(snap.specReady.length, 1)
  assert.equal(snap.specReady[0].spec, specRel)
  assert.equal(snap.specReady[0].batchCount, 5)
})

test('問題③: 手動でバッチを全件起票したら spec_ready ジョブも自動で launched に閉じる', async () => {
  const repo = makeRepo()
  const clock = 1_700_000_000_000
  let tasks = [{ id: 't_arch_m', title: '[ARCH] Manual launch', status: 'done', createdAt: clock }]
  const arch = createArchitect(
    { reviewDir: path.join(repo, 'review') },
    {
      now: () => clock,
      runner: async () => ({ code: 0, stdout: '{"id":"t_arch_m"}', stderr: '' }),
      readTasks: () => tasks,
    },
  )
  await arch.seed(seedInput(repo))
  await settle()
  const specRel = writeSpec(repo, 'SPEC-manual.md', SPEC_TEXT, clock + 2000)

  let snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.specReady.length, 1)
  assert.equal(snap.specReady[0].batchCount, 2)

  // ユーザーが手動で Spec Launchpad から全バッチ起票した
  tasks = [
    ...tasks,
    { id: 't_b1', title: '[D-1] One', body: `Spec: ${specRel}`, status: 'running', createdAt: clock + 5000 },
    { id: 't_b2', title: '[D-2] Two', body: `Spec: ${specRel}`, status: 'ready', createdAt: clock + 5000 },
  ]
  snap = await arch.jobs({ board: 'demo' })
  assert.equal(snap.jobs[0].status, 'launched', '未起票が 0 件なら自動で launched へ遷移する')
  assert.equal(snap.specReady[0].launched, true, 'launched:true でフロント側の起票バナーを消す')
  assert.equal(snap.pending.length, 0)
})

test('D105: makeJobId の seedHash 埋め込みと Retry を殺さない永続 dismiss', async () => {
  const repo = makeRepo()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-arch-d105-'))
  try {
    let clock = 1_700_000_000_000
    let seq = 0
    const arch = createArchitect(
      { dataDir, reviewDir: path.join(repo, 'review') },
      {
        now: () => clock,
        runner: async () => ({ code: 0, stdout: JSON.stringify({ id: `t_a${++seq}` }), stderr: '' }),
        readTasks: () => [],
      },
    )

    const h = seedHashOf('  Same\r\nSeed  ')
    assert.equal(h, seedHashOf('Same\nSeed'))
    const jid = makeJobId(clock, () => 0.5, h)
    assert.equal(jid.split('-')[2], h)

    // 1 本目を seed → failed 相当 / 再試行で 2 本目を作成 → 1 本目を dismiss しても 2 本目は消えない
    const r1 = await arch.seed(seedInput(repo, { seedText: 'Retry same seed text' }))
    clock += 1000
    const r2 = await arch.seed(seedInput(repo, { seedText: 'Retry same seed text' }))
    await settle()
    const d = arch.dismiss(r1.jobId)
    assert.equal(d.ok, true)
    assert.equal(d.persisted, true)

    const vis = (await arch.jobs({ board: 'demo' })).jobs
    assert.equal(vis.length, 1)
    assert.equal(vis[0].id, r2.jobId, '実行中の Retry ジョブは旧ジョブの dismiss で隠されない')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
