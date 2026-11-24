/**
 * A2B パイプライン E2E 結合回帰テスト。
 *
 * 実運用で再発した以下の連鎖不具合を実モジュール結合で検証する:
 * 1. `specs.BATCH_HEADING_RE` と `coherence.BATCH_HEADING_RE` の一致、および `—`/`–`/`-`/`:` 見出し解釈と誤認防止
 * 2. 親 `[ARCH]` が `blocked` のまま子 `[review]` が Round 2 を実行・完了したケース（`t_86fce022`/`t_4fd2fe67` 再現）
 * 3. 子 `[review]` が SPEC 無しで `done` / `failed` になったときに永久 `queued` 固着せず終端へ抜けること
 * 4. `tasks` テーブルが無い空 SQLite DB で `reviewWatcher.tick()` / `pipelineWatcher.tick()` が警告を出さないこと
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BATCH_HEADING_RE as SPECS_BATCH_RE, parseSpec, listSpecs, createSpecs } from '../src/specs.js'
import { BATCH_HEADING_RE as COH_BATCH_RE } from '../src/coherence.js'
import { createArchitect } from '../src/architect.js'
import { createKanban } from '../src/kanban.js'
import { createReview } from '../src/review.js'
import { createReviewWatcher } from '../src/review-watcher.js'
import { createPipelineWatcher } from '../src/pipeline-watcher.js'

function createKanbanDb(kanbanRoot, slug, { workdir = null, empty = false } = {}) {
  const bdir = path.join(kanbanRoot, 'boards', slug)
  fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(
    path.join(bdir, 'board.json'),
    JSON.stringify({ slug, name: slug, ...(workdir ? { default_workdir: workdir } : {}) }),
  )
  const dbPath = path.join(bdir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  if (!empty) {
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        body TEXT,
        status TEXT,
        priority INTEGER,
        assignee TEXT,
        created_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        workspace_path TEXT,
        branch_name TEXT,
        worker_pid INTEGER,
        last_heartbeat_at INTEGER,
        result TEXT,
        consecutive_failures INTEGER,
        session_id TEXT,
        current_step_key TEXT
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        kind TEXT,
        payload TEXT,
        created_at INTEGER
      );
      CREATE TABLE task_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        author TEXT,
        body TEXT,
        created_at INTEGER
      );
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        status TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        exit_code INTEGER
      );
    `)
  }
  return { db, dbPath }
}

function insertTask(db, row) {
  db.prepare(
    `INSERT INTO tasks (id, title, body, status, priority, assignee, created_at, started_at, completed_at, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title ?? '',
    row.body ?? '',
    row.status ?? 'ready',
    row.priority ?? 1,
    row.assignee ?? '',
    row.created_at ?? 1_700_000_000,
    row.started_at ?? null,
    row.completed_at ?? null,
    row.result ?? null,
  )
}

test('specs と coherence の BATCH_HEADING_RE が一致し、ダッシュ区切り受理と非バッチ見出し除外を満たす', () => {
  assert.equal(SPECS_BATCH_RE.source, COH_BATCH_RE.source)

  const sample = [
    '# SPEC: Dash & Colon',
    '',
    '### 3.1 節見出し（番号なので無視）',
    '### A. 付録（ドット付きなので無視）',
    '### 回答 A からの差分（日本語散文なので無視）',
    '### MRG-1 — Em dash batch',
    '- **Execution Mode**: `[Mode: Zero-Stop]`',
    '- **目的**: エムダッシュ区切りを読む',
    '### Batch SHARE280-1 — Batch + em dash',
    '- **Execution Mode**: `[Mode: Fast-Track Review]`',
    '### MRG-2: Colon batch',
    '- **Execution Mode**: `[Mode: Visual Gate]`',
  ].join('\n')

  const parsed = parseSpec(sample)
  assert.deepEqual(
    parsed.batches.map((b) => ({ id: b.id, mode: b.mode })),
    [
      { id: 'MRG-1', mode: 'zero-stop' },
      { id: 'SHARE280-1', mode: 'fast-track-review' },
      { id: 'MRG-2', mode: 'visual-gate' },
    ],
  )
})

test('E2E: 親 [ARCH] が blocked 残置でも子 [review] で Round 2 実行 → SPEC 完成 → 一括起票まで完走する', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-a2b-e2e-'))
  try {
    const pluginDataDir = path.join(root, '.hermes', 'plugin-data', 'hermes-pilot')
    const kanbanRoot = path.join(root, '.hermes', 'kanban')
    const reviewDir = path.join(pluginDataDir, 'review')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(reviewDir, 'sheets'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })

    const { db, dbPath } = createKanbanDb(kanbanRoot, 'hermes-pilot', { workdir: repo })
    db.close()

    const nowSec = 1_700_000_000
    const nowMs = nowSec * 1000
    const kanban = createKanban({ kanbanRoot, kanbanDb: dbPath })
    const launchedCalls = []

    const arch = createArchitect(
      { reviewDir, dataDir: pluginDataDir },
      {
        now: () => nowMs,
        readTasks: (slug) => kanban.tasks(slug, { limit: 200 }),
        runner: async () => ({ code: 0, stdout: '{"id":"t_arch_blk"}', stderr: '' }),
      },
    )

    const review = createReview(
      { kanbanRoot, pluginDataDir, kanbanDb: path.join(root, 'missing.db') },
      {
        assignee: () => 'pilot-e2e',
        runKanban: async (args, targetBoard) => {
          const d = new DatabaseSync(dbPath)
          try {
            if (args[0] === 'unblock') {
              d.prepare("UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'blocked'").run(args[1])
            } else if (args[0] === 'comment') {
              d.prepare('INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)').run(
                args[1],
                'mobile',
                args[2],
                nowSec + 10,
              )
            } else if (args[0] === 'assign') {
              d.prepare('UPDATE tasks SET assignee = ? WHERE id = ?').run(args[2], args[1])
            }
          } finally {
            d.close()
          }
          return { code: 0, stdout: `ok:${targetBoard}`, stderr: '' }
        },
      },
    )

    // 1) Seed 投入 → 親 [ARCH] が blocked、子 [review] がシート実体付きで blocked
    const seedRes = await arch.seed({ board: 'hermes-pilot', repoPath: repo, seedText: 'Split hotspot modules' })
    assert.equal(seedRes.ok, true)
    await new Promise((r) => setTimeout(r, 20))

    fs.writeFileSync(
      path.join(reviewDir, 'sheets', 'spec-e2e-1.json'),
      JSON.stringify({
        title: 'Q1-Q2',
        questions: [{ id: 'q1', text: 'Split style?', options: [{ id: 'A', label: 'Barrel', recommended: true }] }],
      }),
    )
    const d1 = new DatabaseSync(dbPath)
    insertTask(d1, {
      id: 't_arch_blk',
      title: '[ARCH] Split hotspot modules',
      body: `[hermes-pilot:architect job=${seedRes.jobId}]`,
      status: 'blocked',
      assignee: 'pilot-e2e',
      created_at: nowSec,
    })
    insertTask(d1, {
      id: 't_rev_child',
      title: 'Q1-Q2: Split hotspot modules',
      body: '[review] label=spec-e2e round=1 mode=standard sheet=sheets/spec-e2e-1.json',
      status: 'blocked',
      assignee: 'pilot-e2e',
      created_at: nowSec + 5,
    })
    d1.close()

    let snap = await arch.jobs({ board: 'hermes-pilot' })
    assert.equal(snap.jobs[0].status, 'awaiting_review')
    assert.equal(snap.jobs[0].reviewTaskId, 't_rev_child')
    assert.equal(snap.jobs[0].reviewBoard, 'hermes-pilot')

    // 2) レビュー回答 → 子が running の間は phase=round2_spec / queueState='running' / stage='running'、途中 SPEC は確定させない
    const ans = await review.answer('t_rev_child', { answers: [{ id: 'q1', choice: 'A' }], global: '' }, 'en')
    assert.equal(ans.ok, true)
    const d2 = new DatabaseSync(dbPath)
    d2.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(nowSec + 20, 't_rev_child')
    d2.close()

    const specPath = path.join(repo, 'docs', 'SPEC-e2e-split.md')
    fs.writeFileSync(specPath, '# SPEC: E2E Partial\n\n### E2E-1 — First\n- **Execution Mode**: `[Mode: Zero-Stop]`\n')
    fs.utimesSync(specPath, nowSec + 25, nowSec + 25)

    snap = await arch.jobs({ board: 'hermes-pilot' })
    assert.equal(snap.jobs[0].status, 'awaiting_spec')
    assert.equal(snap.jobs[0].phase, 'round2_spec')
    assert.equal(snap.jobs[0].queueState, 'running', '子が running なのに親の blocked=queued に戻さない')
    assert.equal(snap.jobs[0].stage, 'running')
    assert.equal(snap.specReady.length, 0, '執筆中に部分 SPEC を確定しない')

    // 3) 子 [review] がダッシュ見出し付き SPEC を書いて done（親 [ARCH] は blocked のまま）→ 即 spec_ready！
    fs.writeFileSync(
      specPath,
      [
        '# SPEC: E2E Final',
        '',
        '### E2E-1 — First',
        '- **Execution Mode**: `[Mode: Zero-Stop]`',
        '- **目的**: first',
        '',
        '### E2E-2 — Second',
        '- **Execution Mode**: `[Mode: Zero-Stop]`',
        '- **目的**: second',
      ].join('\n'),
    )
    fs.utimesSync(specPath, nowSec + 40, nowSec + 40)
    const d3 = new DatabaseSync(dbPath)
    d3.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(nowSec + 45, 't_rev_child')
    d3.close()

    snap = await arch.jobs({ board: 'hermes-pilot' })
    assert.equal(snap.specReady.length, 1, '親が blocked でも子 done + SPEC 実在で spec_ready になる')
    assert.equal(snap.specReady[0].batchCount, 2)

    // 4) createSpecs.launchSpec が 2 バッチを configured assignee で起票できる
    const specsApi = createSpecs(
      { reviewDir },
      {
        tasks: (slug) => kanban.tasks(slug, { limit: 200 }),
        listSpecs,
        runner: async (args) => {
          launchedCalls.push(args)
          return { code: 0, stdout: JSON.stringify({ id: `t_b${launchedCalls.length}` }), stderr: '' }
        },
      },
    )
    const launch = await specsApi.launchSpec({
      repoPath: repo,
      board: 'hermes-pilot',
      specRelPath: snap.specReady[0].spec,
      assignee: 'pilot-e2e',
    })
    assert.equal(launch.ok, true)
    assert.equal(launch.created.length, 2)
    assert.ok(launchedCalls.every((a) => a.includes('--assignee') && a.includes('pilot-e2e')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('親 blocked + 子 [review] が SPEC 無しで done / failed のとき永久 queued に残らない', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-a2b-term-'))
  try {
    const reviewDir = path.join(root, 'review')
    const sheetsDir = path.join(reviewDir, 'sheets')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(sheetsDir, { recursive: true })
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(sheetsDir, 's-1.json'),
      JSON.stringify({ title: 'Q', questions: [{ id: 'q1', text: '?', options: [{ id: 'A', label: 'A' }] }] }),
    )

    const clock = 1_700_000_000_000
    let seq = 0
    const boards = { demo: [] }
    const arch = createArchitect(
      { reviewDir },
      {
        now: () => clock,
        runner: async () => ({ code: 0, stdout: JSON.stringify({ id: `t_a${++seq}` }), stderr: '' }),
        readTasks: (b) => boards[b] ?? [],
      },
    )

    // Case A: 子 [review] が SPEC なしで done
    await arch.seed({ board: 'demo', repoPath: repo, seedText: 'No spec done' })
    await new Promise((r) => setTimeout(r, 20))
    boards.demo = [
      { id: 't_a1', title: '[ARCH] A', body: '', status: 'blocked', createdAt: clock },
      { id: 't_r1', title: '[review] R1', body: '[review] label=s round=1 mode=standard sheet=sheets/s-1.json', status: 'blocked', createdAt: clock + 500 },
    ]
    await arch.jobs({ board: 'demo' }) // awaiting_review (reviewSeenOnce=true)
    boards.demo[1].status = 'done'
    let snap = await arch.jobs({ board: 'demo' })
    assert.equal(snap.jobs.length, 0, 'SPEC 無し子 done でアクティブ一覧に queued 残置しない')

    // Case B: 子 [review] が failed → job.status === 'failed'
    await arch.seed({ board: 'demo', repoPath: repo, seedText: 'Child failed' })
    await new Promise((r) => setTimeout(r, 20))
    boards.demo = [
      { id: 't_a2', title: '[ARCH] B', body: '', status: 'blocked', createdAt: clock + 1000 },
      { id: 't_r2', title: '[review] R2', body: '[review] label=s round=1 mode=standard sheet=sheets/s-1.json', status: 'blocked', createdAt: clock + 1500 },
    ]
    await arch.jobs({ board: 'demo' })
    boards.demo[1].status = 'failed'
    boards.demo[1].result = 'worker crashed in Round 2'
    snap = await arch.jobs({ board: 'demo' })
    assert.equal(snap.jobs.length, 1)
    assert.equal(snap.jobs[0].status, 'failed')
    assert.match(snap.jobs[0].error, /worker crashed in Round 2/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tasks テーブルの無い空 SQLite DB でも reviewWatcher / pipelineWatcher が warn を出さない', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-empty-db-'))
  const origWarn = console.warn
  const warns = []
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    const pluginDataDir = path.join(root, '.hermes', 'plugin-data', 'hermes-pilot')
    const kanbanRoot = path.join(root, '.hermes', 'kanban')
    const { db, dbPath } = createKanbanDb(kanbanRoot, 'empty-board', { empty: true })
    db.close()

    const rw = createReviewWatcher({ kanbanRoot, pluginDataDir }, { dbPaths: [{ board: 'empty-board', path: dbPath }] })
    await rw.tick()
    const pw = createPipelineWatcher({ kanbanRoot, pluginDataDir }, { dbPaths: [{ board: 'empty-board', path: dbPath }] })
    await pw.tick()

    assert.deepEqual(warns, [])
  } finally {
    console.warn = origWarn
    fs.rmSync(root, { recursive: true, force: true })
  }
})
