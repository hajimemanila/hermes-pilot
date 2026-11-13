import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOps } from '../src/ops.js'

/** 監査だけを集める偽 auth。 */
function fakeAuth() {
  const rows = []
  return { audit: (e) => rows.push(e), rows }
}

/** HERMES_HOME 相当の一時ディレクトリ。 */
function home(estop) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-estop-'))
  if (estop !== undefined) fs.writeFileSync(path.join(dir, 'ESTOP'), estop)
  return dir
}

function ops(cfg = {}) {
  const auth = fakeAuth()
  const calls = []
  const o = createOps(
    {
      hermesHome: cfg.home ?? home(),
      runner:
        cfg.runner ??
        (async (args) => {
          calls.push(args)
          return { code: 0, out: 'ok' }
        }),
    },
    { call: async () => ({ status: 200, data: {} }) },
    auth,
  )
  return { o, auth, calls }
}

test('ESTOP が無ければ engaged:false', () => {
  const { o } = ops({ home: home() })
  assert.deepEqual(o.paused(), { engaged: false, reason: null, engagedAt: null })
})

test('ESTOP があれば理由と時刻を返す', () => {
  const h = home(JSON.stringify({ engaged_at: '2026-10-23T05:00:00+00:00', reason: 'mobile' }))
  const { o } = ops({ home: h })
  const s = o.paused()
  assert.equal(s.engaged, true)
  assert.equal(s.reason, 'mobile')
  assert.equal(s.engagedAt, '2026-10-23T05:00:00+00:00')
})

test('壊れた ESTOP でも engaged:true（fail safe）', () => {
  const { o } = ops({ home: home('not json') })
  const s = o.paused()
  assert.equal(s.engaged, true)
  assert.equal(s.reason, null)
})

test('pause は hermes pause --reason を実行し、監査に残す', async () => {
  const h = home()
  const { o, calls, auth } = ops({
    home: h,
    runner: async (args) => {
      calls.push(args)
      fs.writeFileSync(path.join(h, 'ESTOP'), JSON.stringify({ reason: 'mobile', engaged_at: 'x' }))
      return { code: 0, out: '⏸️ paused' }
    },
  })
  const r = await o.pause('mobile', 'test')
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['pause', '--reason', 'mobile'])
  assert.equal(r.state.engaged, true)
  assert.equal(auth.rows.at(-1).kind, 'gateway.pause')
})

test('resume は hermes resume を実行して ESTOP を消す', async () => {
  const h = home(JSON.stringify({ reason: 'mobile' }))
  const { o, calls, auth } = ops({
    home: h,
    runner: async (args) => {
      calls.push(args)
      fs.unlinkSync(path.join(h, 'ESTOP'))
      return { code: 0, out: '▶️ resumed' }
    },
  })
  assert.equal(o.paused().engaged, true)
  const r = await o.resume('test')
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['resume'])
  assert.equal(r.state.engaged, false)
  assert.equal(auth.rows.at(-1).kind, 'gateway.resume')
})

test('CLI が失敗したら例外（statusCode 502）', async () => {
  const { o } = ops({ runner: async () => ({ code: 1, out: 'boom' }) })
  await assert.rejects(() => o.pause('x'), (e) => e.statusCode === 502 && /boom/.test(e.message))
})

test('overview は Hermes 標準 API だけを叩く（外部プラグインのエンドポイントを呼ばない）', async () => {
  const calls = []
  const o = createOps(
    { hermesHome: home(), version: '0.1.0', port: 4097 },
    {
      call: async (pathname) => {
        calls.push(pathname)
        if (pathname === '/api/status') return { status: 200, data: { version: '1.2.3', model: 'm' } }
        return { status: 200, data: { cpu_count: 8 } }
      },
    },
    fakeAuth(),
    { kanban: { boards: () => [] } },
  )
  const ov = await o.overview()
  assert.deepEqual(calls.sort(), ['/api/status', '/api/system/stats'])
  assert.ok(!calls.some((c) => c.includes('/plugins/')), '外部プラグインは叩かない')
  assert.equal(ov.hermes.version, '1.2.3')
  assert.equal(ov.system.cpuCount, 8)
  assert.equal(ov.bridge.ok, true)
  assert.equal(ov.bridge.port, 4097)
  assert.ok(ov.bridge.uptimeSec >= 0)
  assert.equal(ov.ops, undefined, '旧 ops ブロックは返さない')
})

test('overview のカンバン集計は自前（稼働・判断待ち）で、板が落ちても 0 で返す', async () => {
  const boards = [
    { slug: 'a', counts: { running: 2, blocked: 1, ready: 3 } },
    { slug: 'b', counts: { running: 1, blocked: 2 } },
    { slug: 'old', archived: true, counts: { running: 9, blocked: 9 } },
  ]
  const o = createOps(
    { hermesHome: home(), version: '0.1.0', port: 4097 },
    { call: async () => ({ status: 500, data: null }) },
    fakeAuth(),
    { kanban: { boards: () => boards } },
  )
  const ov = await o.overview()
  assert.deepEqual(ov.kanban, { boards: 2, running: 3, blocked: 3, ready: 3, reviewWaiting: 3 })
  assert.equal(ov.hermes, null, 'status が落ちても他は返す')
  assert.equal(ov.bridge.ok, false)

  const broken = createOps({ hermesHome: home() }, { call: async () => ({ status: 200, data: {} }) }, fakeAuth(), {
    kanban: {
      boards: () => {
        throw new Error('db locked')
      },
    },
  })
  const ov2 = await broken.overview()
  assert.deepEqual(ov2.kanban, { boards: 0, running: 0, blocked: 0, ready: 0, reviewWaiting: 0 })
})
