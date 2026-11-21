/**
 * `/api/*` 契約レジストリの一致テスト（SPEC-COHERENCE §3 COH-2 / D81）。
 *
 * 検査する 4 つの一致:
 * 1. **Web**（`apps/web/src`）が呼ぶ `/api/*` はすべて `API_ROUTES` に載っている（`deprecated` は呼ばない）
 * 2. **デモ**（`apps/web/src/demo/mockApi.js`）は `demo: 'mocked'` の全ルートを明示ハンドラで答える
 * 3. **ブリッジ**（`apps/bridge/src/server.js`）は `API_ROUTES` の全ルートを受け、逆に `handleApi` の
 *    第 1 セグメント分岐に漏れがない
 * 4. **D85**: 行動契約・パイプライン提案文に `npm run verify` / `npm run deploy` / 画面サイズの
 *    決め打ちが再流入していない
 *
 * ここが落ちたときは「表を直す」のではなく**実装・呼び出し側を直す**（表は写像であって仕様ではない）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  API_METHODS,
  API_ROUTES,
  DEMO_KINDS,
  apiPatternToRegExp,
  listApiRoutes,
  matchApiRoute,
  normalizeApiPath,
} from '../src/contracts/routes.js'
import { findHardcodedVerification } from '../src/contracts/verify.js'
import { MODE_CONTRACTS } from '../src/specs.js'
import { A2B_RULES } from '../src/pipeline-optimizer.js'
import { demoRoute } from '../../web/src/demo/mockApi.js'
import { readServerSource } from './helpers/moduleSource.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SERVER_SRC = readServerSource()
const WEB_SRC_DIR = path.join(ROOT, 'apps/web/src')

/** デモの汎用フォールバック（`mocked` の受け皿にしてはいけない名前）。 */
const GENERIC_DEMO_NAMES = new Set(['fallback'])

/** パターンの `:name` を代表値へ置き換えて、実呼び出しに近いパスを作る。 */
const SAMPLE_PARAMS = {
  id: 't_demo_review',
  board: 'mobile',
  action: 'pause',
  rest: 'demo.png',
}

const SAMPLE_QUERY = {
  '/api/review/chat-report': '?session_id=demo-a2b-01',
  '/api/review/library/file': '?path=shots/demo.png',
  '/api/specs/content': '?board=mobile&path=docs/SPEC-DEMO-V1.md',
  '/api/search': '?q=demo',
  '/api/logs': '?file=gateway&lines=200',
}

/**
 * 契約パターンから代表パスを作る（クエリ付き）。
 *
 * @param {string} pattern 契約パターン
 * @returns {string} `/api/...`（クエリ付き）
 */
function samplePath(pattern) {
  const segs = normalizeApiPath(pattern)
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg === '*') return SAMPLE_PARAMS.rest
      if (seg.startsWith(':')) return SAMPLE_PARAMS[seg.slice(1)] ?? 'sample'
      return seg
    })
  const bare = `/${segs.join('/')}`
  return `${bare}${SAMPLE_QUERY[bare] ?? ''}`
}

/**
 * `apps/web/src` の `/api/*` リテラルを集める（テンプレートの `${...}` はセグメント変数として扱う）。
 *
 * `${...}` が `/` の直後なら `:v`（＝任意の 1 セグメント）に、それ以外（クエリの組み立て）は
 * 取り除く。クエリは `normalizeApiPath` が落とすので比較に影響しない。
 *
 * @param {string} dir 走査するディレクトリ
 * @returns {Map<string, string[]>} パス → 出現ファイル（重複は畳む）
 */
function collectWebApiPaths(dir) {
  /** @type {Map<string, string[]>} */
  const found = new Map()
  // 「呼び出し」とみなす文脈（コメント内の言及や `p.startsWith('/api/…')` の比較は拾わない）
  const CALL_CONTEXT = /\b(api|apiFetch|demoFetch|openSocket|withLang)\(|(href|src)=|fetch\(/
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'dist-demo'].includes(e.name)) continue
        walk(p)
        continue
      }
      if (!/\.(js|jsx)$/.test(e.name)) continue
      const raw = fs.readFileSync(p, 'utf8')
      // `/` 直後の `${...}` はパスセグメント、それ以外はクエリ断片として落とす
      const text = raw.replace(/\/\$\{[^}]*\}/g, '/:v').replace(/\$\{[^}]*\}/g, '')
      for (const line of text.split(/\r?\n/)) {
        if (!CALL_CONTEXT.test(line)) continue
        for (const m of line.matchAll(/['"`](\/api\/[^'"`\s\\]*)/g)) {
          const lit = m[1]
          // 部分パス（`/api/boards/` のような組み立て途中）と説明用の記法は対象外
          if (lit.endsWith('/') || lit.includes('*') || lit.includes('...')) continue
          const list = found.get(lit) ?? []
          const rel = path.relative(ROOT, p)
          if (!list.includes(rel)) list.push(rel)
          found.set(lit, list)
        }
      }
    }
  }
  walk(dir)
  return found
}

/** `handleApi` の第 1 セグメント分岐（`a === 'x'`）を集める。 */
function serverFirstSegments() {
  const start = SERVER_SRC.indexOf('async function handleApi')
  const body = start >= 0 ? SERVER_SRC.slice(start) : SERVER_SRC
  const out = new Set()
  for (const m of body.matchAll(/\ba === '([^']+)'/g)) out.add(m[1])
  return out
}

test('API_ROUTES は重複が無く、区分・メソッドが語彙内で、deprecated には移行先がある', () => {
  const seen = new Set()
  for (const r of API_ROUTES) {
    const key = `${r.method} ${r.pattern}`
    assert.equal(seen.has(key), false, `重複した契約: ${key}`)
    seen.add(key)
    assert.ok(API_METHODS.includes(r.method), `未知のメソッド: ${r.method}`)
    assert.ok(DEMO_KINDS.includes(r.demo), `未知の区分: ${r.demo} (${key})`)
    assert.equal(r.pattern.startsWith('/api/'), true, `パスが /api/ で始まらない: ${key}`)
    if (r.demo === 'deprecated') {
      assert.equal(typeof r.deprecatedBy, 'string', `deprecated に deprecatedBy が無い: ${key}`)
      assert.notEqual(matchApiRoute(r.method, samplePath(r.pattern)), null)
    } else {
      assert.equal(r.deprecatedBy, undefined, `deprecated 以外に deprecatedBy がある: ${key}`)
    }
  }
  assert.equal(API_ROUTES.length >= 54, true, `契約が少なすぎる（54+ 系統）: ${API_ROUTES.length}`)
})

test('廃止は from-image だけ（移行先は annotation/new）、ログ・認証・WebSocket は bridge-only', () => {
  const deprecated = listApiRoutes('deprecated').map((r) => `${r.method} ${r.pattern}`)
  assert.deepEqual(deprecated, ['POST /api/review/from-image'])
  const fromImage = matchApiRoute('POST', '/api/review/from-image')
  assert.equal(fromImage.deprecatedBy, '/api/review/annotation/new')
  // 非 JSON・認証・実行環境だけが bridge-only（それ以外はデモが答える約束）
  const bridgeOnly = listApiRoutes('bridge-only').map((r) => `${r.method} ${r.pattern}`)
  for (const expected of [
    'GET /api/me',
    'GET /api/capabilities',
    'GET /api/ws',
    'POST /api/auth/login',
    'GET /api/review/:id/image',
    'GET /api/review/:id/sheet',
  ]) {
    assert.ok(bridgeOnly.includes(expected), `bridge-only に無い: ${expected}`)
  }
  // デモが答えるべき代表ルート（COH-2 で追加した 2 系統を含む）
  for (const [method, p] of [
    ['GET', '/api/overview'],
    ['GET', '/api/coherence/report'],
    ['GET', '/api/discord/session'],
    ['POST', '/api/gateway/pause'],
    ['POST', '/api/gateway/resume'],
  ]) {
    const hit = matchApiRoute(method, p)
    assert.notEqual(hit, null, `契約に無い: ${method} ${p}`)
    assert.equal(hit.demo, 'mocked', `デモ対応になっていない: ${method} ${p}`)
  }
})

test('normalizeApiPath はクエリ・ハッシュ・末尾スラッシュ・連続スラッシュを畳む', () => {
  assert.equal(normalizeApiPath('/api/boards/mobile/tasks/?limit=60#x'), '/api/boards/mobile/tasks')
  assert.equal(normalizeApiPath('api//review//'), '/api/review')
  assert.equal(normalizeApiPath('  /api/overview  '), '/api/overview')
  assert.equal(normalizeApiPath(''), '')
  assert.equal(normalizeApiPath('/'), '/')
})

test('matchApiRoute は静的セグメント優先で当たり、メソッド違い・未登録は null', () => {
  // 静的（library/file）が :id 系より優先される
  assert.equal(matchApiRoute('GET', '/api/review/library/file?path=a.png').pattern, '/api/review/library/file')
  assert.equal(matchApiRoute('GET', '/api/review/t_1/data').pattern, '/api/review/:id/data')
  assert.deepEqual(matchApiRoute('GET', '/api/boards/mobile/tasks/t_9/diff').params, { board: 'mobile', id: 't_9' })
  // サムネイルは残り全部のワイルドカード
  const thumb = matchApiRoute('GET', '/api/review/t_1/thumb/opt/A.png')
  assert.equal(thumb.pattern, '/api/review/:id/thumb/*')
  assert.equal(thumb.params.rest, 'opt/A.png')
  // メソッドが違えば当たらない（POST 専用の answer）
  assert.equal(matchApiRoute('GET', '/api/review/t_1/answer'), null)
  assert.equal(matchApiRoute('POST', '/api/review/t_1/answer').pattern, '/api/review/:id/answer')
  // 未登録・/api 外
  assert.equal(matchApiRoute('GET', '/api/unknown/thing'), null)
  assert.equal(matchApiRoute('GET', '/auth/pairing'), null)
  // パターン→正規表現（名前付きセグメントが取れる）
  const { re } = apiPatternToRegExp('/api/sessions/:id/transcript')
  assert.equal(re.test('/api/sessions/abc/transcript'), true)
  assert.equal(re.test('/api/sessions/abc/transcript/x'), false)
})

test('Web が呼ぶ /api/* はすべて契約に載っていて、廃止ルートを呼ばない', () => {
  const paths = collectWebApiPaths(WEB_SRC_DIR)
  assert.equal(paths.size >= 54, true, `Web 側の /api/* が少なすぎる（54+ 系統）: ${paths.size}`)
  const missing = []
  const deprecated = []
  for (const [lit, files] of paths) {
    // テンプレート変数を代表値へ寄せてから照合する
    const concrete = lit.replace(/:v/g, 't_demo_review')
    const hit = matchApiRoute('GET', concrete) ?? matchApiRoute('POST', concrete) ?? matchApiRoute('PUT', concrete)
      ?? matchApiRoute('PATCH', concrete) ?? matchApiRoute('DELETE', concrete)
    if (!hit) {
      missing.push(`${lit} (${files.join(', ')})`)
      continue
    }
    if (hit.demo === 'deprecated') deprecated.push(`${lit} (${files.join(', ')})`)
  }
  assert.deepEqual(missing, [], `API_ROUTES に無い呼び出し:\n${missing.join('\n')}`)
  assert.deepEqual(deprecated, [], `廃止ルートを呼んでいる:\n${deprecated.join('\n')}`)
  // 代表的な呼び出しが拾えていること（走査が空振りしていない確認）
  assert.equal(paths.has('/api/overview'), true)
  assert.equal(paths.has('/api/review/:v/answer'), true)
})

test('デモの mockApi は mocked の全ルートを明示ハンドラで答える（fallback に逃がさない）', async () => {
  const misses = []
  for (const route of listApiRoutes('mocked')) {
    const p = samplePath(route.pattern)
    const resolved = demoRoute(p)
    if (GENERIC_DEMO_NAMES.has(resolved.name)) misses.push(`${route.method} ${route.pattern} → ${resolved.name}`)
  }
  assert.deepEqual(misses, [], `デモが答えていないルート:\n${misses.join('\n')}`)

  // COH-2 の 2 系統は状態も見る（overview と連動していること）
  const paused = await (await import('../../web/src/demo/mockApi.js')).demoFetch('/api/gateway/pause', {
    method: 'POST',
    body: { confirm: 'PAUSE', reason: 'demo-check' },
  })
  assert.equal(paused.ok, true)
  assert.equal(paused.state.engaged, true)
  assert.equal(paused.state.reason, 'demo-check')
  const overview = await (await import('../../web/src/demo/mockApi.js')).demoFetch('/api/overview')
  assert.equal(overview.paused.engaged, true, 'overview の paused が連動していない')
  const resumed = await (await import('../../web/src/demo/mockApi.js')).demoFetch('/api/gateway/resume', {
    method: 'POST',
    body: { confirm: 'RESUME' },
  })
  assert.equal(resumed.state.engaged, false)
  const after = await (await import('../../web/src/demo/mockApi.js')).demoFetch('/api/overview')
  assert.equal(after.paused.engaged, false)

  const dc = await (await import('../../web/src/demo/mockApi.js')).demoFetch('/api/discord/session?session_id=x')
  assert.equal(dc.found, false)
  assert.equal(dc.demo, true)
})

test('server.js は契約の全ルートを受け、handleApi の第 1 セグメントに漏れがない', () => {
  // 1) 契約 → server.js: 各パターンの静的セグメントが分岐として存在する
  const missing = []
  for (const r of API_ROUTES) {
    if (r.method === 'WS') continue // `/api/ws` はアップグレードで受ける（下で個別に見る）
    const segs = normalizeApiPath(r.pattern).split('/').filter((s) => s && !s.startsWith(':') && s !== '*')
    for (const seg of segs.slice(1)) {
      // 第 1 セグメントは `a === 'x'`、以降は `b === 'x'` などの分岐として現れる。
      // handleApi の外で受ける 2 系統（`/api/auth/login`, `/api/ws`）はフルパスで照合する。
      const asToken = new RegExp(`=== '${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`)
      const asPath = SERVER_SRC.includes(`'${normalizeApiPath(r.pattern)}'`)
      if (!asToken.test(SERVER_SRC) && !asPath) missing.push(`${r.method} ${r.pattern} → '${seg}'`)
    }
  }
  assert.deepEqual(missing, [], `server.js に分岐が無いセグメント:\n${missing.join('\n')}`)
  assert.match(SERVER_SRC, /'\/api\/ws'/, 'WebSocket の受け口が無い')

  // 2) server.js → 契約: `a === 'x'` の第 1 セグメントはすべて表に載っている
  const firstSegs = serverFirstSegments()
  assert.equal(firstSegs.size >= 20, true, `handleApi の分岐が少なすぎる: ${firstSegs.size}`)
  const unmapped = []
  for (const seg of firstSegs) {
    const covered = API_ROUTES.some((r) => normalizeApiPath(r.pattern).split('/')[2] === seg)
    if (!covered) unmapped.push(seg)
  }
  assert.deepEqual(unmapped, [], `契約に無い第 1 セグメント: ${unmapped.join(', ')}`)

  // 3) 廃止ルートは server.js が今も受ける（配信済み dist の端末を切らない）
  assert.match(SERVER_SRC, /b === 'from-image'/)
})

test('D92: ゴミ整理の 2 ルート（一括アーカイブ・SPEC 退避）はデモも答える', () => {
  const bulk = matchApiRoute('POST', '/api/boards/mobile/tasks/bulk-archive')
  assert.notEqual(bulk, null, 'bulk-archive が契約に無い')
  assert.equal(bulk.demo, 'mocked')
  assert.deepEqual(bulk.params, { board: 'mobile' })
  const archive = matchApiRoute('POST', '/api/specs/archive')
  assert.notEqual(archive, null, 'specs/archive が契約に無い')
  assert.equal(archive.demo, 'mocked')
  // 既存の詳細ルートを食っていない（静的セグメント優先）
  assert.equal(matchApiRoute('GET', '/api/boards/mobile/tasks/t_9').pattern, '/api/boards/:board/tasks/:id')
})

test('D85: 行動契約とパイプライン提案文に検証コマンドの決め打ちが無い', () => {
  const contracts = Object.entries(MODE_CONTRACTS)
    .map(([mode, lines]) => `[${mode}]\n${lines.join('\n')}`)
    .join('\n')
  assert.equal(findHardcodedVerification(contracts).ok, true,
    `MODE_CONTRACTS に決め打ち: ${findHardcodedVerification(contracts).hits.join(', ')}`)
  assert.equal(findHardcodedVerification(A2B_RULES).ok, true,
    `A2B_RULES に決め打ち: ${findHardcodedVerification(A2B_RULES).hits.join(', ')}`)
  // 委譲先が文面に現れている（抽象化が「何も言わない」になっていない）
  assert.match(contracts, /the target repository declares/)
  assert.match(A2B_RULES, /the target repository/)
})
