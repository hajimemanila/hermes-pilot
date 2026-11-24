/**
 * 同梱 3 スキルと Architect プロンプトの汎用性ガード（D85 拡張）。
 *
 * Hermes Pilot 自身のリポジトリ固有コマンド・画面サイズ・社内パス
 * (`npm run verify`, `npm run deploy`, `390x844`, `820x1180`, `browser_exec`,
 *  `npm run check:oauth`, `apps/web/dist`) が再流入しないことを機械検査する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHardcodedVerification } from '../src/contracts/verify.js'
import { buildSeedPrompt } from '../src/architect/seed.js'
import { buildArchitectTaskBody } from '../src/architect/task.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SKILLS = ['quick-review', 'annotation', 'spec-architect']

test('同梱 3 スキルと Architect プロンプトに特定リポ前提の文言が混入していない', () => {
  const docs = SKILLS.map((name) => ({
    name: `skills/${name}/SKILL.md`,
    text: fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8'),
    isSkill: true,
  }))
  docs.push(
    {
      name: 'buildSeedPrompt',
      text: buildSeedPrompt({ jobId: 'arch-1', seedText: 'Demo feature', board: 'demo', repoPath: '/tmp/demo' }),
      isSkill: false,
    },
    {
      name: 'buildArchitectTaskBody',
      text: buildArchitectTaskBody({ prompt: 'Demo feature', board: 'demo', repoPath: '/tmp/demo', jobId: 'arch-1' }),
      isSkill: false,
    },
  )

  for (const { name, text, isSkill } of docs) {
    const check = findHardcodedVerification(text)
    assert.equal(check.ok, true, `${name} に決め打ち検証がある: ${check.hits.join(', ')}`)
    assert.doesNotMatch(text, /browser_exec/, `${name} に browser_exec が残っている`)
    assert.doesNotMatch(text, /npm run check:oauth/, `${name} に npm run check:oauth が残っている`)
    if (isSkill) {
      assert.doesNotMatch(text, /apps\/web\/dist/, `${name} に apps/web/dist が残っている`)
    }
  }
})
