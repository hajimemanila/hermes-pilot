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
  advanceArchitectJob,
  createDemoState,
  demoFetch,
  demoImageFor,
  demoJobPhase,
  demoArchitectJobs,
  demoRoute,
  demoSocket,
  demoSpecContent,
  demoSpects,
  demoState,
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
import { fitScale } from '../src/demo/stage.js'
import { listSnippets } from '../../bridge/src/snippets.js'
import { DEMO_BUILTIN, DEMO_SNIPPETS } from '../src/demo/snippets.js'
import { pickActiveArchitectJob } from '../src/lib/specSeed.js'
import { KPI_KEYS, receiptKpis } from '../src/lib/receiptCanvas.js'

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
    // D91: `GET /api/specs` の各要素は `runTaskIds`（pipeline-runs.json の照合キー）を持つ
    assert.ok(Array.isArray(spec.runTaskIds), `${spec.path} に runTaskIds 配列`)
    for (const b of spec.batches) {
      assert.ok(b.id && b.title, `${spec.path} のバッチに id と title`)
      assert.ok(b.mode, `${b.id} に Mode（ModePill 用）`)
    }
  }
  // アーカイブ側も同じ契約（Launchpad の照合が経路で揺れない）
  for (const spec of specs.archivedSpecs) {
    assert.ok(Array.isArray(spec.runTaskIds), `${spec.path} に runTaskIds 配列`)
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

test('未起票の判定は SPEC スコープ: 別 SPEC の同名 ID と archived を「起票済み」にしない（D91/D92）', () => {
  resetDemoState()
  const st = demoState()
  st.tasks.push({
    id: 't_other_spec',
    title: '[DEMO-1] other spec batch',
    status: 'done',
    spec: 'docs/SPEC-OTHER.md',
    createdAt: st.now,
  })
  st.tasks.push({
    id: 't_archived',
    title: '[DEMO-2] dropped batch',
    status: 'archived',
    spec: DEMO_SPEC_PATH,
    createdAt: st.now,
  })
  const pending = demoArchitectJobs('mobile').pending.find((p) => p.path === DEMO_SPEC_PATH)
  assert.ok(pending, 'デモ本編は未起票のまま残る')
  assert.ok(pending.pending.includes('DEMO-1'), '別 SPEC の [DEMO-1] は起票済みにしない')
  assert.ok(pending.pending.includes('DEMO-2'), 'archived は再起票できる')
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
  // COH-5: デモ完走レポートにも汎用予兆検知の形（`coherence_alert`）が載る（D83・自動起票なし）
  const demoAlert = reports.reports[0].coherence_alert
  assert.ok(demoAlert, 'coherence_alert が付く')
  assert.deepEqual(demoAlert.summary, { hardFailCount: 0, softSignalCount: 3, hotspotCount: 1 })
  assert.equal(demoAlert.recommendedSweep, 'hotspots')
  assert.equal(demoAlert.highlights.length, 3)
  assert.deepEqual(demoAlert.layers, { universal: true, repoConfig: true, repoChecker: true })
  assert.match(reports.reports[0].markdown, /#### 🧭 Coherence Signals/)
  assert.match(reports.reports[0].markdown, /Recommended sweep: hotspots/)
  const receipt = await demoFetch('/api/telemetry/receipt')
  assert.equal(receipt.ok, true)
  // 本物（bridge/telemetry.js の buildReceipt）と同じ形: 数字は kpi の下に入る
  assert.equal(receipt.kpi.typedChars, 0)
  assert.ok(receipt.kpi.tests > 0)
  assert.equal(receipt.kpi.batchesDone, receipt.kpi.batchesTotal)
  assert.ok(receipt.kpi.cacheHitRate > 0.9)
  // V7 §3.2: 8 KPI（コスト・キャッシュ・節約・ゼロタイピング・テスト・所要時間・API コール・トークン）が
  // デモでも欠けずに埋まる（`—` を出さない）
  const kpis = receiptKpis(receipt, 'ja')
  assert.equal(kpis.length, 8)
  assert.deepEqual(kpis.map((k) => k.key), KPI_KEYS)
  for (const k of kpis) assert.notEqual(k.value, '—', `kpi.${k.key} が空`)
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

test('demo snippets: 定型チップ帯とツールチップが埋まる形で返す（仕様策定チップが先頭）', async () => {
  const ja = await demoFetch('/api/snippets?lang=ja')
  assert.ok(Array.isArray(ja.snippets) && ja.snippets.length >= 6, 'チップが空だと「仕様策定」だけが残る（実測）')
  // V7 §3.5 / D37: 先頭は仕様策定（本番と同じ順序・同じ日本語ラベル）
  assert.equal(ja.snippets[0].id, 'spec-seed')
  assert.equal(ja.snippets[0].label, '📝 仕様策定')
  assert.equal(ja.snippets[0].action, 'seed', '入力欄ではなく仕様策定シートを開く')
  assert.equal(ja.snippets[1].id, 'quick-review')
  assert.match(ja.snippets[1].label, /Quick Review/)
  assert.ok(ja.snippets[0].text, 'tooltip（title）用の text が無い')
  assert.equal(ja.snippets.filter((s) => s.hot).length, 7, 'Hot は 7 件')
  assert.equal(ja.snippets.filter((s) => s.trigger).length, 3, '意思決定トリガーは 3 件')
  assert.equal(ja.lang, 'ja')
  assert.equal(ja.hotLimit, 8)
  assert.deepEqual(ja.overrides, {})
  assert.deepEqual(ja.custom, [])

  const en = await demoFetch('/api/snippets?lang=en')
  assert.equal(en.lang, 'en')
  assert.equal(en.snippets[0].label, '📝 Spec Seed', '英語は "Spec Seed" を維持する')
  assert.match(en.snippets[1].label, /Quick Review/)
  assert.notEqual(en.snippets[1].label, ja.snippets[1].label, '言語で切り替わっていない')
  // 英語設定の指示文は完全英語（見出しだけ日本語だと en 設定で日本語の SPEC を書かせる）
  const JP_CHAR = /[\u3040-\u30ff\u4e00-\u9fff]/
  for (const s of en.snippets) {
    assert.equal(JP_CHAR.test(s.text), false, `en の text に日本語: ${s.id} → ${s.text}`)
  }
})

test('demo snippets: 本番の組み込み（bridge/src/snippets.js）と 1 文字も違わない', () => {
  assert.equal(DEMO_BUILTIN.length, 15)
  for (const lang of ['en', 'ja']) {
    const prod = listSnippets([], lang)
    const demo = DEMO_SNIPPETS[lang]
    assert.deepEqual(demo.map((s) => s.id), prod.map((s) => s.id), `${lang}: id と順序`)
    for (const p of prod) {
      const d = demo.find((s) => s.id === p.id)
      assert.ok(d, `${lang}/${p.id} がデモに無い`)
      for (const field of ['label', 'text', 'hot', 'trigger', 'action', 'hasPlaceholder', 'hidden', 'custom']) {
        assert.deepEqual(d[field], p[field], `${lang}/${p.id} の ${field} が本番と違う`)
      }
    }
  }
})

/* ------------------------------------------------------------------ *
 * V6（D28〜D32）: 追加ルート・複数 SPEC・Google Sites 埋め込み
 * ------------------------------------------------------------------ */

test('demoRoute は V6 の新規ルートを分類する', () => {
  assert.equal(demoRoute('/api/specs/content?board=mobile&path=docs/SPEC-DEMO-V1.md').name, 'specs.content')
  assert.equal(demoRoute('/api/architect/config').name, 'architect.config')
  assert.equal(demoRoute('/api/architect/jobs?board=mobile').name, 'architect.jobs')
  assert.equal(demoRoute('/api/architect/seed').name, 'architect.seed')
  // V7 §3.1: 進行バーの ×（ジョブ破棄）
  const dismissRoute = demoRoute('/api/architect/jobs/j_demo_1/dismiss')
  assert.equal(dismissRoute.name, 'architect.jobDismiss')
  assert.equal(dismissRoute.id, 'j_demo_1')
  assert.equal(demoRoute('/api/architect/jobs').name, 'architect.jobs', '一覧は従来通り')

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

  // V11 §3.3 / D51: ランナーは Hermes Native 固定（切り替えの口は無い）
  const conf = await demoFetch('/api/architect/config')
  assert.equal(conf.ok, true)
  assert.equal(conf.runner, 'hermes')
  assert.equal(conf.hasAgyCli, undefined, 'agy の検出結果は返さない')
  const put = await demoFetch('/api/architect/config', { method: 'PUT', body: { runner: 'hermes' } })
  assert.equal(put.ok, true)
  assert.equal(put.runner, 'hermes')

  const jobs = await demoFetch('/api/architect/jobs?board=mobile')
  assert.equal(jobs.ok, true)
  assert.equal(jobs.runner, 'hermes')
  assert.equal(jobs.capabilities, undefined, 'ランナー能力の広告は廃止（D51）')
  const waiting = jobs.jobs.find((j) => j.status === 'awaiting_review')
  assert.ok(waiting, '初期状態に Review 待ちのジョブがある（ArchitectJobBar 用）')
  assert.equal(waiting.reviewTaskId, 't_demo_review')
  assert.ok(waiting.reviewTitle)
  assert.ok(waiting.runnerLabel)
  // V11 §3.3 / D51: 初期ジョブも Hermes Native。`[ARCH]` タスクに紐づく
  assert.equal(waiting.runner, 'hermes')
  assert.equal(waiting.runnerLabel, 'Hermes Native')
  assert.equal(waiting.taskId, 't_demo_arch_0')
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

test('Architect: Seed の実行方針がジョブと生成 SPEC に乗り、破棄がデモでも永続する（V7 §3.1 / §3.3）', async () => {
  resetDemoState()
  setDemoTick(1)

  const seed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: {
      board: 'mobile',
      seedText: 'Add a visual gate to the demo',
      runner: 'hermes',
      autoStart: false,
      executionPolicy: 'visual-gate',
      lang: 'ja',
    },
  })
  assert.equal(seed.ok, true)
  assert.equal(seed.executionPolicy, 'visual-gate', '選んだ実行方針を 202 で返す')

  // 走っている間は進行バーの候補になる（破棄前）
  const running = await demoFetch('/api/architect/jobs?board=mobile')
  assert.equal(pickActiveArchitectJob(running.jobs)?.id, seed.jobId, '新しいジョブが進行バーに出る')

  // 不正値は zero-stop に正規化する（本番 `normalizeExecutionPolicy` と同じ）
  const fallbackSeed = await demoFetch('/api/architect/seed', {
    method: 'POST',
    body: { board: 'mobile', seedText: 'bad policy', runner: 'hermes', executionPolicy: 'nope' },
  })
  assert.equal(fallbackSeed.executionPolicy, 'zero-stop')

  await new Promise((resolve) => setTimeout(resolve, 60))
  const jobs = await demoFetch('/api/architect/jobs?board=mobile')
  const job = jobs.jobs.find((j) => j.id === seed.jobId)
  assert.ok(job)
  assert.equal(job.executionPolicy, 'visual-gate')
  assert.equal(job.dismissed, false)
  assert.equal(
    job.completedSpec.batches.every((b) => b.mode === 'Visual Gate'),
    true,
    '生成 SPEC のバッチが方針に追従する（Zero-Stop 固定になっていない）',
  )

  // ×（破棄）はサーバー側に永続化し、進行バーから消える
  const dismissed = await demoFetch(`/api/architect/jobs/${seed.jobId}/dismiss`, { method: 'POST' })
  assert.equal(dismissed.ok, true)
  assert.equal(dismissed.persisted, true)
  assert.equal(dismissed.jobId, seed.jobId)
  const after = await demoFetch('/api/architect/jobs?board=mobile')
  const gone = after.jobs.find((j) => j.id === seed.jobId)
  assert.equal(gone.dismissed, true)
  // 破棄済みは進行バーの候補から外れる（本番と同じ `pickActiveArchitectJob`）
  assert.equal(pickActiveArchitectJob([{ ...gone, status: 'running' }]), null)
  assert.notEqual(pickActiveArchitectJob(after.jobs)?.id, seed.jobId)

  const missing = await demoFetch('/api/architect/jobs/j_nope/dismiss', { method: 'POST' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'JOB_NOT_FOUND', '無いジョブは 404 相当（本番と同じコード）')
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
