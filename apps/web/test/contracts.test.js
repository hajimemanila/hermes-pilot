/**
 * Frontend 契約モジュールのテスト（SPEC-COHERENCE Batch COH-1 / D81）。
 *
 * 固定すること:
 *  1. `HM_EVENTS`（26 種）と `HM_STORAGE`（23 種）が一意で、全件 prefix が揃っている
 *  2. `HM_EVENT_META` が送信側のある全イベントの payload を持つ（契約の抜けを作らない）
 *  3. 既存の定数名（`VIBE_EVENT` / `SNIPPET_BARS_EVENT` / `THEME_KEY` など）が
 *     **同じ値の再エクスポート**として生きている（後方互換）
 *  4. `apps/web/src`（`contracts/` 除く）に生 `'hm:*'` / `'hm.*'` が 0 件
 *  5. `App.jsx` の `setTimeout` タブ間リレーが廃止され、`pendingInboxOpen` /
 *     `setPendingChatOpen` の prop 経路で渡されている
 *  6. `detail` がオブジェクトのイベントは全件 `required` を持ち、その全キーが
 *     **送信リテラル**に存在する（SPEC D108）。1 件でも欠ければ RED
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/stripComments.js'

import { HM_EVENTS, HM_EVENT_META, emitHmEvent, onHmEvent, requiredKeys } from '../src/contracts/events.js'
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

/** イベント値 → `HM_EVENTS` のキー名（送信リテラルは `HM_EVENTS.<KEY>` で書かれる）。 */
function eventKey(name) {
  for (const [key, value] of Object.entries(HM_EVENTS)) if (value === name) return key
  return null
}

/** `start` の `{` から釣り合う `}` までを返す（入れ子の `{}` を数える）。 */
function balancedObject(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * `new CustomEvent(HM_EVENTS.<KEY>, { detail: { … } })` と
 * `emitHmEvent(HM_EVENTS.<KEY>, { … })` の detail リテラル本文を集める。
 *
 * 送信側は `emitHmEvent` と生の `CustomEvent` が混在しているため、契約の `required` は
 * この**実リテラル**と突き合わせる（SPEC D98 / D108）。イベント名を条件式で組み立てた
 * 送信は見つからないので、送信側は契約ごとにリテラルで書く決まりにしている。
 */
function detailLiterals(text, key) {
  const out = []
  // `new CustomEvent(…)` と `new globalThis.CustomEvent(…)` の両方を拾う
  for (const [prefix, extract] of [
    ['CustomEvent(HM_EVENTS.', detailOfCustomEvent],
    ['emitHmEvent(HM_EVENTS.', detailOfEmit],
  ]) {
    const needle = `${prefix}${key}`
    let at = text.indexOf(needle)
    while (at !== -1) {
      const body = extract(text, at + needle.length)
      if (body) out.push(body)
      at = text.indexOf(needle, at + needle.length)
    }
  }
  return out
}

/** 括弧を 1 段潜って読み、呼び出しの引数リストが閉じる位置を返す。 */
function callEnd(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (ch === ')') {
      if (depth === 0) return i
      depth -= 1
    }
  }
  return text.length
}

/** 引数リストの外側にある最初のカンマ（＝第 1 引数の終わり）。無ければ -1。 */
function topLevelComma(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (ch === ')') {
      if (depth === 0) return -1
      depth -= 1
    } else if (ch === ',' && depth === 0) return i
  }
  return -1
}

/** `new CustomEvent(HM_EVENTS.X, { detail: { … } })` の detail 本文。 */
function detailOfCustomEvent(text, from) {
  const comma = topLevelComma(text, from)
  if (comma === -1) return null
  const end = callEnd(text, from)
  const detailAt = text.indexOf('detail', comma)
  if (detailAt === -1 || detailAt > end) return null
  const braceAt = text.indexOf('{', detailAt)
  if (braceAt === -1 || braceAt > end) return null
  return balancedObject(text, braceAt)
}

/** `emitHmEvent(HM_EVENTS.X, { … })` の第 2 引数がオブジェクトリテラルのときの本文。 */
function detailOfEmit(text, from) {
  const comma = topLevelComma(text, from)
  if (comma === -1) return null
  const end = callEnd(text, from)
  let i = comma + 1
  while (i < end && /\s/.test(text[i])) i += 1
  return text[i] === '{' ? balancedObject(text, i) : null
}

/** detail リテラルにキーが現れるか（`{ a }` の省略記法と `a: …` の両方を許す）。 */
function hasDetailKey(body, key) {
  return new RegExp(`[{,\\s]${key}\\s*[:,}]`).test(body)
}

/** detail リテラル群に対して、要求キーのうち欠けているものを返す（純関数）。 */
function missingDetailKeys(bodies, keys) {
  const missing = []
  for (const body of bodies) for (const key of keys) if (!hasDetailKey(body, key)) missing.push(key)
  return missing
}

/** `detail` がオブジェクト宣言（`{` で始まる）のイベント名。 */
function objectDetailEvents(meta) {
  return Object.entries(meta)
    .filter(([, entry]) => String(entry?.detail ?? '').trim().startsWith('{'))
    .map(([name]) => name)
}

/** `required` が非空配列になっていないイベント名（＝宣言漏れ）。 */
function eventsMissingRequired(meta) {
  return objectDetailEvents(meta).filter((name) => {
    const list = meta[name]?.required
    return !Array.isArray(list) || list.length === 0
  })
}

test('HM_EVENTS は 27 種で、値がすべて一意な hm: 名', () => {
  const values = Object.values(HM_EVENTS)
  assert.equal(values.length, 27)
  assert.equal(new Set(values).size, 27, '同じイベント名が 2 回定義されている')
  for (const name of values) assert.match(name, /^hm:[a-z][a-z-]*$/)
  assert.ok(Object.isFrozen(HM_EVENTS))
})

test('HM_EVENT_META は送信側のあるイベントを全件宣言している', () => {
  const names = new Set(Object.values(HM_EVENTS))
  const declared = new Set(Object.keys(HM_EVENT_META))
  // 送信側がリポジトリに無い互換イベントだけがメタを持たない（増えたら RED）。
  // `HM_EVENTS.OPEN_INBOX` は App → TasksPane の prop 経路へ移行済みで、
  // 生 `addEventListener` による後方互換の受信だけが残っている。
  assert.deepEqual([...names].filter((name) => !declared.has(name)), [HM_EVENTS.OPEN_INBOX])
  assert.equal(declared.size, 26)
  for (const [name, meta] of Object.entries(HM_EVENT_META)) {
    assert.ok(name.startsWith('hm:'), `${name} は hm: 名前空間の外`)
    assert.ok(meta && typeof meta === 'object', `${name} の META が無い`)
    assert.ok('detail' in meta, `${name} に detail の宣言が無い`)
    assert.equal(typeof meta.from, 'string', `${name} に送信側の記述が無い`)
    assert.equal(typeof meta.to, 'string', `${name} に購読側の記述が無い`)
  }
})

test('detail がオブジェクトの全イベントは required を宣言している（D108）', () => {
  const objectEvents = objectDetailEvents(HM_EVENT_META)
  // `detail` がオブジェクトのイベントは 19 件（20 件目に数えていた `hm:open-inbox` は
  // 送信側が prop 経路へ移行済みなのでメタから落とした・SPEC §3.3）。
  assert.equal(objectEvents.length, 19)
  assert.deepEqual(eventsMissingRequired(HM_EVENT_META), [])
  for (const name of objectEvents) {
    assert.ok(requiredKeys(name).length > 0, `${name} に required が無い`)
  }
})

test('required を 1 件消す／空にすると RED になる（対照実験）', () => {
  const dropRequired = (name) => ({
    ...HM_EVENT_META,
    [name]: { ...HM_EVENT_META[name], required: undefined },
  })
  const emptyRequired = (name) => ({
    ...HM_EVENT_META,
    [name]: { ...HM_EVENT_META[name], required: [] },
  })
  // 本物の契約は欠落 0 件
  assert.deepEqual(eventsMissingRequired(HM_EVENT_META), [])
  // 1 件でも消すと、そのイベント名が違反として出る
  assert.deepEqual(eventsMissingRequired(dropRequired(HM_EVENTS.CHAT_UNREAD)), [HM_EVENTS.CHAT_UNREAD])
  assert.deepEqual(eventsMissingRequired(emptyRequired(HM_EVENTS.REVIEW_ITEMS)), [HM_EVENTS.REVIEW_ITEMS])
})

test('LIVE_TURNS の契約は送信側の全量（turns / items / architect）を要求する', () => {
  const meta = HM_EVENT_META[HM_EVENTS.LIVE_TURNS]
  assert.deepEqual(requiredKeys(HM_EVENTS.LIVE_TURNS), ['turns', 'items', 'architect'])
  assert.equal(meta.from, 'TasksPane')
  assert.equal(meta.to, 'App')
  for (const key of ['turns', 'items', 'architect']) {
    assert.ok(meta.detail.includes(key), `detail 宣言に ${key} が無い`)
  }
  // `required` は「宣言した detail の部分集合」であること（勝手なキーを足さない）
  for (const [name, entry] of Object.entries(HM_EVENT_META)) {
    for (const key of requiredKeys(name)) {
      assert.equal(typeof entry.detail, 'string', `${name}: detail が null なのに required がある`)
      assert.ok(entry.detail.includes(key), `${name}: required の ${key} が detail 宣言に無い`)
    }
  }
})

test('required の全キーが送信リテラルに存在する（静的走査）', (t) => {
  const files = sourceFiles()
  const offenders = []
  let literals = 0
  for (const name of Object.keys(HM_EVENT_META)) {
    const keys = requiredKeys(name)
    if (!keys.length) continue
    const key = eventKey(name)
    const found = []
    for (const file of files) {
      const rel = path.relative(SRC, file)
      const text = stripComments(fs.readFileSync(file, 'utf8'))
      for (const body of detailLiterals(text, key)) found.push({ rel, body })
    }
    if (!found.length) {
      offenders.push(`${name}: HM_EVENTS.${key} の送信リテラルが 1 つも無い`)
      continue
    }
    literals += found.length
    for (const { rel, body } of found) {
      for (const missing of missingDetailKeys([body], keys)) {
        offenders.push(`${rel}: ${name} の detail に ${missing} が無い`)
      }
    }
  }
  // 「対象 0 件で緑」を緑と読まない（SPEC §5）: 走査件数を出し、下限も固定する
  t.diagnostic(`scanned ${files.length} files / ${Object.keys(HM_EVENT_META).length} events / ${literals} sender literals`)
  assert.ok(literals >= 20, `送信リテラルの検出が少なすぎる（${literals} 件）`)
  assert.deepEqual(offenders, [])
})

test('architect を送信リテラルから落とすと検査が RED になる（フィクスチャ）', () => {
  const keys = requiredKeys(HM_EVENTS.LIVE_TURNS)
  const full =
    'new CustomEvent(HM_EVENTS.LIVE_TURNS, { detail: { turns, items, architect: Number(d?.counts?.architect ?? 0) } })'
  const dropped = 'new CustomEvent(HM_EVENTS.LIVE_TURNS, { detail: { turns, items } })'
  const emitted = 'emitHmEvent(HM_EVENTS.LIVE_TURNS, { turns, items, architect: 2 })'
  const emittedDropped = 'emitHmEvent(HM_EVENTS.LIVE_TURNS, { turns, items })'
  const bodies = (text) => detailLiterals(text, 'LIVE_TURNS')

  // 走査そのものは `new CustomEvent` と `emitHmEvent` の両方のリテラルを見つける
  assert.equal(bodies(full).length, 1)
  assert.equal(bodies(dropped).length, 1)
  assert.equal(bodies(emitted).length, 1)
  assert.equal(bodies(emittedDropped).length, 1)
  assert.deepEqual(missingDetailKeys(bodies(full), keys), [])
  assert.deepEqual(missingDetailKeys(bodies(dropped), keys), ['architect'])
  assert.deepEqual(missingDetailKeys(bodies(emitted), keys), [])
  assert.deepEqual(missingDetailKeys(bodies(emittedDropped), keys), ['architect'])
})

test('detail: null のイベントは required を持たず、素通りが維持される', () => {
  const nullEvents = Object.entries(HM_EVENT_META)
    .filter(([, entry]) => entry.detail === null)
    .map(([name]) => name)
  assert.equal(nullEvents.length, 7)
  for (const name of nullEvents) {
    assert.equal(HM_EVENT_META[name].required, undefined, `${name} に required がある`)
    assert.deepEqual(requiredKeys(name), [])
  }

  // メタを持たない互換イベントは `emitHmEvent` / `onHmEvent` の対象外（生 dispatch だけ受ける）
  assert.throws(() => requiredKeys(HM_EVENTS.OPEN_INBOX), /Unknown hm event/)
  assert.throws(() => onHmEvent(HM_EVENTS.OPEN_INBOX, () => {}), /Unknown hm event/)

  // detail を運ばない送信は `Event` のまま（従来の素通り）
  const events = []
  const prevWindow = globalThis.window
  globalThis.window = { dispatchEvent: (e) => events.push(e) }
  try {
    assert.equal(emitHmEvent(HM_EVENTS.WAKE_SYNC), true)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, HM_EVENTS.WAKE_SYNC)
    assert.equal(events[0].detail, undefined)
  } finally {
    globalThis.window = prevWindow
  }
})

test('HM_STORAGE は 24 種で、値がすべて一意な hm. キー', () => {
  const values = Object.values(HM_STORAGE)
  assert.equal(values.length, 24)
  assert.equal(new Set(values).size, 24, '同じキーが 2 回定義されている')
  for (const key of values) assert.match(key, /^hm\.[A-Za-z0-9.]+$/)
  assert.ok(Object.isFrozen(HM_STORAGE))
})

test('HM_STORAGE は既存 21 キーと Coherence / Autopilot 系キーを集約している', () => {
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
    'hm.coherenceAck',
    'hm.autopilotRun.v1',
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
