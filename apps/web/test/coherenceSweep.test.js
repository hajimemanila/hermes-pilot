/**
 * Generic coherence sweeps — pure logic (SPEC-COHERENCE §3.6 / D82, SPEC-RELIABILITY-GUARD D93).
 *
 * Fixed here without rendering anything:
 *  - the six presets are language/repo agnostic and stable
 *  - a report (or a missing one) maps to per-preset counts and a recommendation
 *  - the generated task body keeps the machine labels (`Execution Mode` / `Objective` / `Files` /
 *    `Verify`) while the prose follows the UI language
 *  - `bug-hunt` defaults to a read-only report contract and only switches to reproduce-first when
 *    `autoFix` is on; both carry the same five blind spots
 *  - **no self-repository vocabulary leaks into a payload**: no `npm run …`, no `SOUL.md`, no
 *    `OAuth`, no viewport size, no `mockApi`/`hm:`/`hermes-pilot` (the whole point of D82/D85)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  BUG_HUNT_CHECKS,
  DEFAULT_SWEEP,
  MAX_LISTED_FILES,
  SWEEP_PRESETS,
  ackForRepo,
  acknowledgeSignal,
  adviceKeyForRule,
  buildSweepPayload,
  isSignalAcknowledged,
  normalizePreset,
  normalizeReport,
  partitionSoftSignals,
  parseCoherenceAck,
  presetForRule,
  recommendSweep,
  restoreSignal,
  signalKeyOf,
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

test('presets are the six generic sweeps and unknown ids fall back to the default', () => {
  assert.deepEqual(
    [...SWEEP_PRESETS],
    ['state-flow', 'contracts', 'hotspots', 'docs-specs', 'bug-hunt', 'custom'],
  )
  assert.ok(SWEEP_PRESETS.includes(DEFAULT_SWEEP))
  assert.equal(SWEEP_PRESETS.at(-1), 'custom', '任意ターゲットは常に最後の 1 枚')
  for (const id of SWEEP_PRESETS) assert.equal(normalizePreset(id), id)
  assert.equal(normalizePreset(' State-Flow '), 'state-flow')
  assert.equal(normalizePreset(' BUG-HUNT '), 'bug-hunt')
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
  const extra = Object.keys(ja).filter((key) => key.startsWith('coherence.') && !(key in en))
  assert.deepEqual(extra, [], `en に無い coherence キー: ${extra.join(', ')}`)
})

test('bug-hunt carries the blind spots, both contracts and the checkbox label in both languages', () => {
  const keys = [
    'coherence.preset.bug-hunt.contract',
    'coherence.preset.bug-hunt.reportOnly',
    'coherence.preset.bug-hunt.reproduceFirst',
    'coherence.preset.bug-hunt.blindSpots',
    'coherence.preset.bug-hunt.orderPolicy',
    'coherence.preset.bug-hunt.autoFix',
    ...BUG_HUNT_CHECKS.map((check) => `coherence.preset.bug-hunt.${check}`),
  ]
  for (const key of keys) {
    assert.ok(en[key], `en.json に ${key} が無い`)
    assert.ok(ja[key], `ja.json に ${key} が無い`)
    assert.notEqual(en[key], ja[key], `${key} が両言語で同じ`)
  }
  assert.equal(ja['coherence.preset.bug-hunt'], 'バグ・不具合ハント')
  assert.equal(BUG_HUNT_CHECKS.length, 5, '5 大盲点')
  assert.equal(en['coherence.preset.bug-hunt.autoFix'].includes('default off'), true, '既定 OFF を明記する')
  assert.equal(ja['coherence.preset.bug-hunt.autoFix'].includes('既定 OFF'), true, '既定 OFF を明記する')
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
  assert.equal(presetForRule('event-contract'), 'contracts')
  assert.equal(presetForRule('state-relay-drift'), 'state-flow')
  assert.equal(presetForRule('whatever-custom-rule'), 'custom')
  assert.equal(presetForRule(''), 'custom')
  // D93: 単体テストが見逃す実害バグの語彙は bug-hunt へ（parity は contracts より先に取る）
  assert.equal(presetForRule('api-parity'), 'bug-hunt')
  assert.equal(presetForRule('docs-scripts-parity'), 'bug-hunt')
  assert.equal(presetForRule('cli-exit-code'), 'bug-hunt')
  assert.equal(presetForRule('silent-http-200'), 'bug-hunt')
  assert.equal(presetForRule('guard-drift'), 'bug-hunt')
  assert.equal(presetForRule('bug-report'), 'bug-hunt')
  assert.equal(presetForRule('deadend-state'), 'bug-hunt')
  assert.equal(presetForRule('cache-collision'), 'bug-hunt')
  assert.equal(presetForRule('duplicate-batch'), 'bug-hunt')
})

test('per-preset counts add up and the recommendation follows the report', () => {
  const counts = sweepCounts(REPORT)
  // 1 hotspot + debt-spike(soft) が hotspots、spec-sprawl が docs-specs、state-relay-drift が state-flow
  assert.deepEqual(counts, {
    'state-flow': 1,
    contracts: 0,
    hotspots: 2,
    'docs-specs': 1,
    'bug-hunt': 0,
    custom: 0,
  })
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

test('bug-hunt defaults to a read-only report contract with the five blind spots', () => {
  const payload = buildSweepPayload({ preset: 'bug-hunt', report: REPORT, lang: 'en' })
  assert.equal(payload.preset, 'bug-hunt')
  assert.equal(payload.autoFix, false)
  assert.ok(payload.title.startsWith('[COHERENCE/BUG-HUNT] '), payload.title)
  assert.match(payload.body, /^Contract: Report only /m)
  assert.doesNotMatch(payload.body, /Reproduce first/)
  assert.ok(payload.body.includes(en['coherence.preset.bug-hunt.reportOnly']))
  assert.ok(payload.body.includes(`${en['coherence.preset.bug-hunt.blindSpots']}:`))
  // 5 大盲点は必ず 5 行（Files の箇条書きより前）
  const head = payload.body.split('Files:')[0]
  assert.equal(head.split('\n').filter((line) => line.startsWith('- ')).length, 5)
  for (const key of BUG_HUNT_CHECKS) {
    assert.ok(payload.body.includes(en[`coherence.preset.bug-hunt.${key}`]), `${key} が本文に無い`)
  }
  assert.equal(payload.body.split('\n').at(-1).startsWith('Verify: '), true, 'Verify が最後の行')
  assert.ok(payload.body.length <= SEED_MAX)
  assert.doesNotMatch(payload.body, /^Plan: /m, 'single ではバッチ分割計画を書かない')
})

test('the bug-hunt opt-in switches the contract to reproduce-first', () => {
  const off = buildSweepPayload({ preset: 'bug-hunt', report: REPORT, lang: 'en' })
  const on = buildSweepPayload({ preset: 'bug-hunt', report: REPORT, lang: 'en', autoFix: true })
  assert.equal(on.autoFix, true)
  assert.match(on.body, /^Contract: Reproduce first /m)
  assert.doesNotMatch(on.body, /Report only/)
  assert.ok(on.body.includes(en['coherence.preset.bug-hunt.reproduceFirst']))
  // 盲点リストは OFF / ON で同一（変わるのは契約の 1 行だけ）
  const bullets = (body) => body.split('\n').filter((line) => line.startsWith('- ')).join('\n')
  assert.equal(bullets(on.body), bullets(off.body))
  // 他のプリセットは autoFix を受け取っても契約行を出さない
  const hotspots = buildSweepPayload({ preset: 'hotspots', report: REPORT, lang: 'en', autoFix: true })
  assert.equal(hotspots.autoFix, false)
  assert.doesNotMatch(hotspots.body, /^Contract: /m)
})

test('the bug-hunt spec route hands the checklist and severity policy to the architect', () => {
  const payload = buildSweepPayload({ preset: 'bug-hunt', report: REPORT, mode: 'spec', lang: 'en' })
  assert.equal(payload.mode, 'spec')
  assert.match(payload.body, /^Plan: /m)
  assert.ok(payload.body.includes(en['coherence.preset.bug-hunt.orderPolicy']), '重要度の方針を種に渡す')
  assert.ok(payload.seedText.includes(en['coherence.preset.bug-hunt.blindSpots']))
  assert.ok(payload.seedText.startsWith('Draft a multi-batch SPEC'))
  assert.ok(payload.seedText.length <= SEED_MAX)
  // チェックを黙って無視しない: spec ルートでも契約は切り替わる
  const fixed = buildSweepPayload({ preset: 'bug-hunt', report: REPORT, mode: 'spec', lang: 'en', autoFix: true })
  assert.match(fixed.body, /^Contract: Reproduce first /m)
})

test('the bug-hunt body is translated while the machine labels stay ASCII', () => {
  const payload = buildSweepPayload({ preset: 'bug-hunt', report: REPORT, lang: 'ja' })
  assert.match(payload.title, /^\[COHERENCE\/BUG-HUNT\] バグ・不具合ハント/)
  assert.match(payload.body, /^Execution Mode: \[Mode: Zero-Stop\]$/m)
  assert.ok(payload.body.includes(ja['coherence.preset.bug-hunt.blindSpots']))
  assert.ok(payload.body.includes(ja['coherence.preset.bug-hunt.reportOnly']))
  assert.match(payload.body, /^Verify: /m)
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

test('soft-signal archive ratchets on numeric value and auto-resurfaces on growth', () => {
  const repoSignal21 = { rule: 'akapen-residual', file: '', detail: "21 legacy 'akapen' references", value: 21 }
  const repoSignal22 = { rule: 'akapen-residual', file: '', detail: "22 legacy 'akapen' references", value: 22 }
  const bloatSignal = { rule: 'file-bloat', file: 'src/big.js', detail: '810 lines', value: 810, limit: 800 }
  assert.equal(signalKeyOf(repoSignal21), signalKeyOf(repoSignal22), '数字が変わっても同一シグナルのキーに束ねる')
  assert.equal(signalKeyOf(bloatSignal), 'file-bloat::src/big.js')

  let store = acknowledgeSignal({}, '/repo/a', repoSignal21, 1000)
  store = parseCoherenceAck(JSON.stringify(store))
  const repoMap = ackForRepo(store, '/repo/a')

  assert.equal(isSignalAcknowledged(repoSignal21, repoMap), true)
  assert.equal(isSignalAcknowledged({ ...repoSignal21, value: 20 }, repoMap), true)
  assert.equal(isSignalAcknowledged(repoSignal22, repoMap), false, '件数増加時は自動で再点灯する')
  assert.deepEqual(ackForRepo(store, '/repo/other'), {}, '別リポジトリへ漏れない')
  assert.deepEqual(parseCoherenceAck('{broken'), {})

  const split = partitionSoftSignals([repoSignal21, bloatSignal], repoMap)
  assert.deepEqual(split.archived.map((x) => x.rule), ['akapen-residual'])
  assert.deepEqual(split.active.map((x) => x.rule), ['file-bloat'])

  const countsWithAck = sweepCounts({ hardFails: [], softSignals: [repoSignal21, bloatSignal] }, repoMap)
  assert.equal(countsWithAck.hotspots, 1)
  assert.equal(countsWithAck.custom, 0)

  const payloadWithAck = buildSweepPayload({
    preset: 'hotspots',
    report: {
      hardFails: [],
      softSignals: [{ rule: 'debt-spike', file: 'src/skip.js', detail: '10 markers', value: 10 }, bloatSignal],
    },
    ackMap: ackForRepo(acknowledgeSignal({}, '/repo/a', { rule: 'debt-spike', file: 'src/skip.js', value: 10 }), '/repo/a'),
    lang: 'en',
  })
  assert.match(payloadWithAck.body, /^Detected: 0 hard fail\(s\), 1 soft signal\(s\), 0 hotspot\(s\)$/m)
  assert.doesNotMatch(payloadWithAck.body, /src\/skip\.js/)
  assert.match(payloadWithAck.body, /src\/big\.js/)

  const restored = restoreSignal(store, '/repo/a', repoSignal21)
  assert.deepEqual(ackForRepo(restored, '/repo/a'), {})
})

test('adviceKeyForRule maps universal rules and falls back cleanly for repo-specific rules', () => {
  assert.equal(adviceKeyForRule('file-bloat'), 'coherence.advice.fileBloat')
  assert.equal(adviceKeyForRule('git-hotspot'), 'coherence.advice.gitHotspot')
  assert.equal(adviceKeyForRule('spec-sprawl'), 'coherence.advice.specSprawl')
  assert.equal(adviceKeyForRule('duplicate-batch-id'), 'coherence.advice.duplicateBatchId')
  assert.equal(adviceKeyForRule('debt-spike'), 'coherence.advice.debtSpike')
  assert.equal(adviceKeyForRule('baseline-ratchet'), 'coherence.advice.baselineRatchet')
  assert.equal(adviceKeyForRule('akapen-residual'), 'coherence.advice.preset')
  const normalized = normalizeReport({
    softSignals: [{ rule: 'file-bloat', file: 'src/x.js', message: '900 lines', value: 900, limit: 800 }],
  })
  assert.equal(normalized.softSignals[0].value, 900)
  assert.equal(normalized.softSignals[0].limit, 800)
})
