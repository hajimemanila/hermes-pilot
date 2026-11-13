import test from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../src/i18n/lang.js'
import {
  BOARD_KEY,
  PENDING_REPO_KEY,
  PINNED_ROWS,
  RECENT_REPOS_KEY,
  RECENT_MAX,
  REPO_KEY,
  boardSummary,
  defaultBoard,
  matchRepoByCwd,
  pinnedRepos,
  readLastRepo,
  readPendingRepo,
  readRecent,
  rememberRepo,
  writePendingRepo,
} from '../src/lib/repoPicker.js'

/** localStorage 相当（テスト用の最小実装）。 */
function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

const REPOS = [
  { id: 'hermes-mobile-pwa', label: 'Hermes Mobile PWA', boards: [{ slug: 'hermes-mobile-pwa', current: false }] },
  {
    id: 'app-launcher',
    label: 'App Launcher',
    boards: [
      { slug: 'custom-launcher' },
      { slug: 'app-launcher' },
      { slug: 'app-dev-env' },
    ],
  },
  { id: 'hermes-agent', label: 'Hermes Agent', boards: [] },
  { id: 'web-console', label: 'Web Console', boards: [{ slug: 'web-console' }] },
  { id: 'controller-pwa', label: 'controller-pwa', boards: [{ slug: 'controller-pwa' }] },
]

test('boardSummary は板の数を偽らない（sheet repo-picker-01 Q2=A の文言）', () => {
  setLang('ja')
  assert.equal(boardSummary([{ slug: 'hermes-mobile-pwa' }]), 'ボード 1 つ: hermes-mobile-pwa')
  assert.equal(
    boardSummary([{ slug: 'custom-launcher' }, { slug: 'app-launcher' }, { slug: 'app-dev-env' }]),
    'ボード 3 つ: custom-launcher / app-launcher / app-dev-env',
  )
  assert.equal(boardSummary([]), 'ボードなし', '板が無いリポジトリは「ボードなし」')
  assert.equal(boardSummary([{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }, { slug: 'd' }]), 'ボード 4 つ: a / b / c ほか 1')
  // 英語が既定（SPEC §6.1）。日本語と同じ意味で、件数は偽らない
  setLang('en')
  assert.equal(boardSummary([{ slug: 'hermes-mobile-pwa' }]), '1 boards: hermes-mobile-pwa')
  assert.equal(boardSummary([]), 'No boards')
  setLang('en')
})

test('defaultBoard は current を優先し、無ければ先頭', () => {
  assert.equal(defaultBoard([{ slug: 'a' }, { slug: 'b', current: true }]).slug, 'b')
  assert.equal(defaultBoard([{ slug: 'a' }, { slug: 'b' }]).slug, 'a')
  assert.equal(defaultBoard([]), null)
})

test('pinnedRepos: 履歴が先頭、足りない分は一覧の順で 4 行に埋める（Q1=A の 3+4 行）', () => {
  const { rows, total, hidden } = pinnedRepos(REPOS, ['web-console', 'hermes-agent'])
  assert.equal(rows.length, PINNED_ROWS)
  assert.equal(rows[0].id, 'web-console', '直近が先頭')
  assert.equal(rows[1].id, 'hermes-agent')
  assert.equal(total, REPOS.length)
  assert.equal(hidden, REPOS.length - PINNED_ROWS, '残りは「すべて」から選ぶ')
})

test('pinnedRepos: 履歴が壊れていても・重複しても落ちない', () => {
  const { rows } = pinnedRepos(REPOS, ['web-console', 'web-console', 'ghost', '', null])
  assert.equal(rows[0].id, 'web-console')
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, '重複しない')
  assert.deepEqual(pinnedRepos([], ['x']).rows, [])
})

test('rememberRepo は「この会話の選択」と次回の初期値・ボード既定を同時に残す（Q4=A）', () => {
  const s = fakeStorage({ [RECENT_REPOS_KEY]: JSON.stringify(['web-console']) })
  const saved = rememberRepo(s, { id: 'hermes-mobile-pwa', board: { slug: 'hermes-mobile-pwa' } })
  assert.deepEqual(saved, { repo: 'hermes-mobile-pwa', board: 'hermes-mobile-pwa' })
  assert.equal(s.getItem(REPO_KEY), 'hermes-mobile-pwa', '次回の初期値')
  assert.equal(s.getItem(BOARD_KEY), 'hermes-mobile-pwa', '起票の既定ボードがその repo の板になる')
  const recent = JSON.parse(s.getItem(RECENT_REPOS_KEY))
  assert.deepEqual(recent, ['hermes-mobile-pwa', 'web-console'], '新しい順・重複なし')
})

test('rememberRepo: 履歴は 6 件まで・storage が拒否しても会話は始められる', () => {
  const many = Array.from({ length: RECENT_MAX }, (_, i) => `r${i}`)
  const s = fakeStorage({ [RECENT_REPOS_KEY]: JSON.stringify(many) })
  rememberRepo(s, { id: 'new', board: { slug: 'new' } })
  const recent = JSON.parse(s.getItem(RECENT_REPOS_KEY))
  assert.equal(recent.length, RECENT_MAX)
  assert.equal(recent[0], 'new')
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  assert.deepEqual(rememberRepo(broken, { id: 'x', board: { slug: 'x' } }), { repo: 'x', board: 'x' })
  assert.deepEqual(rememberRepo(null, { id: 'x' }), { repo: null, board: null })
})

test('readRecent / readLastRepo は壊れた保存値を無視する', () => {
  assert.deepEqual(readRecent(fakeStorage({ [RECENT_REPOS_KEY]: '{oops' })), [])
  assert.deepEqual(readRecent(fakeStorage({ [RECENT_REPOS_KEY]: '{"a":1}' })), [])
  assert.equal(readLastRepo(fakeStorage()), null)
  assert.equal(readLastRepo(fakeStorage({ [REPO_KEY]: 'web-console' })), 'web-console')
})

test('matchRepoByCwd は大小文字と末尾スラッシュを無視して一致を返す', () => {
  const repos = [
    { id: 'hermes-mobile-pwa', path: '/Users/h/Projects/hermes-mobile-pwa' },
    { id: 'sample-app', path: '/Users/h/projects/sample-app' },
  ]
  assert.equal(matchRepoByCwd(repos, '/Users/h/projects/hermes-mobile-pwa/')?.id, 'hermes-mobile-pwa')
  assert.equal(matchRepoByCwd(repos, '/Users/h/projects/unknown'), null)
  assert.equal(matchRepoByCwd(repos, ''), null)
})

test('writePendingRepo / readPendingRepo は未送信時の選択を保存・削除する', () => {
  const s = fakeStorage()
  writePendingRepo(s, { repoId: 'hermes-mobile-pwa', profile: 'mobile' })
  assert.deepEqual(readPendingRepo(s), { repoId: 'hermes-mobile-pwa', profile: 'mobile' })
  writePendingRepo(s, null)
  assert.equal(readPendingRepo(s), null)
  assert.equal(readPendingRepo(fakeStorage({ [PENDING_REPO_KEY]: '{broken' })), null)
})
