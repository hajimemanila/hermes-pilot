import test from 'node:test'
import assert from 'node:assert/strict'
import { toolDetail, mergeProgress } from '../src/lib/toolProgress.js'

test('toolDetail は引数から短い説明を作る', () => {
  assert.equal(toolDetail('terminal', { command: 'npm test' }), 'npm test')
  assert.equal(toolDetail('write_file', { path: 'apps/web/src/App.jsx', content: 'x'.repeat(999) }), 'apps/web/src/App.jsx')
  assert.equal(toolDetail('web_search', { query: 'nanoKVM h264 latency' }), 'nanoKVM h264 latency')
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
