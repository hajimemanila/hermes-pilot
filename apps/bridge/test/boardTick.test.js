/**
 * 盤面ティック（`apps/bridge/src/board-tick.js`）のテスト。D110 / SPEC-COHERENCE-RESIDUAL-DRIFT §4 DRF-5
 *
 * 検証する 6 点:
 *  ① `snapshot` の行に `BOARD_ROW_COLUMNS` が全列そろう（review の `[review]` 判定と
 *     pipeline のグループ判定が同じ行で成立する）
 *  ② 1 回の走査を 2 購読者が受け取る（同じオブジェクト・同じ `changes`）
 *  ③ 同じタスクの `running → blocked` が `changes` に 1 件だけ載る（from / to / kind）
 *  ④ 読み取りは `readOnly` のみ（D55）
 *  ⑤ タイマーは 1 本だけ（`board-tick.js`）で、`server.js` と watcher には無い
 *  ⑥ 監視対象 DB の列挙（ボード DB ＋ ルート DB）は board-tick が持つ
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BOARD_ROW_COLUMNS,
  boardDbPaths,
  createBoardTick,
} from '../src/board-tick.js'
import { isReviewBody, specRelFromBody, createPipelineWatcher } from '../src/pipeline-watcher.js'
import { createReviewWatcher } from '../src/review-watcher.js'
import { parseReviewLine } from '../src/review.js'

const SRC = path.dirname(new URL(import.meta.url).pathname)
const BRIDGE_SRC = path.resolve(SRC, '../src')

/** 一時環境（kanban/boards/mobile/kanban.db ＋ ルート kanban.db）。 */
function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-tick-'))
  const kanbanRoot = path.join(root, 'kanban')
  const boardDir = path.join(kanbanRoot, 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile' }))
  const dbPath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
    result TEXT, session_id TEXT)`)
  db.close()
  return { root, kanbanRoot, dbPath }
}

function addTask(dbPath, task) {
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO tasks (id,title,body,status,created_at,started_at,completed_at,result,session_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    task.id,
    task.title ?? 'タスク',
    task.body ?? '',
    task.status ?? 'ready',
    task.createdAt ?? 1_765_000_000,
    task.startedAt ?? null,
    task.completedAt ?? null,
    task.result ?? null,
    task.sessionId ?? null,
  )
  db.close()
}

function setStatus(dbPath, id, status) {
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id)
  db.close()
}

/** JSONL を読む（無ければ空）。 */
function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** 一時環境の 1 本だけを見るティック。 */
function makeTick(env, opts = {}) {
  return createBoardTick(
    { kanbanRoot: env.kanbanRoot },
    { dbPaths: [{ board: 'mobile', path: env.dbPath }], logger: { warn: () => {} }, ...opts },
  )
}

test('① snapshot の行は BOARD_ROW_COLUMNS を全列持ち、review と pipeline が同じ行で判定できる', () => {
  const env = tempEnv()
  addTask(env.dbPath, {
    id: 't_both',
    title: '共通の行',
    status: 'running',
    body: '[review] label=x-01 round=1\nSpec: docs/SPEC-x.md\nChat: 20260101_120000_cafebabe',
  })
  const snap = makeTick(env).tick()

  assert.equal(snap.rows.length, 1)
  const row = snap.rows[0]
  for (const column of BOARD_ROW_COLUMNS) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, column), `${column} が行に無い`)
  }
  assert.equal(row.board, 'mobile', 'ボード名も行に載る')
  // review 側の判定（本文の機械可読行）と pipeline 側の判定（Spec: 行・レビュー除外）が同じ行で成立する
  assert.equal(parseReviewLine(row.body)?.label, 'x-01')
  assert.equal(specRelFromBody(row.body), 'docs/SPEC-x.md')
  assert.equal(isReviewBody(row.body), true)
})

test('② 1 回の走査を 2 購読者が同じスナップショットで受け取る', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_two', status: 'running', body: '[review] label=x-02' })
  const bt = makeTick(env)
  const seen = []
  bt.subscribe((snapshot) => seen.push(['review', snapshot]))
  bt.subscribe((snapshot) => seen.push(['pipeline', snapshot]))

  const snapshot = bt.tick()
  assert.equal(seen.length, 2, '2 購読者に配る')
  assert.equal(seen[0][1], snapshot, '同じオブジェクト（同じ根拠）')
  assert.equal(seen[1][1], snapshot)
  assert.equal(bt.status().ticks, 1, '読み取りは 1 回（購読ごとに読み直さない）')
})

test('③ running → blocked が changes に 1 件だけ載り、両購読者が同じ from/to を見る', () => {
  const env = tempEnv()
  addTask(env.dbPath, {
    id: 't_blk',
    title: '2 巡目',
    status: 'running',
    body: '[review] label=r2-01 round=2 chat=chat-b',
  })
  const bt = makeTick(env)
  const review = []
  const pipeline = []
  bt.subscribe((snapshot) => review.push(snapshot))
  bt.subscribe((snapshot) => pipeline.push(snapshot))

  const baseline = bt.tick()
  assert.deepEqual(
    baseline.changes.map((c) => [c.id, c.kind, c.to]),
    [['t_blk', 'new', 'running']],
    '初回は new だけ（遡って通知しない）',
  )

  setStatus(env.dbPath, 't_blk', 'blocked')
  const second = bt.tick()
  assert.deepEqual(
    second.changes.map((c) => ({ id: c.id, kind: c.kind, from: c.from, to: c.to })),
    [{ id: 't_blk', kind: 'status', from: 'running', to: 'blocked' }],
  )
  assert.equal(review[1], second)
  assert.equal(pipeline[1], second)
  assert.deepEqual(pipeline[1].changes, review[1].changes, '同じ差分を見る')

  // 状態が変わらなければ差分は空（同じ遷移を 2 度通知しない根拠）
  assert.deepEqual(bt.tick().changes, [])
})

test('③b アーカイブ済みは走査の対象外（どちらの購読者も集計しない）', () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_live', status: 'running' })
  addTask(env.dbPath, { id: 't_arch', status: 'archived' })
  const snap = makeTick(env).tick()
  assert.deepEqual(snap.rows.map((r) => r.id), ['t_live'])
})

test('④ 読み取り専用: board-tick 以外は DB を開かず、board-tick は readOnly だけを使う', () => {
  const owner = fs.readFileSync(path.join(BRIDGE_SRC, 'board-tick.js'), 'utf8')
  const opens = owner.match(/new DatabaseSync\([^)]*\)/g) ?? []
  assert.ok(opens.length >= 1, 'board-tick は DB を開く（読み取りの唯一の場所）')
  for (const call of opens) assert.match(call, /readOnly:\s*true/, `${call} に readOnly が無い`)

  for (const name of ['review-watcher.js', 'pipeline-watcher.js']) {
    const src = fs.readFileSync(path.join(BRIDGE_SRC, name), 'utf8')
    assert.equal((src.match(/new DatabaseSync\(/g) ?? []).length, 0, `${name} が DB を開いている`)
    assert.equal((src.match(/setInterval\(/g) ?? []).length, 0, `${name} がタイマーを持っている`)
  }
})

test('⑤ タイマーは 1 本だけ（board-tick）で、server.js には無い', () => {
  const owner = fs.readFileSync(path.join(BRIDGE_SRC, 'board-tick.js'), 'utf8')
  assert.equal((owner.match(/setInterval\(/g) ?? []).length, 1, 'board-tick のタイマーは 1 本')

  const server = fs.readFileSync(path.join(BRIDGE_SRC, 'server.js'), 'utf8')
  assert.equal((server.match(/setInterval\(/g) ?? []).length, 0, 'server.js はタイマーを持たない')
  assert.equal((server.match(/boardTick\.start\(\)/g) ?? []).length, 1, 'start() は 1 回だけ')
  assert.equal((server.match(/createBoardTick\(/g) ?? []).length, 1)

  // 10 秒の盤面走査タイマーが board-tick 以外に無い（`board-tick-owner` と同じ条件）
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue
      if (abs === path.join(BRIDGE_SRC, 'board-tick.js')) continue
      const src = fs.readFileSync(abs, 'utf8')
      for (const m of src.matchAll(/setInterval\([^;]*?,\s*(10_000|10000)\s*\)/g)) {
        offenders.push(`${path.relative(BRIDGE_SRC, abs)}:${m[0].slice(0, 60)}`)
      }
    }
  }
  walk(BRIDGE_SRC)
  assert.deepEqual(offenders, [], '10 秒の盤面走査は board-tick だけ')
})

test('⑥ 監視対象 DB の列挙（ボード DB ＋ ルート DB）は board-tick が持つ', () => {
  const env = tempEnv()
  const rootDb = path.join(env.kanbanRoot, 'kanban.db')
  const db = new DatabaseSync(rootDb)
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT)')
  db.close()

  const paths = boardDbPaths({ kanbanRoot: env.kanbanRoot })
  assert.deepEqual(
    paths.map((p) => [p.board, path.basename(path.dirname(p.path))]),
    [
      ['mobile', 'mobile'],
      [null, 'kanban'],
    ],
  )

  // 注入は 1 か所（board-tick）だけ。渡したリストをそのまま使う。
  const injected = [{ board: 'mobile', path: env.dbPath }]
  assert.equal(boardDbPaths({ kanbanRoot: env.kanbanRoot }, injected), injected)
})

test('⑦ 同じタスクの running → blocked で、review の ⏸ と pipeline の完了判定が同じ 1 回の走査から出る', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-tick-both-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const kanbanRoot = path.join(root, 'kanban')
  const boardDir = path.join(kanbanRoot, 'boards', 'demo')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(
    path.join(boardDir, 'board.json'),
    JSON.stringify({ slug: 'demo', name: 'Demo', default_workdir: repo }),
  )
  const dbPath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
    result TEXT, session_id TEXT)`)
  db.close()
  const reviewDir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(reviewDir, { recursive: true })

  addTask(dbPath, { id: 't_rv', title: 'レビュー待ち', status: 'running', body: '[review] label=x-07 round=1' })
  addTask(dbPath, { id: 't_wk', title: '実装', status: 'running', body: 'Chat: 20260101_120000_cafebabe' })

  // 1 本の盤面ティックに、本番と同じ 2 ウォッチャーを購読させる
  const bt = createBoardTick(
    { kanbanRoot },
    { dbPaths: [{ board: 'demo', path: dbPath }], logger: { warn: () => {} } },
  )
  const rw = createReviewWatcher({ kanbanRoot, reviewDir }, { boardTick: bt, logger: { warn: () => {} } })
  const pw = createPipelineWatcher(
    { kanbanRoot, reviewDir },
    { boardTick: bt, logger: { warn: () => {} }, stateDbs: [], coherenceAnalyzer: async () => null },
  )
  assert.equal(bt.status().subscribers, 2, '2 ウォッチャーが同じティックを購読する')

  await bt.run() // ベースライン（この 1 回の走査を両方が受け取る）
  assert.equal(rw.status().ticks, 1)
  assert.equal(pw.status().ticks, 1)

  // 同じタスクが running → blocked
  setStatus(dbPath, 't_rv', 'blocked')
  setStatus(dbPath, 't_wk', 'blocked')
  const snapshot = await bt.run()
  assert.deepEqual(
    snapshot.changes.map((c) => [c.id, c.from, c.to]).sort(),
    [
      ['t_rv', 'running', 'blocked'],
      ['t_wk', 'running', 'blocked'],
    ],
  )

  // review 側: ⏸ が 1 行
  const feed = readJsonl(path.join(reviewDir, 'feed.jsonl'))
  assert.deepEqual(
    feed.map((row) => [row.task_id, row.kind]),
    [['t_rv', 'blocked']],
  )
  // pipeline 側: 同じ走査から halted レポート
  const reports = readJsonl(path.join(reviewDir, 'pipeline-reports.jsonl'))
  assert.equal(reports.length, 1, '1 回の走査で 1 レポート')
  assert.equal(reports[0].status, 'halted')
  assert.equal(reports[0].board, 'demo')
  assert.equal(reports[0].kind, 'pipeline')
})

test('start / stop は 1 本のタイマーで、初回は即走査する', async () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_start', status: 'running' })
  const bt = makeTick(env, { intervalMs: 60_000 })
  let got = 0
  bt.subscribe(() => {
    got += 1
  })
  bt.start()
  await bt.run() // 初回走査の async 完了待ち（start は同じ 1 本）
  assert.equal(bt.status().running, true)
  assert.ok(got >= 1, '初回の走査で購読者へ配る')
  bt.stop()
  assert.equal(bt.status().running, false)
})
