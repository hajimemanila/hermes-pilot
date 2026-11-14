/**
 * Spec Launchpad（`apps/bridge/src/specs.js`）のテスト。SPEC §5.4 / D15④
 *
 * カンバンは**一時ディレクトリのダミー**とドライランで検証する（実ボードを汚さない）。
 * `hermes kanban create` は `runner` を差し替えて、渡された引数だけを見る。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BATCH_ID_RE,
  buildTaskBody,
  buildTaskTitle,
  createSpecs,
  findOpenBatchTask,
  listSpecs,
  makeRunId,
  parseCreatedTask,
  parseSpec,
  pruneRuns,
  readRuns,
  resolveSpecPath,
  runsPathFor,
  sanitizeSpecChat,
} from '../src/specs.js'

const SPEC = `# SPEC: Demo (SPEC-DEMO)

Intro paragraph.

## 6. Batches

### Batch P1: First batch

- **目的**: do the first thing
- **受入条件（Verify）**:
  - it works

### P2: Second batch

- **Objective**: do the second thing

#### Sub note

keep me

---

## Other section

### 1.1 Not a batch

text
`

/** 一時ディレクトリ。 */
function tempDir(prefix = 'hm-specs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** `<dir>/<rel>` を書く（親も作る）。 */
function writeFile(dir, rel, text) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}

test('parseSpec はタイトルと `### Batch <ID>: <Title>` / `### <ID>: <Title>` を抽出する', () => {
  const parsed = parseSpec(SPEC)
  assert.equal(parsed.title, 'SPEC: Demo (SPEC-DEMO)')
  assert.equal(parsed.valid, true)
  assert.deepEqual(
    parsed.batches.map((b) => b.id),
    ['P1', 'P2'],
  )
  assert.equal(parsed.batches[0].title, 'First batch')
  assert.equal(parsed.batches[0].objective, 'do the first thing')
  assert.equal(parsed.batches[1].objective, 'do the second thing')
})

test('バッチの抜粋は次の見出しで切れ、`####` の小見出しは含む', () => {
  const [p1, p2] = parseSpec(SPEC).batches
  assert.ok(p1.section.includes('**受入条件（Verify）**'), '受入条件が抜粋に入る')
  assert.ok(!p1.section.includes('Second batch'), '次のバッチは混ざらない')
  assert.ok(p2.section.includes('keep me'), '#### の小見出しは本文に含める')
  assert.ok(!p2.section.endsWith('---'), '末尾の区切り線は落とす')
})

test('番号だけの見出し（`### 1.1 …`）はバッチとして拾わない', () => {
  assert.equal(BATCH_ID_RE.test('1.1'), false)
  assert.equal(BATCH_ID_RE.test('P3'), true)
  assert.ok(!parseSpec(SPEC).batches.some((b) => b.id === '1.1'))
})

test('同じ ID の見出しが 2 回出ても 1 件に畳む', () => {
  const text = '### T1: One\n\nbody\n\n### T1: One again\n\nbody2\n'
  assert.equal(parseSpec(text).batches.length, 1)
})

test('listSpecs は docs/SPEC*.md と直下 SPEC*.md を拾い、他の md は無視する', () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  writeFile(root, 'SPEC-B.md', '# SPEC: B\n\n### T1: alpha\n\nbody\n')
  writeFile(root, 'docs/NOTES.md', '# NOTES\n\n### P9: nope\n')
  writeFile(root, 'docs/sub/SPEC-DEEP.md', '# SPEC: deep\n\n### P1: x\n')
  const specs = listSpecs(root)
  assert.deepEqual(
    specs.map((s) => s.path).sort(),
    ['SPEC-B.md', 'docs/SPEC-A.md'],
  )
  const a = specs.find((s) => s.path === 'docs/SPEC-A.md')
  assert.equal(a.title, 'SPEC: Demo (SPEC-DEMO)')
  assert.deepEqual(
    a.batches.map((b) => b.id),
    ['P1', 'P2'],
  )
  assert.ok(Number.isFinite(a.mtime) && a.mtime > 0, 'mtime は数値')
})

test('listSpecs は存在しないディレクトリでも落ちない（空配列）', () => {
  assert.deepEqual(listSpecs(path.join(tempDir(), 'missing')), [])
})

test('バッチの無い spec は valid のまま batches 0 件、タイトルも無ければ invalid', () => {
  assert.deepEqual(parseSpec('# SPEC: only title\n\ntext\n').batches, [])
  assert.equal(parseSpec('# SPEC: only title\n').valid, true)
  assert.equal(parseSpec('no headings at all').valid, false)
})

test('buildTaskTitle / buildTaskBody は `[ID] Title` と spec・target・抜粋を入れる', () => {
  const batch = parseSpec(SPEC).batches[0]
  assert.equal(buildTaskTitle(batch), '[P1] First batch')
  const body = buildTaskBody({ specRelPath: 'docs/SPEC-A.md', repoPath: '/tmp/repo', board: 'mobile', batch })
  assert.ok(body.includes('Spec: docs/SPEC-A.md'))
  assert.ok(body.includes('Target: /tmp/repo'))
  assert.ok(body.includes('Board: mobile'))
  assert.ok(body.includes('do the first thing'))
  assert.ok(body.includes('受入条件（Verify）'))
})

test('findOpenBatchTask は未完了だけを拾う（done / archived は無視）', () => {
  const tasks = [
    { id: 't_1', title: '[P1] First batch', status: 'done' },
    { id: 't_2', title: '[P2] Second batch', status: 'blocked' },
    { id: 't_3', title: 'unrelated', status: 'ready' },
  ]
  assert.equal(findOpenBatchTask(tasks, 'P1'), null)
  assert.equal(findOpenBatchTask(tasks, 'P2').id, 't_2')
  assert.equal(findOpenBatchTask(tasks, 'P3'), null)
})

test('resolveSpecPath はリポジトリの外を指すパスを拒否する', () => {
  const root = tempDir()
  assert.equal(resolveSpecPath(root, 'docs/SPEC-A.md'), path.join(root, 'docs/SPEC-A.md'))
  assert.throws(() => resolveSpecPath(root, '../etc/passwd'), /外を指しています/)
  assert.throws(() => resolveSpecPath(root, '/abs/SPEC.md'), /相対パス/)
  assert.throws(() => resolveSpecPath(root, ''), /パスがありません/)
})

test('parseCreatedTask は --json の出力からも `Created t_x` からも ID を取る', () => {
  assert.equal(parseCreatedTask('{"id":"t_abc","status":"ready"}').id, 't_abc')
  assert.equal(parseCreatedTask('Created t_deadbeef\n').id, 't_deadbeef')
  assert.equal(parseCreatedTask('nothing'), null)
})

test('launchSpec（ドライラン）は CLI を呼ばずに全バッチを返す', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  let calls = 0
  const specs = createSpecs({}, { runner: async () => ((calls += 1), { code: 0, stdout: '{}', stderr: '' }), tasks: () => [] })
  const r = await specs.launchSpec({
    repoPath: root,
    board: 'mobile',
    specRelPath: 'docs/SPEC-A.md',
    batchIds: ['P1', 'P2'],
    dryRun: true,
  })
  assert.equal(r.ok, true)
  assert.equal(r.created.length, 2)
  assert.equal(r.skipped.length, 0)
  assert.equal(calls, 0, 'ドライランでは kanban create を実行しない')
})

test('launchSpec は 2 回目に重複起票しない（未完了があるバッチは skipped）', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  /** @type {Array<{id: string, title: string, status: string}>} 疑似ボード */
  const boardState = []
  /** @type {string[][]} 実行された引数 */
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    const title = args[4]
    const id = `t_${String(boardState.length + 1).padStart(3, '0')}`
    boardState.push({ id, title, status: 'ready' })
    return { code: 0, stdout: JSON.stringify({ id, title, status: 'ready' }), stderr: '' }
  }
  const specs = createSpecs({}, { runner, tasks: () => boardState })

  const first = await specs.launchSpec({
    repoPath: root,
    board: 'mobile',
    specRelPath: 'docs/SPEC-A.md',
    batchIds: ['P1', 'P2'],
    assignee: 'mobile',
  })
  assert.equal(first.ok, true)
  assert.deepEqual(
    first.created.map((c) => c.id),
    ['P1', 'P2'],
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'kanban')
  assert.equal(calls[0][2], 'mobile', '--board を渡す')
  assert.equal(calls[0][4], '[P1] First batch')
  assert.ok(calls[0].includes('--assignee'))
  assert.ok(calls[0].includes('mobile'))
  assert.ok(calls[0].includes('--json'))

  const second = await specs.launchSpec({
    repoPath: root,
    board: 'mobile',
    specRelPath: 'docs/SPEC-A.md',
    batchIds: ['P1', 'P2'],
  })
  assert.equal(second.ok, true)
  assert.equal(second.created.length, 0, '2 回目は起票しない')
  assert.deepEqual(
    second.skipped.map((s) => s.id),
    ['P1', 'P2'],
  )
  assert.equal(second.skipped[0].reason, 'exists')
  assert.equal(calls.length, 2, 'CLI 呼び出しも増えない')
})

test('launchSpec は完了済み（done）だけなら起票し直す', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  const boardState = [{ id: 't_old', title: '[P1] First batch', status: 'done' }]
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ id: 't_new', status: 'ready' }), stderr: '' }
  }
  const specs = createSpecs({}, { runner, tasks: () => boardState })
  const r = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/SPEC-A.md', batchIds: ['P1'] })
  assert.equal(r.ok, true)
  assert.equal(r.created.length, 1)
  assert.equal(calls.length, 1)
})

test('launchSpec は batchIds 未指定なら全バッチ、指定ならその分だけ', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  const runner = async () => ({ code: 0, stdout: JSON.stringify({ id: 't_x', status: 'ready' }), stderr: '' })
  const specs = createSpecs({}, { runner, tasks: () => [] })
  const all = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/SPEC-A.md' })
  assert.equal(all.created.length, 2)
  const one = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/SPEC-A.md', batchIds: ['P2'] })
  assert.deepEqual(
    one.created.map((c) => c.id),
    ['P2'],
  )
})

test('不正 spec・不正ボード・存在しないファイルは ok:false で理由を返す', async () => {
  const root = tempDir()
  writeFile(root, 'docs/EMPTY.md', 'no headings at all')
  const specs = createSpecs({}, { runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }), tasks: () => [] })
  const noBatch = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/EMPTY.md' })
  assert.equal(noBatch.ok, false)
  assert.match(noBatch.error, /バッチ見出し/)
  const missing = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/NOPE.md' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /読めません/)
  const badBoard = await specs.launchSpec({ repoPath: root, board: 'bad board!', specRelPath: 'docs/EMPTY.md' })
  assert.equal(badBoard.ok, false)
  assert.match(badBoard.error, /ボード名/)
  const escape = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: '../../etc/passwd' })
  assert.equal(escape.ok, false)
})

test('kanban create が失敗したバッチは failed に入り、成功分は created に残る', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  let n = 0
  const runner = async () => {
    n += 1
    if (n === 1) return { code: 0, stdout: JSON.stringify({ id: 't_ok', status: 'ready' }), stderr: '' }
    return { code: 1, stdout: '', stderr: 'kanban: boom' }
  }
  const specs = createSpecs({}, { runner, tasks: () => [] })
  const r = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/SPEC-A.md' })
  assert.equal(r.ok, false)
  assert.deepEqual(
    r.created.map((c) => c.id),
    ['P1'],
  )
  assert.deepEqual(
    r.failed.map((f) => f.id),
    ['P2'],
  )
  assert.match(r.error, /boom/)
})

// --- V4-2: 起票元チャットの記録（`Chat:` 行）とラン記録（`pipeline-runs.json`） ----------

test('buildTaskBody は `Batch:` の次行に `Chat:` を入れ、不正な ID は書かない', () => {
  const batch = parseSpec(SPEC).batches[0]
  const body = buildTaskBody({
    specRelPath: 'docs/SPEC-A.md',
    repoPath: '/tmp/repo',
    board: 'mobile',
    batch,
    chat: 'local-abc.def:1',
  })
  const lines = body.split('\n')
  const batchAt = lines.findIndex((l) => l.startsWith('Batch: '))
  assert.equal(lines[batchAt + 1], 'Chat: local-abc.def:1', 'Batch の直後に置く')

  const noChat = buildTaskBody({ specRelPath: 'docs/SPEC-A.md', repoPath: '/tmp/repo', board: 'mobile', batch })
  assert.equal(noChat.includes('Chat:'), false, '未指定なら行を作らない')

  assert.equal(sanitizeSpecChat('ok_id-1.2:x').length > 0, true)
  assert.equal(sanitizeSpecChat('bad id with space'), '', '空白は弾く')
  assert.equal(sanitizeSpecChat('line\nbreak'), '', '改行は弾く')
  assert.equal(sanitizeSpecChat(''), '')
})

test('launchSpec は chat を本文に載せ、ランを記録する（DI 可能）', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ id: `t_${calls.length}`, status: 'ready' }), stderr: '' }
  }
  const recorded = []
  const specs = createSpecs({}, { runner, tasks: () => [], recordRun: (r) => recorded.push(r), now: () => 1794800000000 })

  const r = await specs.launchSpec({
    repoPath: root,
    board: 'mobile',
    specRelPath: 'docs/SPEC-A.md',
    batchIds: ['P1', 'P2'],
    chat: 'ses_chat_1',
  })
  assert.equal(r.ok, true)
  const bodyAt = calls[0].indexOf('--body') + 1
  assert.ok(calls[0][bodyAt].includes('Chat: ses_chat_1'), '--body に Chat: 行が入る')

  assert.equal(recorded.length, 1, '1 ランだけ記録する')
  const run = recorded[0]
  assert.match(run.id, /^run_\d{8}T\d{6}_[a-z0-9]{4}$/)
  assert.equal(run.board, 'mobile')
  assert.equal(run.repoPath, root)
  assert.equal(run.specRelPath, 'docs/SPEC-A.md')
  assert.equal(run.title, 'SPEC: Demo (SPEC-DEMO)')
  assert.deepEqual(run.batchIds, ['P1', 'P2'])
  assert.deepEqual(run.taskIds, ['t_1', 't_2'], '起票したタスク ID を残す')
  assert.equal(run.originSessionId, 'ses_chat_1')
  assert.equal(run.reportedAt, null)
  assert.equal(run.createdAt, 1794800000000)
  assert.equal(r.runId, run.id)
})

test('launchSpec はドライランではランを記録しない', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  const recorded = []
  const specs = createSpecs({}, { runner: async () => ({ code: 0, stdout: '{}', stderr: '' }), tasks: () => [], recordRun: (r) => recorded.push(r) })
  const r = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/SPEC-A.md', dryRun: true })
  assert.equal(r.created.length, 2)
  assert.equal(recorded.length, 0)
  assert.equal(r.runId, null)
})

test('既定の recordRun は review/pipeline-runs.json に書く（既存 skip 分も紐づける）', async () => {
  const root = tempDir()
  writeFile(root, 'docs/SPEC-A.md', SPEC)
  const reviewDir = path.join(root, 'plugin-data', 'hermes-pilot', 'review')
  const boardState = [{ id: 't_old', title: '[P1] First batch', status: 'blocked' }]
  const runner = async (args) => {
    const title = args[4]
    const id = `t_${title.replace(/[^A-Za-z0-9]/g, '')}`
    boardState.push({ id, title, status: 'ready' })
    return { code: 0, stdout: JSON.stringify({ id, status: 'ready' }), stderr: '' }
  }
  const specs = createSpecs({ reviewDir }, { runner, tasks: () => boardState })
  const r = await specs.launchSpec({
    repoPath: root,
    board: 'mobile',
    specRelPath: 'docs/SPEC-A.md',
    batchIds: ['P1', 'P2'],
    chat: 'ses_x',
  })
  assert.equal(r.ok, true)
  const runs = readRuns(path.join(reviewDir, 'pipeline-runs.json'))
  assert.equal(runs.length, 1)
  assert.equal(runsPathFor({ reviewDir }), path.join(reviewDir, 'pipeline-runs.json'))
  assert.deepEqual(
    runs[0].taskIds.sort(),
    ['t_old', ...r.created.map((c) => c.taskId)].sort(),
    '既存の紐づけ（skip）も taskIds に入れる',
  )
  assert.equal(fs.existsSync(path.join(reviewDir, 'pipeline-runs.json.tmp')), false, 'アトミック書込')
})

test('pruneRuns は 50 件上限で古い完了分から落とす（未報告は残す）', () => {
  const runs = []
  for (let i = 0; i < 60; i += 1) {
    runs.push({ id: `run_${i}`, createdAt: i, reportedAt: i < 40 ? 'reported' : null })
  }
  const kept = pruneRuns(runs, 50)
  assert.equal(kept.length, 50)
  assert.equal(kept.some((r) => r.id === 'run_0'), false, '最も古い完了分が落ちる')
  assert.equal(kept.some((r) => r.id === 'run_59'), true, '未報告は残る')
  assert.deepEqual(
    kept.map((r) => r.id),
    runs.filter((r) => kept.includes(r)).map((r) => r.id),
    '元の順序を保つ',
  )
  assert.equal(makeRunId(1794800000000).startsWith('run_202611'), true)
})
