/**
 * D103（SWALLOW-OWNER / silent-failure-guard 強化）の回帰テスト。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeList } from '../src/lib/safe.js'
import {
  SAFE_OWNER_FILE,
  analyzeRepo,
  silentServerProblems,
  swallowOwnerProblems,
} from '../../../scripts/check-coherence.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(here, '..', '..', '..')
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/

test('safeList は成功時にそのまま値を返し、失敗時に 1 行英語 warn と既定値を返す', () => {
  assert.deepEqual(safeList('test.ok', () => ['a', 'b']), ['a', 'b'])

  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    const out = safeList('review.list', () => {
      throw new Error(`SQLITE_BUSY:\n  ${'x'.repeat(250)}`)
    })
    assert.deepEqual(out, [])
    assert.equal(warns.length, 1)
    assert.match(warns[0], /^\[review\.list\] /)
    assert.equal(warns[0].includes('\n'), false)
    assert.equal(CJK_RE.test(warns[0]), false)
    assert.ok(warns[0].length <= '[review.list] '.length + 200)

    const custom = safeList('custom.null', () => {
      throw new Error('boom')
    }, null)
    assert.equal(custom, null)
  } finally {
    console.warn = origWarn
  }
})

test('swallowOwnerProblems は safe.js 以外の catch { return [] } を検出する', () => {
  const raw = [
    'export function readItems() {',
    '  try {',
    '    return load()',
    '  } catch {',
    '    return []',
    '  }',
    '}',
  ].join('\n')
  const withErr = raw.replace('catch {', 'catch (err) {')

  assert.equal(swallowOwnerProblems('apps/bridge/src/kanban.js', raw).length, 1)
  assert.equal(swallowOwnerProblems('apps/bridge/src/inbox.js', withErr).length, 1)
  assert.deepEqual(swallowOwnerProblems(SAFE_OWNER_FILE, raw), [])
  assert.deepEqual(swallowOwnerProblems('apps/bridge/src/kanban.js', `// ${raw.replace(/\n/g, ' ')}`), [])
})

test('silentServerProblems は auth.audit({ ok: out.ok }) だけの素通りを許さず、実リポジトリも通る', async () => {
  const bad = [
    "if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {",
    '  const out = await kanban.abort(b, d, reason)',
    '  auth.audit({ ok: out.ok })',
    '  return sendJson(res, 200, out)',
    '}',
  ].join('\n')
  assert.equal(silentServerProblems(bad).length, 1)

  const viaSendOutcome = [
    "if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {",
    '  const out = await kanban.abort(b, d, reason)',
    '  auth.audit({ ok: out.ok })',
    '  return sendOutcome(res, out)',
    '}',
  ].join('\n')
  assert.deepEqual(silentServerProblems(viaSendOutcome), [])

  const viaBranch = [
    "if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {",
    '  const out = await kanban.abort(b, d, reason)',
    '  auth.audit({ ok: out.ok })',
    '  if (!out.ok) return sendFailure(res, 502, out)',
    '  return sendJson(res, 200, out)',
    '}',
  ].join('\n')
  assert.deepEqual(silentServerProblems(viaBranch), [])

  const report = await analyzeRepo(REPO_ROOT, { strict: true })
  assert.deepEqual(
    report.hardFails.filter((f) => ['silent-failure-guard', 'swallow-owner', 'transition-owner'].includes(f.rule)),
    [],
  )
})
