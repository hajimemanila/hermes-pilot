import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SCAN_TTL_MS,
  boardsForRepo,
  createRepos,
  defaultReposConfig,
  isGitRepo,
  isSafeBoardSlug,
  joinRepos,
  mergeRepos,
  normalizePath,
  readReposConfig,
  repoIdFromPath,
  scanGitDirs,
  writeReposConfig,
} from '../src/repos.js'

const HOME = os.homedir()

const REPOS = [
  { id: 'hermes-mobile-pwa', label: 'Hermes Mobile PWA', path: path.join(HOME, 'Projects/hermes-mobile-pwa') },
  { id: 'other-app', label: 'Other App', path: path.join(HOME, 'projects/other-app') },
  { id: 'hermes-agent', label: 'Hermes Agent', path: path.join(HOME, '.hermes/hermes-agent') },
]

const BOARDS = [
  { slug: 'hermes-mobile-pwa', name: 'hermes-mobile-pwa', workdir: path.join(HOME, 'Projects/hermes-mobile-pwa'), current: true },
  { slug: 'custom-launcher', name: 'Custom Launcher（Phase 1）', workdir: path.join(HOME, 'Projects/other-app') },
  { slug: 'other-app-2', name: 'Other App 2', workdir: path.join(HOME, 'projects/other-app') },
  { slug: 'old', name: 'Old', workdir: path.join(HOME, 'projects/other-app'), archived: true },
  { slug: 'elsewhere', name: 'Elsewhere', workdir: path.join(HOME, 'Projects/akapen') },
]

/** 一時ディレクトリ（Git リポジトリの入れ物）。 */
function tempDir(prefix = 'hm-repos-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** `<dir>/<name>/.git` を作る（中身は空でよい）。 */
function makeRepo(dir, name) {
  const abs = path.join(dir, name)
  fs.mkdirSync(path.join(abs, '.git'), { recursive: true })
  return abs
}

test('normalizePath は ~ を展開し、大小文字と末尾スラッシュを揃える', () => {
  assert.equal(normalizePath('~/Projects/x/'), normalizePath(path.join(HOME, 'projects/x')))
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath('   '), '')
})

test('isGitRepo は .git ディレクトリでも worktree の .git ファイルでも true', () => {
  const dir = tempDir()
  const a = makeRepo(dir, 'a')
  const b = path.join(dir, 'b')
  fs.mkdirSync(b)
  fs.writeFileSync(path.join(b, '.git'), 'gitdir: /tmp/x\n')
  const c = path.join(dir, 'c')
  fs.mkdirSync(c)
  assert.equal(isGitRepo(a), true)
  assert.equal(isGitRepo(b), true, 'worktree の .git はファイル')
  assert.equal(isGitRepo(c), false)
  assert.equal(isGitRepo(path.join(dir, 'nope')), false)
})

test('repoIdFromPath は安全な slug を作る（記号は - に潰す）', () => {
  assert.equal(repoIdFromPath('/Users/a/Projects/hermes-mobile-pwa'), 'hermes-mobile-pwa')
  assert.equal(repoIdFromPath('/tmp/My Repo!'), 'my-repo')
  assert.equal(repoIdFromPath('/tmp/---'), 'repo')
  assert.ok(isSafeBoardSlug(repoIdFromPath('/tmp/日本語')))
})

test('scanGitDirs: 一時ディレクトリのダミー .git リポジトリ 2 個を 1 階層で自動検出する', () => {
  const scanRoot = tempDir('hm-scan-')
  const one = makeRepo(scanRoot, 'alpha')
  const two = makeRepo(scanRoot, 'beta')
  fs.mkdirSync(path.join(scanRoot, 'not-a-repo')) // .git が無い → 出さない
  fs.mkdirSync(path.join(scanRoot, '.hidden', '.git'), { recursive: true }) // 隠しは対象外
  const nested = path.join(scanRoot, 'not-a-repo', 'deep')
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true }) // 2 階層目 → 出さない

  const found = scanGitDirs([scanRoot])
  assert.deepEqual(
    found.map((r) => r.label),
    ['alpha', 'beta'],
    '.git を持つ直下の 2 個だけ（深さ 1 に限定）',
  )
  assert.deepEqual(
    found.map((r) => r.path).sort(),
    [one, two].sort(),
  )
  assert.equal(found[0].source, 'scan')
  assert.equal(found[0].id, 'alpha')
})

test('scanGitDirs: 存在しない走査先・重複指定でも落ちない', () => {
  const scanRoot = tempDir('hm-scan2-')
  makeRepo(scanRoot, 'alpha')
  const found = scanGitDirs([scanRoot, scanRoot, path.join(scanRoot, 'missing')])
  assert.equal(found.length, 1)
  assert.deepEqual(scanGitDirs([]), [])
  assert.deepEqual(scanGitDirs(['~/definitely-not-a-real-dir-xyz']), [])
})

test('repos.json: 壊れた値・配列・欠損は既定に落ちる（落ちない）', () => {
  const dir = tempDir()
  const file = path.join(dir, 'repos.json')
  const def = defaultReposConfig()
  assert.deepEqual(readReposConfig(file), def, 'ファイルが無ければ既定')
  fs.writeFileSync(file, 'not json')
  assert.deepEqual(readReposConfig(file), def)
  fs.writeFileSync(file, JSON.stringify([1, 2]))
  assert.deepEqual(readReposConfig(file), def)
  const saved = writeReposConfig(file, {
    scanDirs: ['~/projects', ''],
    pinned: ['a', 'a'],
    hidden: [path.join(HOME, 'Projects/x')],
    custom: [{ id: 'my-repo', label: 'My', path: '~/work/my-repo' }, { path: '' }],
  })
  assert.deepEqual(saved.scanDirs, ['~/projects'])
  assert.deepEqual(saved.pinned, ['a'], '重複は落とす')
  assert.equal(saved.custom.length, 1)
  assert.equal(saved.custom[0].path, path.join(HOME, 'work/my-repo'), '~ を展開して保存')
  assert.equal(saved.hidden.length, 1)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'トークン隣に置くので 0600')
})

test('mergeRepos: 4 ソースを統合し、重複パスは 1 件に畳む', () => {
  const dir = tempDir()
  const customRepo = makeRepo(dir, 'custom-one')
  const scanRepo = makeRepo(dir, 'scanned-one')
  const boardRepo = makeRepo(dir, 'board-one')
  const sessionRepo = makeRepo(dir, 'session-one')
  const rows = mergeRepos({
    config: { scanDirs: [], pinned: [], hidden: [], custom: [{ id: 'custom-one', label: 'Custom', path: customRepo }] },
    scanned: [{ id: 'scanned-one', label: 'scanned-one', path: scanRepo, source: 'scan' }],
    boards: [{ slug: 'b1', name: 'Board One', workdir: boardRepo }],
    cwds: [sessionRepo, scanRepo],
  })
  assert.deepEqual(
    rows.map((r) => r.source).sort(),
    ['board', 'custom', 'scan', 'session'],
  )
  assert.equal(rows.filter((r) => normalizePath(r.path) === normalizePath(scanRepo)).length, 1, 'パスの重複は 1 件')
  assert.equal(rows.length, 4)
})

test('mergeRepos: hidden は除外・pinned は先頭・.git の無いものとホームは候補にしない', () => {
  const dir = tempDir()
  const a = makeRepo(dir, 'aaa')
  const b = makeRepo(dir, 'zzz')
  const noGit = path.join(dir, 'plain')
  fs.mkdirSync(noGit)
  const rows = mergeRepos({
    config: { scanDirs: [], pinned: ['zzz'], hidden: [a], custom: [] },
    scanned: [
      { id: 'aaa', label: 'aaa', path: a, source: 'scan' },
      { id: 'zzz', label: 'zzz', path: b, source: 'scan' },
    ],
    boards: [{ slug: 'x', name: 'X', workdir: noGit }],
    cwds: [HOME],
  })
  assert.deepEqual(rows.map((r) => r.id), ['zzz'], 'hidden と .git 無しとホームは落ちる')
  assert.equal(rows[0].pinned, true)
})

test('boardsForRepo: workdir が一致する板だけ・アーカイブは除く（実測 3 板の repo がある）', () => {
  const hits = boardsForRepo(REPOS[1].path, BOARDS)
  assert.deepEqual(hits.map((b) => b.slug), ['custom-launcher', 'other-app-2'], 'archived と別 workdir は混ぜない')
  assert.deepEqual(boardsForRepo(REPOS[2].path, BOARDS), [], '板が無い repo は空（推測で寄せない）')
})

test('joinRepos: repo ごとに板を添え、未知の workdir の板は捨てる', () => {
  const out = joinRepos(REPOS, BOARDS)
  assert.equal(out.length, 3)
  assert.equal(out[0].boards.length, 1)
  assert.equal(out[0].boards[0].current, true, 'current を残す（複数板の既定に使う）')
  assert.equal(out[1].boards.length, 2)
  assert.equal(out[2].boards.length, 0)
  assert.ok(!JSON.stringify(out).includes('elsewhere'), 'どの repo にも属さない板は出さない')
})

test('joinRepos: 空・重複 id でも落ちない', () => {
  assert.deepEqual(joinRepos([], BOARDS), [])
  assert.equal(joinRepos([REPOS[0], REPOS[0]], BOARDS).length, 1)
  assert.deepEqual(joinRepos([{ id: '', path: '/x' }], BOARDS), [])
})

test('isSafeBoardSlug は CLI と同じ規則（パス区切り・空白・先頭記号を弾く）', () => {
  assert.equal(isSafeBoardSlug('hermes-mobile-pwa'), true)
  assert.equal(isSafeBoardSlug('a.b_c-1'), true)
  assert.equal(isSafeBoardSlug('../etc'), false)
  assert.equal(isSafeBoardSlug('-x'), false)
  assert.equal(isSafeBoardSlug('a b'), false)
  assert.equal(isSafeBoardSlug(''), false)
})

/** 設定ファイル付きの repos を作る（走査先は一時ディレクトリ。未指定なら空）。 */
function makeRepos({ scanRoot, boards = () => [], cwds = () => [], now, runner } = {}) {
  const dir = tempDir('hm-cfg-')
  const configPath = path.join(dir, 'repos.json')
  // 既定の走査先（~/Projects 等）に依存しないよう、必ず明示した設定で始める
  writeReposConfig(configPath, { scanDirs: scanRoot ? [scanRoot] : [], pinned: [], hidden: [], custom: [] })
  let clock = 1_000
  const repos = createRepos(
    {},
    {
      boards,
      cwds,
      configPath,
      now: now ?? (() => (clock += 1)),
      runner: runner ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
    },
  )
  return { repos, configPath }
}

test('createRepos.list: scanDirs のダミー 2 個がボード付きで返る（自動検出）', () => {
  const scanRoot = tempDir('hm-scan3-')
  makeRepo(scanRoot, 'alpha')
  makeRepo(scanRoot, 'beta')
  const { repos } = makeRepos({ scanRoot })
  const list = repos.list()
  assert.deepEqual(list.map((r) => r.id), ['alpha', 'beta'])
  assert.equal(list[0].source, 'scan')
  assert.equal(list[0].boards.length, 0)
  assert.deepEqual(repos.scanDirs(), [scanRoot])
  assert.deepEqual(
    repos.targets().map((t) => t.id),
    ['alpha', 'beta'],
  )
})

test('createRepos: 30 秒キャッシュ・POST /api/repos/scan 相当で即時再スキャン', () => {
  const scanRoot = tempDir('hm-scan4-')
  makeRepo(scanRoot, 'alpha')
  let clock = 1_000_000
  const { repos } = makeRepos({ scanRoot, now: () => clock })
  assert.equal(repos.list().length, 1)
  makeRepo(scanRoot, 'beta')
  assert.equal(repos.list().length, 1, `${SCAN_TTL_MS}ms 未満はキャッシュ`)
  clock += SCAN_TTL_MS + 1
  assert.equal(repos.list().length, 2, 'TTL を過ぎたら再走査')

  makeRepo(scanRoot, 'gamma')
  const scanned = repos.scan()
  assert.deepEqual(scanned.repos.map((r) => r.id), ['alpha', 'beta', 'gamma'], 'scan は即時')
})

test('createRepos.add: 実在＋.git を確認し、ホーム・非 Git は拒否する', () => {
  const dir = tempDir('hm-add-')
  const repo = makeRepo(dir, 'mine')
  const plain = path.join(dir, 'plain')
  fs.mkdirSync(plain)
  const { repos } = makeRepos({})

  assert.equal(repos.add({ path: HOME }).ok, false)
  assert.equal(repos.add({ path: '~' }).ok, false)
  assert.equal(repos.add({ path: plain }).ok, false)
  assert.match(repos.add({ path: path.join(dir, 'ghost') }).error, /Git リポジトリではありません|存在しません/)
  assert.equal(repos.add({ path: '' }).ok, false)

  const added = repos.add({ path: repo, label: 'Mine' })
  assert.equal(added.ok, true)
  const list = repos.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'mine')
  assert.equal(list[0].source, 'custom')
  assert.equal(list[0].label, 'Mine')
})

test('createRepos.remove: custom は削除・自動検出は hidden に入れて一覧から消す', () => {
  const scanRoot = tempDir('hm-rm-')
  const scanned = makeRepo(scanRoot, 'alpha')
  const customDir = tempDir('hm-rm2-')
  const custom = makeRepo(customDir, 'mine')
  const { repos, configPath } = makeRepos({ scanRoot })
  repos.add({ path: custom })
  assert.deepEqual(repos.list().map((r) => r.source).sort(), ['custom', 'scan'])

  assert.equal(repos.remove('mine').ok, true)
  const afterCustom = readReposConfig(configPath)
  assert.equal(afterCustom.custom.length, 0, 'custom から消える')
  assert.equal(afterCustom.hidden.length, 0, '自動検出は hidden に入れない')

  const res = repos.remove('alpha')
  assert.equal(res.ok, true)
  assert.equal(res.hidden, true)
  assert.deepEqual(repos.list().map((r) => r.id), [], 'hidden は一覧から消える')
  assert.equal(readReposConfig(configPath).hidden[0], normalizePath(scanned))
  assert.equal(repos.remove('nope').ok, false)
})

test('createRepos.setScanDirs: 実在ディレクトリのみ・ホーム直下は拒否', () => {
  const scanRoot = tempDir('hm-dirs-')
  const { repos, configPath } = makeRepos({})
  assert.equal(repos.setScanDirs([HOME]).ok, false)
  assert.equal(repos.setScanDirs(['/definitely/not/here']).ok, false)
  assert.equal(repos.setScanDirs('nope').ok, false)
  const ok = repos.setScanDirs([scanRoot, scanRoot])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.scanDirs, [scanRoot], '重複は落とす')
  assert.deepEqual(readReposConfig(configPath).scanDirs, [scanRoot])
})

test('createRepos: ボードの workdir と直近 cwd も一覧に入る', () => {
  const boardDir = makeRepo(tempDir('hm-b-'), 'board-repo')
  const cwdDir = makeRepo(tempDir('hm-c-'), 'cwd-repo')
  const { repos } = makeRepos({
    boards: () => [{ slug: 'board-repo', name: 'Board Repo', workdir: boardDir, counts: {} }],
    cwds: () => [cwdDir],
  })
  const byId = Object.fromEntries(repos.list().map((r) => [r.id, r]))
  assert.equal(byId['board-repo'].source, 'board')
  assert.equal(byId['cwd-repo'].source, 'session')
})

test('createBoard: 板が無い repo にだけ作る（既にあれば作らない）', async () => {
  const calls = []
  const dir = tempDir('hm-cb-')
  const repoA = makeRepo(dir, 'board-repo')
  const repoB = makeRepo(dir, 'no-board-repo')
  const { repos } = makeRepos({
    boards: () => [{ slug: 'board-repo', name: 'Board Repo', workdir: repoA, counts: {} }],
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  repos.add({ path: repoA, label: 'Board Repo' })
  repos.add({ path: repoB, label: 'No Board Repo' })

  const existing = await repos.createBoard('board-repo')
  assert.equal(existing.ok, true)
  assert.equal(existing.created, false)
  assert.equal(existing.board.slug, 'board-repo')
  assert.equal(calls.length, 0, '既にある板では CLI を叩かない')

  const made = await repos.createBoard('no-board-repo')
  assert.equal(made.ok, true)
  assert.equal(made.created, true)
  assert.deepEqual(calls[0], ['kanban', 'boards', 'create', 'no-board-repo', '--name', 'No Board Repo', '--default-workdir', repoB])
})

test('createBoard: 未登録 id と CLI 失敗は ok:false で返す（黙って作らない）', async () => {
  const { repos } = makeRepos({ boards: () => [], runner: async () => ({ code: 1, stdout: '', stderr: 'board already exists' }) })
  const unknown = await repos.createBoard('nope')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未登録/)
  const custom = makeRepo(tempDir('hm-cb2-'), 'fresh')
  repos.add({ path: custom })
  const failed = await repos.createBoard('fresh')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /board already exists/)
})
