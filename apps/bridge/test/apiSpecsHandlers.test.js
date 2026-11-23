/**
 * `createSpecsApi`（`apps/bridge/src/server/api-specs.js`）の実ハンドラ結合テスト。
 *
 * RefactorSheet や Spec Launchpad などの `/api/repos` / `/api/specs` / `/api/coherence` /
 * `/api/pipeline` / `/api/architect` 各エンドポイントを実際に実行し、分割時の
 * destructure 漏れ・応答コード・ウォッチャー同期の呼び出しを検証する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecsApi } from '../src/server/api-specs.js'
import { langOf, sendError, sendFailure, sendJson } from '../src/http/respond.js'

function mockRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end(chunk = '') {
      this.body = String(chunk ?? '')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

function makeHarness({ throwCoherence = false } = {}) {
  let nudges = 0
  let watcherSyncs = 0
  let pilotProfile = 'mobile'
  let coherenceRuns = 0
  const audits = []
  const launchCalls = []
  const seedCalls = []

  const targetRepo = {
    repo: 'demo',
    label: 'Demo',
    path: '/tmp/demo',
    board: 'mobile',
  }

  const ctx = {
    cfg: {
      hermesHome: '/tmp/.hermes',
      home: '/tmp',
      configPath: '/tmp/config.json',
      reviewDir: '/tmp/review',
      rate: { maxWrites: 100, windowMs: 60_000 },
    },
    auth: { audit: (e) => audits.push(e) },
    repos: {
      list: () => [{ id: 'demo', label: 'Demo', path: '/tmp/demo' }],
      scanDirs: () => ['/tmp'],
      setScanDirs: (dirs) => ({ ok: true, scanDirs: dirs }),
      add: (b) => (b?.path ? { ok: true, id: 'demo', path: b.path } : { ok: false, code: 'BAD_PATH' }),
      scan: () => ({ ok: true, repos: [{ id: 'demo' }] }),
      createBoard: async (id) => ({ ok: true, board: { slug: `${id}-board` } }),
      remove: (id) => ({ ok: true, removed: id, hidden: false }),
    },
    specs: {
      listSpecs: () => [
        { path: 'docs/SPEC-ACTIVE.md', status: 'active' },
        { path: 'docs/SPEC-DONE.md', status: 'archived' },
      ],
      launchSpec: async (opts) => {
        launchCalls.push(opts)
        return { ok: true, created: ['t_1'], skipped: [], failed: [], dryRun: opts.dryRun }
      },
    },
    architect: {
      getConfig: () => ({ runner: 'hermes-native' }),
      setConfig: ({ runner }) =>
        runner === 'invalid' ? { ok: false, code: 'INVALID_RUNNER' } : { ok: true, runner: runner || 'hermes-native' },
      seed: async (opts) => {
        seedCalls.push(opts)
        return { ok: true, jobId: 'j_1', runner: opts.runner || 'hermes-native', executionPolicy: 'review' }
      },
      dismiss: (id) => (id === 'j_1' ? { ok: true, jobId: id, persisted: true } : { ok: false, code: 'JOB_NOT_FOUND' }),
      jobs: async (opts) => ({ ok: true, jobs: [{ id: 'j_1', board: opts.board || 'mobile' }], strictBoard: opts.strictBoard }),
    },
    readPipelineReports: (_dir, { board, limit }) => [{ board: board || 'mobile', limit, ok: true }],
    getPilotProfile: () => pilotProfile,
    writePilotProfile: (_cfgPath, p) => {
      pilotProfile = String(p || 'mobile')
      return pilotProfile
    },
    ensurePilotProfile: ({ profile }) => ({ ok: true, copiedConfig: false, soul: { mode: 'pilot', changed: false }, profiles: [{ name: profile, changed: false }] }),
    DEFAULT_SKILLS_SRC: '/tmp/skills',
    getOptimizeStatus: ({ pilotProfile: p }) => ({ ok: true, pilotProfile: p, skillsReady: true }),
    optimizeAgentSkills: () => ({ ok: true, targets: ['/tmp/.hermes/skills'] }),
    sendJson,
    sendError,
    sendFailure,
    readJson: async (req) => req._body ?? {},
    langOf,
    writeAllowed: () => true,
    archiveSpec: (_repoPath, p) => ({ ok: true, path: p, noop: false }),
    partitionSpecs: (all) => ({
      active: all.filter((s) => s.status !== 'archived'),
      archived: all.filter((s) => s.status === 'archived'),
    }),
    readRuns: () => [],
    attachRunTaskIds: (s) => s,
    readSpecContent: (_repoPath, p) => ({ ok: true, path: p, bytes: 12, content: '# Demo Spec\n' }),
    runsPathFor: () => '/tmp/spec-runs.json',
    analyzeCoherence: async () => {
      coherenceRuns += 1
      if (throwCoherence) throw new Error('boom')
      return { ok: true, hardFails: [], softSignals: [], hotspots: [], summary: { hardFailCount: 0 } }
    },
    resolveSpecRepo: ({ repoId, boardSlug }) => {
      if (repoId === 'missing' || boardSlug === 'missing') return null
      return targetRepo
    },
    coherenceCache: new Map(),
    COHERENCE_TTL_MS: 15_000,
    ensureWatchersFresh: async () => {
      watcherSyncs += 1
    },
    nudgeWatchers: () => {
      nudges += 1
    },
  }

  return {
    api: createSpecsApi(ctx),
    get nudges() {
      return nudges
    },
    get watcherSyncs() {
      return watcherSyncs
    },
    get coherenceRuns() {
      return coherenceRuns
    },
    audits,
    launchCalls,
    seedCalls,
  }
}

async function invoke(fn, method, pathname, body = {}) {
  const url = new URL(`http://127.0.0.1${pathname}`)
  const seg = url.pathname.split('/').filter(Boolean)
  const res = mockRes()
  await fn({ method, headers: { 'accept-language': 'ja' }, _body: body }, res, url, seg)
  return res
}

test('handleRepos の全ルートが正常系・異常系とも未定義参照なく応答する', async () => {
  const h = makeHarness()

  assert.equal((await invoke(h.api.handleRepos, 'GET', '/api/repos')).status, 200)
  assert.equal((await invoke(h.api.handleRepos, 'GET', '/api/repos?fresh=1')).status, 200)
  assert.equal((await invoke(h.api.handleRepos, 'POST', '/api/repos', { path: '/tmp/demo' })).status, 201)
  assert.equal((await invoke(h.api.handleRepos, 'POST', '/api/repos', { scanDirs: ['/tmp'] })).status, 201)
  assert.equal((await invoke(h.api.handleRepos, 'POST', '/api/repos', {})).status, 400)
  assert.equal((await invoke(h.api.handleRepos, 'POST', '/api/repos/scan')).status, 200)
  assert.equal((await invoke(h.api.handleRepos, 'POST', '/api/repos/demo/board')).status, 201)
  assert.equal((await invoke(h.api.handleRepos, 'DELETE', '/api/repos/demo')).status, 200)
  assert.equal((await invoke(h.api.handleRepos, 'GET', '/api/repos/unknown/sub')).status, 404)
})

test('handleSpecs の全ルートがフィルタ・起動・ウォッチャー通知を含め動作する', async () => {
  const h = makeHarness()

  const activeOnly = await invoke(h.api.handleSpecs, 'GET', '/api/specs?repo=demo')
  assert.equal(activeOnly.status, 200)
  assert.equal(activeOnly.json().specs.length, 1)
  assert.equal(activeOnly.json().archivedCount, 1)

  const withArchived = await invoke(h.api.handleSpecs, 'GET', '/api/specs?repo=demo&includeArchived=1')
  assert.equal(withArchived.json().specs.length, 2)

  assert.equal((await invoke(h.api.handleSpecs, 'GET', '/api/specs?repo=missing')).status, 404)
  assert.equal((await invoke(h.api.handleSpecs, 'GET', '/api/specs/content?repo=demo&path=docs/SPEC-DEMO.md')).status, 200)

  const reports = await invoke(h.api.handleSpecs, 'GET', '/api/specs/reports?board=mobile&limit=5')
  assert.equal(reports.status, 200)
  assert.equal(h.watcherSyncs, 1)

  assert.equal((await invoke(h.api.handleSpecs, 'POST', '/api/specs/archive', { repo: 'demo', path: 'docs/SPEC-ACTIVE.md' })).status, 200)

  const dry = await invoke(h.api.handleSpecs, 'POST', '/api/specs/launch', { repo: 'demo', specRelPath: 'docs/SPEC-ACTIVE.md', dryRun: true })
  assert.equal(dry.status, 201)
  assert.equal(h.nudges, 0)

  const live = await invoke(h.api.handleSpecs, 'POST', '/api/specs/launch', { repo: 'demo', specRelPath: 'docs/SPEC-ACTIVE.md' })
  assert.equal(live.status, 201)
  assert.equal(h.nudges, 1)
  assert.equal(h.launchCalls[1].assignee, 'mobile')

  assert.equal((await invoke(h.api.handleSpecs, 'GET', '/api/specs/unknown')).status, 404)
})

test('handleCoherence はキャッシュ・fresh・失敗フォールバックを正しく処理する', async () => {
  const h = makeHarness()

  const first = await invoke(h.api.handleCoherence, 'GET', '/api/coherence/report?repo=demo')
  assert.equal(first.status, 200)
  assert.equal(first.json().cached, false)
  assert.equal(h.coherenceRuns, 1)

  const second = await invoke(h.api.handleCoherence, 'GET', '/api/coherence/report?repo=demo')
  assert.equal(second.status, 200)
  assert.equal(second.json().cached, true)
  assert.equal(h.coherenceRuns, 1)

  const fresh = await invoke(h.api.handleCoherence, 'GET', '/api/coherence/report?repo=demo&fresh=1')
  assert.equal(fresh.status, 200)
  assert.equal(fresh.json().cached, false)
  assert.equal(h.coherenceRuns, 2)

  const errHarness = makeHarness({ throwCoherence: true })
  const degraded = await invoke(errHarness.api.handleCoherence, 'GET', '/api/coherence/report?repo=demo')
  assert.equal(degraded.status, 200)
  assert.equal(degraded.json().ok, false)
  assert.deepEqual(degraded.json().hardFails, [])
})

test('handlePipeline と handleArchitect の全ルートが応答する', async () => {
  const h = makeHarness()

  assert.equal((await invoke(h.api.handlePipeline, 'GET', '/api/pipeline/status')).status, 200)
  const prof = await invoke(h.api.handlePipeline, 'POST', '/api/pipeline/profile', { profile: 'pilot-alt' })
  assert.equal(prof.status, 200)
  assert.equal(prof.json().pilotProfile, 'pilot-alt')
  assert.equal((await invoke(h.api.handlePipeline, 'POST', '/api/pipeline/optimize', {})).status, 200)
  assert.equal((await invoke(h.api.handlePipeline, 'GET', '/api/pipeline/unknown')).status, 404)

  assert.equal((await invoke(h.api.handleArchitect, 'GET', '/api/architect/config')).status, 200)
  assert.equal((await invoke(h.api.handleArchitect, 'PUT', '/api/architect/config', { runner: 'hermes-native' })).status, 200)
  assert.equal((await invoke(h.api.handleArchitect, 'PUT', '/api/architect/config', { runner: 'invalid' })).status, 400)
  assert.equal((await invoke(h.api.handleArchitect, 'POST', '/api/architect/seed', { repo: 'demo', seedText: 'seed' })).status, 202)
  assert.equal((await invoke(h.api.handleArchitect, 'GET', '/api/architect/jobs?board=mobile&strictBoard=1')).status, 200)
  assert.equal((await invoke(h.api.handleArchitect, 'POST', '/api/architect/jobs/j_1/dismiss')).status, 200)
  assert.equal((await invoke(h.api.handleArchitect, 'POST', '/api/architect/jobs/missing/dismiss')).status, 404)
  assert.equal((await invoke(h.api.handleArchitect, 'GET', '/api/architect/unknown')).status, 404)
})
