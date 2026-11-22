import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const BASELINE_PATH = path.resolve(import.meta.dirname, '../../../scripts/audit-responsive.baseline.json')

test('audit-responsive ベースラインに新規緩和（button.attach-x 等）が紛れ込んでいない', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  assert.ok(Array.isArray(baseline.tap), 'tap 配列が存在する')
  assert.ok(Array.isArray(baseline.clip), 'clip 配列が存在する')
  assert.equal(baseline.tap.includes('button.attach-x'), false, 'button.attach-x は 44px .job-bar-x 化済みのためベースラインに載せない')
  assert.ok(baseline.tap.length <= 18, `tap ベースライン上限超過 (${baseline.tap.length} > 18): 新規違反をベースラインに逃げず CSS で直すこと`)
  assert.equal(baseline.clip.length, 0, 'clip ベースラインは 0 を維持する')
})
