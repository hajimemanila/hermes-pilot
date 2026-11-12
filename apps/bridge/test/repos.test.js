import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { boardsForRepo, createRepos, isSafeBoardSlug, joinRepos, normalizePath } from '../src/repos.js'

const HOME = os.homedir()

const REPOS = [
  { id: 'hermes-mobile-pwa', label: 'Hermes Mobile PWA', path: path.join(HOME, 'Projects/hermes-mobile-pwa') },
  { id: 'nanokvm-custom-launcher', label: 'NanoKVM Custom Launcher', path: path.join(HOME, 'projects/nanokvm-custom-launcher') },
  { id: 'hermes-agent', label: 'Hermes Agent', path: path.join(HOME, '.hermes/hermes-agent') },
]

const BOARDS = [
  { slug: 'hermes-mobile-pwa', name: 'hermes-mobile-pwa', workdir: path.join(HOME, 'Projects/hermes-mobile-pwa'), current: true },
  { slug: 'custom-launcher', name: 'Custom Launcher（Phase 1）', workdir: path.join(HOME, 'Projects/nanokvm-custom-launcher') },
  { slug: 'nanokvm-custom-launcher', name: 'NanoKVM Custom Launcher', workdir: path.join(HOME, 'Projects/nanokvm-custom-launcher') },
  { slug: 'nanokvm-dev-env', name: 'NanoKVM 開発環境構築', workdir: path.join(HOME, 'Projects/nanokvm-custom-launcher') },
  { slug: 'old', name: 'Old', workdir: path.join(HOME, 'Projects/nanokvm-custom-launcher'), archived: true },
  { slug: 'elsewhere', name: 'Elsewhere', workdir: path.join(HOME, 'Projects/akapen') },
]

test('normalizePath は ~ を展開し、大小文字と末尾スラッシュを揃える', () => {
  assert.equal(normalizePath('~/Projects/hermes-mobile-pwa/'), normalizePath(path.join(HOME, 'projects/hermes-mobile-pwa')))
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath('   '), '')
})

test('boardsForRepo: workdir が一致する板だけ・アーカイブは除く（実測 3 板の repo がある）', () => {
  const hits = boardsForRepo(REPOS[1].path, BOARDS)
  assert.deepEqual(
    hits.map((b) => b.slug),
    ['custom-launcher', 'nanokvm-custom-launcher', 'nanokvm-dev-env'],
    'archived と別 workdir は混ぜない',
  )
  assert.deepEqual(boardsForRepo(REPOS[2].path, BOARDS), [], '板が無い repo は空（推測で寄せない）')
})

test('joinRepos: repo ごとに板を添え、未知の workdir の板は捨てる', () => {
  const out = joinRepos(REPOS, BOARDS)
  assert.equal(out.length, 3)
  assert.equal(out[0].boards.length, 1)
  assert.equal(out[0].boards[0].current, true, 'current を残す（複数板の既定に使う）')
  assert.equal(out[1].boards.length, 3)
  assert.equal(out[2].boards.length, 0)
  assert.ok(!JSON.stringify(out).includes('elsewhere'), 'どの repo にも属さない板は出さない')
})

test('joinRepos: repos.json が空・重複 id でも落ちない', () => {
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

test('createBoard: 板が無い repo にだけ作る（既にあれば作らない）', async () => {
  const calls = []
  const repos = createRepos(
    { hermesBin: 'hermes' },
    {
      targets: () => REPOS,
      boards: () => BOARDS,
      runner: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )

  const existing = await repos.createBoard('hermes-mobile-pwa')
  assert.equal(existing.ok, true)
  assert.equal(existing.created, false)
  assert.equal(existing.board.slug, 'hermes-mobile-pwa')
  assert.equal(calls.length, 0, '既にある板では CLI を叩かない')

  const made = await repos.createBoard('hermes-agent')
  assert.equal(made.ok, true)
  assert.equal(made.created, true)
  assert.deepEqual(calls[0], [
    'kanban',
    'boards',
    'create',
    'hermes-agent',
    '--name',
    'Hermes Agent',
    '--default-workdir',
    path.join(HOME, '.hermes/hermes-agent'),
  ])
})

test('createBoard: 未登録 id と CLI 失敗は ok:false で返す（黙って作らない）', async () => {
  const repos = createRepos(
    {},
    {
      targets: () => REPOS,
      boards: () => BOARDS,
      runner: async () => ({ code: 1, stdout: '', stderr: 'board already exists' }),
    },
  )
  const unknown = await repos.createBoard('nope')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未登録/)
  const failed = await repos.createBoard('hermes-agent')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /board already exists/)
})

test('list は boards / targets の差し替えだけで合成できる（CLI もファイルも触らない）', () => {
  const repos = createRepos({}, { targets: () => REPOS, boards: () => BOARDS })
  const list = repos.list()
  assert.equal(list.length, 3)
  assert.equal(list[1].boards.length, 3)
})
