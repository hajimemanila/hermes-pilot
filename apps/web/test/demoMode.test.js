/**
 * インタラクティブデモ（`npm run build:demo`）の自動検証（SPEC-PILOT-V5 §3.4）。
 *
 * 画面を起動しなくても、デモが「4 ステップを完走できる形」であることを固定する:
 * - ステップ判定（純関数）
 * - ルーティング（本物のブリッジと同じパスを拾える）
 * - 4 ステップの状態遷移（承認 -> 起票 -> 検収 -> サマリ/レシート）
 * - 画像（外部ファイルゼロ: SVG -> data URL）
 * - 通常ビルドへの混入防止（`api.js` が `demo/` を import していないこと）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEMO_SPEC_PATH,
  DEMO_SPEC_V4_PATH,
  DEMO_SPEC_V5_PATH,
  createDemoState,
  demoFetch,
  demoImageFor,
  demoRoute,
  demoSocket,
  demoSpecContent,
  demoSpects,
  emptyProgress,

  initialReviewItems,
  mockShotDataUrl,
  mockShotSvg,
  resetDemoState,
  setDemoTick,
  snapshot,
  stepIndex,
} from '../src/demo/mockApi.js'
import {
  createMemoryStorage,
  frameUrl,
  installSafeStorage,
  isEmbeddedSession,
  safeStorage,
} from '../src/demo/frame.js'
import { EMBED_BOOTSTRAP, inlineAssets, verifyEmbedHtml } from '../../../scripts/build-demo-embed.mjs'
import { fitScale } from '../src/demo/stage.js'

const here = import.meta.dirname
const SRC = path.join(here, '..', 'src')

test('stepIndex は 4 段階を進捗から決める', () => {
  assert.equal(stepIndex(emptyProgress()), 1)
  assert.equal(stepIndex({ ...emptyProgress(), review: true }), 2)
  assert.equal(stepIndex({ ...emptyProgress(), review: true, batches: true }), 3)
  assert.equal(stepIndex({ ...emptyProgress(), review: true, batches: true, visual: true }), 4)
  // 前段が未完了なら前段のまま（飛ばして 4 にはならない）
  assert.equal(stepIndex({ ...emptyProgress(), visual: true }), 1)
})

test('demoRoute は本物のブリッジと同じパスを分類する', () => {
  assert.equal(demoRoute('/api/overview').name, 'overview')
  assert.equal(demoRoute('/api/review').name, 'review.list')
  assert.equal(demoRoute('/api/review/feed?limit=20').name, 'review.feed')
  assert.equal(demoRoute('/api/review/t_demo_review/data').name, 'review.data')
  assert.equal(demoRoute('/api/review/t_demo_review/data').id, 't_demo_review')
  assert.equal(demoRoute('/api/review/t_demo_visual/approve').name, 'review.approve')
  assert.equal(demoRoute('/api/boards/mobile/tasks?limit=60').name, 'board.tasks')
  assert.equal(demoRoute('/api/boards/mobile/tasks?limit=60').id, 'mobile')
  assert.equal(demoRoute('/api/specs?board=mobile').name, 'specs')
  assert.equal(demoRoute('/api/specs/launch').name, 'specs.launch')
  assert.equal(demoRoute('/api/sessions/demo-a2b-01/transcript?limit=250').name, 'sessions.transcript')
  assert.equal(demoRoute('/api/unknown/thing').name, 'fallback')
})

test('レビュー一覧は 2 件（設計判断 + 視覚検収）で、両方にラベルがある', async () => {
  resetDemoState()
  const r = await demoFetch('/api/review')
  assert.equal(r.board, 'mobile')
  assert.equal(r.items.length, 2)
  const waiting = r.items.filter((x) => x.status === 'blocked' && x.review?.label)
  assert.equal(waiting.length, 2)
  assert.deepEqual(
    waiting.map((x) => x.review.mode).sort(),
    ['annotation', 'standard'],
  )
})

test('Step 1: 設問 3 問すべてに推奨があり、回答でステップ 2 へ進む', async () => {
  resetDemoState()
  const d = await demoFetch('/api/review/t_demo_review/data')
  assert.equal(d.data.questions.length, 3)
  for (const q of d.data.questions) {
    assert.ok(Array.isArray(q.options) && q.options.length >= 2, `${q.id} に選択肢`)
    assert.equal(q.options.filter((o) => o.recommended).length, 1, `${q.id} の推奨は 1 つ`)
  }
  assert.equal(snapshot().step, 1)
  const answers = d.data.questions.map((q) => ({
    id: q.id,
    choice: q.options.find((o) => o.recommended).id,
    note: '',
  }))
  const res = await demoFetch('/api/review/t_demo_review/answer', { method: 'POST', body: { answers } })
  assert.equal(res.ok, true)
  assert.equal(snapshot().step, 2)
  const after = await demoFetch('/api/review')
  assert.equal(after.items.find((x) => x.id === 't_demo_review').status, 'done')
})

test('Step 2: 仕様書は 3 件（本編 3 バッチ + V5/V4 のダイジェスト）で、起票すると 3 タスクが増える', async () => {
  resetDemoState()
  setDemoTick(1)
  const specs = await demoFetch('/api/specs?board=mobile')
  assert.equal(specs.specs.length, 3, 'V6: 複数 SPEC を返す（アコーディオンと MD プレビュー用）')
  assert.equal(specs.specs[0].path, DEMO_SPEC_PATH)
  assert.equal(specs.specs[0].batches.length, 3)
  assert.equal(specs.specs[1].path, DEMO_SPEC_V5_PATH)
  assert.ok(specs.specs[1].batches.length >= 2)
  assert.equal(specs.specs[2].path, DEMO_SPEC_V4_PATH)
  assert.ok(specs.specs[2].batches.length >= 2)
  for (const spec of specs.specs) {
    assert.ok(spec.title, `${spec.path} にタイトル`)
    for (const b of spec.batches) {
      assert.ok(b.id && b.title, `${spec.path} のバッチに id と title`)
      assert.ok(b.mode, `${b.id} に Mode（ModePill 用）`)
    }
  }

  await demoFetch('/api/review/t_demo_review/answer', { method: 'POST', body: { answers: [] } })
  const launch = await demoFetch('/api/specs/launch', {
    method: 'POST',
    body: { board: 'mobile', specRelPath: DEMO_SPEC_PATH, batchIds: ['DEMO-1', 'DEMO-2', 'DEMO-3'] },
  })
  assert.equal(launch.created.length, 3)
  const board = await demoFetch('/api/boards/mobile/tasks')
  const filed = board.tasks.filter((t) => /^\[DEMO-[123]\]/.test(t.title))
  assert.equal(filed.length, 3)
  assert.equal(snapshot().step, 3)
})

test('Step 2 -> 4: バッチが done まで進むとサマリと完了レシートが出る', async () => {
  resetDemoState()
  setDemoTick(1)
  await demoFetch('/api/review/t_demo_review/answer', { method: 'POST', body: { answers: [] } })
  await demoFetch('/api/specs/launch', {
    method: 'POST',
    body: { board: 'mobile', specRelPath: DEMO_SPEC_PATH, batchIds: ['DEMO-1', 'DEMO-2', 'DEMO-3'] },
  })
  // 800ms の代わりに 1ms 間隔（テストだけ）。3 タスク x 2 遷移ぶん待つ
  await new Promise((resolve) => setTimeout(resolve, 80))
  const board = await demoFetch('/api/boards/mobile/tasks')
  const filed = board.tasks.filter((t) => /^\[DEMO-[123]\]/.test(t.title))
  assert.equal(filed.filter((t) => t.status === 'done').length, 3)
  const reports = await demoFetch('/api/specs/reports?board=mobile&limit=1')
  assert.equal(reports.reports.length, 1)
  assert.match(reports.reports[0].markdown, /verify: npm run verify/)
  const receipt = await demoFetch('/api/telemetry/receipt')
  assert.equal(receipt.ok, true)
  // 本物（bridge/telemetry.js の buildReceipt）と同じ形: 数字は kpi の下に入る
  assert.equal(receipt.kpi.typedChars, 0)
  assert.ok(receipt.kpi.tests > 0)
  assert.equal(receipt.kpi.batchesDone, receipt.kpi.batchesTotal)
  assert.ok(receipt.kpi.cacheHitRate > 0.9)
})

test('Step 3: 視覚検収の承認でステップ 4 に到達する', async () => {
  resetDemoState()
  const res = await demoFetch('/api/review/t_demo_visual/approve', { method: 'POST', body: {} })
  assert.equal(res.moved, 'done')
  const items = (await demoFetch('/api/review')).items
  assert.equal(items.find((x) => x.id === 't_demo_visual').status, 'done')
  const progress = snapshot().progress
  assert.equal(progress.visual, true)
})

test('画像は SVG から data URL を作る（外部ファイル依存ゼロ）', () => {
  const before = mockShotSvg('before')
  const after = mockShotSvg('after')
  assert.match(before, /^<svg /)
  assert.notEqual(before, after)
  const url = mockShotDataUrl('before')
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'))
  assert.ok(url.includes(encodeURIComponent('<svg')))
  // 呼び出し側のパスからも引ける
  assert.ok(demoImageFor('/api/review/t_demo_visual/image?compare=1')?.startsWith('data:'))
  assert.ok(demoImageFor('/api/review/t_demo_visual/image')?.startsWith('data:'))
  assert.equal(demoImageFor('/assets/logo.png'), null)
})

test('fitScale は実寸と領域から 0.1..1 の倍率を返す', () => {
  assert.equal(fitScale({ width: 390, height: 844 }, 390, 844), 1)
  assert.equal(fitScale({ width: 390, height: 844 }, 0, 0), 1)
  const s = fitScale({ width: 390, height: 844 }, 390, 422)
  assert.ok(s > 0.49 && s < 0.51, `half height -> ~0.5, got ${s}`)
  assert.ok(fitScale({ width: 820, height: 1180 }, 100, 100) >= 0.1)
})

test('擬似ソケットは gateway.ready を 1 回流し、JSON-RPC に応答する', async () => {
  const sock = demoSocket()
  const got = []
  sock.onmessage = (ev) => got.push(JSON.parse(ev.data))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(got[0]?.params?.type, 'gateway.ready')
  sock.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session.list', params: {} }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const reply = got.find((m) => m.id === 7)
  assert.equal(reply.result.sessions.length, 1)
  sock.close()
  assert.equal(sock.readyState, 3)
})

test('initialReviewItems は同じ時刻なら同じ並び（決定論的）', () => {
  const a = initialReviewItems(1_700_000_000_000)
  const b = initialReviewItems(1_700_000_000_000)
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id))
  const c = createDemoState(1_700_000_000_000)
  assert.deepEqual(c.reviewItems.map((x) => x.id), a.map((x) => x.id))
})

test('通常ビルドにデモが混ざらない: api.js は demo/ を import しない', () => {
  const apiSrc = fs.readFileSync(path.join(SRC, 'api.js'), 'utf8')
  assert.equal(/from\s+['"]\.\/demo\//.test(apiSrc), false, 'api.js が demo/ を静的 import している')
  assert.equal(/import\(\s*['"]\.\/demo\//.test(apiSrc), false, 'api.js が demo/ を動的 import している')
  // 差し込み口は globalThis 経由（= 本番では誰も入れないので分岐しない）
  assert.match(apiSrc, /__hmDemoFetch/)
})

test('demo snippets: 定型チップ帯とツールチップが埋まる形で返す（仕様の種だけにならない）', async () => {
  const ja = await demoFetch('/api/snippets?lang=ja')
  assert.ok(Array.isArray(ja.snippets) && ja.snippets.length >= 6, 'チップが空だと「仕様の種」だけが残る（実測）')
  assert.equal(ja.snippets[0].id, 'quick-review')
  assert.match(ja.snippets[0].label, /Quick Review/)
  assert.ok(ja.snippets[0].text, 'tooltip（title）用の text が無い')
  assert.equal(ja.snippets.filter((s) => s.hot).length, 6, 'Hot は 6 件')
  assert.equal(ja.snippets.filter((s) => s.trigger).length, 2, '意思決定トリガーは 2 件')
  assert.equal(ja.lang, 'ja')
  assert.equal(ja.hotLimit, 8)
  assert.deepEqual(ja.overrides, {})
  assert.deepEqual(ja.custom, [])

  const en = await demoFetch('/api/snippets?lang=en')
  assert.equal(en.lang, 'en')
  assert.match(en.snippets[0].label, /Quick Review/)
  assert.notEqual(en.snippets[0].label, ja.snippets[0].label, '言語で切り替わっていない')
})

/* ------------------------------------------------------------------ *
 * V6（D28〜D32）: 追加ルート・複数 SPEC・Google Sites 埋め込み
 * ------------------------------------------------------------------ */

test('demoRoute は V6 の新規ルートを分類する', () => {
  assert.equal(demoRoute('/api/specs/content?board=mobile&path=docs/SPEC-DEMO-V1.md').name, 'specs.content')
  assert.equal(demoRoute('/api/architect/config').name, 'architect.config')
  assert.equal(demoRoute('/api/architect/jobs?board=mobile').name, 'architect.jobs')
  assert.equal(demoRoute('/api/architect/seed').name, 'architect.seed')

  const detail = demoRoute('/api/boards/mobile/tasks/t_demo_done')
  assert.equal(detail.name, 'board.task')
  assert.equal(detail.id, 'mobile')
  assert.equal(detail.taskId, 't_demo_done')

  const diff = demoRoute('/api/boards/mobile/tasks/t_demo_done/diff?file=a.js')
  assert.equal(diff.name, 'board.taskDiff')
  assert.equal(diff.taskId, 't_demo_done')
  assert.equal(diff.params.get('file'), 'a.js')

  // 一覧（`/tasks`）は従来通り
  assert.equal(demoRoute('/api/boards/mobile/tasks?limit=60').name, 'board.tasks')
})

test('仕様書の本文（MD プレビュー）: 3 件とも本文とバッチ見出しが取れる', async () => {
  resetDemoState()
  for (const spec of demoSpects().specs) {
    const d = await demoFetch(
      `/api/specs/content?board=mobile&repo=hermes-pilot-demo&path=${encodeURIComponent(spec.path)}`,
    )
    assert.equal(d.ok, true, `${spec.path} の本文`)
    assert.equal(d.path, spec.path)
    assert.equal(d.batchCount, spec.batches.length)
    assert.equal(d.truncated, false)
    assert.match(d.markdown, /^# SPEC: /, '見出しで始まる')
    assert.ok(d.mtime > 0)
    for (const b of spec.batches) {
      assert.match(d.markdown, new RegExp(`### Batch ${b.id}:`), `${b.id} の見出しが本文にある`)
    }
  }
  const missing = demoSpecContent('docs/NOPE.md')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')
})

test('Architect: 設定の読み書き・ジョブ一覧・Seed の進行がデモで動く', async () => {
  resetDemoState()
  setDemoTick(1)

  const conf = await demoFetch('/api/architect/config')
  assert.equal(conf.ok, true)
  assert.equal(conf.runner, 'hermes')
  assert.equal(conf.hasAgyCli, true, 'デモは agy がある体（ランナー切替を試せる）')
  const put = await demoFetch('/api/architect/config', { method: 'PUT', body: { runner: 'antigravity' } })
  assert.equal(put.ok, true)
  assert.equal(put.runner, 'antigravity')

  const jobs = await demoFetch('/api/architect/jobs?board=mobile')
  assert.equal(jobs.ok, true)
  assert.equal(jobs.runner, 'antigravity')
  const waiting = jobs.jobs.find((j) => j.status === 'awaiting_review')
  assert.ok(waiting, '初期状態に Review 待ちのジョブがある（ArchitectJobBar 用）')
  assert.equal(waiting.reviewTaskId, 't_demo_review')
  assert.ok(waiting.reviewTitle)
  assert.ok(waiting.runnerLabel)
  assert.ok(Array.isArray(jobs.pending) && jobs.pending.length >= 1, '未起票 SPEC を持つ')

  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'Add a markdown preview', runner: 'hermes', autoStart: false, lang: 'ja' },
  })
  assert.equal(seed.ok, true)
  assert.ok(seed.jobId)
  assert.equal(seed.status, 'running')
  assert.equal(seed.runner, 'hermes')

  await new Promise((resolve) => setTimeout(resolve, 60))
  const after = await demoFetch('/api/architect/jobs?board=mobile')
  const job = after.jobs.find((j) => j.id === seed.jobId)
  assert.ok(job, 'Seed したジョブが一覧に出る')
  assert.equal(job.status, 'spec_ready')
  assert.match(job.completedSpec.path, /^docs\/SPEC-DEMO-SEED-\d\.md$/, 'V6: 仕上げると SPEC が返る')
  assert.equal(job.completedSpec.batchCount, 2)
  assert.equal(job.seed, 'Add a markdown preview')
  assert.ok(after.specReady.some((row) => row.spec === job.completedSpec.path))
  // 生まれた SPEC は一覧（アコーディオン・MD プレビュー・一括起票）にも出る
  const specs = await demoFetch('/api/specs?board=mobile')
  assert.ok(specs.specs.some((s) => s.path === job.completedSpec.path))
  const content = await demoFetch(`/api/specs/content?path=${encodeURIComponent(job.completedSpec.path)}`)
  assert.equal(content.ok, true)
  assert.match(content.markdown, /Add a markdown preview/, '種の内容がタイトルに入る')
})

test('タスク詳細と差分: 履歴の詳細カードと差分アコーディオンが埋まる', async () => {
  resetDemoState()
  const detail = await demoFetch('/api/boards/mobile/tasks/t_demo_done')
  assert.equal(detail.id, 't_demo_done')
  assert.equal(detail.status, 'done')
  assert.ok(detail.body)
  assert.equal(detail.git.head, 'd3m0a1b')
  assert.ok(detail.git.subject)
  assert.ok(detail.events.length >= 2)
  assert.ok(Array.isArray(detail.runs))
  assert.ok(Array.isArray(detail.comments))

  const diff = await demoFetch('/api/boards/mobile/tasks/t_demo_done/diff')
  assert.equal(diff.ok, true)
  assert.ok(diff.files.length >= 1)
  assert.equal(
    diff.total.add,
    diff.files.reduce((a, f) => a + f.add, 0),
  )
  const file = diff.files[0].path
  const patch = await demoFetch(`/api/boards/mobile/tasks/t_demo_done/diff?file=${encodeURIComponent(file)}`)
  assert.equal(patch.ok, true)
  assert.equal(patch.path, file)
  assert.match(patch.text, /^diff --git/)

  const outside = await demoFetch('/api/boards/mobile/tasks/t_demo_done/diff?file=nope.js')
  assert.equal(outside.ok, false, 'そのコミットに無いファイルは ok:false（本物は 404）')

  const unknown = await demoFetch('/api/boards/mobile/tasks/t_nope')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'TASK_NOT_FOUND')
})

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
