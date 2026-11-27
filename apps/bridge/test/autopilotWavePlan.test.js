/**
 * AP3-1 tests for Autopilot-only 3-way Wave batch planning and safe serial fallback
 * (Cockpit default serial behavior untouched).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSpecs } from '../src/specs.js'
import {
  MAX_AUTOPILOT_PARALLEL,
  extractBatchDependsOn,
  extractBatchFiles,
  isSharedHotspot,
  planBatchWaves,
} from '../src/specs/wave-plan.js'

const batchWith = (id, filesLines, extra = '') => ({
  id,
  title: `Batch ${id}`,
  section: [
    `### Batch ${id}: Task ${id}`,
    '- **Execution Mode**: `[Mode: Zero-Stop]`',
    '- **Objective**: Work cleanly',
    ...(extra ? [extra] : []),
    '- **Files**:',
    ...filesLines.map((f) => `  - \`${f}\``),
  ],
})

test('extractBatchFiles and isSharedHotspot parse files and identify hotspots', () => {
  const files = extractBatchFiles([
    '- **Files**:',
    '  - New: `apps/web/src/components/A.jsx`',
    '  - Changed: `apps/web/src/styles/a.css` (tweak)',
  ])
  assert.deepEqual(files, ['apps/web/src/components/A.jsx', 'apps/web/src/styles/a.css'])
  assert.equal(isSharedHotspot('package.json'), true)
  assert.equal(isSharedHotspot('apps/web/src/i18n/en.json'), true)
  assert.equal(isSharedHotspot('apps/web/src/components/A.jsx'), false)
  assert.deepEqual(extractBatchDependsOn(['- **Depends On**: none']), {
    explicit: true,
    none: true,
    ids: [],
  })
})

test('planBatchWaves keeps Cockpit default serial mode 1-by-1', () => {
  const batches = [
    batchWith('B1', ['src/a.js']),
    batchWith('B2', ['src/b.js']),
    batchWith('B3', ['src/c.js']),
  ]
  const plan = planBatchWaves(batches)
  assert.equal(plan.mode, 'serial')
  assert.equal(plan.waves.length, 3)
  assert.equal(plan.entries[0].parentBatchId, null)
  assert.equal(plan.entries[1].parentBatchId, 'B1')
  assert.equal(plan.entries[2].parentBatchId, 'B2')
})

test('planBatchWaves packs up to 3 disjoint batches and falls back to serial on overlaps or hotspots', () => {
  assert.equal(MAX_AUTOPILOT_PARALLEL, 3)
  const batches = [
    batchWith('B1', ['src/a.js']),
    batchWith('B2', ['src/b.js']),
    batchWith('B3', ['src/c.js']),
    batchWith('B4', ['src/d.js']),
    batchWith('B5', ['src/d.js']),
    batchWith('B6', ['apps/web/src/i18n/en.json', 'src/e.js']),
    batchWith('B7', ['src/f.js']),
  ]
  const plan = planBatchWaves(batches, { parallelMode: 'wave', maxParallel: 3 })
  assert.equal(plan.mode, 'wave')
  // B1,B2,B3 -> Wave 0 (3 parallel)
  // B4 -> Wave 1
  // B5 overlaps src/d.js -> Wave 2 (auto fallback)
  // B6 touches hotspot i18n/en.json -> Wave 3 serial barrier
  // B7 -> Wave 4
  assert.equal(plan.waves.length, 5)
  assert.deepEqual(plan.waves[0].map((b) => b.id), ['B1', 'B2', 'B3'])
  assert.equal(plan.entries[0].parentBatchId, null)
  assert.equal(plan.entries[1].parentBatchId, null)
  assert.equal(plan.entries[2].parentBatchId, null)
  assert.equal(plan.entries[3].waveIndex, 1)
  assert.equal(plan.entries[3].parentBatchId, 'B3')
  assert.deepEqual(plan.entries[3].waitBatchIds, ['B1', 'B2', 'B3'])
  assert.equal(plan.entries[4].waveIndex, 2)
  assert.equal(plan.entries[5].reason, 'shared_hotspot_fallback')
  assert.equal(plan.entries[6].parentBatchId, 'B6')
})

test('launchSpec with parallelMode=wave emits --parent only on wave boundaries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wave-launch-'))
  try {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'docs', 'SPEC-WAVE.md'),
      `# SPEC Wave Test
### Batch W-1: Feature A
- **Execution Mode**: \`[Mode: Zero-Stop]\`
- **Objective**: Build A
- **Files**:
  - \`src/a.js\`

### Batch W-2: Feature B
- **Execution Mode**: \`[Mode: Zero-Stop]\`
- **Objective**: Build B
- **Files**:
  - \`src/b.js\`

### Batch W-3: Shared Package
- **Execution Mode**: \`[Mode: Zero-Stop]\`
- **Objective**: Update pkg
- **Files**:
  - \`package.json\`
`,
    )
    const calls = []
    let seq = 0
    const specs = createSpecs(
      { kanbanRoot: dir, pluginDataDir: dir },
      {
        tasks: () => [],
        runner: async (args) => {
          calls.push(args)
          seq += 1
          return { code: 0, stdout: JSON.stringify({ id: `t_${seq}`, status: 'ready' }), stderr: '' }
        },
      },
    )
    const res = await specs.launchSpec({
      repoPath: dir,
      board: 'mobile',
      specRelPath: 'docs/SPEC-WAVE.md',
      parallelMode: 'wave',
      maxParallel: 3,
    })
    assert.equal(res.ok, true)
    assert.equal(res.parallelMode, 'wave')
    assert.equal(res.created[0].wave, 0)
    assert.equal(res.created[1].wave, 0)
    assert.equal(res.created[2].wave, 1)
    assert.equal(calls[0].includes('--parent'), false)
    assert.equal(calls[1].includes('--parent'), false)
    const parentIdx = calls[2].indexOf('--parent')
    assert.ok(parentIdx > -1)
    assert.equal(calls[2][parentIdx + 1], 't_2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
