/**
 * `createBoardsApi`（`apps/bridge/src/server/api-boards.js`）の実ハンドラ結合テスト。
 *
 * RefactorSheet からの単発タスク起票（全 6 プリセット × en/ja）と、分割時に
 * destructure / import が抜けやすい各ルートを実際に実行して HTTP 応答を検証する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoardsApi } from '../src/server/api-boards.js'
import { normalizeCapture } from '../src/capture.js'
import { errorBody } from '../src/api-errors.js'
import { langOf, sendError, sendFailure, sendJson } from '../src/http/respond.js'
import { SWEEP_PRESETS, buildSweepPayload } from '../../web/src/lib/coherenceSweep.js'

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

function makeHarness() {
  let nudges = 0
  let watcherSyncs = 0
  const createdCalls = []
  const audits = []

  const ctx = {
    cfg: { rate: { maxWrites: 100, windowMs: 60_000 } },
    auth: { audit: (e) => audits.push(e) },
    kanban: {
      boards: () => [{ slug: 'mobile', name: 'Mobile', current: true }],
      tasks: () => [{ id: 't_1', status: 'blocked', title: 'Blocked task' }],
      task: (_b, id) => ({ id, status: 'blocked', title: 'Task' }),
      abort: async (_b, id) => ({ ok: true, id }),
    },
    repos: {},
    review: {
      board: 'mobile',
      workdir: () => '/tmp/demo',
      list: () => [],
      feed: (limit) => [{ kind: 'done', text: 'ok', at: 1000, limit }],
      chatReports: () => [{ sessionId: 's1', taskId: 't_1', at: 1000 }],
      chatReport: (sid) => [{ sessionId: sid, taskId: 't_1', at: 1000 }],
      sheetHtml: (id) => ({
        ok: true,
        html: `<!doctype html><html><body><p>Sheet ${id}</p></body></html>`,
      }),
      answer: async (id) => ({ ok: true, taskId: id }),
      reopen: async (id) => ({ ok: true, taskId: id }),
      approve: async (id) => ({ ok: true, taskId: id, moved: 'done' }),
      saveAnnotation: async () => ({ ok: true, marks: 1 }),
      createFromImage: async () => ({ ok: true, taskId: 't_anno' }),
    },
    ops: {},
    live: {},
    inbox: {
      close: async (_b, id) => ({ ok: true, id, status: 'archived' }),
      unblock: async (_b, id) => ({ ok: true, id, status: 'ready' }),
    },
    usage: {},
    search: {},
    discord: { forAnchor: () => null },
    memos: {},
    capture: {
      create: async (input) => {
        const c = normalizeCapture(input)
        createdCalls.push(c)
        return {
          ok: true,
          created: true,
          task: {
            id: `t_sweep_${createdCalls.length}`,
            title: c.title,
            status: 'ready',
            priority: c.priority,
            assignee: c.assignee,
            board: c.board,
          },
        }
      },
    },
    transcript: {},
    reviewWatcher: {},
    gitinfo: { entryFor: () => null, forTask: async () => null },
    pipelineWatcher: {},
    stateDbFor: () => '',
    listProfiles: async () => [],
    listStateDbs: async () => [],
    readWorkerFeed: async () => ({ feed: { messages: [] } }),
    loadSnippetStore: () => ({}),
    saveSnippetStore: () => ({}),
    snippetPayload: () => ({}),
    SNIPPET_STORE: {},
    tailLog: () => '',
    sendJson,
    sendError,
    sendFailure,
    readJson: async (req) => req._body ?? {},
    langOf,
    readAllowed: () => true,
    writeAllowed: () => true,
    errorBody,
    normalizePath: (p) => p,
    listSpecs: () => [],
    archiveSpec: () => ({ ok: true }),
    partitionSpecs: () => ({ active: [], archived: [] }),
    readRuns: () => [],
    attachRunTaskIds: (x) => x,
    resolveSpecRepo: () => null,
    BULK_ARCHIVE_MAX: 50,
    TASK_ID_RE: /^t_[0-9a-z]+$/i,
    sendOutcome: (res, out) => sendJson(res, out?.ok === false ? 502 : 200, out),
    getPilotProfile: () => 'mobile',
    ensureWatchersFresh: async () => {
      watcherSyncs += 1
    },
    nudgeWatchers: () => {
      nudges += 1
    },
    VERSION: '0.2.4',
  }

  return {
    api: createBoardsApi(ctx),
    get nudges() {
      return nudges
    },
    get watcherSyncs() {
      return watcherSyncs
    },
    createdCalls,
  }
}

test('POST /api/boards/:slug/tasks は RefactorSheet 全 6 プリセット（en/ja）を assignee 省略でも 201 で起票できる', async () => {
  const h = makeHarness()
  for (const lang of ['en', 'ja']) {
    for (const preset of SWEEP_PRESETS) {
      const payload = buildSweepPayload({
        preset,
        report: {
          available: true,
          hardFails: [{ rule: 'state-relay', file: 'src/a.js', detail: 'relay drift' }],
          softSignals: [],
          hotspots: [],
          summary: { hardFailCount: 1, softSignalCount: 0, hotspotCount: 0 },
        },
        target: 'x'.repeat(240),
        mode: 'single',
        board: 'mobile',
        lang,
        autoFix: preset === 'bug-hunt',
      })
      const url = new URL('http://127.0.0.1/api/boards/mobile/tasks')
      const req = { method: 'POST', headers: { 'accept-language': lang }, _body: { title: payload.title, body: payload.body, priority: 1 } }
      const res = mockRes()
      await h.api.handleBoards(req, res, url, ['api', 'boards', 'mobile', 'tasks'])
      assert.equal(res.status, 201, `${preset}/${lang} failed: ${res.body}`)
      assert.equal(res.json().created, true)
    }
  }
  assert.equal(h.createdCalls.length, SWEEP_PRESETS.length * 2)
  assert.ok(h.createdCalls.every((c) => c.assignee === 'mobile'))
  assert.equal(h.nudges, SWEEP_PRESETS.length * 2)
})

test('handleBoards の更新系と handleReview の各エンドポイントが未定義参照なく応答する', async () => {
  const h = makeHarness()
  const run = async (fn, method, pathname, body = {}) => {
    const url = new URL(`http://127.0.0.1${pathname}`)
    const seg = url.pathname.split('/').filter(Boolean)
    const res = mockRes()
    await fn({ method, headers: {}, _body: body }, res, url, seg)
    return res
  }

  assert.equal((await run(h.api.handleBoards, 'POST', '/api/boards/mobile/tasks/bulk-archive', { taskIds: ['t_1'] })).status, 200)
  assert.equal((await run(h.api.handleBoards, 'POST', '/api/boards/mobile/tasks/t_1/close', { action: 'done' })).status, 200)
  assert.equal((await run(h.api.handleBoards, 'POST', '/api/boards/mobile/tasks/t_1/unblock', {})).status, 200)
  assert.equal((await run(h.api.handleBoards, 'POST', '/api/boards/mobile/tasks/t_1/abort', {})).status, 200)

  assert.equal((await run(h.api.handleReview, 'GET', '/api/review/feed?limit=10')).status, 200)
  assert.equal((await run(h.api.handleReview, 'GET', '/api/review/chat-reports')).status, 200)
  assert.equal((await run(h.api.handleReview, 'GET', '/api/review/chat-report?session_id=s1')).status, 200)
  assert.equal(h.watcherSyncs, 3)

  const sheetRes = await run(h.api.handleReview, 'GET', '/api/review/t_1/sheet')
  assert.equal(sheetRes.status, 200)
  assert.match(sheetRes.body, /Sheet t_1/)
  assert.ok(sheetRes.headers['content-security-policy'])

  const viewRes = await run(h.api.handleReview, 'GET', '/api/review/t_1/view')
  assert.equal(viewRes.status, 200)
  assert.match(viewRes.body, /<iframe/)

  assert.equal((await run(h.api.handleReview, 'POST', '/api/review/t_1/answer', {})).status, 200)
  assert.equal((await run(h.api.handleReview, 'POST', '/api/review/t_1/reopen', {})).status, 200)
  assert.equal((await run(h.api.handleReview, 'POST', '/api/review/t_1/approve', {})).status, 200)
  assert.equal((await run(h.api.handleReview, 'POST', '/api/review/t_1/annotation', {})).status, 200)
  assert.equal((await run(h.api.handleReview, 'POST', '/api/review/annotation/new', {})).status, 201)
  assert.equal(h.nudges, 9)
})
