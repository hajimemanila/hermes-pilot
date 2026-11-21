/**
 * パイプライン完走ウォッチャー（`apps/bridge/src/pipeline-watcher.js`）のテスト。SPEC §3.2 / D20 / D21
 *
 * カンバンは**一時ディレクトリのダミー DB**（実ボードは汚さない）、時刻は固定クロック。
 * 検証する 8 点:
 *  ① 初回ベースラインで過去分を送らない
 *  ② Spec 全件 done の統合 Markdown（Git 情報・followUpPrompt 付き）
 *  ③ 一部 blocked/failed 停止時の `status: 'halted'` 要確認サマリ
 *  ④ 非 Spec（チャット起票）ボードウェーブの収束検知
 *  ⑤ 高速完了タスクの取りこぼし防止
 *  ⑥ 同一ラン/ウェーブの重複通知抑止
 *  ⑦ `state.db` cwd マッチフォールバック ＆ `__latest__` フォールバック
 *  ⑧ `review/feed.jsonl` を汚さない
 *
 * 追加（COH-5 / D83）:
 *  ⑨ 完走時に汎用予兆検知を 1 回だけ走らせ `coherence_alert` と EN/JA の次の一手を付ける
 *  ⑩ 予兆が閾値未満なら何も足さない（レポートは従来どおり）
 *  ⑪ 解析失敗は `log.warn` のみでレポートは正常配信
 *  ⑫ 予兆検知は完走ティックだけで、10 秒ポーリングでは走らない
 *  ⑬ `workdir` の実ディレクトリが無ければ解析しない
 *  ⑭ 純関数（`coherenceNextStep` / `buildNextSteps` / `buildPipelineReport`）の汎用表現
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildNextSteps,
  buildPipelineReport,
  chatFromBody,
  coherenceNextStep,
  createPipelineWatcher,
  extractIssuesAndRemaining,
  readPipelineReports,
  specRelFromBody,
} from '../src/pipeline-watcher.js'

const BOARD = 'proj'
const CLOCK = Date.parse('2026-11-15T00:00:00Z')

/** 一時環境（home/kanban/boards/proj/kanban.db ＋ state.db ＋ review ディレクトリ）。 */
function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-watcher-'))
  const repoPath = path.join(root, 'repo')
  fs.mkdirSync(repoPath, { recursive: true })
  const kanbanRoot = path.join(root, 'kanban')
  const boardDir = path.join(kanbanRoot, 'boards', BOARD)
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(
    path.join(boardDir, 'board.json'),
    JSON.stringify({ slug: BOARD, name: 'Proj Board', default_workdir: repoPath }),
  )
  const dbPath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL, assignee TEXT,
    priority INTEGER DEFAULT 0, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
    result TEXT, session_id TEXT)`)
  db.close()
  // 既定プロファイルの state.db（宛先フォールバック用）
  const stateDb = path.join(root, 'state.db')
  const s = new DatabaseSync(stateDb)
  s.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, last_activity_at REAL)')
  s.close()
  const reviewDir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  fs.mkdirSync(reviewDir, { recursive: true })
  return { root, repoPath, kanbanRoot, dbPath, stateDb, reviewDir }
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
    task.createdAt ?? Math.floor(CLOCK / 1000),
    task.startedAt ?? null,
    task.completedAt ?? null,
    task.result ?? null,
    task.sessionId ?? null,
  )
  db.close()
}

function setStatus(dbPath, id, status, extra = {}) {
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE tasks SET status=?, completed_at=?, result=? WHERE id=?').run(
    status,
    extra.completedAt ?? null,
    extra.result ?? null,
    id,
  )
  db.close()
}

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

/** 固定クロックのウォッチャー（`opts.now` をテストから進める）。 */
function makeWatcher(env, opts = {}) {
  const clock = { ms: CLOCK }
  const w = createPipelineWatcher(
    { kanbanRoot: env.kanbanRoot, reviewDir: env.reviewDir, stateDb: env.stateDb, hermesHome: env.root },
    {
      intervalMs: 10_000,
      now: () => clock.ms,
      logger: { warn: () => {} },
      stateDbs: [env.stateDb],
      ...opts,
    },
  )
  return { w, clock }
}

/** Git 情報のダミー（実リポジトリに依存しない）。 */
function fakeGitinfo(repoPath) {
  return {
    forTask: async (id) => ({ repo: repoPath, head: `abc1234${String(id).slice(-2)}`, subject: 'feat: x', dirty: false }),
    diffSummary: async () => ({
      ok: true,
      head: 'abc1234de',
      total: { add: 84, del: 12 },
      files: [{ path: 'a.js', add: 80, del: 12 }, { path: 'b.js', add: 4, del: 0 }],
    }),
  }
}

/** ラン記録（`pipeline-runs.json`）を書く。 */
function writeRuns(env, runs) {
  fs.writeFileSync(path.join(env.reviewDir, 'pipeline-runs.json'), JSON.stringify({ version: 1, runs }, null, 2))
}

function readRunsFile(env) {
  return JSON.parse(fs.readFileSync(path.join(env.reviewDir, 'pipeline-runs.json'), 'utf8')).runs
}

/** Spec バッチ 1 件分の本文。 */
function specBody(specRelPath, chat) {
  return ['Spec: ' + specRelPath, 'Target: /tmp/repo', 'Board: ' + BOARD, 'Batch: V4-2 — x', ...(chat ? ['Chat: ' + chat] : []), '', '## 目的', '', '- やる'].join('\n')
}

test('① 初回起動はベースライン確立のみ（過去の done を送らない・feed も作らない）', async () => {
  const env = tempEnv()
  addTask(env.dbPath, {
    id: 't_old',
    title: '[V4-1] 古い完了',
    body: specBody('docs/SPEC-V4.md'),
    status: 'done',
    completedAt: Math.floor(CLOCK / 1000) - 3600,
    result: 'done long ago',
  })
  const { w } = makeWatcher(env)
  const r = await w.tick()
  assert.equal(r.baseline, true)
  assert.deepEqual(r.reported, [])
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')), [])
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'pipeline-reports.jsonl')), [])
  assert.equal(fs.existsSync(path.join(env.reviewDir, 'feed.jsonl')), false, 'feed は作らない')
  const state = JSON.parse(fs.readFileSync(w.statePath, 'utf8'))
  assert.equal(state.knownTaskIds.t_old.status, 'done', '現在の状態だけ覚える')
  assert.equal(fs.existsSync(`${w.statePath}.tmp`), false, 'アトミック更新（.tmp が残らない）')
})

test('② Spec 全件 done で統合 Markdown（Git 情報・followUpPrompt・counts）を 1 行追記する', async () => {
  const env = tempEnv()
  const spec = 'docs/SPEC-V4.md'
  addTask(env.dbPath, { id: 't_a', title: '[V4-1] ドロワー', body: specBody(spec, 'ses_chat'), status: 'ready' })
  addTask(env.dbPath, { id: 't_b', title: '[V4-2] レポート', body: specBody(spec), status: 'ready' })
  writeRuns(env, [
    {
      id: 'run_1',
      board: BOARD,
      repoPath: env.repoPath,
      specRelPath: spec,
      title: 'SPEC: Hermes Pilot v4',
      batchIds: ['V4-1', 'V4-2'],
      taskIds: ['t_a', 't_b'],
      originSessionId: 'ses_chat',
      createdAt: CLOCK - 60_000,
      reportedAt: null,
    },
  ])
  const { w, clock } = makeWatcher(env, { gitinfo: fakeGitinfo(env.repoPath) })

  assert.equal((await w.tick()).baseline, true, '初回はベースライン')
  setStatus(env.dbPath, 't_a', 'done', { completedAt: Math.floor(CLOCK / 1000), result: '未読バッジを直した' })
  setStatus(env.dbPath, 't_b', 'done', { completedAt: Math.floor(CLOCK / 1000) + 60, result: 'レポートを出した' })
  clock.ms = CLOCK + 12 * 60_000

  const r = await w.tick()
  assert.equal(r.reported.length, 1, '1 件だけ報告する')
  assert.equal(r.reported[0].status, 'done')

  const rows = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.kind, 'pipeline')
  assert.equal(row.status, 'done')
  assert.equal(row.session_id, 'ses_chat', '本文の Chat: を宛先にする')
  assert.equal(row.board, BOARD)
  assert.equal(row.spec, spec)
  assert.equal(row.task_id, 'pipeline:proj:run_1')
  assert.equal(row.label, 'SPEC: Hermes Pilot v4')
  assert.deepEqual(row.counts, { done: 2, blocked: 0, failed: 0, total: 2 })
  assert.match(row.text, /🎉 SPEC: Hermes Pilot v4 \(2\/2 done\)/)
  assert.match(row.markdown, /### 🎉 Pipeline Completed: SPEC: Hermes Pilot v4 \(2\/2 done/)
  assert.match(row.markdown, /#### ✅ 完了タスク \/ Completed Tasks/)
  assert.match(row.markdown, /#### 🚀 次のステップ \/ Recommended Next Steps/)
  assert.match(row.markdown, /`abc1234`, \+84\/-12, 2 files/, 'Git の SHA・増減・ファイル数が入る')
  assert.match(row.markdown, /未読バッジを直した/, 'result の要約が入る')
  assert.match(row.follow_up_prompt, /次の一手/, 'followUpPrompt が付く')
  // UI 側が言語ごとに組み立てるための材料（日本語を焼き込まない）
  assert.equal(row.follow_up.title, 'SPEC: Hermes Pilot v4')
  assert.equal(row.follow_up.board, BOARD)
  assert.deepEqual(row.follow_up.counts, { done: 2, blocked: 0, failed: 0, total: 2 })
  assert.ok(Array.isArray(row.follow_up.issues), 'issues は配列')
  // 英語 UI 用の本文（日本語 UI 用の markdown は従来どおり残す）
  assert.match(row.markdown_en, /#### ⏱ Time & Usage/, '英語版の見出しが入る')
  assert.match(row.markdown_en, /#### ✅ Completed Tasks/)
  // ラベル（自前の文言）に日本語が残らない。タスク名は利用者データなので対象外
  for (const jp of ['実稼働', '経過時間', '所要時間', '完了タスク', '次のステップ', 'トークン数']) {
    assert.ok(!row.markdown_en.includes(jp), `英語版に「${jp}」が残っている`)
  }
  assert.match(row.text_en, /⏱ active /, 'text の英語版も active 表記')
  assert.match(row.at, /^2026-11-15T/, 'ISO 時刻')

  assert.equal(readJsonl(path.join(env.reviewDir, 'pipeline-reports.jsonl')).length, 1, '直近レポートにも追記')
  assert.equal(readRunsFile(env)[0].reportedAt, row.at, 'ランの reportedAt を更新する')
  assert.equal(fs.existsSync(path.join(env.reviewDir, 'feed.jsonl')), false, 'feed は汚さない')
})

test('③ 一部 blocked で停止したら status:halted の要確認サマリ（完了分と停止理由を分ける）', async () => {
  const env = tempEnv()
  const spec = 'docs/SPEC-V4.md'
  addTask(env.dbPath, { id: 't_1', title: '[V4-1] 完了分', body: specBody(spec), status: 'done', completedAt: Math.floor(CLOCK / 1000) })
  addTask(env.dbPath, { id: 't_2', title: '[V4-2] 停止分', body: specBody(spec), status: 'ready' })
  addTask(env.dbPath, { id: 't_3', title: '[V4-3] 失敗分', body: specBody(spec), status: 'ready' })
  const { w } = makeWatcher(env)
  assert.equal((await w.tick()).baseline, true)

  setStatus(env.dbPath, 't_2', 'blocked', { result: '認証情報が要る（needs_input）' })
  setStatus(env.dbPath, 't_3', 'failed', { result: 'verify が落ちた: npm test exit 1' })
  const r = await w.tick()
  assert.equal(r.reported.length, 1)
  assert.equal(r.reported[0].status, 'halted')

  const row = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal(row.status, 'halted')
  assert.match(row.text, /^⚠️ /)
  assert.match(row.markdown, /### ⚠️ Action Required: docs\/SPEC-V4\.md \(1 done · 1 blocked · 1 failed/)
  assert.match(row.markdown, /\[blocked\].*認証情報が要る/, '停止理由を残す')
  assert.match(row.markdown, /\[failed\].*verify が落ちた/, '失敗理由を残す')
  assert.deepEqual(row.counts, { done: 1, blocked: 1, failed: 1, total: 3 })
  assert.match(row.follow_up_prompt, /blocked 1 件/, 'followUpPrompt に件数と相談文が入る')
})

test('④ 非 Spec（チャット起票）のボードウェーブ収束を検知する', async () => {
  const env = tempEnv()
  addTask(env.dbPath, { id: 't_w1', title: 'チャット起票 A', body: 'Chat: ses_wave\n\n本文', status: 'running' })
  addTask(env.dbPath, { id: 't_w2', title: 'チャット起票 B', body: 'Chat: ses_wave\n\n本文', status: 'ready' })
  const { w } = makeWatcher(env)
  assert.equal((await w.tick()).baseline, true, '稼働中の波はベースラインで覚えるだけ')

  setStatus(env.dbPath, 't_w1', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'A done' })
  setStatus(env.dbPath, 't_w2', 'done', { completedAt: Math.floor(CLOCK / 1000) + 10, result: 'B done' })
  const r = await w.tick()
  assert.equal(r.reported.length, 1)
  assert.equal(r.reported[0].spec, null, 'Spec を持たないウェーブ')
  const row = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal(row.spec, null)
  assert.equal(row.label, 'Proj Board', 'ボード名をラベルにする')
  assert.equal(row.session_id, 'ses_wave')
  assert.match(row.text, /\(2\/2 done\)/)
})

test('④b [review] タスクだけのウェーブは報告しない（個別レビュー報告と二重にしない）', async () => {
  const env = tempEnv()
  addTask(env.dbPath, {
    id: 't_r1',
    title: '赤ペン',
    body: '[review] label=x-01 round=1 mode=sheet sheet=sheets/x-01-1.html',
    status: 'ready',
  })
  const { w } = makeWatcher(env)
  assert.equal((await w.tick()).baseline, true)
  setStatus(env.dbPath, 't_r1', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'ok' })
  const r = await w.tick()
  assert.deepEqual(r.reported, [], 'review タスクはウェーブ集計から外す')
  assert.deepEqual(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')), [])
})

test('⑤ ティック間で起票→完了したタスクも取りこぼさない', async () => {
  const env = tempEnv()
  const { w, clock } = makeWatcher(env)
  assert.equal((await w.tick()).baseline, true, '空の盤面でベースライン')

  clock.ms = CLOCK + 5_000
  addTask(env.dbPath, {
    id: 't_fast',
    title: '[V4-2] 一瞬で終わった',
    body: specBody('docs/SPEC-V4.md'),
    status: 'done',
    completedAt: Math.floor((CLOCK + 5_000) / 1000),
    result: 'すぐ終わった',
  })
  const r = await w.tick()
  assert.equal(r.reported.length, 1, 'openCount>0 を観測できなくても完了を拾う')
  assert.equal(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')).length, 1)
})

test('⑥ 同じランの完了を 2 回通知しない（reportedKeys / reportedAt）', async () => {
  const env = tempEnv()
  const spec = 'docs/SPEC-V4.md'
  addTask(env.dbPath, { id: 't_1', title: '[V4-1] 一つ目', body: specBody(spec), status: 'ready' })
  writeRuns(env, [
    {
      id: 'run_dup',
      board: BOARD,
      repoPath: env.repoPath,
      specRelPath: spec,
      title: 'SPEC: dup',
      taskIds: ['t_1'],
      originSessionId: 'ses_dup',
      createdAt: CLOCK,
      reportedAt: null,
    },
  ])
  const { w, clock } = makeWatcher(env)
  await w.tick()
  setStatus(env.dbPath, 't_1', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'done' })
  const first = await w.tick()
  assert.equal(first.reported.length, 1)

  clock.ms = CLOCK + 10_000
  const second = await w.tick()
  assert.deepEqual(second.reported, [], '2 回目は通知しない')
  const third = await w.tick()
  assert.deepEqual(third.reported, [])
  assert.equal(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')).length, 1, '行も増えない')
  assert.equal(readRunsFile(env)[0].reportedAt !== null, true)
})

test('⑦ 宛先は state.db の cwd 一致 → 見つからなければ __latest__', async () => {
  // (a) cwd 一致の最新通常セッション
  const envA = tempEnv()
  const db = new DatabaseSync(envA.stateDb)
  db.prepare('INSERT INTO sessions (id,cwd,started_at,last_activity_at) VALUES (?,?,?,?)').run(
    'local-should-be-skipped',
    envA.repoPath,
    CLOCK / 1000,
    CLOCK / 1000,
  )
  db.prepare('INSERT INTO sessions (id,cwd,started_at,last_activity_at) VALUES (?,?,?,?)').run(
    'ses_by_cwd',
    envA.repoPath + '/',
    CLOCK / 1000 + 5,
    CLOCK / 1000 + 5,
  )
  db.close()
  addTask(envA.dbPath, { id: 't_c1', title: 'チャット起票', body: '本文だけ（Chat: 行なし）', status: 'ready' })
  const a = makeWatcher(envA)
  await a.w.tick()
  setStatus(envA.dbPath, 't_c1', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'ok' })
  await a.w.tick()
  const rowA = readJsonl(path.join(envA.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal(rowA.session_id, 'ses_by_cwd', 'local- は避け、cwd 一致（末尾 / 許容）の最新を採る')
  assert.equal(rowA.repo_path, envA.repoPath, 'repo_path はボードの作業ディレクトリ')

  // (b) 何も一致しなければ __latest__
  const envB = tempEnv()
  addTask(envB.dbPath, { id: 't_c2', title: '宛先不明', body: '本文だけ', status: 'ready' })
  const b = makeWatcher(envB)
  await b.w.tick()
  setStatus(envB.dbPath, 't_c2', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'ok' })
  await b.w.tick()
  const rowB = readJsonl(path.join(envB.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal(rowB.session_id, '__latest__')

  // (c) default より他プロファイル (mobile 等) のセッションが新しければ、古い default に吸い込まれない
  const envC = tempEnv()
  const mobileDb = path.join(envC.root, 'mobile-state.db')
  const dbDef = new DatabaseSync(envC.stateDb)
  dbDef
    .prepare('INSERT INTO sessions (id,cwd,started_at,last_activity_at) VALUES (?,?,?,?)')
    .run('ses_old_default', envC.repoPath, 1000, 1000)
  dbDef.close()
  const dbMob = new DatabaseSync(mobileDb)
  dbMob.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, last_activity_at REAL)')
  dbMob
    .prepare('INSERT INTO sessions (id,cwd,started_at,last_activity_at) VALUES (?,?,?,?)')
    .run('ses_new_mobile', envC.repoPath, 5000, 5000)
  dbMob.close()
  addTask(envC.dbPath, { id: 't_c3', title: 'mobile起票', body: '本文だけ', status: 'ready' })
  const c = makeWatcher(envC, { stateDbs: [envC.stateDb, mobileDb] })
  await c.w.tick()
  setStatus(envC.dbPath, 't_c3', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'ok' })
  await c.w.tick()
  const rowC = readJsonl(path.join(envC.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal(rowC.session_id, 'ses_new_mobile', '全プロファイルの state.db を比較して最新時刻のセッションを選ぶ')
})

test('⑧ review/feed.jsonl を汚さない（既存行はそのまま）', async () => {
  const env = tempEnv()
  const feed = path.join(env.reviewDir, 'feed.jsonl')
  const original = JSON.stringify({ at: '2026-11-14T23:00:00.000Z', task_id: 't_x', kind: 'done', text: '既存' }) + '\n'
  fs.writeFileSync(feed, original)
  addTask(env.dbPath, { id: 't_f', title: 'タスク', body: 'Chat: ses_f', status: 'ready' })
  const { w } = makeWatcher(env)
  await w.tick()
  setStatus(env.dbPath, 't_f', 'done', { completedAt: Math.floor(CLOCK / 1000), result: 'ok' })
  const r = await w.tick()
  assert.equal(r.reported.length, 1, 'レポート自体は出る')
  assert.equal(fs.readFileSync(feed, 'utf8'), original, 'feed.jsonl は 1 バイトも変えない')
})

test('buildPipelineReport は純関数（counts・issues・nextSteps・halted 見出し）', () => {
  const tasks = [
    { id: 't_1', title: 'A', status: 'done', result: 'TODO: あとで直す\n完了しました' },
    { id: 't_2', title: 'B', status: 'blocked', result: '指示待ち' },
  ]
  const rep = buildPipelineReport({
    status: 'halted',
    label: 'SPEC: demo',
    board: BOARD,
    specRelPath: 'docs/SPEC-X.md',
    tasks,
    gitMap: { t_1: { head: 'deadbee', total: { add: 3, del: 1 }, files: [{ path: 'a' }] } },
    startedAt: CLOCK - 5 * 60_000,
    now: CLOCK,
  })
  assert.deepEqual(rep.counts, { done: 1, blocked: 1, failed: 0, total: 2 })
  assert.match(rep.markdown, /Action Required: SPEC: demo \(1 done · 1 blocked · 5m\)/)
  assert.match(rep.markdown, /TODO: あとで直す/, 'result 行から残課題を拾う')
  assert.match(rep.markdown, /\[blocked\] B\*\* — 指示待ち/)
  assert.deepEqual(rep.nextSteps.length > 0, true)
  assert.equal(rep.issues.length >= 2, true)
})

test('buildPipelineReport は Spec スコープの実稼働時間と API コール・トークンを出す', () => {
  const t0 = Date.parse('2026-11-15T10:00:00Z') / 1000
  const rep = buildPipelineReport({
    status: 'done',
    label: 'V7',
    board: BOARD,
    specRelPath: 'docs/SPEC-PILOT-V7.md',
    tasks: [
      { id: 'a', title: '[V7-1] x', status: 'done', started_at: t0, completed_at: t0 + 40 * 60, result: 'ok' },
      { id: 'b', title: '[V7-2] y', status: 'done', started_at: t0 + 20 * 60, completed_at: t0 + 60 * 60, result: 'ok' },
      { id: 'c', title: '[V7-3] z', status: 'done', started_at: t0 + 180 * 60, completed_at: t0 + 210 * 60, result: 'ok' },
    ],
    startedAt: t0 * 1000,
    now: (t0 + 210 * 60) * 1000,
    usage: {
      apiCalls: 128,
      totalTokens: 1_240_000,
      totals: { input: 900_000, output: 300_000, cacheRead: 40_000 },
      scope: { sessionIds: 2, sinceMs: null, untilMs: null, fallback: false },
    },
  })
  // 40 分と 40 分の重なりは 1 本にマージし、離れた 30 分は足す（40+40+30 ではなく 90 分）
  assert.equal(rep.timing.activeDurationMin, 90)
  assert.equal(rep.timing.wallDurationMin, 210)
  assert.equal(rep.usage.apiCalls, 128)
  assert.equal(rep.usage.totalTokens, 1_240_000)
  assert.match(rep.markdown, /### 🎉 Pipeline Completed: V7 \(3\/3 done/)
  assert.match(rep.markdown, /⏱ 実稼働 1 時間 30 分 · 経過 3 時間 30 分/)
  assert.match(rep.markdown, /🔌 128 API · 🪙 1\.2M tokens/)
  assert.match(rep.markdown, /#### ⏱ 所要時間・使用量 \/ Time & Usage/)
  assert.match(rep.markdown, /- 実稼働（重複区間をマージ）: 1 時間 30 分/)
  assert.match(rep.markdown, /- 経過時間: 3 時間 30 分/)
  assert.match(rep.markdown, /- API コール数: 128/)
  assert.match(rep.markdown, /- トークン数: 1\.2M（入力 900K · 出力 300K · キャッシュ読取 40K）/)
  assert.match(rep.text, /⏱ 実稼働 1 時間 30 分/)
})

test('buildPipelineReport は usage 未指定でも時間だけは出す（— で埋める）', () => {
  const t0 = Date.parse('2026-11-15T10:00:00Z') / 1000
  const rep = buildPipelineReport({
    status: 'done',
    label: 'plain',
    board: BOARD,
    tasks: [{ id: 'a', title: 'A', status: 'done', started_at: t0, completed_at: t0 + 15 * 60 }],
    now: (t0 + 15 * 60) * 1000,
  })
  assert.equal(rep.timing.activeDurationMin, 15)
  assert.equal(rep.usage.apiCalls, null)
  assert.match(rep.markdown, /- API コール数: —/)
})

test('extractIssuesAndRemaining は blocked/failed を優先し、重複を除いて 8 件まで', () => {
  const tasks = []
  for (let i = 0; i < 12; i += 1) {
    tasks.push({ id: `t_${i}`, title: `T${i}`, status: 'done', result: `TODO: 同じ行` })
  }
  tasks.push({ id: 't_b', title: '止まった', status: 'blocked', result: '理由あり' })
  const out = extractIssuesAndRemaining(tasks)
  assert.equal(out[0].kind, 'blocked', '停止タスクを先頭に置く')
  assert.equal(out.length <= 8, true)
  assert.equal(out.filter((i) => i.text.includes('同じ行')).length, 1, '重複除去')
})

test('buildNextSteps は halted / done で違う提案を返す', () => {
  const halted = buildNextSteps({
    status: 'halted',
    board: BOARD,
    specRelPath: 'docs/SPEC-V4.md',
    tasks: [{ status: 'blocked' }],
    issues: [{ text: 'x' }],
  })
  assert.match(halted[0], /blocked\/failed/)
  const done = buildNextSteps({ status: 'done', board: BOARD, tasks: [{ status: 'done' }], issues: [] })
  const doneEn = buildNextSteps({ status: 'done', board: BOARD, tasks: [{ status: 'done' }], issues: [], lang: 'en' })
  // D85: 検証コマンドは対象リポジトリの宣言へ委ね、決め打ちしない（EN / JA 両方）
  assert.equal(doneEn.some((s) => s.includes('the verification command the target repository declares')), true)
  assert.equal(done.some((s) => s.includes('対象リポジトリが宣言する検証コマンド')), true)
  assert.equal(done.some((s) => s.includes('npm run verify')), false)
  assert.equal(doneEn.some((s) => s.includes('npm run verify')), false)
})

test('specRelFromBody / chatFromBody は行頭の `Spec:` `Chat:` を読む', () => {
  assert.equal(specRelFromBody('Spec: docs/SPEC-V4.md\nTarget: /tmp'), 'docs/SPEC-V4.md')
  assert.equal(specRelFromBody('仕様: docs/x.md'), null)
  assert.equal(chatFromBody('Chat: ses_1'), 'ses_1')
  assert.equal(chatFromBody('Chat: bad id with space'), null)
})

test('readPipelineReports はボードで絞り、新しい順に返す（壊れた行は捨てる）', () => {
  const env = tempEnv()
  const file = path.join(env.reviewDir, 'pipeline-reports.jsonl')
  fs.writeFileSync(
    file,
    [
      { at: '2026-11-15T00:00:00.000Z', kind: 'pipeline', board: 'a', text: '古い', task_id: 'pipeline:a:1' },
      { at: '2026-11-15T01:00:00.000Z', kind: 'pipeline', board: 'b', text: '新しい', task_id: 'pipeline:b:1' },
      'not json',
    ]
      .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
      .join('\n') + '\n',
  )
  const all = readPipelineReports(env.reviewDir)
  assert.equal(all.length, 2)
  assert.equal(all[0].text, '新しい', '新しい順')
  assert.equal(all[0].at > all[1].at, true, 'at は epoch ms')
  const onlyB = readPipelineReports(env.reviewDir, { board: 'b' })
  assert.deepEqual(onlyB.map((r) => r.board), ['b'])
  assert.deepEqual(readPipelineReports(path.join(env.root, 'nope')), [])
})

/* ---------------------------------------------------------------------------
 * COH-5 / D83: 完走フックの汎用予兆検知（`coherence.js` は読み取り専用）
 * ------------------------------------------------------------------------- */

/** `analyzeCoherence()` の出力契約を満たすダミーレポート。 */
function fakeCoherenceReport({ hard = 0, soft = 0, hotspot = 0, sweep = null } = {}) {
  const hardFails = Array.from({ length: hard }, (_, i) => ({
    rule: 'forbidden-pattern',
    severity: 'hard',
    message: `forbidden pattern ${i}`,
  }))
  const softSignals = Array.from({ length: soft }, (_, i) => ({
    rule: 'file-bloat',
    severity: 'soft',
    message: `apps/demo/file${i}.js is 1200 lines (limit 900)`,
  }))
  const hotspots = Array.from({ length: hotspot }, (_, i) => ({
    file: `apps/demo/hot${i}.js`,
    touches: 6,
    lines: 300,
  }))
  return {
    ok: hard === 0,
    generatedAt: new Date(CLOCK).toISOString(),
    repoRoot: '/tmp/repo',
    layers: { universal: true, repoConfig: true, repoChecker: false },
    hardFails,
    softSignals,
    hotspots,
    summary: {
      hardFailCount: hard,
      softSignalCount: soft,
      hotspotCount: hotspot,
      activeSpecCount: 1,
      archivedSpecCount: 0,
      deprecatedRoutes: 0,
    },
    recommendedSweep: sweep,
  }
}

/** 呼び出し回数と引数を記録する差し替えアナライザ。 */
function countingAnalyzer(report) {
  const calls = []
  const fn = async (root, thresholds) => {
    calls.push({ root, thresholds })
    return report
  }
  fn.calls = calls
  return fn
}

/** Spec 1 件だけの完走ランを仕込む（戻り値は `{env, spec}`）。 */
function doneSpecEnv(chat) {
  const env = tempEnv()
  const spec = 'docs/SPEC-V4.md'
  addTask(env.dbPath, { id: 't_c1', title: '[V4-1] 完走', body: specBody(spec, chat), status: 'ready' })
  writeRuns(env, [
    {
      id: 'run_coh',
      board: BOARD,
      repoPath: env.repoPath,
      specRelPath: spec,
      title: 'SPEC: Coherence hook',
      batchIds: ['V4-1'],
      taskIds: ['t_c1'],
      originSessionId: chat ?? null,
      createdAt: CLOCK - 60_000,
      reportedAt: null,
    },
  ])
  return { env, spec }
}

/** その環境のタスクを done にして次のティックを進める。 */
async function finishAndTick(env, w, clock) {
  setStatus(env.dbPath, 't_c1', 'done', { completedAt: Math.floor(CLOCK / 1000), result: '予兆検知を繋いだ' })
  clock.ms = CLOCK + 5 * 60_000
  return w.tick()
}

test('⑨ 完走時に予兆検知を 1 回走らせ、coherence_alert と EN/JA の次の一手を付ける', async () => {
  const { env } = doneSpecEnv('ses_coh')
  const analyzer = countingAnalyzer(fakeCoherenceReport({ hotspot: 1, soft: 3, sweep: 'hotspots' }))
  const { w, clock } = makeWatcher(env, {
    coherenceAnalyzer: analyzer,
    coherenceThresholds: { maxLines: 900 },
  })

  assert.equal((await w.tick()).baseline, true, '初回はベースライン')
  assert.equal(analyzer.calls.length, 0, 'ベースライン（非完走）では解析しない')

  const r = await finishAndTick(env, w, clock)
  assert.equal(r.reported.length, 1)
  assert.equal(analyzer.calls.length, 1, '完走 1 回につき 1 回だけ解析する')
  assert.equal(analyzer.calls[0].root, env.repoPath, 'workdir（ボード既定）を渡す')
  assert.deepEqual(analyzer.calls[0].thresholds, { maxLines: 900 }, 'coherenceThresholds を渡す')

  const row = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))[0]
  assert.deepEqual(
    row.coherence_alert.summary,
    { hardFailCount: 0, softSignalCount: 3, hotspotCount: 1 },
    'summary は 3 つの件数',
  )
  assert.equal(row.coherence_alert.recommendedSweep, 'hotspots')
  assert.deepEqual(row.coherence_alert.layers, { universal: true, repoConfig: true, repoChecker: false })
  assert.equal(Array.isArray(row.coherence_alert.highlights), true)
  assert.equal(row.coherence_alert.highlights.length, 3, 'highlights は hard+soft の先頭 5 件')
  assert.match(row.coherence_alert.highlights[0], /1200 lines/, 'シグナルの本文がそのまま入る')

  // 日本語本文（既定）: 節 ＋ 次の一手の 1 行
  assert.match(row.markdown, /#### 🧭 予兆シグナル \/ Coherence Signals/)
  assert.match(row.markdown, /推奨スイープ: hotspots/)
  assert.match(row.markdown, /整合性の検証・改善: hotspotsを「リファクタリング」から実行する/)
  assert.match(row.markdown, /Hard Fail 0 \/ 予兆 3 \/ ホットスポット 1/)
  // 英語本文: 同じ情報を英語だけで（CJK を持ち込まない）
  assert.match(row.markdown_en, /#### 🧭 Coherence Signals/)
  assert.match(row.markdown_en, /Recommended sweep: hotspots/)
  assert.match(row.markdown_en, /Coherence signals: run the hotspots sweep from Refactor & audit/)
  for (const jp of ['予兆シグナル', '推奨スイープ', '整合性の検証・改善', 'ホットスポット']) {
    assert.ok(!row.markdown_en.includes(jp), `英語版に「${jp}」が残っている`)
  }

  // D83: 予兆の 1 行にコマンド決め打ちを入れない（自動起票もしない）
  const jaLine = row.markdown.split('\n').find((l) => l.includes('整合性の検証・改善'))
  assert.ok(jaLine, '日本語の予兆行がある')
  assert.equal(jaLine.includes('npm run'), false, '予兆行に npm run を決め打ちしない')
  assert.equal(jaLine.includes('kanban'), false, '予兆行に自動起票の指示を入れない')

  // 直近レポート経由でも形がそのまま読める
  const latest = readPipelineReports(env.reviewDir)[0]
  assert.deepEqual(latest.coherence_alert, row.coherence_alert, 'pipeline-reports.jsonl 経由でも同じ形')
})

test('⑩ 予兆が閾値未満なら何も足さない（レポートは従来どおり配信）', async () => {
  const { env } = doneSpecEnv('ses_coh')
  const analyzer = countingAnalyzer(fakeCoherenceReport({ soft: 2 }))
  const { w, clock } = makeWatcher(env, { coherenceAnalyzer: analyzer })

  assert.equal((await w.tick()).baseline, true)
  const r = await finishAndTick(env, w, clock)
  assert.equal(r.reported.length, 1, 'レポートは配信する')
  assert.equal(analyzer.calls.length, 1, '判定のために 1 回は走る')

  const row = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal('coherence_alert' in row, false, 'alert === false では付与しない')
  assert.equal(row.markdown.includes('🧭'), false, '予兆の節を足さない')
  assert.equal(row.markdown.includes('整合性の検証・改善'), false, '次の一手にも足さない')
  assert.match(row.markdown, /#### 🚀 次のステップ \/ Recommended Next Steps/, '従来の見出しはそのまま')
  assert.match(row.markdown_en, /#### 🚀 Recommended Next Steps/)
  assert.equal(readPipelineReports(env.reviewDir)[0].coherence_alert, null)
})

test('⑪ 解析が失敗しても warn だけでレポートは正常配信（非干渉）', async () => {
  const { env } = doneSpecEnv('ses_coh')
  const warns = []
  const { w, clock } = makeWatcher(env, {
    logger: { warn: (m) => warns.push(String(m)) },
    coherenceAnalyzer: async () => {
      throw new Error('boom')
    },
  })

  assert.equal((await w.tick()).baseline, true)
  const r = await finishAndTick(env, w, clock)
  assert.equal(r.reported.length, 1, '解析が落ちてもレポートは出る')
  assert.equal(warns.some((m) => m.includes('coherence analysis skipped: boom')), true, 'warn だけ残す')

  const row = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal('coherence_alert' in row, false)
  assert.match(row.text, /🎉 SPEC: Coherence hook \(1\/1 done\)/, '本文は通常どおり')
  assert.match(row.markdown, /#### ✅ 完了タスク \/ Completed Tasks/)
})

test('⑫ 予兆検知は完走ティックだけで、定期ポーリングでは走らない', async () => {
  const { env } = doneSpecEnv('ses_coh')
  const analyzer = countingAnalyzer(fakeCoherenceReport({ hotspot: 1, sweep: 'hotspots' }))
  const { w, clock } = makeWatcher(env, { coherenceAnalyzer: analyzer })

  assert.equal((await w.tick()).baseline, true)
  assert.equal(analyzer.calls.length, 0)

  await finishAndTick(env, w, clock)
  assert.equal(analyzer.calls.length, 1, '収束した瞬間に 1 回')

  clock.ms += 10_000
  const second = await w.tick()
  assert.deepEqual(second.reported, [], '2 回目は報告しない')
  clock.ms += 10_000
  await w.tick()
  assert.equal(analyzer.calls.length, 1, 'ポーリングでは走らない（重複解析しない）')
  assert.equal(readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl')).length, 1)
})

test('⑬ workdir の実ディレクトリが無ければ解析しない（既定アナライザでも安全）', async () => {
  const { env } = doneSpecEnv('ses_coh')
  fs.rmSync(env.repoPath, { recursive: true, force: true })
  const analyzer = countingAnalyzer(fakeCoherenceReport({ hotspot: 1, sweep: 'hotspots' }))
  const { w, clock } = makeWatcher(env, { coherenceAnalyzer: analyzer })

  assert.equal((await w.tick()).baseline, true)
  const r = await finishAndTick(env, w, clock)
  assert.equal(r.reported.length, 1, 'レポートは出る')
  assert.equal(analyzer.calls.length, 0, '実在しない workdir では走らせない')
  const row = readJsonl(path.join(env.reviewDir, 'chat-reports.jsonl'))[0]
  assert.equal('coherence_alert' in row, false)
})

test('⑭ 純関数は予兆を汎用表現で受け、halted でも停止理由を先頭に残す', () => {
  const alert = {
    alert: true,
    summary: { hardFailCount: 1, softSignalCount: 2, hotspotCount: 0 },
    recommendedSweep: 'contracts',
    highlights: ['forbidden pattern "eval" found in 1 file(s)'],
    layers: { universal: true, repoConfig: true, repoChecker: true },
  }
  assert.equal(
    coherenceNextStep(alert, { board: BOARD }),
    '整合性の検証・改善: contractsを「リファクタリング」から実行する（board: proj · Hard Fail 1 / 予兆 2 / ホットスポット 0）',
  )
  assert.match(coherenceNextStep(alert, { en: true, board: BOARD }), /^Coherence signals: run the contracts sweep/)
  assert.match(coherenceNextStep({ ...alert, recommendedSweep: null }, { board: BOARD }), /対象メニュー/)

  const done = buildNextSteps({ status: 'done', board: BOARD, tasks: [{ status: 'done' }], issues: [], coherence: alert })
  assert.match(done[0], /contractsを「リファクタリング」から実行する/, 'done では先頭に置く（3 件枠で落とさない）')
  assert.equal(done.length <= 3, true)

  const halted = buildNextSteps({
    status: 'halted',
    board: BOARD,
    tasks: [{ status: 'blocked' }],
    issues: [{ text: 'x', kind: 'blocked', title: 't' }],
    coherence: alert,
  })
  assert.match(halted[0], /blocked\/failed/, '停止理由がいちばん先')
  assert.equal(halted[1], coherenceNextStep(alert, { board: BOARD }), 'その次に予兆の 1 行')

  const plain = buildNextSteps({ status: 'done', board: BOARD, tasks: [{ status: 'done' }], issues: [] })
  assert.equal(plain.some((s) => s.includes('整合性の検証・改善')), false, '予兆なしは従来どおり')

  // 生レポート（analyzeCoherence の出力）も受け、alert のときだけ節を足す
  const rep = buildPipelineReport({
    status: 'done',
    label: 'x',
    board: BOARD,
    tasks: [{ id: 't', title: 'T', status: 'done' }],
    coherence: fakeCoherenceReport({ hard: 1, sweep: 'contracts' }),
    now: CLOCK,
  })
  assert.equal(rep.coherence_alert.summary.hardFailCount, 1)
  assert.equal(rep.coherence_alert.recommendedSweep, 'contracts')
  assert.match(rep.markdown, /#### 🧭 予兆シグナル \/ Coherence Signals/)
  assert.match(rep.markdown, /forbidden pattern 0/)
  assert.equal(rep.markdownEn.includes('予兆シグナル'), false)

  const quiet = buildPipelineReport({ status: 'done', label: 'x', board: BOARD, tasks: [{ id: 't', title: 'T', status: 'done' }], now: CLOCK })
  assert.equal(quiet.coherence_alert, null)
  assert.equal(quiet.markdown.includes('🧭'), false)
})
