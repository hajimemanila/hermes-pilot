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
  BODY_MAX,
  CONTRACT_HEADER,
  RECOMMENDED_ROLE_RE,
  SPEC_CONTENT_MAX,
  buildTaskBody,
  buildTaskTitle,
  createSpecs,
  extractRecommendedRole,
  findOpenBatchTask,
  listSpecs,
  makeRunId,
  normalizeExecutionMode,
  normalizeRecommendedRole,
  parseCreatedTask,
  parseSpec,
  pruneRuns,
  readRuns,
  readSpecContent,
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
  assert.throws(() => resolveSpecPath(root, '../etc/passwd'), (e) => e.code === 'SPEC_PATH_OUTSIDE')
  assert.throws(() => resolveSpecPath(root, '/abs/SPEC.md'), (e) => e.code === 'SPEC_PATH_NOT_RELATIVE')
  assert.throws(() => resolveSpecPath(root, ''), (e) => e.code === 'SPEC_PATH_REQUIRED')
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
  assert.equal(noBatch.code, 'SPEC_BATCH_HEADING_MISSING')
  const missing = await specs.launchSpec({ repoPath: root, board: 'mobile', specRelPath: 'docs/NOPE.md' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'SPEC_READ_FAILED')
  assert.deepEqual(missing.params, { path: 'docs/NOPE.md' })
  const badBoard = await specs.launchSpec({ repoPath: root, board: 'bad board!', specRelPath: 'docs/EMPTY.md' })
  assert.equal(badBoard.ok, false)
  assert.equal(badBoard.code, 'BOARD_NAME_INVALID')
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

// --- Execution Mode 解析 ＆ 行動契約の注入（SPEC-PILOT-V5 §3.2 / Batch V5-1） -------------

const MODE_SPEC = `# SPEC: Mode demo (SPEC-MODE)

### Batch M1: zero stop batch

- **Execution Mode**: \`[Mode: Zero-Stop]\`
- **目的**: 自律で完走する

### Batch M2: review batch

- **実行モード**: [Mode: Fast-Track Review]
- **目的**: 分岐したら聞く

### Batch M3: visual batch

- **Execution Mode**: [Mode: Visual Gate]
- **目的**: 見た目を検証する

### Batch M4: legacy batch

- **目的**: モード未宣言（過去 SPEC）

### 3.1 not a batch

- **Execution Mode**: [Mode: Zero-Stop]
`

test('parseSpec はバッチごとに Execution Mode を正規化して返す（未宣言は null）', () => {
  const parsed = parseSpec(MODE_SPEC)
  assert.deepEqual(
    parsed.batches.map((b) => b.id),
    ['M1', 'M2', 'M3', 'M4'],
    '番号見出しをバッチと誤認している',
  )
  assert.deepEqual(
    parsed.batches.map((b) => b.mode),
    ['zero-stop', 'fast-track-review', 'visual-gate', null],
  )
})

test('normalizeExecutionMode は表記ゆれを吸収し、未知は null', () => {
  assert.equal(normalizeExecutionMode('Zero-Stop'), 'zero-stop')
  assert.equal(normalizeExecutionMode('[Mode: Visual Gate]'), 'visual-gate')
  assert.equal(normalizeExecutionMode('fast-track'), 'fast-track-review')
  assert.equal(normalizeExecutionMode(''), null)
  assert.equal(normalizeExecutionMode('Turbo'), null)
})

test('docs/SPEC-PILOT-V5.md の Batch V5-1 〜 V5-6 と各 Execution Mode を抽出できる', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const file = path.join(root, 'docs', 'SPEC-PILOT-V5.md')
  if (!fs.existsSync(file)) return // 仕様書が無い環境ではスキップ相当
  const parsed = parseSpec(fs.readFileSync(file, 'utf8'))
  const ids = parsed.batches.map((b) => b.id)
  assert.deepEqual(ids, ['V5-1', 'V5-2', 'V5-3', 'V5-4', 'V5-5', 'V5-6'])
  assert.deepEqual(
    parsed.batches.map((b) => b.mode),
    ['zero-stop', 'visual-gate', 'zero-stop', 'visual-gate', 'visual-gate', 'visual-gate'],
  )
  for (const b of parsed.batches) {
    assert.ok(b.section.includes('受入条件'), `${b.id} の受入条件が抜けている`)
  }
})

test('buildTaskBody は Mode 行と [Hermes Pilot Execution Contract] を注入する', () => {
  const batch = parseSpec(MODE_SPEC).batches[2] // M3 = visual-gate
  const body = buildTaskBody({
    specRelPath: 'docs/SPEC-MODE.md',
    repoPath: '/tmp/repo',
    board: 'mobile',
    batch,
    chat: 'local-abc.def:1',
  })
  const lines = body.split('\n')
  const batchAt = lines.findIndex((l) => l.startsWith('Batch: '))
  assert.equal(lines[batchAt + 1], 'Chat: local-abc.def:1', 'Chat が Batch の直後に無い')
  assert.equal(lines[batchAt + 2], 'Mode: visual-gate', 'Mode 行が Chat の直後に無い')
  assert.ok(body.includes(CONTRACT_HEADER), '行動契約ブロックが無い')
  assert.ok(body.includes('npm run deploy'), 'visual-gate の契約（deploy）が入っていない')
  assert.ok(body.includes('390×844'), 'visual-gate の実画面検証が入っていない')
  assert.ok(body.includes('受入条件'), '抜粋が消えている')
  assert.equal(body.indexOf(CONTRACT_HEADER) > body.indexOf('受入条件'), true, '契約は本文の末尾に置く')
})

test('buildTaskBody の契約はモードごとに違う（zero-stop / fast-track-review）', () => {
  const [m1, m2] = parseSpec(MODE_SPEC).batches
  const zero = buildTaskBody({ specRelPath: 'docs/SPEC-MODE.md', repoPath: '/tmp/repo', board: 'b', batch: m1 })
  const fast = buildTaskBody({ specRelPath: 'docs/SPEC-MODE.md', repoPath: '/tmp/repo', board: 'b', batch: m2 })
  assert.ok(zero.includes('Do not ask confirmation questions'), 'zero-stop の契約が無い')
  assert.ok(zero.includes('npm run verify'))
  assert.ok(fast.includes('quick-review'), 'fast-track-review の契約が無い')
  assert.equal(zero.includes('npm run deploy'), false, 'zero-stop に visual-gate の契約が混ざっている')
})

test('buildTaskBody は後方互換: モード未宣言なら Mode 行も契約も足さない', () => {
  const batch = parseSpec(MODE_SPEC).batches[3]
  const body = buildTaskBody({ specRelPath: 'docs/SPEC-MODE.md', repoPath: '/tmp/repo', board: 'b', batch })
  assert.equal(body.includes('Mode: '), false)
  assert.equal(body.includes(CONTRACT_HEADER), false)
  assert.equal(body.length <= BODY_MAX, true)
})

test('buildTaskBody は抜粋を切り詰めても契約ブロックを落とさない（BODY_MAX 内）', () => {
  const huge = {
    id: 'H1',
    title: 'huge batch',
    objective: '大きなバッチ',
    mode: 'zero-stop',
    section: `${'x'.repeat(BODY_MAX * 2)}\n`,
  }
  const body = buildTaskBody({ specRelPath: 'docs/SPEC-BIG.md', repoPath: '/tmp/repo', board: 'b', batch: huge })
  assert.equal(body.length <= BODY_MAX, true, `本文が上限を超えている: ${body.length}`)
  assert.ok(body.includes(CONTRACT_HEADER), '上限で契約が切れている')
  assert.ok(body.trimEnd().endsWith('still unverified.'), '契約の末尾が切れている')
})

test('listSpecs が返すバッチにも mode が載る（PWA のモードピル用）', () => {
  const root = tempDir()
  try {
    writeFile(root, 'docs/SPEC-MODE.md', MODE_SPEC)
    const list = listSpecs(root)
    assert.equal(list.length, 1)
    assert.deepEqual(
      list[0].batches.map((b) => b.mode),
      ['zero-stop', 'fast-track-review', 'visual-gate', null],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('launchSpec は mode 付きバッチの本文へ契約を入れて起票する（dryRun も同じ本文）', async () => {
  const root = tempDir()
  try {
    writeFile(root, 'docs/SPEC-MODE.md', MODE_SPEC)
    const calls = []
    const runner = async (args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify({ id: `t_${calls.length}`, status: 'ready' }), stderr: '' }
    }
    const specs = createSpecs({}, { runner, tasks: () => [], recordRun: () => {} })
    const r = await specs.launchSpec({
      repoPath: root,
      board: 'mobile',
      specRelPath: 'docs/SPEC-MODE.md',
      batchIds: ['M1'],
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(calls.length, 1)
    const bodyArg = calls[0][calls[0].indexOf('--body') + 1]
    assert.ok(bodyArg.includes('Mode: zero-stop'))
    assert.ok(bodyArg.includes(CONTRACT_HEADER))
    assert.equal(calls[0][calls[0].indexOf('--board') + 1], 'mobile')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- readSpecContent（SPEC §V6-2: GET /api/specs/content） ------------------

test('readSpecContent は title / mtime / batchCount / markdown を返す', () => {
  const root = tempDir()
  try {
    writeFile(root, 'docs/SPEC-READ.md', SPEC)
    const r = readSpecContent(root, 'docs/SPEC-READ.md')
    assert.equal(r.ok, true)
    assert.equal(r.path, 'docs/SPEC-READ.md')
    assert.equal(r.title, 'SPEC: Demo (SPEC-DEMO)')
    assert.equal(r.batchCount, 2)
    assert.equal(r.truncated, false)
    assert.equal(r.markdown, SPEC, '全文をそのまま返す')
    assert.equal(r.bytes, Buffer.byteLength(SPEC, 'utf8'))
    assert.ok(r.mtime > 0, 'mtime は epoch ms')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readSpecContent は `../` でリポジトリの外を指すパスを 400 で拒否する', () => {
  const root = tempDir()
  try {
    writeFile(root, 'docs/SPEC-A.md', SPEC)
    writeFile(path.dirname(root), 'SECRET.md', '# secret\n')
    for (const bad of ['../SECRET.md', '../../etc/passwd', 'docs/../../SECRET.md']) {
      assert.throws(
        () => readSpecContent(root, bad),
        (e) => e.code === 'SPEC_PATH_OUTSIDE' && e.statusCode === 400,
        bad,
      )
    }
    // 絶対パス・空も 400
    assert.throws(() => readSpecContent(root, '/etc/passwd'), (e) => e.code === 'SPEC_PATH_NOT_RELATIVE')
    assert.throws(() => readSpecContent(root, ''), (e) => e.code === 'SPEC_PATH_REQUIRED')
  } finally {
    fs.rmSync(path.join(path.dirname(root), 'SECRET.md'), { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readSpecContent は非 `.md` を 400（SPEC_NOT_MARKDOWN）で拒否する', () => {
  const root = tempDir()
  try {
    writeFile(root, 'docs/notes.txt', 'plain text\n')
    writeFile(root, 'docs/SPEC.md.bak', SPEC)
    for (const bad of ['docs/notes.txt', 'docs/SPEC.md.bak']) {
      assert.throws(
        () => readSpecContent(root, bad),
        (e) => e.code === 'SPEC_NOT_MARKDOWN' && e.statusCode === 400,
        bad,
      )
    }
    // 大文字の拡張子は許可する
    writeFile(root, 'docs/SPEC-UPPER.MD', SPEC)
    assert.equal(readSpecContent(root, 'docs/SPEC-UPPER.MD').ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readSpecContent は未検出を 404（SPEC_READ_FAILED）で返す', () => {
  const root = tempDir()
  try {
    assert.throws(
      () => readSpecContent(root, 'docs/SPEC-NOPE.md'),
      (e) => e.code === 'SPEC_READ_FAILED' && e.statusCode === 404,
    )
    // ディレクトリ（`.md` で終わる名前）も 404
    fs.mkdirSync(path.join(root, 'docs', 'SPEC-DIR.md'), { recursive: true })
    assert.throws(
      () => readSpecContent(root, 'docs/SPEC-DIR.md'),
      (e) => e.code === 'SPEC_READ_FAILED' && e.statusCode === 404,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readSpecContent は 256KB を超える本文を切り詰めて truncated を立てる', () => {
  const root = tempDir()
  try {
    // 1 行 100 バイト × 3000 行 ≒ 300KB（ASCII なので境界は安全）
    const line = `${'x'.repeat(99)}\n`
    writeFile(root, 'docs/SPEC-BIG.md', `# SPEC: Big\n\n${line.repeat(3000)}\n### B1: one\n\nbody\n`)
    const r = readSpecContent(root, 'docs/SPEC-BIG.md')
    assert.equal(r.truncated, true)
    assert.ok(r.bytes <= SPEC_CONTENT_MAX, `bytes=${r.bytes} は上限以内`)
    assert.ok(Buffer.byteLength(r.markdown, 'utf8') <= SPEC_CONTENT_MAX)
    assert.equal(r.title, 'SPEC: Big')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readSpecContent は UTF-8 の途中で切れた文字を末尾に残さない', () => {
  const root = tempDir()
  try {
    // 3 バイト文字（あ）で埋めて、上限が文字の途中に落ちるようにする
    const body = 'あ'.repeat(Math.ceil((SPEC_CONTENT_MAX + 10) / 3))
    writeFile(root, 'docs/SPEC-UTF8.md', `# SPEC: UTF8\n\n${body}\n`)
    const r = readSpecContent(root, 'docs/SPEC-UTF8.md')
    assert.equal(r.truncated, true)
    assert.ok(!r.markdown.includes('\uFFFD'), '壊れた文字（U+FFFD）を含まない')
    assert.ok(Buffer.byteLength(r.markdown, 'utf8') <= SPEC_CONTENT_MAX)
    assert.equal(r.bytes, Buffer.byteLength(r.markdown, 'utf8'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** 推奨ロール（D64）付きの SPEC。ロールの有無 × モードの有無を 4 通りそろえる。 */
const ROLE_SPEC = `# SPEC: Role (SPEC-ROLE)

## 4. Batches

### Batch RB1: Builder batch

- **Execution Mode**: [Mode: Zero-Stop]
- **Recommended Role**: \`role:builder\`
- **目的**: build it

### Batch RB2: Reviewer batch

- **Execution Mode**: [Mode: Visual Gate]
- **推奨ロール**: role:visual-reviewer

### RB3: Legacy batch

- **目的**: no role, no mode

### Batch RB4: Unknown role

- **Execution Mode**: [Mode: Fast-Track Review]
- **Recommended Role**: role:ninja
`

test('extractRecommendedRole は抽象ロール 4 つを正規化し、未知・未宣言は null', () => {
  assert.equal(extractRecommendedRole('- **Recommended Role**: `role:builder`'), 'role:builder')
  assert.equal(extractRecommendedRole('- **Recommended Role**: role:visual-reviewer'), 'role:visual-reviewer')
  assert.equal(extractRecommendedRole('- **推奨ロール**: `role:planner`'), 'role:planner')
  // `role:` 接頭辞なしの表記も正規化して受け入れる
  assert.equal(extractRecommendedRole('- **Recommended Role**: `builder`'), 'role:builder')
  assert.equal(extractRecommendedRole('- **Recommended Role**: ROLE:Decision-Framer'), 'role:decision-framer')
  // 抽象ロール 4 つ以外は推測しない
  assert.equal(extractRecommendedRole('- **Recommended Role**: role:ninja'), null)
  assert.equal(extractRecommendedRole('- **Recommended Role**: reviewer'), null)
  assert.equal(extractRecommendedRole('- **目的**: do it'), null)
  assert.equal(extractRecommendedRole(''), null)
  assert.equal(normalizeRecommendedRole('  `role:planner`  '), 'role:planner')
})

test('parseSpec は各バッチへ recommendedRole を付ける（未宣言・未知は null）', () => {
  const parsed = parseSpec(ROLE_SPEC)
  assert.deepEqual(
    parsed.batches.map((b) => b.id),
    ['RB1', 'RB2', 'RB3', 'RB4'],
  )
  assert.deepEqual(
    parsed.batches.map((b) => b.recommendedRole),
    ['role:builder', 'role:visual-reviewer', null, null],
  )
  // Execution Mode の抽出は従来どおり（後方互換）
  assert.deepEqual(
    parsed.batches.map((b) => b.mode),
    ['zero-stop', 'visual-gate', null, 'fast-track-review'],
  )
  assert.equal(RECOMMENDED_ROLE_RE.test('- **Recommended Role**: `role:builder`'), true)
})

test('buildTaskBody は Recommended Role を [Hermes Pilot Execution Contract] に注入する', () => {
  const [rb1, rb2, rb3, rb4] = parseSpec(ROLE_SPEC).batches

  const body = buildTaskBody({ specRelPath: 'docs/SPEC-ROLE.md', repoPath: '/tmp/repo', board: 'b', batch: rb1 })
  assert.ok(body.includes(CONTRACT_HEADER), '行動契約ブロックが無い')
  assert.ok(body.includes('Recommended role: `role:builder`'), 'ロール指針が契約に無い')
  assert.ok(body.includes('fallback chain'), 'フォールバック指示が無い')
  assert.ok(body.includes('external AI CLI'), '外部 AI CLI 禁止が無い')
  assert.ok(body.includes('Do not ask confirmation questions'), 'zero-stop の契約が消えている')
  assert.equal(body.length <= BODY_MAX, true, `本文が上限超過: ${body.length}`)
  assert.equal(body.indexOf(CONTRACT_HEADER) > 0, true, '契約は本文の末尾に置く')

  // visual-gate はロール未宣言でも `role:visual-reviewer` 併用を勧める（既存挙動＋1 行）
  const visual = buildTaskBody({ specRelPath: 'docs/SPEC-ROLE.md', repoPath: '/tmp/repo', board: 'b', batch: rb2 })
  assert.ok(visual.includes('`role:visual-reviewer`'))
  assert.ok(visual.includes('npm run deploy'))

  // 後方互換: モードもロールも無ければ契約を足さない
  const legacy = buildTaskBody({ specRelPath: 'docs/SPEC-ROLE.md', repoPath: '/tmp/repo', board: 'b', batch: rb3 })
  assert.equal(legacy.includes(CONTRACT_HEADER), false)

  // 未知のロール宣言は推測せず、モード契約だけを出す
  const fast = buildTaskBody({ specRelPath: 'docs/SPEC-ROLE.md', repoPath: '/tmp/repo', board: 'b', batch: rb4 })
  assert.ok(fast.includes('Mode: fast-track-review'))
  assert.equal(fast.includes('Recommended role:'), false, '未知のロールを推測して書いている')
  assert.ok(fast.includes('quick-review'))
})

test('docs/SPEC-ROLE-DELEGATION-ROUTING.md の Batch R1〜R4 と推奨ロールを抽出できる', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const file = path.join(root, 'docs', 'SPEC-ROLE-DELEGATION-ROUTING.md')
  if (!fs.existsSync(file)) return // 仕様書が無い環境ではスキップ相当
  const parsed = parseSpec(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(
    parsed.batches.map((b) => b.id),
    ['R1', 'R2', 'R3', 'R4'],
  )
  assert.deepEqual(
    parsed.batches.map((b) => b.recommendedRole),
    ['role:planner', 'role:builder', 'role:planner', 'role:builder'],
  )
  assert.deepEqual(
    parsed.batches.map((b) => b.mode),
    ['zero-stop', 'zero-stop', 'fast-track-review', 'zero-stop'],
  )
})
