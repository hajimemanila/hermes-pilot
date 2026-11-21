/**
 * 全タスク緊急停止（`POST /api/emergency/stop-all` / `ops.stopAll()`）の検証（D90）。
 *
 * 見ているもの:
 * - 正常系: ESTOP（pause）＋ 非アーカイブ全ボードの `running` を順に abort し、`ok:true` を返す
 * - 異常系: `confirm` 不一致は 400 `CONFIRM_MISMATCH`（server.js の分岐を静的に確認）
 * - 部分失敗: 1 件でも abort が失敗したら `ok:false` ＋ `failed` 配列（HTTP 502 の材料）
 * - pause が失敗しても中断処理は続行し、`failed` に pause を残す
 * - 監査（`emergency.stop_all`）とウォッチャー起動（`nudge`）が記録される
 * - 新しいコード `PARTIAL_FAILURE` が英語既定文と en/ja 辞書を持つ
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOps } from '../src/ops.js'
import { ERROR_MESSAGES } from '../src/api-errors.js'
import { matchApiRoute } from '../src/contracts/routes.js'
import { readServerSource } from './helpers/moduleSource.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SERVER_SRC = readServerSource()

const readDict = (lang) => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/src/i18n', `${lang}.json`), 'utf8'))

/** 監査だけを集める偽 auth。 */
function fakeAuth() {
  const rows = []
  return { audit: (e) => rows.push(e), rows }
}

/** HERMES_HOME 相当の一時ディレクトリ。 */
function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hm-stopall-'))
}

/**
 * 偽カンバン。`running` を中断すると一覧から消える（`remainingRunning` が減る）。
 * `failIds` は `{ok:false}`、`throwIds` は例外を返す。
 */
function fakeKanban({ running = [], failIds = [], throwIds = [] } = {}) {
  const calls = []
  const live = new Map(running.map((t) => [`${t.board}/${t.id}`, t]))
  return {
    calls,
    runningTasks: () => [...live.values()],
    abort: async (board, id, reason, lang) => {
      calls.push({ board, id, reason, lang })
      if (throwIds.includes(id)) throw new Error('abort boom')
      if (failIds.includes(id)) return { ok: false, output: 'reclaim failed' }
      live.delete(`${board}/${id}`)
      return { ok: true, reclaimed: true, blocked: true }
    },
  }
}

/**
 * `createOps()` をテスト用に組む。
 * `pauseCode === 0` のとき、偽 CLI は ESTOP センチネルを実際に書く（`paused()` と連動させる）。
 */
function makeOps({ kanban = null, pauseCode = 0, pauseOut = 'paused' } = {}) {
  const dir = home()
  const auth = fakeAuth()
  const calls = []
  const nudges = []
  const o = createOps(
    {
      hermesHome: dir,
      runner: async (args) => {
        calls.push(args)
        if (args[0] === 'pause' && pauseCode === 0) {
          fs.writeFileSync(
            path.join(dir, 'ESTOP'),
            JSON.stringify({ reason: args[2] ?? 'mobile', engaged_at: '2026-11-21T00:00:00+00:00' }),
          )
        }
        if (args[0] === 'resume') {
          try {
            fs.unlinkSync(path.join(dir, 'ESTOP'))
          } catch {
            /* 無ければ何もしない */
          }
        }
        return { code: pauseCode, out: pauseOut }
      },
    },
    { call: async () => ({ status: 200, data: {} }) },
    auth,
    { kanban, nudge: () => nudges.push(Date.now()) },
  )
  return { o, auth, calls, nudges, dir }
}

test('stopAll: ESTOP ＋ 全 running の abort が成功したら ok:true', async () => {
  const kanban = fakeKanban({
    running: [
      { board: 'mobile', id: 't_a1' },
      { board: 'hermes-pilot', id: 't_a2' },
    ],
  })
  const { o, auth, nudges } = makeOps({ kanban })

  const out = await o.stopAll({ reason: 'emergency test', by: 'unit' })

  assert.equal(out.ok, true)
  assert.equal(out.aborted, 2)
  assert.deepEqual(out.abortedTasks, [
    { board: 'mobile', id: 't_a1' },
    { board: 'hermes-pilot', id: 't_a2' },
  ])
  assert.deepEqual(out.failed, [])
  assert.equal(out.remainingRunning, 0)
  assert.equal(out.paused.engaged, true)
  assert.equal(typeof out.at, 'number')
  // 順次（並列にしない）中断し、理由がそのまま渡る
  assert.deepEqual(kanban.calls.map((c) => c.id), ['t_a1', 't_a2'])
  assert.equal(kanban.calls[0].reason, 'emergency test')
  // 監査とウォッチャー起動
  const audit = auth.rows.find((r) => r.kind === 'emergency.stop_all')
  assert.ok(audit, 'emergency.stop_all が監査に無い')
  assert.equal(audit.ok, true)
  assert.equal(audit.aborted, 2)
  assert.equal(audit.failed, 0)
  assert.equal(nudges.length, 1)
})

test('stopAll: abort が 1 件失敗したら ok:false ＋ failed 配列（残りは止める）', async () => {
  const kanban = fakeKanban({
    running: [
      { board: 'mobile', id: 't_b1' },
      { board: 'mobile', id: 't_b2' },
    ],
    failIds: ['t_b1'],
  })
  const { o, auth } = makeOps({ kanban })

  const out = await o.stopAll({ reason: 'partial' })

  assert.equal(out.ok, false)
  assert.equal(out.aborted, 1)
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].kind, 'abort')
  assert.equal(out.failed[0].id, 't_b1')
  assert.equal(out.failed[0].code, 'CLI_FAILED')
  assert.equal(out.remainingRunning, 1)
  // 失敗しても 2 件目は試す（1 件目で止まらない）
  assert.deepEqual(kanban.calls.map((c) => c.id), ['t_b1', 't_b2'])
  assert.equal(auth.rows.find((r) => r.kind === 'emergency.stop_all').ok, false)
})

test('stopAll: abort が例外でも failed に載せて続行する', async () => {
  const kanban = fakeKanban({
    running: [
      { board: 'mobile', id: 't_c1' },
      { board: 'mobile', id: 't_c2' },
    ],
    throwIds: ['t_c1'],
  })
  const { o } = makeOps({ kanban })

  const out = await o.stopAll({})
  assert.equal(out.ok, false)
  assert.equal(out.aborted, 1)
  assert.equal(out.failed.length, 1)
  assert.match(out.failed[0].detail, /abort boom/)
})

test('stopAll: pause が失敗しても中断は続行し、failed に pause を残す', async () => {
  const kanban = fakeKanban({ running: [{ board: 'mobile', id: 't_d1' }] })
  const { o, auth } = makeOps({ kanban, pauseCode: 1, pauseOut: 'hermes: ESTOP write failed' })

  const out = await o.stopAll({ reason: 'pause down' })

  assert.equal(out.ok, false)
  assert.equal(out.aborted, 1, 'pause 失敗でも running は止める')
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].kind, 'pause')
  assert.match(out.failed[0].detail, /ESTOP write failed/, 'pause の失敗詳細が捨てられている')
  assert.equal(out.paused.engaged, false)
  assert.equal(auth.rows.find((r) => r.kind === 'emergency.stop_all').failed, 1)
})

test('stopAll: 実行中が 0 件でも ESTOP は作動して ok:true', async () => {
  const kanban = fakeKanban({ running: [] })
  const { o } = makeOps({ kanban })

  const out = await o.stopAll({})
  assert.equal(out.ok, true)
  assert.equal(out.aborted, 0)
  assert.deepEqual(out.failed, [])
  assert.equal(out.remainingRunning, 0)
  assert.equal(out.paused.engaged, true)
})

test('stopAll: 言語を abort へ渡す（カンバンに残る運用メモの言語）', async () => {
  const kanban = fakeKanban({ running: [{ board: 'mobile', id: 't_e1' }] })
  const { o } = makeOps({ kanban })

  await o.stopAll({ lang: 'ja' })
  assert.equal(kanban.calls[0].lang, 'ja')
})

test('stopAll: kanban が無い（差し替え漏れ）でも ESTOP だけで ok:true', async () => {
  const { o } = makeOps({ kanban: null })
  const out = await o.stopAll({})
  assert.equal(out.ok, true)
  assert.equal(out.aborted, 0)
  assert.equal(out.remainingRunning, 0)
})

test('契約: POST /api/emergency/stop-all は mocked で登録され、server.js が分岐を持つ', () => {
  const hit = matchApiRoute('POST', '/api/emergency/stop-all')
  assert.notEqual(hit, null, 'API_ROUTES に無い')
  assert.equal(hit.demo, 'mocked', 'デモが答える区分になっていない')
  // confirm 不一致は 400 CONFIRM_MISMATCH、expect は STOP_ALL
  assert.match(SERVER_SRC, /a === 'emergency'/)
  assert.match(SERVER_SRC, /b === 'stop-all'/)
  assert.match(SERVER_SRC, /'STOP_ALL'/)
  assert.match(SERVER_SRC, /sendError\(res, 400, 'CONFIRM_MISMATCH', \{ expected: 'STOP_ALL' \}\)/)
  // 失敗は 200 で返さない（部分失敗 502）
  assert.match(SERVER_SRC, /sendJson\(res, 502, \{ \.\.\.out, \.\.\.body \}\)/)
})

test('新しいコード PARTIAL_FAILURE は英語既定文と en/ja 辞書を持つ', () => {
  assert.equal(typeof ERROR_MESSAGES.PARTIAL_FAILURE, 'string')
  assert.match(ERROR_MESSAGES.PARTIAL_FAILURE, /\{aborted\}/)
  const en = readDict('en')
  const ja = readDict('ja')
  assert.ok(en['err.PARTIAL_FAILURE'], 'en.err.PARTIAL_FAILURE が無い')
  assert.ok(ja['err.PARTIAL_FAILURE'], 'ja.err.PARTIAL_FAILURE が無い')
  // プレースホルダは両言語で一致する
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  assert.equal(names(en['err.PARTIAL_FAILURE']), names(ja['err.PARTIAL_FAILURE']))
  assert.equal(names(en['err.PARTIAL_FAILURE']), 'aborted,failed')
})
