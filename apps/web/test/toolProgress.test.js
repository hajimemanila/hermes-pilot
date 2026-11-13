import test from 'node:test'
import assert from 'node:assert/strict'
import { toolDetail, toolFullDetail, mergeProgress, shortenPath, foldTranscriptMessages } from '../src/lib/toolProgress.js'

test('toolDetail は引数から短い説明を作る', () => {
  assert.equal(toolDetail('terminal', { command: 'npm test' }), 'npm test')
  assert.equal(toolDetail('write_file', { path: 'apps/web/src/App.jsx', content: 'x'.repeat(999) }), 'apps/web/src/App.jsx')
  assert.equal(toolDetail('web_search', { query: 'webrtc stream latency' }), 'webrtc stream latency')
  assert.equal(toolDetail('read_file', {}), '')
  assert.match(toolDetail('terminal', { command: 'x'.repeat(200) }), /…$/)
})

test('mergeProgress: start で積み、complete で同じ id を完了にする', () => {
  let rows = mergeProgress([], { kind: 'start', id: 'c1', name: 'terminal', args: { command: 'npm run verify' } })
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { name: rows[0].name, detail: rows[0].detail, done: rows[0].done },
    { name: 'terminal', detail: 'npm run verify', done: false },
  )
  rows = mergeProgress(rows, { kind: 'complete', id: 'c1', name: 'terminal', duration_ms: 4200 })
  assert.equal(rows[0].done, true)
  assert.equal(rows[0].ms, 4200)
})

test('mergeProgress は 8 行で頭を落とす', () => {
  let rows = []
  for (let i = 0; i < 12; i += 1) rows = mergeProgress(rows, { kind: 'start', id: 'c' + i, name: 'terminal', args: { command: 'cmd' + i } })
  assert.equal(rows.length, 8)
  assert.equal(rows[rows.length - 1].detail, 'cmd11')
})

test('complete だけ来ても壊れない（対応する start が無い）', () => {
  const rows = mergeProgress([], { kind: 'complete', id: 'ghost', name: 'terminal' })
  assert.deepEqual(rows, [])
})

test('shortenPath は長いパスの末尾 2 セグメントを残す', () => {
  const longPath = '/Users/alice/projects/hermes-pilot/apps/web/src/features/ChatPane.jsx'
  assert.equal(shortenPath(longPath, 30), '…/features/ChatPane.jsx')
  assert.equal(toolDetail('read_file', { path: longPath }), '…/features/ChatPane.jsx')
  assert.equal(toolFullDetail('read_file', { path: longPath }), longPath)
})

test('mergeProgress は full 詳細も保持する', () => {
  const cmd = 'npm run verify && node --test apps/web/test/toolProgress.test.js'
  const rows = mergeProgress([], { kind: 'start', id: 'c1', name: 'terminal', args: { command: cmd } })
  assert.equal(rows[0].full, cmd)
  assert.match(rows[0].detail, /…$/)
})

test('foldTranscriptMessages は tool 行を assistant ブロックへ畳む', () => {
  const { blocks, trailingTools } = foldTranscriptMessages([
    { id: 1, role: 'user', text: '調べて', at: 1000 },
    { id: 2, role: 'tool', toolName: 'read_file', text: 'ok', at: 1100 },
    { id: 3, role: 'tool', toolName: 'terminal', text: 'pass', at: 1200 },
    { id: 4, role: 'assistant', text: '完了です', at: 1300 },
  ])
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].role, 'assistant')
  assert.equal(blocks[1].tools.length, 2)
  assert.equal(blocks[1].tools[0].name, 'read_file')
  assert.equal(trailingTools.length, 0)
})
