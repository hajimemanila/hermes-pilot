/**
 * Generic coherence sweeps — pure logic (SPEC-COHERENCE §3.6 / D82).
 *
 * Fixed here without rendering anything:
 *  - the five presets are language/repo agnostic and stable
 *  - a report (or a missing one) maps to per-preset counts and a recommendation
 *  - the generated task body keeps the machine labels (`Execution Mode` / `Objective` / `Files` /
 *    `Verify`) while the prose follows the UI language
 *  - **no self-repository vocabulary leaks into a payload**: no `npm run …`, no `SOUL.md`, no
 *    `OAuth`, no viewport size, no `mockApi`/`hm:`/`hermes-pilot` (the whole point of D82/D85)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_SWEEP,
  MAX_LISTED_FILES,
  SWEEP_PRESETS,
  buildSweepPayload,
  normalizePreset,
  normalizeReport,
  presetForRule,
  recommendSweep,
  sweepCounts,
  sweepFiles,
} from '../src/lib/coherenceSweep.js'
import { SEED_MAX } from '../src/lib/specSeed.js'

const here = import.meta.dirname
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'i18n', 'en.json'), 'utf8'))
const ja = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'i18n', 'ja.json'), 'utf8'))

/** CJK / full-width characters: must never appear in an English payload. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/

/** Anything that would mean this repository's own habits leaked into a generic sweep. */
const REPO_SPECIFIC = [
  'npm run',
  'SOUL.md',
  'OAuth',
  '390px',
  '390×844',
  '820×1180',
  'mockApi',
  'hm:',
  'hermes-pilot',
  'apps/web',
  'apps/bridge',
  'work kanban task',
]

/** A report in the shape `GET /api/coherence/report` returns (mixed Layer-1 and Layer-2 rules). */
const REPORT = {
  ok: false,
  generatedAt: '2026-11-21T00:00:00Z',
  repoRoot: '/tmp/sample-repo',
  layers: { universal: true, repoConfig: false, repoChecker: false },
  hardFails: [
    { rule: 'spec-sprawl', file: 'docs/SPEC-A.md', message: '7 active specs' },
    { rule: 'state-relay-drift', file: 'src/relay.js', message: 'setTimeout relay between tabs' },
  ],
  softSignals: [{ rule: 'debt-spike', file: 'src/app.js', message: '12 TODO markers' }],
  hotspots: [{ file: 'src/app.js', touches: 9, lines: 2400 }],
  summary: {
    hardFailCount: 2,
    softSignalCount: 1,
    hotspotCount: 1,
    activeSpecCount: 7,
    archivedSpecCount: 3,
    deprecatedRoutes: 1,
  },
  recommendedSweep: 'hotspots',
}

test('presets are the five generic sweeps and unknown ids fall back to the default', () => {
  assert.deepEqual([...SWEEP_PRESETS], ['state-flow', 'contracts', 'hotspots', 'docs-specs', 'custom'])
  assert.ok(SWEEP_PRESETS.includes(DEFAULT_SWEEP))
  for (const id of SWEEP_PRESETS) assert.equal(normalizePreset(id), id)
  assert.equal(normalizePreset(' State-Flow '), 'state-flow')
  assert.equal(normalizePreset(''), DEFAULT_SWEEP)
  assert.equal(normalizePreset('css'), DEFAULT_SWEEP)
  assert.equal(normalizePreset(null), DEFAULT_SWEEP)
})

test('every preset has a label, a description and an objective in both languages', () => {
  for (const id of SWEEP_PRESETS) {
    for (const key of [`coherence.preset.${id}`, `coherence.preset.${id}.desc`, `coherence.preset.${id}.objective`]) {
      assert.ok(en[key], `en.json に ${key} が無い`)
      assert.ok(ja[key], `ja.json に ${key} が無い`)
    }
  }
  const missing = Object.keys(en).filter((key) => key.startsWith('coherence.') && !(key in ja))
  assert.deepEqual(missing, [], `ja に無い coherence キー: ${missing.join(', ')}`)
})

test('a missing or broken report degrades to zeros instead of throwing', () => {
  const none = normalizeReport(null)
  assert.equal(none.available, false)
  assert.deepEqual(none.hardFails, [])
  assert.deepEqual(none.softSignals, [])
  assert.deepEqual(none.hotspots, [])
  assert.deepEqual(none.counts, {
    hardFailCount: 0,
    softSignalCount: 0,
    hotspotCount: 0,
    activeSpecCount: 0,
    archivedSpecCount: 0,
    deprecatedRoutes: 0,
  })
  assert.equal(normalizeReport(undefined).available, false)
  assert.equal(normalizeReport('nope').available, false)
  // 空オブジェクトは「取得できたが信号ゼロ」= available
  assert.equal(normalizeReport({}).available, true)
  assert.equal(normalizeReport({ summary: { hardFailCount: 'x' } }).counts.hardFailCount, 0)
})

test('the report is normalised: counts follow the summary, arrays follow the body', () => {
  const r = normalizeReport(REPORT)
  assert.equal(r.available, true)
  assert.equal(r.repoRoot, '/tmp/sample-repo')
  assert.equal(r.hardFails.length, 2)
  assert.equal(r.softSignals.length, 1)
  assert.deepEqual(r.hotspots[0], { file: 'src/app.js', touches: 9, lines: 2400 })
  assert.equal(r.counts.hardFailCount, 2)
  assert.equal(r.counts.hotspotCount, 1)
  assert.equal(r.recommendedSweep, 'hotspots')
  // 未知の推奨は捨てる（誤った id でプリセットが選ばれない）
  assert.equal(normalizeReport({ ...REPORT, recommendedSweep: 'css' }).recommendedSweep, '')
  // 文字列の issue / hotspot も読む（チェッカーごとに形が違う）
  const loose = normalizeReport({ hardFails: ['rule-a failed'], hotspots: ['src/x.js'] })
  assert.deepEqual(loose.hardFails[0], { rule: '', detail: 'rule-a failed', file: '' })
  assert.deepEqual(loose.hotspots[0], { file: 'src/x.js', touches: 0, lines: 0 })
})

test('rules map to the preset that would fix them', () => {
  assert.equal(presetForRule('git-hotspot'), 'hotspots')
  assert.equal(presetForRule('file-bloat'), 'hotspots')
  assert.equal(presetForRule('debt-spike'), 'hotspots')
  assert.equal(presetForRule('spec-sprawl'), 'docs-specs')
  assert.equal(presetForRule('api-parity'), 'contracts')
  assert.equal(presetForRule('event-contract'), 'contracts')
  assert.equal(presetForRule('state-relay-drift'), 'state-flow')
  assert.equal(presetForRule('docs-scripts-parity'), 'contracts')
  assert.equal(presetForRule('whatever-custom-rule'), 'custom')
  assert.equal(presetForRule(''), 'custom')
})

test('per-preset counts add up and the recommendation follows the report', () => {
  const counts = sweepCounts(REPORT)
  // 1 hotspot + debt-spike(soft) が hotspots、spec-sprawl が docs-specs、state-relay-drift が state-flow
  assert.deepEqual(counts, { 'state-flow': 1, contracts: 0, hotspots: 2, 'docs-specs': 1, custom: 0 })
  assert.equal(recommendSweep(REPORT), 'hotspots')
  // 推奨が無い/不正なら最多シグナルのプリセット、シグナルゼロなら既定
  assert.equal(recommendSweep({ ...REPORT, recommendedSweep: '' }), 'hotspots')
  assert.equal(recommendSweep({}), DEFAULT_SWEEP)
  assert.equal(recommendSweep(null), DEFAULT_SWEEP)
})

test('files are deduped and ordered hard fail -> soft signal -> hotspot', () => {
  const files = sweepFiles(REPORT, 'en')
  assert.deepEqual(files, [
    'docs/SPEC-A.md (spec-sprawl)',
    'src/relay.js (state-relay-drift)',
    'src/app.js (debt-spike)',
  ])
  assert.equal(new Set(files).size, files.length, '同じファイルを 2 回書かない')
})

test('the task body keeps the machine labels and carries the target repository facts', () => {
  const { title, body } = buildSweepPayload({ preset: 'hotspots', report: REPORT, target: 'src/app.js', board: 'mobile', lang: 'en' })
  assert.ok(title.startsWith('[COHERENCE/HOTSPOTS] '), title)
  assert.ok(title.includes('src/app.js'), 'target がタイトルに出る')
  assert.match(body, /^Execution Mode: \[Mode: Zero-Stop\]$/m)
  assert.match(body, /^Objective: .+/m)
  assert.match(body, /^Target: src\/app\.js$/m)
  assert.match(body, /^Detected: 2 hard fail\(s\), 1 soft signal\(s\), 1 hotspot\(s\)$/m)
  assert.match(body, /^Files:$/m)
  assert.match(body, /^- src\/app\.js \(debt-spike\)$/m)
  assert.match(body, /^Verify: .+/m)
  // Verify は最後の行（本文の形が機械的に読める）
  assert.equal(body.split('\n').at(-1).startsWith('Verify: '), true)
  assert.doesNotMatch(body, /^Plan: /m, 'single ではバッチ分割計画を書かない')
})

test('no report still produces a usable body in both languages', () => {
  const enPayload = buildSweepPayload({ preset: 'custom', report: null, lang: 'en' })
  assert.match(enPayload.body, /^Detected: No live signals/m)
  assert.match(enPayload.body, /^Target: whole repository$/m)
  assert.doesNotMatch(enPayload.body, /^Files:$/m, '検出ファイルが無ければ Files 行を出さない')

  const jaPayload = buildSweepPayload({ preset: 'custom', report: null, lang: 'ja' })
  assert.match(jaPayload.body, /^Target: リポジトリ全体$/m)
  assert.match(jaPayload.body, CJK)
})

test('the multi-batch route adds a plan line and a seed within the seed limit', () => {
  const payload = buildSweepPayload({ preset: 'contracts', report: REPORT, target: '', mode: 'spec', board: 'mobile', lang: 'en' })
  assert.equal(payload.mode, 'spec')
  assert.match(payload.body, /^Plan: .+/m)
  assert.ok(payload.seedText.startsWith('Draft a multi-batch SPEC'), payload.seedText.slice(0, 40))
  assert.ok(payload.seedText.includes(payload.body), 'seed は本文を含む')
  assert.ok(payload.seedText.length <= SEED_MAX)
  assert.ok(payload.body.length <= SEED_MAX)
})

test('long file lists are capped and summarised', () => {
  const hardFails = Array.from({ length: 20 }, (_, i) => ({ rule: 'file-bloat', file: `src/f${i}.js` }))
  const { body } = buildSweepPayload({ preset: 'hotspots', report: { hardFails }, lang: 'en' })
  const listed = body.split('\n').filter((line) => line.startsWith('- src/'))
  assert.equal(listed.length, MAX_LISTED_FILES)
  assert.match(body, new RegExp(`^- …and ${20 - MAX_LISTED_FILES} more$`, 'm'))
})

test('no self-repository vocabulary leaks into any payload (any preset, any language)', () => {
  const reports = [null, REPORT, { hardFails: [{ rule: 'custom-thing', file: 'pkg/main.go' }] }]
  for (const lang of ['en', 'ja']) {
    for (const preset of SWEEP_PRESETS) {
      for (const report of reports) {
        const payload = buildSweepPayload({ preset, report, target: '', lang })
        for (const banned of REPO_SPECIFIC) {
          assert.equal(
            payload.body.includes(banned),
            false,
            `${preset}/${lang} の本文に "${banned}" が混ざっている:\n${payload.body}`,
          )
          assert.equal(payload.title.includes(banned), false, `${preset}/${lang} のタイトルに "${banned}"`)
          assert.equal(payload.seedText.includes(banned), false, `${preset}/${lang} の seed に "${banned}"`)
        }
      }
    }
  }
})

test('English payloads stay CJK-free, Japanese payloads are translated', () => {
  for (const preset of SWEEP_PRESETS) {
    const enBody = buildSweepPayload({ preset, report: REPORT, lang: 'en' }).body
    assert.doesNotMatch(enBody, CJK, `en の本文に CJK が混ざっている:\n${enBody}`)
    const jaBody = buildSweepPayload({ preset, report: REPORT, lang: 'ja' }).body
    assert.match(jaBody, CJK, 'ja の本文が英語のまま')
    assert.notEqual(enBody, jaBody)
  }
  // 未知の lang は en へ落とす（辞書の無い言語で空文字列を出さない）
  assert.doesNotMatch(buildSweepPayload({ preset: 'custom', lang: 'fr' }).body, CJK)
})
