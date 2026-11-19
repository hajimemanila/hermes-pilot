/**
 * リスト表示の `⋯` メニュー（SPEC-ver-0-2-1 §2.2 / Batch ver-0-2-1-4）の検証。
 *
 * 受入条件:
 *  - メニューに「ピン留め/解除・ブレスト・仕様策定（＋元チャット）」が仕様の順で揃う
 *  - `chatId` の無いメモでは元チャット行が出ない
 *  - 一列・二列は従来のボタン列が残り、`⋯` はリスト表示のときだけ出る
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MEMO_MENU_ACTIONS, memoMenuRows, showsCardButtons, showsListMenu } from '../src/lib/memoListMenu.js'
import { DEFAULT_MEMOS_VIEW, MEMOS_VIEW_KEY, VIEWS, parseMemosView, rememberMemosView } from '../src/lib/memoView.js'
import { stripComments } from './helpers/stripComments.js'

const here = import.meta.dirname
const readDict = (lang) => JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'i18n', `${lang}.json`), 'utf8'))
const readSource = (rel) => stripComments(fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8'))

test('memoMenuRows: ピン留め/解除・ブレスト・仕様策定がこの順で並ぶ', () => {
  const rows = memoMenuRows({ pinned: false })
  assert.deepEqual(rows.map((r) => r.action), ['pin', 'brainstorm', 'seed'])
  assert.deepEqual(rows.map((r) => r.labelKey), ['notes.pin', 'notes.brainstorm', 'notes.toSeed'])
})

test('memoMenuRows: ピン留め済みは「解除」になる', () => {
  const rows = memoMenuRows({ pinned: true })
  assert.equal(rows[0].labelKey, 'notes.unpin')
})

test('memoMenuRows: chatId を持つメモだけ元チャット行が出る（4 行目・仕様の順）', () => {
  const rows = memoMenuRows({ pinned: false, source: { chatId: 'c-1' } })
  assert.deepEqual(rows.map((r) => r.action), MEMO_MENU_ACTIONS)
  assert.equal(rows[3].labelKey, 'notes.openChat')
})

test('memoMenuRows: chatId が無い／空のメモでは元チャット行を出さない', () => {
  for (const memo of [{}, { source: {} }, { source: { chatId: '' } }, { source: { chatId: null } }]) {
    const actions = memoMenuRows(memo).map((r) => r.action)
    assert.ok(!actions.includes('chat'), `chat 行が出た: ${JSON.stringify(memo)}`)
    assert.deepEqual(actions, ['pin', 'brainstorm', 'seed'])
  }
  assert.deepEqual(memoMenuRows().map((r) => r.action), ['pin', 'brainstorm', 'seed'], 'memo 未指定でも落ちない')
})

test('memoMenuRows: チャットを開く導線が無い呼び出しでは chatId があっても出さない', () => {
  const actions = memoMenuRows({ source: { chatId: 'c-1' } }, { canOpenChat: false }).map((r) => r.action)
  assert.deepEqual(actions, ['pin', 'brainstorm', 'seed'])
})

test('showsListMenu / showsCardButtons: ⋯ はリスト表示のときだけ・ボタン列はその逆', () => {
  assert.equal(showsListMenu('list'), true)
  for (const v of VIEWS.filter((x) => x !== 'list')) {
    assert.equal(showsListMenu(v), false, `${v} で ⋯ を出してはいけない`)
    assert.equal(showsCardButtons(v), true, `${v} は従来のボタン列を残す`)
  }
  assert.equal(showsCardButtons('list'), false)
  assert.equal(showsListMenu(undefined), false, '未知の view はリスト扱いにしない')
})

test('memoMenuRows の labelKey はすべて ja/en に存在する', () => {
  const ja = readDict('ja')
  const en = readDict('en')
  const keys = new Set(MEMO_MENU_ACTIONS.flatMap((action) => memoMenuRows({ pinned: action === 'pin', source: { chatId: 'x' } }).map((r) => r.labelKey)))
  keys.add('notes.more')
  keys.add('notes.menuTitle')
  const missing = [...keys].filter((k) => !(k in ja) || !(k in en))
  assert.deepEqual(missing, [])
})

test('表示モードは既定=二列で、端末保存は 3 モードだけを受ける', () => {
  assert.equal(parseMemosView(null), 'two')
  assert.equal(parseMemosView('nope'), 'two')
  assert.equal(parseMemosView('two'), 'two')
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(rememberMemosView(storage, 'list'), true)
  assert.equal(store.get(MEMOS_VIEW_KEY), 'list')
  assert.equal(parseMemosView(store.get(MEMOS_VIEW_KEY)), 'list')
  assert.equal(rememberMemosView(storage, 'grid'), false, '未知のモードは保存しない')
  assert.equal(DEFAULT_MEMOS_VIEW, 'two')
})

test('MemosPane は ⋯ をリスト表示の分岐の中だけで描く（一列・二列では出さない）', () => {
  const src = readSource('features/MemosPane.jsx')
  const listGate = src.indexOf('showsListMenu(view)')
  const moreBtn = src.indexOf('memo-more-btn')
  const buttonsGate = src.indexOf('showsCardButtons(view)')
  assert.ok(listGate > -1, '⋯ の表示判定に showsListMenu(view) を使う')
  assert.ok(buttonsGate > -1, '従来のボタン列は showsCardButtons(view) で出す')
  assert.ok(moreBtn > listGate, '⋯ ボタンは showsListMenu(view) の後に置く')
  assert.equal(src.split('memo-more-btn').length - 1, 1, '⋯ ボタンは 1 箇所だけ')
})
