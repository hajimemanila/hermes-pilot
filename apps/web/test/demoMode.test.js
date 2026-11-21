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
