/**
 * デモの「埋め込み（single-file / srcdoc / iframe）」まわりのテスト。
 * `demoMode.test.js` の後半を分割したもの（対象は `apps/web/src/demo/frame.js` と
 * `scripts/build-demo-embed.mjs`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { demoFetch, demoState, resetDemoState } from '../src/demo/mockApi.js'
import {
  DEMO_SPEC_PATH,
  DEMO_SPEC_V4_PATH,
  DEMO_SPEC_V5_PATH,
  advanceArchitectJob,
  createDemoState,
  demoArchitectJobs,
  demoImageFor,
  demoJobPhase,
  demoRoute,
  demoSocket,
  demoSpecContent,
  demoSpects,
  emptyProgress,
  initialReviewItems,
  mockShotDataUrl,
  mockShotSvg,
  setDemoTick,
  snapshot,
  stepIndex,
} from '../src/demo/mockApi.js'
import {
  FRAME_ATTR,
  FRAME_FLAG,
  FRAME_QUERY,
  buildEmbeddedFrameSrcDoc,
  createMemoryStorage,
  frameUrl,
  installSafeStorage,
  isEmbeddedSession,
  isFrameSession,
  safeStorage,
} from '../src/demo/frame.js'
import { EMBED_BOOTSTRAP, inlineAssets, verifyEmbedHtml } from '../../../scripts/build-demo-embed.mjs'
import { DEMO_BUILTIN, DEMO_SNIPPETS } from '../src/demo/snippets.js'
import { listSnippets } from '../../bridge/src/snippets.js'

const here = import.meta.dirname
const SRC = path.join(here, '..', 'src')

test('埋め込み判定: srcdoc / sandbox では iframe を張らない', () => {
  assert.equal(isEmbeddedSession({ __HM_DEMO_EMBED__: true }), true)
  assert.equal(isEmbeddedSession({ location: { href: 'about:srcdoc', protocol: 'about:' } }), true)
  assert.equal(isEmbeddedSession({ location: { href: 'blob:https://x/1', protocol: 'blob:' } }), true)
  assert.equal(isEmbeddedSession({ location: { href: 'https://example.com/demo/', protocol: 'https:' } }), false)
  assert.equal(isEmbeddedSession(null), false)

  assert.equal(frameUrl('https://example.com/demo/', true), null, '埋め込みでは相対 URL を作らない')
  assert.ok(String(frameUrl('https://example.com/demo/', false)).endsWith('?demo-frame=1'))
})

test('保存領域: 例外を投げる localStorage をメモリ実装に差し替える', () => {
  const throwing = {
    get localStorage() {
      throw new Error('SecurityError')
    },
    get sessionStorage() {
      throw new Error('SecurityError')
    },
  }
  assert.equal(installSafeStorage(throwing), true)
  throwing.localStorage.setItem('k', 'v')
  assert.equal(throwing.localStorage.getItem('k'), 'v')
  assert.equal(throwing.localStorage.length, 1)
  throwing.localStorage.removeItem('k')
  assert.equal(throwing.localStorage.getItem('k'), null)

  const mem = createMemoryStorage()
  mem.setItem('a', 1)
  assert.equal(mem.getItem('a'), '1')
  assert.equal(mem.key(0), 'a')
  mem.clear()
  assert.equal(mem.length, 0)
  assert.equal(safeStorage('localStorage', throwing), throwing.localStorage)
})

test('単一ファイル埋め込み: CSS/JS をインライン化し外部参照を残さない', () => {
  const files = {
    './assets/index-abc.js': 'console.log("hi"); const s = "</script>";',
    './assets/index-abc.css': '.a{color:red}',
  }
  const indexHtml = `<!doctype html><html lang="ja"><head><meta charset="UTF-8" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" href="./icon-v5.svg" />
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css" />
    <title>Hermes Mobile</title></head><body><div id="root"></div>
    <script type="module" crossorigin src="./assets/index-abc.js"></script></body></html>`

  const { html, inlined } = inlineAssets(indexHtml, (rel) => {
    if (!(rel in files)) throw new Error(`missing ${rel}`)
    return files[rel]
  })

  assert.deepEqual(inlined.sort(), ['./assets/index-abc.css', './assets/index-abc.js'])
  assert.ok(html.includes('<style>.a{color:red}</style>'))
  assert.ok(html.includes('<script type="module">'))
  assert.ok(html.includes('console.log("hi")'))
  assert.ok(html.includes('<\\/script>'), 'スクリプト内の </script> を退避している')
  assert.equal(html.includes('manifest.webmanifest'), false, 'manifest は落とす（404 回避）')
  assert.equal(html.includes('icon-v5.svg'), false, 'アイコンは落とす')
  assert.ok(html.indexOf(EMBED_BOOTSTRAP) < html.indexOf('<script type="module">'), '保存領域の安全化が先')
  assert.equal(EMBED_BOOTSTRAP.includes('__HM_DEMO_EMBED__'), true)
  assert.deepEqual(verifyEmbedHtml(html), [])

  // 取りこぼしを検出できること（検査関数が空振りしない）
  assert.notDeepEqual(verifyEmbedHtml('<script src="./x.js"></script>'), [])
  assert.notDeepEqual(verifyEmbedHtml('<style>.a{background:url(./font.woff2)}</style>'), [])
})

test('npm run build:demo は埋め込みビルドを含む（package.json と実ファイル）', () => {
  const pkgPath = path.join(here, '..', '..', '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.match(pkg.scripts['build:demo'], /scripts\/build-demo-embed\.mjs/)
  assert.equal(fs.existsSync(path.join(here, '..', '..', '..', 'scripts', 'build-demo-embed.mjs')), true)
})

test('筐体判定: ?demo-frame=1 と <html data-hm-frame> の両方を見る', () => {
  assert.equal(FRAME_QUERY, 'demo-frame')
  assert.equal(FRAME_ATTR, 'data-hm-frame')
  assert.equal(FRAME_FLAG, '__HM_DEMO_FRAME__')
  // 静的サイト（URL モード）
  assert.equal(isFrameSession({ location: { search: '?demo-frame=1' } }), true)
  assert.equal(isFrameSession({ location: { search: '?a=1&demo-frame=1&b=2' } }), true)
  assert.equal(isFrameSession({ location: { search: '?demo-frame=0' } }), false)
  assert.equal(isFrameSession({ location: { search: '?demo-frame' } }), false)
  assert.equal(isFrameSession({ location: { search: '' } }), false)

  // 埋め込み（srcdoc）: 親が <html> に付ける目印属性
  const withRoot = (attr) => ({
    document: { documentElement: { getAttribute: (name) => (name === FRAME_ATTR ? attr : null) } },
    location: { search: '' },
  })
  assert.equal(isFrameSession(withRoot('1')), true)
  assert.equal(isFrameSession(withRoot(null)), false)
  // 明示フラグ（テスト・手動起動用）
  assert.equal(isFrameSession({ [FRAME_FLAG]: true, location: { search: '' } }), true)

  // 壊れた window でも落ちない
  assert.equal(isFrameSession(null), false)
  assert.equal(
    isFrameSession({
      get location() {
        throw new Error('SecurityError')
      },
    }),
    false,
  )
})

test('埋め込み筐体: 初期 HTML を srcDoc に複製し <html> に目印を 1 回だけ付ける', () => {
  const base =
    '<!doctype html><html lang="ja"><head><meta charset="UTF-8" /><title>Hermes Mobile</title></head>' +
    '<body><div id="root"></div><script type="module">console.log("hi")</script></body></html>'
  const doc = buildEmbeddedFrameSrcDoc(base)
  assert.equal((doc.match(/data-hm-frame="1"/g) ?? []).length, 1, '目印は 1 回だけ')
  assert.ok(doc.includes('<html lang="ja" data-hm-frame="1">'), '既存の属性を壊さず足す')
  assert.ok(doc.indexOf('data-hm-frame') < doc.indexOf('<head>'), '目印は html 要素（描画より前）')
  assert.ok(doc.includes('<div id="root"></div>'), '本文はそのまま残る')
  assert.ok(doc.includes('console.log("hi")'), 'スクリプトもそのまま残る')
  assert.equal(doc.startsWith('<!doctype html>'), true, 'doctype を保つ（srcdoc の quirks mode 回避）')

  // 冪等: 2 回通しても増えない（既に目印がある HTML はそのまま返す）
  assert.equal(buildEmbeddedFrameSrcDoc(doc), doc)
  assert.equal(buildEmbeddedFrameSrcDoc(buildEmbeddedFrameSrcDoc(base)), doc)

  // 属性なしの <html> でも壊れない
  assert.ok(buildEmbeddedFrameSrcDoc('<html><body>x</body></html>').startsWith('<html data-hm-frame="1">'))

  // 複製できない入力は空（呼び出し側は筐体を出さず全画面にフォールバックする）
  assert.equal(buildEmbeddedFrameSrcDoc(''), '')
  assert.equal(buildEmbeddedFrameSrcDoc(undefined), '')
  assert.equal(buildEmbeddedFrameSrcDoc('   \n '), '')
  assert.equal(buildEmbeddedFrameSrcDoc('<div id="root"></div>'), '', '<html> の無い断片は複製しない')
})

test('埋め込み筐体: バンドル内の目印文字列に釣られない（実測で踏んだ誤判定の回帰）', () => {
  // 複製元の HTML にはアプリのバンドルが入っており、そこには定数名がそのまま現れる。
  // 文字列一致で「もう目印が入っている」と判断すると何も注入できず、子が筐体を再帰的に描いてしまう。
  const bundle = '<script type="module">const F="__HM_DEMO_FRAME__";const A="data-hm-frame";</script>'
  const base = `<!doctype html><html lang="ja"><head></head><body><div id="root"></div>${bundle}</body></html>`
  const doc = buildEmbeddedFrameSrcDoc(base)
  assert.ok(doc.includes('<html lang="ja" data-hm-frame="1">'), 'バンドルに定数名があっても html に目印を付ける')
  assert.equal(buildEmbeddedFrameSrcDoc(doc), doc, '付けたあとは足さない')
})

test('埋め込み筐体: 複製した srcDoc も外部参照ゼロのまま（Google Sites で 404 を出さない）', () => {
  const files = {
    './assets/index-abc.js': 'console.log("hi"); const s = "</script>";',
    './assets/index-abc.css': '.a{color:red}',
  }
  const indexHtml = `<!doctype html><html lang="ja"><head><meta charset="UTF-8" />
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css" />
    <title>Hermes Mobile</title></head><body><div id="root"></div>
    <script type="module" crossorigin src="./assets/index-abc.js"></script></body></html>`
  const { html } = inlineAssets(indexHtml, (rel) => files[rel])
  const srcDoc = buildEmbeddedFrameSrcDoc(html)

  assert.deepEqual(verifyEmbedHtml(srcDoc), [], '複製しても外部参照が増えない')
  assert.equal((srcDoc.match(/data-hm-frame="1"/g) ?? []).length, 1)
  assert.ok(srcDoc.indexOf('data-hm-frame') < srcDoc.indexOf('<script type="module">'), '目印がアプリより先')
  // 元のブートストラップ（保存領域の安全化）も複製に残る = 子フレームでも localStorage で落ちない
  assert.ok(srcDoc.includes(EMBED_BOOTSTRAP), '安全化スクリプトを維持している')
})

test('通常ビルドにデモが混ざらない: main.jsx は demo/ を静的 import しない', () => {
  const mainSrc = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8')
  assert.equal(/^\s*import\s+[^\n]*from\s+['"]\.\/demo\//m.test(mainSrc), false, 'static import がある')
  assert.equal(/^\s*import\s+['"]\.\/demo\//m.test(mainSrc), false, '副作用 import がある')
  // 退避・筐体判定は if (DEMO) の中でだけ行う（本番ビルドでは丸ごと消える）
  const demoBlock = mainSrc.slice(mainSrc.indexOf('if (DEMO) {'))
  assert.ok(demoBlock.length > 0, 'if (DEMO) ブロックがある')
  assert.ok(demoBlock.includes('__HM_INITIAL_HTML__'), '初期 HTML の退避はデモ分岐の中')
  assert.ok(demoBlock.includes('isFrameSession'), '筐体判定はデモ分岐の中')
  assert.ok(demoBlock.includes("import('./demo/frame.js')"), 'demo/frame.js は動的 import')
  assert.equal(mainSrc.indexOf('__HM_INITIAL_HTML__') > mainSrc.indexOf('if (DEMO) {'), true)

  // demo/ 以外の src から demo/ を静的 import している人が居ないこと
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'demo' && entry.name !== 'node_modules') walk(full)
        continue
      }
      if (!/\.(js|jsx|mjs)$/.test(entry.name)) continue
      const src = fs.readFileSync(full, 'utf8')
      if (/^\s*import\s+[^\n]*from\s+['"][^'"]*demo\//m.test(src)) offenders.push(path.relative(SRC, full))
    }
  }
  walk(SRC)
  assert.deepEqual(offenders, [], 'demo/ を静的 import しているファイルがある')
})


/* ------------------------------------------------------------------ *
 * V10-B3（SPEC-PILOT-V10 §3.3 / D47）: モック API・WS の V3〜V9 完全パリティ
 * ------------------------------------------------------------------ */

test('V10-B3: demoRoute は V3〜V9 の未対応エンドポイントを本番と同じ名前で拾う', () => {
  assert.equal(demoRoute('/api/snippets?lang=ja').kind, 'chat')
  const term = demoRoute('/api/snippets/term?lang=ja')
  assert.equal(term.name, 'snippets')
  assert.equal(term.kind, 'term')

  assert.equal(demoRoute('/api/pipeline/status').name, 'pipeline.status')
  assert.equal(demoRoute('/api/pipeline/optimize').name, 'pipeline.optimize')
  assert.equal(demoRoute('/api/auth/pairing').name, 'auth.pairing')
  assert.equal(demoRoute('/api/logs?file=gateway&lines=200').name, 'logs')
  assert.equal(demoRoute('/api/logs?file=gateway&lines=200').params.get('file'), 'gateway')
  const search = demoRoute('/api/search?q=redline&limit=30')
  assert.equal(search.name, 'search')
  assert.equal(search.params.get('q'), 'redline')
  // 既存の catch-all（ログイン・セッション等）は壊さない
  assert.equal(demoRoute('/api/auth/session').name, 'auth')
  assert.equal(demoRoute('/api/gateway/restart').name, 'gateway')
  // D90: 全タスク緊急停止（本番と同じ 1 本。`gateway` の catch-all に落とさない）
  assert.equal(demoRoute('/api/emergency/stop-all').name, 'emergency.stopAll')
})

test('D90: デモの全タスク緊急停止は confirm を検証し、ESTOP と実行中を止める', async () => {
  resetDemoState()
  // 実行中タスクを 1 件足す（本番の `status === 'running'` と同じ判定）
  demoState().tasks.push({
    id: 't_demo_running',
    board: 'mobile',
    title: '[DEMO] running task',
    status: 'running',
    assignee: 'mobile',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    priority: 0,
  })

  // confirm 不一致は本番と同じ `CONFIRM_MISMATCH`（HTTP 400 相当）を返し、状態を変えない
  const bad = await demoFetch('/api/emergency/stop-all', { method: 'POST', body: { confirm: 'nope' } })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'CONFIRM_MISMATCH')
  assert.equal(demoState().demoOps.paused.engaged, false)
  assert.equal(demoState().tasks.find((t) => t.id === 't_demo_running').status, 'running')

  // 正常系: ESTOP が作動し、実行中が止まり、残り 0 件
  const ok = await demoFetch('/api/emergency/stop-all', {
    method: 'POST',
    body: { confirm: 'STOP_ALL', reason: 'demo check' },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.paused.engaged, true)
  assert.equal(ok.paused.reason, 'demo check')
  assert.equal(ok.aborted, 1)
  assert.deepEqual(ok.abortedTasks, [{ board: 'mobile', id: 't_demo_running' }])
  assert.deepEqual(ok.failed, [])
  assert.equal(ok.remainingRunning, 0)
  assert.equal(demoState().tasks.find((t) => t.id === 't_demo_running').status, 'blocked')

  // `/api/overview` の paused とタスク一覧に連動する（停止バナーが出る）
  const ov = await demoFetch('/api/overview')
  assert.equal(ov.paused.engaged, true)
  const board = await demoFetch('/api/boards/mobile/tasks')
  assert.equal(board.paused.engaged, true)
  assert.equal(board.tasks.filter((t) => t.status === 'running').length, 0)
})

test('V10-B3: /api/usage は UsageSheet が読む totals / models / topSessions を返す', async () => {
  resetDemoState()
  const d = await demoFetch('/api/usage')
  assert.equal(d.ok, true, 'ok が無いとシートが「失敗」表示になる')
  assert.equal(d.hours, 24)
  assert.equal(d.cacheHitRate, 0.994)
  assert.deepEqual(Object.keys(d.totals).sort(), [
    'cacheRead',
    'calls',
    'cost',
    'input',
    'messages',
    'output',
    'sessions',
    'tools',
  ])
  assert.equal(d.totals.cost, 1.08)
  assert.equal(d.totals.sessions, 4)
  assert.ok(d.totals.input > d.totals.output, '入力を出力より多く見せる（キャッシュ前提）')

  assert.equal(d.models.length, 2)
  for (const m of d.models) {
    assert.equal(typeof m.model, 'string')
    for (const k of ['calls', 'input', 'output', 'cacheRead', 'cost']) {
      assert.equal(typeof m[k], 'number', `models[].${k}`)
    }
  }
  assert.equal(d.topSessions.length, 2)
  for (const s of d.topSessions) {
    for (const k of ['id', 'profile', 'title', 'source', 'input', 'output', 'at', 'cost']) {
      assert.ok(s[k] !== undefined && s[k] !== null, `topSessions[].${k}`)
    }
    assert.ok(s.at <= Date.now(), 'at は過去（relTime が「未来」と言わない）')
  }
  // 期間は URL に従う（本番 `/api/usage?hours=`）
  const d3 = await demoFetch('/api/usage?hours=72')
  assert.equal(d3.hours, 72)
})

test('V10-B3: /api/live は counts{turns,tasks,architect} と整形済みの tasks / turns を返す', async () => {
  resetDemoState()
  setDemoTick(50)
  const idle = await demoFetch('/api/live')
  assert.equal(idle.ok, true, 'ok が無いと LiveSheet が「失敗」表示になる')
  assert.deepEqual(Object.keys(idle.counts).sort(), ['architect', 'tasks', 'turns'])
  assert.deepEqual(idle.tasks, [])
  assert.deepEqual(idle.turns, [])
  assert.equal(idle.counts.architect, 0, 'awaiting_review は ⚡ 実行中に数えない（判断待ちの担当）')
  assert.equal(idle.architect.length, 1, '一覧には review 待ちのジョブが載る')

  // Hermes Native の Seed は実行中タスクを 1 件立てる → LiveSheet の 2 列目とターンが点灯する
  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Live parity', runner: 'hermes', autoStart: false, lang: 'en' },
  })
  const live = await demoFetch('/api/live')
  assert.equal(live.tasks.length, 1)
  const task = live.tasks[0]
  assert.equal(task.id, `t_demo_arch_${String(seed.jobId).replace(/[^0-9]/g, '')}`)
  assert.equal(task.board, 'mobile')
  assert.equal(task.boardName, 'mobile')
  assert.equal(task.assignee, 'architect')
  assert.equal(typeof task.workerPid, 'number')
  assert.ok(task.elapsedSec >= 0)
  assert.equal(live.turns.length, 1)
  assert.equal(live.turns[0].sessionId, 'demo-a2b-01')
  assert.equal(live.turns[0].platform, 'pwa')
  assert.ok(live.turns[0].lastTool.name)
  assert.equal(live.counts.tasks, 1)
  assert.equal(live.counts.turns, 1)
  assert.equal(live.counts.architect, 1, 'running の Seed は ⚡ 実行中に数える')

  // 仕上げると実行中タスクもターンも空になる（LiveSheet が「なし」を出す）
  const jobId = seed.jobId
  advanceArchitectJob(jobId)
  advanceArchitectJob(jobId)
  advanceArchitectJob(jobId)
  const done = await demoFetch('/api/live')
  assert.deepEqual(done.tasks, [])
  assert.deepEqual(done.turns, [])
  assert.equal(done.counts.architect, 0)
  await new Promise((resolve) => setTimeout(resolve, 80))
})

test('V10-B3: /api/snippets/term は端末チップ帯の形（本番 snippetPayload と同一構造）を返す', async () => {
  resetDemoState()
  const ja = await demoFetch('/api/snippets/term?lang=ja')
  assert.deepEqual(Object.keys(ja).sort(), [
    'allSnippets',
    'custom',
    'customMax',
    'hotLimit',
    'lang',
    'overrides',
    'snippets',
  ])
  assert.equal(ja.lang, 'ja')
  assert.equal(ja.snippets.length, 15, '本番の汎用端末スニペット 15 件と同じ数')
  assert.equal(ja.snippets.filter((s) => s.hot).length, 6, 'Hot は 6 件（チップ帯の幅に収まる数）')
  for (const s of ja.snippets) {
    for (const k of ['id', 'label', 'text', 'hot', 'run', 'note']) {
      assert.ok(s[k] !== undefined, `snippets[].${k}`)
    }
    assert.equal(typeof s.text, 'string')
    assert.equal(/[^\x00-\x7F]/.test(s.text), false, 'コマンド文字列は ASCII のみ（本番と同じ約束）')
  }
  // 長押し実行できるものだけ run: true（破壊的なものは載せない）
  assert.equal(ja.snippets.every((s) => s.run === true), true)
  assert.ok(ja.snippets.some((s) => s.label === 'Pilot状態'))
  const en = await demoFetch('/api/snippets/term?lang=en')
  assert.ok(en.snippets[0].id === 't-hermes-status' && en.snippets[0].label === 'Hermes Status' && !en.snippets.find((s) => s.id === 't-pilot-restart').hot)
  assert.notEqual(en.snippets[0].label, ja.snippets[0].label, 'JA/EN が切り替わる')
  // チャット側の帯は壊さない
  const chat = await demoFetch('/api/snippets?lang=ja')
  assert.equal(chat.snippets[0].id, 'spec-seed')
})

test('V10-B3: pipeline.status → optimize で SOUL 適用＋3 スキルが揃う', async () => {
  resetDemoState()
  const before = await demoFetch('/api/pipeline/status')
  assert.equal(before.ok, true)
  assert.equal(before.pilotProfile, 'mobile')
  assert.deepEqual(before.availableProfiles, ['mobile', 'default'])
  assert.equal(before.soul.applied, false)
  assert.deepEqual(before.hermes.present, ['quick-review', 'annotation'])
  assert.deepEqual(before.bundled.names, ['quick-review', 'annotation', 'spec-architect'])

  const switched = await demoFetch('/api/pipeline/profile', { method: 'POST', body: { profile: 'default' } })
  assert.equal(switched.ok, true)
  assert.equal(switched.pilotProfile, 'default')
  assert.equal(switched.status.pilotProfile, 'default')

  const back = await demoFetch('/api/pipeline/profile', { method: 'POST', body: { profile: 'mobile' } })
  assert.equal(back.pilotProfile, 'mobile')

  const applied = await demoFetch('/api/pipeline/optimize', { method: 'POST', body: {} })
  assert.equal(applied.ok, true)
  assert.equal(applied.status.soul.applied, true)
  assert.deepEqual(applied.status.hermes.present, ['quick-review', 'annotation', 'spec-architect'])
  assert.equal(applied.status.hermes.present.length, 3)

  // 自己申告ではなく「読み直し」で適用済みが返る（本番 PipelinePanel と同じ確認経路）
  const after = await demoFetch('/api/pipeline/status')
  assert.equal(after.soul.applied, true)
  assert.equal(after.hermes.present.length, 3)

  // ツアーをやり直すと未適用へ戻る
  resetDemoState()
  const reset = await demoFetch('/api/pipeline/status')
  assert.equal(reset.soul.applied, false)
  assert.equal(reset.pilotProfile, 'mobile')
})

test('V10-B3: /api/auth/pairing は 21×21 の qrRows と targets を返す', async () => {
  resetDemoState()
  const d = await demoFetch('/api/auth/pairing')
  assert.equal(d.ok, true)
  assert.equal(d.qrRows.length, 21)
  for (const row of d.qrRows) {
    assert.equal(row.length, 21, '正方（21 列）')
    assert.equal(/^[01]+$/.test(row), true, "'0'/ '1' だけ")
  }
  // 3 隅のファインダーパターン（7x7 の枠＋中心 3x3）
  assert.equal(d.qrRows[0].slice(0, 7), '1111111')
  assert.equal(d.qrRows[0].slice(-7), '1111111')
  assert.equal(d.qrRows[20].slice(0, 7), '1111111')
  assert.equal(d.qrRows[1].slice(0, 7), '1000001')
  assert.equal(d.qrRows[3].slice(0, 7), '1011101')
  assert.equal(d.qrMargin, 4)
  assert.equal(d.targets.length, 2)
  assert.deepEqual(
    d.targets.map((t) => t.kind),
    ['tailscale', 'lan'],
  )
  for (const t of d.targets) {
    assert.ok(t.label)
    assert.match(t.url, /^https?:\/\//)
    assert.match(t.url, /token=demo-only/)
  }
  assert.equal(d.tailscale, true)
  assert.equal(d.dnsName, 'demo.tailnet.ts.net')
  assert.ok(d.expiresAt > Date.now(), '有効期限が未来（画面が「あと何分」を出せる）')
})

test('V10-B3: /api/logs と /api/search は SettingsPane / SearchSheet の形を返す', async () => {
  resetDemoState()
  const log = await demoFetch('/api/logs?file=gateway&lines=200')
  assert.equal(log.ok, true)
  assert.equal(log.file, 'gateway')
  assert.equal(typeof log.text, 'string')
  assert.ok(log.text.split('\n').length >= 3, '数行は返す（空欄だと原因が分からない）')

  const hit = await demoFetch('/api/search?q=redline&limit=30')
  assert.equal(hit.ok, true)
  assert.equal(typeof hit.tookMs, 'number')
  assert.equal(hit.hits.length, 1, 'q で絞る')
  for (const k of ['profile', 'messageId', 'sessionId', 'snippet', 'role', 'at', 'sessionTitle', 'source']) {
    assert.ok(hit.hits[0][k] !== undefined, `hits[].${k}`)
  }
  assert.match(hit.hits[0].snippet, /redline/)
  const none = await demoFetch('/api/search?q=zzzz-nothing')
  assert.deepEqual(none.hits, [])
  const blank = await demoFetch('/api/search?q=')
  assert.deepEqual(blank.hits, [], '空クエリは 0 件（本番は 400 を返すが、デモは空で返す）')
})

test('V11-B3: Hermes Native の Seed は常に [ARCH] タスクを立てる（D51）', async () => {
  resetDemoState()
  setDemoTick(50)
  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Native parity', autoStart: false, lang: 'en' },
  })
  const jobs = await demoFetch('/api/architect/jobs?board=mobile')
  const job = jobs.jobs.find((j) => j.id === seed.jobId)
  assert.ok(job)
  assert.equal(job.runner, 'hermes')
  assert.equal(job.runnerLabel, 'Hermes Native')
  assert.equal(typeof job.taskId, 'string', 'Hermes Native はカンバンタスクを作る')

  const board = await demoFetch('/api/boards/mobile/tasks')
  const arch = board.tasks.find((t) => t.id === job.taskId)
  assert.ok(arch, '実行中タスクとして一覧に出る')
  assert.equal(arch.status, 'running')
  assert.equal(arch.assignee, 'architect')
  assert.match(arch.title, /^\[ARCH\] Native parity/)

  // ランナーを偽って送っても Hermes Native のまま（切り替えの口はもう無い）
  const forged = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Forced runner', runner: 'hermes', autoStart: false, lang: 'en' },
  })
  const jobs2 = await demoFetch('/api/architect/jobs?board=mobile')
  const job2 = jobs2.jobs.find((j) => j.id === forged.jobId)
  assert.equal(job2.runner, 'hermes')
  assert.equal(typeof job2.taskId, 'string')
  await new Promise((resolve) => setTimeout(resolve, 80))
})

test('V10-B3: Architect Seed は round1_sheet → round2_spec → spec_ready と段階で進む', async () => {
  resetDemoState()
  setDemoTick(50)
  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Stage walk', runner: 'hermes', autoStart: false, lang: 'en' },
  })
  const read = async () => {
    const list = await demoFetch('/api/architect/jobs?board=mobile')
    return list.jobs.find((j) => j.id === seed.jobId)
  }
  let job = await read()
  assert.equal(job.status, 'running')
  assert.equal(job.phase, 'spawning')
  assert.equal(job.sheetPath, null)

  // 段 1: 設問シートができる（Round 1）
  job = advanceArchitectJob(seed.jobId)
  assert.equal(job.status, 'awaiting_spec')
  assert.match(job.sheetPath, /^sheets\/spec-demo-seed-\d+-1\.json$/)
  assert.equal(demoJobPhase(job), 'round1_sheet')

  // 段 2: 回答を受けて SPEC を書き始める（Round 2・FS に残る）
  job = advanceArchitectJob(seed.jobId)
  assert.equal(job.status, 'awaiting_spec')
  assert.equal(job.reviewSeenOnce, true)
  assert.equal(demoJobPhase(job), 'round2_spec')
  assert.ok(demoState().architect.jobs.find((j) => j.id === seed.jobId).sheetPath)

  // 段 3: 仕上げ
  job = advanceArchitectJob(seed.jobId)
  assert.equal(job.status, 'spec_ready')
  assert.equal(demoJobPhase(job), 'spec_ready')
  assert.equal(job.completedSpec.batchCount, 2)

  // [ARCH] タスクも一緒に終わる（実行中のまま居座らない）
  const board = await demoFetch('/api/boards/mobile/tasks')
  assert.equal(board.tasks.find((t) => t.id === job.taskId).status, 'done')
  await new Promise((resolve) => setTimeout(resolve, 80))
})

test('V10-B3: /ws/term の擬似ソケットはバナーと疑似標準出力を返す', async () => {
  const sock = demoSocket('/ws/term')
  const frames = []
  sock.onmessage = (ev) => frames.push(JSON.parse(ev.data))
  const tick = () => new Promise((resolve) => setTimeout(resolve, 12))
  await tick()
  assert.equal(sock.readyState, 1)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].t, 'out')
  assert.match(frames[0].d, /Hermes Pilot Demo Shell \(read-only simulation\)/)
  assert.match(frames[0].d, /\$ $/)

  // 1 文字ずつ来る入力を溜め、改行で 1 コマンドとして実行する
  sock.send(JSON.stringify({ t: 'in', d: 'h' }))
  sock.send(JSON.stringify({ t: 'in', d: 'elp' }))
  await tick()
  assert.equal(frames.length, 1, '改行前は何も返さない（本物の端末と同じ）')
  sock.send(JSON.stringify({ t: 'in', d: '\r' }))
  await tick()
  assert.equal(frames.length, 2)
  assert.match(frames[1].d, /Demo shell commands/)
  assert.match(frames[1].d, /\$ $/)

  sock.send(JSON.stringify({ t: 'in', d: 'hermes gateway status\r' }))
  await tick()
  assert.match(frames[2].d, /gateway: running/)

  sock.send(JSON.stringify({ t: 'in', d: 'nope-command\r' }))
  await tick()
  assert.match(frames[3].d, /command not found: nope-command/)

  // resize は端末フレームを増やさない（本番も PTY のサイズ変更だけ）
  const before = frames.length
  sock.send(JSON.stringify({ t: 'resize', c: 80, r: 24 }))
  await tick()
  assert.equal(frames.length, before)

  sock.close()
  assert.equal(sock.readyState, 3)
})

test('デモの定型スニペットは英語版が用意され、en 側に日本語を含まない', () => {
  // デモの既定言語は en（`?lang=` 省略時）。英語訪問者が日本語のチップを見ないための固定。
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  assert.ok(DEMO_SNIPPETS.en.length >= 7, `en スニペットが少ない: ${DEMO_SNIPPETS.en.length}`)
  assert.equal(DEMO_SNIPPETS.en.length, DEMO_SNIPPETS.ja.length, 'en / ja の件数が揃っていない')
  const bad = DEMO_SNIPPETS.en.filter((s) => CJK.test(`${s.label} ${s.text}`))
  assert.deepEqual(bad.map((s) => s.id), [], 'en のスニペットに日本語が混ざっている')
})

/* ------------------------------------------------------------------ *
 * D92 / RG-3: ゴミ整理（一括アーカイブ・SPEC 退避）のデモ同等動作
 * ------------------------------------------------------------------ */

test('D92: demoRoute は一括アーカイブと SPEC 退避を本番と同じ名前で拾う', () => {
  const bulk = demoRoute('/api/boards/mobile/tasks/bulk-archive')
  assert.equal(bulk.name, 'board.bulkArchive')
  assert.equal(bulk.id, 'mobile')
  assert.equal(demoRoute('/api/specs/archive').name, 'specs.archive')
  // 一覧（`/tasks`）は従来通り（bulk-archive を taskId と誤読しない）
  assert.equal(demoRoute('/api/boards/mobile/tasks').name, 'board.tasks')
})

test('D92: 一括アーカイブは running をスキップし、archivedCount が増える', async () => {
  resetDemoState()
  setDemoTick(50)
  const seeded = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Bulk archive parity', autoStart: false, lang: 'en' },
  })
  const jobs = await demoFetch('/api/architect/jobs?board=mobile')
  const runningTaskId = jobs.jobs.find((j) => j.id === seeded.jobId)?.taskId
  assert.ok(runningTaskId, 'Seed の実行中タスクが要る')

  const before = await demoFetch('/api/boards/mobile/tasks')
  assert.equal(typeof before.archivedCount, 'number')

  const res = await demoFetch('/api/boards/mobile/tasks/bulk-archive', {
    method: 'POST',
    body: { taskIds: [runningTaskId, 't_demo_done', 't_missing'], reason: 'Cleanup' },
  })
  assert.equal(res.ok, true)
  assert.deepEqual(res.skippedRunning, [runningTaskId], '実行中は止めずにスキップ')
  assert.deepEqual(res.archived, ['t_demo_done'])
  assert.deepEqual(res.failed.map((f) => f.id), ['t_missing'])

  const after = await demoFetch('/api/boards/mobile/tasks')
  assert.equal(after.tasks.find((t) => t.id === 't_demo_done').status, 'archived')
  assert.equal(after.tasks.find((t) => t.id === runningTaskId).status, 'running')
  assert.equal(after.archivedCount, before.archivedCount + 1)

  // 既にアーカイブ済みは noop 側（skippedArchived）へ
  const again = await demoFetch('/api/boards/mobile/tasks/bulk-archive', {
    method: 'POST',
    body: { taskIds: ['t_demo_done'] },
  })
  assert.deepEqual(again.archived, [])
  assert.deepEqual(again.skippedArchived, ['t_demo_done'])
  await new Promise((resolve) => setTimeout(resolve, 80))
})

test('D92: SPEC 退避は冪等で、アクティブ一覧からアーカイブ側へ移る', async () => {
  resetDemoState()
  const target = DEMO_SPEC_V4_PATH
  const before = await demoFetch('/api/specs?board=mobile')
  assert.ok(before.specs.some((s) => s.path === target), '前提: アクティブに居る')

  const first = await demoFetch('/api/specs/archive', { method: 'POST', body: { path: target } })
  assert.equal(first.ok, true)
  assert.equal(first.noop, false)
  assert.equal(first.status, 'archived')

  const after = await demoFetch('/api/specs?board=mobile')
  assert.equal(after.specs.some((s) => s.path === target), false, 'アクティブから消える')
  assert.ok(after.archivedSpecs.some((s) => s.path === target), 'アーカイブ側へ移る')

  const content = await demoFetch(`/api/specs/content?path=${encodeURIComponent(target)}`)
  assert.equal(content.archived, true, 'MD プレビューが退避済みと分かる')

  const second = await demoFetch('/api/specs/archive', { method: 'POST', body: { path: target } })
  assert.equal(second.noop, true, '2 回目は冪等')

  const outside = await demoFetch('/api/specs/archive', { method: 'POST', body: { path: '../SPEC-NOPE.md' } })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, 'SPEC_PATH_OUTSIDE', 'リポジトリの外は拒否')

  // アーカイブした SPEC は未起票通知 (`GET /api/architect/jobs` の pending) からも消える
  const jobsAfter = await demoFetch('/api/architect/jobs?board=mobile')
  assert.equal(
    jobsAfter.pending.some((p) => p.path === target),
    false,
    '退避した SPEC が pending に残らない',
  )
  assert.equal(
    jobsAfter.pending.some((p) => p.path.startsWith('docs/SPEC-DEMO-V3')),
    false,
    '最初から archived の過去 SPEC も pending に出さない',
  )
})
