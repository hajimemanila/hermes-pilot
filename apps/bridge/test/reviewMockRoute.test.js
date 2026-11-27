/**
 * AP2-3 tests for `/api/review/:id/mock`, `REVIEW_MOCK_CSP`, and `stylePreset` persistence in remix.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { REVIEW_MOCK_CSP, createReview, reviewMockHeaders } from '../src/review.js'
import { createBoardsApi } from '../src/server/api-boards.js'
import { errorBody } from '../src/api-errors.js'
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

function setupReviewHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-review-mock-'))
  const kanbanRoot = path.join(dir, 'kanban')
  const boardDir = path.join(kanbanRoot, 'boards', 'mobile')
  const workdir = path.join(dir, 'repo')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.mkdirSync(path.join(workdir, '.hermes-pilot', 'sandbox', 'job1'), { recursive: true })
  fs.mkdirSync(path.join(workdir, 'sheets'), { recursive: true })

  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug: 'mobile', workdir }))

  const dbPath = path.join(boardDir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      body TEXT,
      status TEXT,
      priority INTEGER,
      assignee TEXT,
      parent_id TEXT,
      created_at REAL,
      completed_at REAL,
      updated_at REAL
    );
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, payload TEXT, created_at REAL);
  `)
  db.prepare('INSERT INTO tasks (id, title, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
    't_mock_1',
    'Visual Fork',
    '[review] label=demo round=1 mode=standard sheet=sheets/demo-1.json target=' + workdir,
    'blocked',
    1000,
    1000,
  )
  db.close()

  const htmlMock = '<!doctype html><html><body><h1>Sandbox Mock A</h1></body></html>'
  fs.writeFileSync(path.join(workdir, '.hermes-pilot', 'sandbox', 'job1', 'opt-a.html'), htmlMock)
  fs.writeFileSync(path.join(workdir, 'sheets', 'evil.js'), 'alert(1)')
  fs.writeFileSync(
    path.join(workdir, 'sheets', 'demo-1.json'),
    JSON.stringify({
      title: 'Demo',
      deck: true,
      questions: [
        {
          id: 'q1',
          text: 'Choose layout',
          options: [
            {
              id: 'A',
              label: 'Option A',
              recommended: true,
              visualMock: { html: '.hermes-pilot/sandbox/job1/opt-a.html' },
            },
          ],
        },
      ],
    }),
  )

  const noopRunner = async () => ({ code: 0, out: '' })
  const review = createReview(
    {
      kanbanRoot,
      pluginDataDir: path.join(dir, 'plugin-data'),
      hermesBin: 'echo',
    },
    {
      board: 'mobile',
      root: workdir,
      runKanban: noopRunner,
    },
  )

  const api = createBoardsApi({
    cfg: { rate: { maxWrites: 100, windowMs: 60_000 } },
    auth: { audit: () => {} },
    kanban: { boards: () => [{ slug: 'mobile', name: 'Mobile', workdir }], tasks: () => [] },
    review,
    ops: {},
    live: {},
    inbox: {},
    usage: {},
    search: {},
    discord: {},
    memos: {},
    capture: {},
    transcript: {},
    reviewWatcher: {},
    gitinfo: {},
    pipelineWatcher: {},
    readWorkerFeed: async () => ({}),
    sendJson,
    sendError,
    sendFailure,
    readJson: async (req) => req._body ?? {},
    langOf,
    writeAllowed: () => true,
    errorBody,
    nudgeWatchers: () => {},
  })

  return { dir, workdir, htmlMock, review, api }
}

test('REVIEW_MOCK_CSP enforces sandbox allow-scripts allow-forms without allow-same-origin', () => {
  assert.match(REVIEW_MOCK_CSP, /sandbox allow-scripts allow-forms/)
  assert.doesNotMatch(REVIEW_MOCK_CSP, /allow-same-origin/)
  const hdr = reviewMockHeaders()
  assert.equal(hdr['content-security-policy'], REVIEW_MOCK_CSP)
  assert.equal(hdr['x-content-type-options'], 'nosniff')
  assert.equal(hdr['referrer-policy'], 'no-referrer')
})

test('GET /api/review/:id/mock serves sandboxed HTML and blocks traversal/invalid paths', async () => {
  const { dir, htmlMock, api } = setupReviewHarness()
  try {
    const reqFor = (p) => ({ method: 'GET', url: p, headers: { host: '127.0.0.1:4097' } })

    const resVar = mockRes()
    await api.handleReview(reqFor('/api/review/t_mock_1/mock?variant=A'), resVar, new URL('http://127.0.0.1:4097/api/review/t_mock_1/mock?variant=A'), [
      '',
      'review',
      't_mock_1',
      'mock',
    ])
    assert.equal(resVar.status, 200)
    assert.equal(resVar.headers['content-security-policy'], REVIEW_MOCK_CSP)
    assert.equal(resVar.headers['referrer-policy'], 'no-referrer')
    assert.equal(resVar.body, htmlMock)

    const resFile = mockRes()
    await api.handleReview(
      reqFor('/api/review/t_mock_1/mock?file=.hermes-pilot/sandbox/job1/opt-a.html'),
      resFile,
      new URL('http://127.0.0.1:4097/api/review/t_mock_1/mock?file=.hermes-pilot/sandbox/job1/opt-a.html'),
      ['', 'review', 't_mock_1', 'mock'],
    )
    assert.equal(resFile.status, 200)
    assert.equal(resFile.body, htmlMock)

    for (const badPath of [
      '../../etc/passwd',
      '.hermes-pilot/sandbox/../../secret.html',
      '/etc/passwd',
      'sheets/evil.js',
    ]) {
      const resBad = mockRes()
      const u = new URL(`http://127.0.0.1:4097/api/review/t_mock_1/mock?file=${encodeURIComponent(badPath)}`)
      await api.handleReview(reqFor(u.pathname + u.search), resBad, u, ['', 'review', 't_mock_1', 'mock'])
      assert.equal(resBad.status, 403, `Expected 403 for ${badPath}, got ${resBad.status}`)
      assert.equal(resBad.json().code, 'BAD_MOCK_PATH')
    }

    const res404 = mockRes()
    await api.handleReview(
      reqFor('/api/review/t_missing/mock'),
      res404,
      new URL('http://127.0.0.1:4097/api/review/t_missing/mock'),
      ['', 'review', 't_missing', 'mock'],
    )
    assert.equal(res404.status, 404)
    assert.equal(res404.json().code, 'NOT_FOUND')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('review.remix persists valid stylePreset in .remix.json', async () => {
  const { dir, workdir, review } = setupReviewHarness()
  try {
    const out = await review.remix('t_mock_1', {
      questionId: 'q1',
      reason: 'style_gacha',
      stylePreset: 'Bento',
    })
    assert.equal(out.record.stylePreset, 'bento')
    const saved = JSON.parse(fs.readFileSync(path.join(workdir, 'sheets', 'demo-1.remix.json'), 'utf8'))
    assert.equal(saved.stylePreset, 'bento')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
