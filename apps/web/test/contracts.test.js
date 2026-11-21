/**
 * Frontend 契約モジュールのテスト（SPEC-COHERENCE Batch COH-1 / D81）。
 *
 * 固定すること:
 *  1. `HM_EVENTS`（25 種）と `HM_STORAGE`（22 種）が一意で、全件 prefix が揃っている
 *  2. `HM_EVENT_META` が全イベントの payload を持つ（契約の抜けを作らない）
 *  3. 既存の定数名（`VIBE_EVENT` / `SNIPPET_BARS_EVENT` / `THEME_KEY` など）が
 *     **同じ値の再エクスポート**として生きている（後方互換）
 *  4. `apps/web/src`（`contracts/` 除く）に生 `'hm:*'` / `'hm.*'` が 0 件
 *  5. `App.jsx` の `setTimeout` タブ間リレーが廃止され、`pendingInboxOpen` /
 *     `setPendingChatOpen` の prop 経路で渡されている
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/stripComments.js'

import { HM_EVENTS, HM_EVENT_META, emitHmEvent, onHmEvent } from '../src/contracts/events.js'
import { HM_STORAGE } from '../src/contracts/storage.js'

import { FX_EVENT, VIBE_EVENT, VIBE_KEY } from '../src/lib/vibe.js'
import { SNIPPET_BARS_EVENT, SNIPPET_BARS_KEY } from '../src/lib/snippetBars.js'
import { THEME_KEY } from '../src/lib/theme.js'
import { HAPTIC_KEY } from '../src/lib/haptic.js'
import { SOUND_KEY } from '../src/lib/soundFx.js'
import {
  ACTIVE_CHAT_KEY,
  LAST_CHAT_KEY,
  SEEN_MAP_KEY,
  SEEN_NAV_KEY,
} from '../src/lib/chatReports.js'
import {
  BOARD_KEY as REPO_BOARD_KEY,
  PENDING_REPO_KEY,
  RECENT_REPOS_KEY,
  REPO_KEY,
  REVIEW_REPO_KEY,
} from '../src/lib/repoPicker.js'
import { MEMOS_VIEW_KEY } from '../src/lib/memoView.js'
import { DEFAULT_PROFILE_MARK, STORED_PROFILE_KEY } from '../src/lib/profile.js'
import { SESSION_SEEN_KEY } from '../src/lib/sessionUnread.js'
import { STORAGE_KEY as LANG_STORAGE_KEY } from '../src/i18n/lang.js'

const here = import.meta.dirname
const SRC = path.join(here, '..', 'src')

/** `src` 配下の JS/JSX を集める（`contracts/` は正本なので除外する）。 */
function sourceFiles(dir = SRC, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'contracts') continue
      sourceFiles(full, acc)
      continue
    }
    if (!/\.(js|jsx)$/.test(entry.name)) continue
    acc.push(full)
  }
  return acc
}

/** コメントを落としたソース（コメント中の `hm.` 言及を違反にしない）。 */
function code(rel) {
  return stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))
}

test('HM_EVENTS は 25 種で、値がすべて一意な hm: 名', () => {
  const values = Object.values(HM_EVENTS)
  assert.equal(values.length, 25)
  assert.equal(new Set(values).size, 25, '同じイベント名が 2 回定義されている')
  for (const name of values) assert.match(name, /^hm:[a-z][a-z-]*$/)
  assert.ok(Object.isFrozen(HM_EVENTS))
})

test('HM_EVENT_META は全イベントの payload を宣言している', () => {
  const names = new Set(Object.values(HM_EVENTS))
  const declared = new Set(Object.keys(HM_EVENT_META))
  assert.equal(declared.size, 25)
  assert.deepEqual([...declared].sort(), [...names].sort())
  for (const [name, meta] of Object.entries(HM_EVENT_META)) {
    assert.ok(name.startsWith('hm:'), `${name} は hm: 名前空間の外`)
    assert.ok(meta && typeof meta === 'object', `${name} の META が無い`)
    assert.ok('detail' in meta, `${name} に detail の宣言が無い`)
    assert.equal(typeof meta.from, 'string', `${name} に送信側の記述が無い`)
    assert.equal(typeof meta.to, 'string', `${name} に購読側の記述が無い`)
  }
})

test('HM_STORAGE は 22 種で、値がすべて一意な hm. キー', () => {
  const values = Object.values(HM_STORAGE)
  assert.equal(values.length, 22)
  assert.equal(new Set(values).size, 22, '同じキーが 2 回定義されている')
  for (const key of values) assert.match(key, /^hm\.[A-Za-z0-9.]+$/)
  assert.ok(Object.isFrozen(HM_STORAGE))
})

test('HM_STORAGE は既存 21 キーと COHERENCE_DISMISSED を集約している', () => {
  const expected = [
    'hm.board',
    'hm.storedSid',
    'hm.lastStoredSid',
    'hm.lang',
    'hm.vibe',
    'hm.sound',
    'hm.theme',
    'hm.reviewSeenAt',
    'hm.chatReportSeen',
    'hm.chatReportSeenAt',
    'hm.session.seen.v1',
    'hm.repo',
    'hm.repoRecent',
    'hm.reviewRepo',
    'hm.pendingRepo',
    'hm.haptic',
    'hm.storedProfile',
    'hm.defaultProfile',
    'hm.snippetBars.v1',
    'hm.swReload',
    'hm.memosView',
    'hm.coherenceDismissed',
  ]
  assert.deepEqual([...Object.values(HM_STORAGE)].sort(), expected.sort())
})

test('既存の定数名は契約モジュールの再エクスポートになっている', () => {
  assert.equal(VIBE_EVENT, HM_EVENTS.VIBE)
  assert.equal(FX_EVENT, HM_EVENTS.FX_BURST)
  assert.equal(SNIPPET_BARS_EVENT, HM_EVENTS.SNIPPET_BARS)

  assert.equal(VIBE_KEY, HM_STORAGE.VIBE)
  assert.equal(SNIPPET_BARS_KEY, HM_STORAGE.SNIPPET_BARS)
  assert.equal(THEME_KEY, HM_STORAGE.THEME)
  assert.equal(HAPTIC_KEY, HM_STORAGE.HAPTIC)
  assert.equal(SOUND_KEY, HM_STORAGE.SOUND)
  assert.equal(SEEN_NAV_KEY, HM_STORAGE.CHAT_REPORT_SEEN_AT)
  assert.equal(SEEN_MAP_KEY, HM_STORAGE.CHAT_REPORT_SEEN)
  assert.equal(ACTIVE_CHAT_KEY, HM_STORAGE.STORED_SID)
  assert.equal(LAST_CHAT_KEY, HM_STORAGE.LAST_STORED_SID)
  assert.equal(REPO_KEY, HM_STORAGE.REPO)
  assert.equal(RECENT_REPOS_KEY, HM_STORAGE.REPO_RECENT)
  assert.equal(REPO_BOARD_KEY, HM_STORAGE.BOARD)
  assert.equal(PENDING_REPO_KEY, HM_STORAGE.PENDING_REPO)
  assert.equal(REVIEW_REPO_KEY, HM_STORAGE.REVIEW_REPO)
  assert.equal(MEMOS_VIEW_KEY, HM_STORAGE.MEMOS_VIEW)
  assert.equal(STORED_PROFILE_KEY, HM_STORAGE.STORED_PROFILE)
  assert.equal(DEFAULT_PROFILE_MARK, HM_STORAGE.DEFAULT_PROFILE)
  assert.equal(SESSION_SEEN_KEY, HM_STORAGE.SESSION_SEEN)
  assert.equal(LANG_STORAGE_KEY, HM_STORAGE.LANG)
})

test('emitHmEvent は契約済みイベントだけを window へ流す', () => {
  const events = []
  const prevWindow = globalThis.window
  globalThis.window = { dispatchEvent: (e) => events.push(e) }
  try {
    assert.equal(emitHmEvent(HM_EVENTS.VIBE, { vibe: 'dopamine' }), true)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, HM_EVENTS.VIBE)
    assert.deepEqual(events[0].detail, { vibe: 'dopamine' })

    // detail を渡さないイベントは detail を持たない（従来の `new Event` と同じ）
    assert.equal(emitHmEvent(HM_EVENTS.WAKE_SYNC), true)
    assert.equal(events.length, 2)
    assert.equal(events[1].type, HM_EVENTS.WAKE_SYNC)
    assert.equal(events[1].detail, undefined)

    // 未登録の名前は静かに素通りさせない
    assert.throws(() => emitHmEvent('hm:not-a-contract'), /Unknown hm event/)
  } finally {
    globalThis.window = prevWindow
  }
  // DOM の無い環境では false を返し、例外にしない
  assert.equal(emitHmEvent(HM_EVENTS.LANG, { lang: 'en' }), false)
})

test('onHmEvent は購読と解除を対で提供する', () => {
  const handlers = new Map()
  const prevWindow = globalThis.window
  globalThis.window = {
    addEventListener: (name, fn) => handlers.set(name, fn),
    removeEventListener: (name, fn) => {
      if (handlers.get(name) === fn) handlers.delete(name)
    },
  }
  try {
    const off = onHmEvent(HM_EVENTS.MEMOS_CHANGED, () => {})
    assert.equal(handlers.has(HM_EVENTS.MEMOS_CHANGED), true)
    off()
    assert.equal(handlers.has(HM_EVENTS.MEMOS_CHANGED), false)
    assert.throws(() => onHmEvent('hm:nope', () => {}), /Unknown hm event/)
  } finally {
    globalThis.window = prevWindow
  }
})

test("src（contracts/ 除く）に生 'hm:*' / 'hm.*' リテラルが 0 件", () => {
  const rawEvent = []
  const rawStorage = []
  for (const file of sourceFiles()) {
    const text = stripComments(fs.readFileSync(file, 'utf8'))
    const rel = path.relative(SRC, file)
    for (const m of text.matchAll(/'hm:[a-z][a-z-]*'/g)) rawEvent.push(`${rel}: ${m[0]}`)
    for (const m of text.matchAll(/'hm\.[A-Za-z0-9.]+'/g)) rawStorage.push(`${rel}: ${m[0]}`)
  }
  assert.deepEqual(rawEvent, [], '生のイベント名が残っている（HM_EVENTS を使う）')
  assert.deepEqual(rawStorage, [], '生のストレージキーが残っている（HM_STORAGE を使う）')
})

test('App.jsx は setTimeout のタブ間リレーを使わず prop で渡す', () => {
  const app = code('App.jsx')

  // インボックス: `setTimeout` の中にイベントを投げる経路が残っていない
  for (const m of app.matchAll(/setTimeout\(([\s\S]{0,240}?)\)/g)) {
    assert.doesNotMatch(m[1], /OPEN_INBOX|OPEN_SESSION/, `setTimeout 内のイベントリレーが残存: ${m[1]}`)
  }
  assert.match(app, /pendingInboxOpen=\{pendingInboxOpen\}/)
  assert.match(app, /onConsumedPendingInboxOpen=\{\(\) => setPendingInboxOpen\(null\)\}/)
  assert.match(app, /setPendingInboxOpen\(\{ task: task \?\? null, nonce: Date\.now\(\) \}\)/)

  // 検索 → チャットは `setPendingChatOpen` 渡し
  assert.match(app, /setPendingChatOpen\(\{\s*id: hit\.sessionId/)
})

test('TasksPane は pendingInboxOpen を消費してシートを開く', () => {
  const pane = code('features/TasksPane.jsx')
  assert.match(pane, /pendingInboxOpen = null/)
  assert.match(pane, /onConsumedPendingInboxOpen/)
  assert.match(pane, /openInbox\(pendingInboxOpen\.task \?\? null\)/)
})
