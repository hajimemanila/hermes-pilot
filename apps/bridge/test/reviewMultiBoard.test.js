/**
 * マルチボード Review / コールドインストール互換性の回帰テスト。
 *
 * - `mobile` ボードが存在しない環境（別スラッグ `my-app` のみ）で
 *   `list` / `sheetData` / `answer` / `approve` / `saveAnnotation` / `createFromImage` が動くこと。
 * - 複数ボード混在時（`mobile` + `my-app`）に、回答・検収・CLI 呼び出しが各タスクの実ボードへ届くこと。
 * - `createFromImage` が Git リポジトリ配下を汚さず `reviewRoot()` へ保存すること。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createReview } from '../src/review.js'

const TINY_PNG_DATA =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function createBoard(kanbanRoot, slug, { name = slug, workdir = null, current = false } = {}) {
  const bdir = path.join(kanbanRoot, 'boards', slug)
  fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(
    path.join(bdir, 'board.json'),
    JSON.stringify({ slug, name, ...(workdir ? { default_workdir: workdir } : {}) }),
  )
  if (current) fs.writeFileSync(path.join(kanbanRoot, 'current'), `${slug}\n`)

  const dbPath = path.join(bdir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
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
      result TEXT,
      last_heartbeat_at INTEGER,
      session_id TEXT
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      kind TEXT,
      payload TEXT,
      created_at INTEGER
    );
  `)
  return db
}

function insertTask(db, row) {
  db.prepare(
    `INSERT INTO tasks (id, title, body, status, priority, assignee, created_at, started_at, completed_at, result, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title ?? 'Task',
    row.body ?? '',
    row.status ?? 'blocked',
    row.priority ?? 1,
    row.assignee ?? '',
    row.created_at ?? 1_700_000_000,
    row.started_at ?? null,
    row.completed_at ?? null,
    row.result ?? null,
    row.session_id ?? null,
  )
}

test('mobile ボード非存在のコールドインストール環境でも my-app で全 Review 操作が成立する', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rev-cold-'))
  try {
    const pluginDataDir = path.join(root, '.hermes', 'plugin-data', 'hermes-pilot')
    const kanbanRoot = path.join(root, '.hermes', 'kanban')
    const reviewRoot = path.join(pluginDataDir, 'review')
    const repoDir = path.join(root, 'my-app')
    fs.mkdirSync(path.join(reviewRoot, 'sheets'), { recursive: true })
    fs.mkdirSync(path.join(reviewRoot, 'shots'), { recursive: true })
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })

    fs.writeFileSync(
      path.join(reviewRoot, 'sheets', 'q-cold-1.json'),
      JSON.stringify({
        title: 'Cold install Q',
        questions: [{ id: 'q1', text: 'Proceed?', options: [{ id: 'A', label: 'Yes', recommended: true }] }],
      }),
    )
    fs.writeFileSync(
      path.join(reviewRoot, 'shots', 'ui-cold-1.png'),
      Buffer.from(TINY_PNG_DATA.split(',')[1], 'base64'),
    )

    const db = createBoard(kanbanRoot, 'my-app', { name: 'My App', workdir: repoDir, current: true })
    try {
      insertTask(db, {
        id: 't_coldq001',
        title: '[review] Cold Q',
        body: `[review] label=q-cold round=1 mode=standard sheet=sheets/q-cold-1.json target=${repoDir}`,
        status: 'blocked',
        assignee: 'pilot-alt',
      })
      insertTask(db, {
        id: 't_colda001',
        title: '[review] Cold Annotation',
        body: `[review] label=ui-cold round=1 mode=annotation image=shots/ui-cold-1.png target=${repoDir}`,
        status: 'blocked',
        assignee: '',
      })
    } finally {
      db.close()
    }

    const cliCalls = []
    let seq = 0
    const review = createReview(
      { kanbanRoot, pluginDataDir, kanbanDb: path.join(root, 'missing.db') },
      {
        assignee: () => 'pilot-alt',
        targets: () => [{ id: 'my-app', label: 'my-app', path: repoDir }],
        runKanban: async (args, targetBoard) => {
          cliCalls.push({ board: targetBoard, args })
          if (args[0] === 'create') {
            seq += 1
            return { code: 0, stdout: `created t_${String(seq).padStart(8, '0')}`, stderr: '' }
          }
          return { code: 0, stdout: 'ok', stderr: '' }
        },
      },
    )

    // 1) mobile 無しでも my-app のアイテムを返し、board が my-app になる
    const items = review.list(20)
    assert.equal(items.length, 2)
    assert.ok(items.every((it) => it.board === 'my-app'))

    // 2) sheetData / answer が my-app へルーティングされる
    const sdata = review.sheetData('t_coldq001')
    assert.equal(sdata.ok, true)
    assert.equal(sdata.data.title, 'Cold Q'.replace('Cold Q', 'Cold install Q'))

    const ans = await review.answer('t_coldq001', { answers: [{ id: 'q1', choice: 'A' }], global: 'go' }, 'en')
    assert.equal(ans.ok, true)
    assert.ok(fs.existsSync(path.join(reviewRoot, 'sheets', 'q-cold-1.answer.json')))
    assert.ok(cliCalls.some((c) => c.board === 'my-app' && c.args[0] === 'unblock' && c.args[1] === 't_coldq001'))

    // 3) saveAnnotation は未割当タスクに assignee を自動付与し my-app へ投げる
    const ann = await review.saveAnnotation(
      't_colda001',
      { annotated_image: TINY_PNG_DATA, marks: [{ tool: 'rect', points: [[0.1, 0.1], [0.2, 0.2]] }], note: 'fix box' },
      'en',
    )
    assert.equal(ann.ok, true)
    assert.equal(ann.assigned, 'pilot-alt')
    assert.ok(fs.existsSync(path.join(reviewRoot, 'shots', 'ui-cold-1.annotation.json')))
    assert.ok(cliCalls.some((c) => c.board === 'my-app' && c.args[0] === 'assign' && c.args[2] === 'pilot-alt'))

    // 4) approve が my-app で実行される
    const dbApprove = new DatabaseSync(path.join(kanbanRoot, 'boards', 'my-app', 'kanban.db'))
    try {
      insertTask(dbApprove, {
        id: 't_coldv001',
        title: '[review] Approve check',
        body: `[review] label=ui-cold round=1 mode=annotation image=shots/ui-cold-1.png target=${repoDir}`,
        status: 'blocked',
        assignee: 'pilot-alt',
      })
    } finally {
      dbApprove.close()
    }
    const app = await review.approve('t_coldv001', { note: 'lgtm' })
    assert.equal(app.ok, true)
    assert.ok(cliCalls.some((c) => c.board === 'my-app' && c.args[0] === 'complete' && c.args[1] === 't_coldv001'))

    // 5) createFromImage が Git リポを汚さず reviewRoot() へ書き、board: 'my-app' で作成する
    const created = await review.createFromImage({ source: 'upload', image: TINY_PNG_DATA, title: 'Fix header', target: repoDir })
    assert.equal(created.ok, true)
    assert.equal(created.board, 'my-app')
    assert.ok(fs.existsSync(path.join(reviewRoot, created.image)))
    assert.equal(fs.existsSync(path.join(repoDir, 'review')), false, 'Git リポジトリ内に review/ を作らない')
    assert.ok(cliCalls.some((c) => c.board === 'my-app' && c.args[0] === 'create' && c.args.includes('pilot-alt')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('mobile と別ボードの混在時に、それぞれの実ボードへ回答・検収がルーティングされる', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rev-mix-'))
  try {
    const pluginDataDir = path.join(root, '.hermes', 'plugin-data', 'hermes-pilot')
    const kanbanRoot = path.join(root, '.hermes', 'kanban')
    const reviewRoot = path.join(pluginDataDir, 'review')
    fs.mkdirSync(path.join(reviewRoot, 'sheets'), { recursive: true })
    fs.writeFileSync(
      path.join(reviewRoot, 'sheets', 'mix-1.json'),
      JSON.stringify({ title: 'Mix', questions: [{ id: 'q1', text: '?', options: [{ id: 'A', label: 'A' }] }] }),
    )

    const dbMob = createBoard(kanbanRoot, 'mobile', { name: 'Mobile' })
    const dbApp = createBoard(kanbanRoot, 'my-app', { name: 'My App', current: true })
    try {
      insertTask(dbMob, {
        id: 't_mob00001',
        title: '[review] Mob task',
        body: '[review] label=mix round=1 mode=standard sheet=sheets/mix-1.json',
        status: 'blocked',
        assignee: 'mobile',
        created_at: 1_700_000_010,
      })
      insertTask(dbApp, {
        id: 't_app00001',
        title: '[review] App task',
        body: '[review] label=mix round=1 mode=standard sheet=sheets/mix-1.json',
        status: 'blocked',
        assignee: 'mobile',
        created_at: 1_700_000_020,
      })
    } finally {
      dbMob.close()
      dbApp.close()
    }

    const routed = []
    const review = createReview(
      { kanbanRoot, pluginDataDir, kanbanDb: path.join(root, 'missing.db') },
      {
        runKanban: async (args, targetBoard) => {
          routed.push({ board: targetBoard, verb: args[0], id: args[1] })
          return { code: 0, stdout: 'ok', stderr: '' }
        },
      },
    )

    const list = review.list(20)
    assert.equal(list.length, 2)
    assert.equal(list.find((x) => x.id === 't_mob00001')?.board, 'mobile')
    assert.equal(list.find((x) => x.id === 't_app00001')?.board, 'my-app')

    await review.answer('t_app00001', { answers: [{ id: 'q1', choice: 'A' }], global: 'app' }, 'en')
    await review.answer('t_mob00001', { answers: [{ id: 'q1', choice: 'A' }], global: 'mob' }, 'en')

    assert.ok(routed.some((r) => r.board === 'my-app' && r.verb === 'unblock' && r.id === 't_app00001'))
    assert.ok(routed.some((r) => r.board === 'mobile' && r.verb === 'unblock' && r.id === 't_mob00001'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
