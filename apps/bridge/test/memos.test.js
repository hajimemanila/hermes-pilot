import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createMemosStore } from '../src/memos.js'

test('memos: create / list (pinned first) / update / remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-memos-'))
  try {
    const store = createMemosStore(dir)
    assert.deepEqual(store.list(), [])

    assert.throws(() => store.create({ title: '  ', body: '' }), { code: 'MEMO_EMPTY' })

    const m1 = store.create({
      title: 'First idea',
      body: 'Details here',
      tags: ['#idea', 'ux', 'IDEA'],
      color: 'teal',
      checklist: [{ text: 'Step 1', done: false }],
      source: { chatId: 'c1', board: 'mobile', repo: 'hermes-pilot' },
    })
    assert.equal(m1.tags.length, 2)
    assert.equal(m1.checklist.length, 1)
    assert.equal(m1.source.board, 'mobile')

    const m2 = store.create({ title: 'Pinned report', body: 'Daily summary', pinned: true, kind: 'report' })
    const listed = store.list()
    assert.equal(listed[0].id, m2.id, 'pinned memo appears first')

    const updated = store.update(m1.id, { pinned: true, checklist: [{ id: 'c1', text: 'Step 1', done: true }] })
    assert.equal(updated.pinned, true)
    assert.equal(updated.checklist[0].done, true)

    assert.deepEqual(store.remove(m2.id), { ok: true, id: m2.id })
    assert.equal(store.list().length, 1)
    assert.throws(() => store.remove('m_missing'), { code: 'MEMO_NOT_FOUND' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
