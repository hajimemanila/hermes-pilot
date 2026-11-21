/**
 * メモ編集シートの未保存確認（SPEC-ver-0-2-1 §2.2 / Batch ver-0-2-1-3 / Q3=A）。
 *
 * 受入条件:
 *  - 未変更で閉じると確認なしで閉じる
 *  - 変更ありで 3 択（保存する／破棄する／戻る）が出る
 *  - 「戻る」で入力が残る／「破棄する」で入力が消える
 *  - 新規メモは本文 1 文字以上（またはチェックリスト 1 件以上）で dirty
 *
 * 判定の正本は `src/lib/memoDraft.js` の純関数。UI の配線（onClose が
 * `requestClose` を通ること・3 択のキーが揃うこと）は静的に検査する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DRAFT_FIELDS, draftSnapshot, hasDraftContent, isDraftDirty } from '../src/lib/memoDraft.js'
import { readStyles } from './helpers/styles.js'

const here = import.meta.dirname
const readSrc = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8')

/** 既存メモを開いたときの下書き（`openEditor(memo)` が作る形）。 */
const existingDraft = () => ({
  id: 'memo_1',
  title: '買い物',
  body: '牛乳とパン',
  tagsText: 'idea, 生活',
  pinned: false,
  color: 'default',
  kind: 'note',
  checklist: [
    { id: 'c1', text: '牛乳', done: false },
    { id: 'c2', text: 'パン', done: true },
  ],
})

/** 新規メモを開いたときの下書き（`openEditor(null)` が作る形）。 */
const newDraft = () => ({
  id: null,
  title: '',
  body: '',
  tagsText: 'idea',
  pinned: false,
  color: 'default',
  kind: 'note',
  checklist: [],
})

test('既存メモ: 何も触らずに閉じる → 確認しない（dirty でない）', () => {
  const draft = existingDraft()
  assert.equal(isDraftDirty(draft, draftSnapshot(draft)), false)
  // 別オブジェクトでも同じ内容なら dirty でない（参照比較ではない）
  assert.equal(isDraftDirty({ ...existingDraft() }, draftSnapshot(existingDraft())), false)
})

test('既存メモ: 本文を 1 文字変える → 3 択を出す（dirty）', () => {
  const base = draftSnapshot(existingDraft())
  const draft = { ...existingDraft(), body: '牛乳とパンと卵' }
  assert.equal(isDraftDirty(draft, base), true)
})

test('既存メモ: 変更しても元に戻せば dirty でない（戻るで入力が残る前提）', () => {
  const base = draftSnapshot(existingDraft())
  const changed = { ...existingDraft(), body: '牛乳とパンと卵' }
  assert.equal(isDraftDirty(changed, base), true)
  assert.equal(isDraftDirty({ ...changed, body: '牛乳とパン' }, base), false)
})

test('既存メモ: チェックリストの完了切替・色・タグも dirty として拾う', () => {
  const base = draftSnapshot(existingDraft())
  const toggled = existingDraft()
  toggled.checklist[0] = { ...toggled.checklist[0], done: true }
  assert.equal(isDraftDirty(toggled, base), true)
  assert.equal(isDraftDirty({ ...existingDraft(), color: 'teal' }, base), true)
  assert.equal(isDraftDirty({ ...existingDraft(), tagsText: 'idea' }, base), true)
  assert.equal(isDraftDirty({ ...existingDraft(), pinned: true }, base), true)
})

test('新規メモ: 空のまま閉じる → 確認しない（tagsText の既定 idea は数えない）', () => {
  const draft = newDraft()
  assert.equal(isDraftDirty(draft, null), false)
  assert.equal(isDraftDirty({ ...draft, color: 'amber' }, null), false)
  assert.equal(hasDraftContent(draft), false)
})

test('新規メモ: 本文 1 文字以上 → dirty（タイトルだけ・チェックリスト 1 件も同じ）', () => {
  assert.equal(isDraftDirty({ ...newDraft(), body: 'あ' }, null), true)
  assert.equal(isDraftDirty({ ...newDraft(), body: '   ' }, null), false, '空白だけは中身とみなさない')
  assert.equal(isDraftDirty({ ...newDraft(), title: '案' }, null), true)
  assert.equal(
    isDraftDirty({ ...newDraft(), checklist: [{ id: 'c1', text: 'あとで', done: false }] }, null),
    true,
  )
})

test('draftSnapshot: 6 フィールドだけを見て、チェックリストは複製する', () => {
  const draft = existingDraft()
  const snap = draftSnapshot(draft)
  assert.deepEqual(Object.keys(JSON.parse(snap)), DRAFT_FIELDS)
  // id / kind は比較対象外（編集 UI から変わらない）
  assert.equal(isDraftDirty({ ...draft, id: 'memo_2' }, snap), false)
  assert.equal(isDraftDirty({ ...draft, kind: 'report' }, snap), false)
  // 元の配列を書き換えてもスナップショットは動かない
  draft.checklist[0].done = true
  assert.equal(isDraftDirty({ ...existingDraft() }, snap), false)
})

test('UI 配線: シートの onClose は requestClose を通り、3 択のキーが揃う', () => {
  const pane = readSrc('features/MemosPane.jsx')
  assert.match(pane, /onClose=\{requestClose\}/, 'シートは無条件に閉じない（requestClose 経由）')
  assert.match(pane, /isDraftDirty\(/, '閉じる判断に純関数を使う')
  assert.match(pane, /setConfirming\(true\)/, '変更があるとき確認状態へ入る')
  for (const key of ['notes.unsavedTitle', 'notes.saveAndClose', 'notes.discard', 'notes.keepEditing']) {
    assert.ok(pane.includes(`'${key}'`), `${key} を 3 択に出す`)
  }
  // 「破棄する」は下書きを捨てて閉じる（入力が消える）
  assert.match(pane, /const discardAndClose = [\s\S]{0,400}?setEditing\(null\)/, '破棄は下書きを捨てる')
  // 「戻る」は confirm を畳むだけで editing を保つ（入力が残る）
  assert.match(pane, /const keepEditing = \(\) =>[\s\S]{0,200}?setConfirming\(false\)/, '戻るは入力を保つ')
  const css = readStyles()
  assert.match(css, /\.memo-unsaved\b/, '確認ブロックのスタイルがある')
})
