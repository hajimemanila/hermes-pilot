/**
 * デモの `fetch` 代替（`demoFetch`）。本物のブリッジ API と同じパス・形で応答する。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import { DEMO_BOARD, DEMO_SESSION, DEMO_SPEC_PATH, MIN, demoQuestions, demoRunnerLabel } from './fixtures.js'
import {
  advanceArchitectJob,
  demoArchitectJobs,
  demoExecutionMode,
  demoLiveArchitect,
  demoPublicJob,
  startDemoArchitectJob,
} from './architectDemo.js'
import {
  advanceBatches,
  demoCoherenceAlert,
  demoCoherenceReport,
  demoLogText,
  demoPipelineStatus,
  demoQrRows,
  demoSearchHits,
  finishPipeline,
  itemById,
  overviewBody,
  receiptBody,
  setDemoTick,
} from './payloads.js'
import { demoRoute } from './route.js'
import { DEMO_SNIPPETS, DEMO_TERM_SNIPPETS } from './snippets.js'
import { demoDiffSummary, demoFilePatch, demoTaskDetail, demoWorkerFeed } from './gitFixtures.js'
import {
  currentSpecs,
  demoSpecContent,
  demoSpecList,
  demoSpects,
  demoSpecsWithArchive,
  publish,
  state,
} from './store.js'


export async function demoFetch(path, { method = 'GET', body } = {}) {
  const route = demoRoute(path)
  const payload = body === undefined ? undefined : typeof body === 'string' ? JSON.parse(body) : body
  switch (route.name) {
    case 'overview':
      return overviewBody()
    case 'review.list':
      return { board: DEMO_BOARD, workdir: '/demo/review', items: state.reviewItems.map((x) => ({ ...x })), demo: true }
    case 'review.feed':
      return { items: state.progress.visual ? [{ at: Date.now(), text: 'demo-visual-01 accepted', kind: 'done' }] : [] }
    case 'review.chatReports':
      return { items: state.chatReports.map((x) => ({ ...x })) }
    case 'review.library':
      return { items: [{ path: 'demo/visual-01.svg', name: 'visual-01.svg', source: 'library', repo: { id: 'hermes-pilot-demo', label: 'demo' } }] }
    case 'review.targets':
      return { targets: [{ id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)', path: '/demo/hermes-pilot' }] }
    case 'review.data': {
      const item = itemById(route.id)
      if (!item) return { data: { questions: [] }, answer: null }
      const answered = item.status === 'done'
      return {
        data: {
          title: item.review?.title || item.title,
          deck: item.review?.mode === 'standard',
          questions: item.review?.mode === 'standard' ? demoQuestions() : [],
        },
        answer: answered ? { answers: [{ id: 'q1', choice: 'A' }], global: '', by: 'mobile' } : null,
      }
    }
    case 'review.annotation':
      return { image: 'demo/visual-01.svg', marks: [], note: '', demo: true }
    case 'review.answer': {
      const item = itemById(route.id)
      if (item) {
        item.status = 'done'
        item.completedAt = Date.now()
        item.review = { ...item.review, answeredAt: new Date().toISOString() }
        state.progress.review = true
      }
      publish('review')
      return { ok: true, files: { answer: 'answer.json', sheet: null }, duplicate: false }
    }
    case 'review.remix': {
      const item = itemById(route.id)
      publish('review')
      return {
        ok: true,
        taskId: route.id,
        status: item?.status ?? 'blocked',
        moved: null,
        files: { remix: 'sheets/demo-review-01.remix.json' },
        record: {
          questionId: body?.questionId ?? null,
          reason: body?.reason ?? 'alternative',
          stylePreset: body?.stylePreset ?? null,
          hint: body?.hint ?? '',
        },
      }
    }
    case 'review.approve': {
      const item = itemById(route.id)
      if (item) {
        item.status = 'done'
        item.completedAt = Date.now()
        item.review = { ...item.review, answeredAt: new Date().toISOString(), approved: true }
        state.progress.visual = true
      }
      publish('review')
      return { ok: true, moved: 'done', files: { approval: 'approved.json' }, duplicate: false }
    }
    case 'review.reopen':
      return { ok: true, moved: 'blocked' }
    case 'review.worker':
      return { taskId: route.id, status: 'running', sessionId: DEMO_SESSION, db: null, profile: null, feed: demoWorkerFeed(route.id) }
    case 'review.annotationNew':
      return { ok: false, message: 'demo', demo: true }
    case 'review.misc':
      return { ok: true, demo: true }
    // COH-2: 1 会話ぶんの完了報告（未読の点の材料）。`{ items: [...] }` は本番と同じ形。
    case 'review.chatReport':
      return {
        sessionId: String(route.params.get('session_id') || ''),
        items: state.chatReports.filter((x) => !route.params.get('session_id') || x.sessionId === route.params.get('session_id')),
      }
    // COH-2: 実行ワーカーの session_id 解決（`ChatPane` の worker 連携が読む）
    case 'review.session':
      return { taskId: route.id, status: 'running', sessionId: DEMO_SESSION, demo: true }
    // COH-2: 非 JSON 応答（画像・HTML）。デモでは img/iframe のシムが差し替えるので marker を返す。
    case 'review.image':
    case 'review.thumb':
    case 'review.sheet':
    case 'review.view':
      return { ok: true, nonJson: true, path: route.name, id: route.id, demo: true }
    case 'boards':
      return {
        boards: [{ slug: DEMO_BOARD, label: 'Mobile (demo)', current: true, counts: { running: state.tasks.filter((t) => t.status === 'running').length } }],
      }
    case 'board.preview':
      return {
        ok: true,
        kind: 'static',
        board: route.id,
        url: `/api/boards/${encodeURIComponent(route.id)}/preview-files/`,
        entry: 'dist/index.html',
        rootRel: 'dist',
        updatedAt: Date.now(),
        launchCmd: 'npm run dev',
      }
    case 'board.previewFiles':
      return { ok: true, demo: true }
    case 'board.tasks':
      // COH-2: 緊急停止の状態も返す（本番の `/api/overview` の `paused` と同じ値）。
      // D92: `archivedCount` は一覧の LIMIT と独立に数える（「アーカイブ済み (N)」の N）。
      return {
        board: route.id,
        tasks: state.tasks.map((x) => ({ ...x })),
        archivedCount: state.tasks.filter((t) => t.status === 'archived').length,
        paused: state.demoOps.paused,
      }
    // D92: 整理モードの一括アーカイブ（本番と同じく running はスキップして返す）
    case 'board.bulkArchive': {
      const ids = Array.isArray(payload?.taskIds) ? payload.taskIds.map((x) => String(x ?? '').trim()).filter(Boolean) : []
      const archived = []
      const skippedRunning = []
      const skippedArchived = []
      const failed = []
      for (const id of ids) {
        const task = state.tasks.find((t) => t.id === id)
        if (!task) {
          failed.push({ id, code: 'TASK_NOT_FOUND' })
          continue
        }
        if (task.status === 'running') {
          skippedRunning.push(id)
          continue
        }
        if (task.status === 'archived') {
          skippedArchived.push(id)
          continue
        }
        task.status = 'archived'
        task.updatedAt = Date.now()
        archived.push(id)
      }
      if (archived.length) publish('tasks')
      return { ok: true, board: route.id, archived, skippedRunning, skippedArchived, failed, demo: true }
    }
    // V6 §3.5: 履歴の詳細・差分（`🔍 タスク詳細・差分を見る`）
    case 'board.task': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: 'task not found', id: route.taskId, demo: true }
      return demoTaskDetail(task)
    }
    case 'board.taskDiff': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (!task) return { ok: false, reason: 'task not found', demo: true }
      const file = route.params.get('file')
      if (!file) return demoDiffSummary(task)
      return demoFilePatch(task, String(file))
    }
    // V8-B3: 任意のボードの実行中タスクでも worker のライブ進捗を出す
    case 'board.taskWorker': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: 'task not found', id: route.taskId, demo: true }
      return {
        taskId: task.id,
        status: task.status,
        sessionId: DEMO_SESSION,
        db: null,
        profile: null,
        feed: demoWorkerFeed(task.id),
      }
    }
    case 'board.taskAbort': {
      const task = state.tasks.find((t) => t.id === route.taskId)
      if (task) {
        task.status = 'ready'
        task.updatedAt = Date.now()
        publish('tasks')
      }
      return { ok: true, reclaimed: 1, blocked: 0, demo: true }
    }
    case 'inbox':
      return { items: [] }
    case 'specs':
      return demoSpects(state.now)
    // SPEC-COHERENCE §3.4 / D82: スイープシートのライブ診断（バッジ・推奨プリセットの材料）
    case 'coherence.report':
      return demoCoherenceReport()
    // V6 §3.4: 仕様書の本文（MD プレビュー）
    case 'specs.content':
      return demoSpecContent(route.params.get('path'), state.now)
    // D92: SPEC をヘッダ追記でアーカイブ退避する（デモはメモリ上で同じ効果を出す）
    case 'specs.archive': {
      const wanted = String(payload?.path ?? route.params.get('path') ?? '').trim()
      if (!wanted) return { ok: false, code: 'SPEC_PATH_REQUIRED', error: 'path is required', demo: true }
      if (wanted.startsWith('/') || wanted.includes('..')) {
        return { ok: false, code: 'SPEC_PATH_OUTSIDE', error: 'path must stay inside the repository', demo: true }
      }
      const spec = currentSpecs(state.now).find((s) => s.path === wanted)
      if (!spec) return { ok: false, code: 'SPEC_READ_FAILED', error: 'spec not found', path: wanted, demo: true }
      if (spec.archived || state.archivedSpecPaths.includes(wanted)) {
        return { ok: true, path: wanted, noop: true, archived: true, status: 'archived', demo: true }
      }
      state.archivedSpecPaths.push(wanted)
      publish('specs')
      return { ok: true, path: wanted, noop: false, archived: true, status: 'archived', demo: true }
    }
    // V6 §3.1/§3.2: Architect のランナー設定とジョブ（進行バーの材料）
    // V11 §3.3 / D51: ランナーは `Hermes Native` 固定。`PUT` で別の値を送られても
    // 本番ブリッジと同じく `hermes` のまま返す（UI から切り替える手段はもう無い）。
    case 'architect.config': {
      return { ok: true, runner: state.architect.runner, demo: true }
    }
    case 'architect.jobs':
      return demoArchitectJobs(route.params.get('board'))
    case 'architect.seed': {
      const job = startDemoArchitectJob(payload)
      // 本物は 202（ジョブは動き出したが SPEC はまだ無い）。`executionPolicy` を返し、
      // 画面が「選んだ方針で走っている」ことを表示できるようにする（V7 §3.3 ①）。
      return {
        ok: true,
        jobId: job.id,
        status: job.status,
        runner: job.runner,
        executionPolicy: job.executionPolicy,
        autoStart: job.autoStart,
        demo: true,
      }
    }
    // V7 §3.1: ジョブ破棄はサーバー側に永続化する（デモでは一覧から消える）。
    case 'architect.jobDismiss': {
      const job = state.architect.jobs.find((j) => j.id === route.id)
      if (!job) {
        return { ok: false, code: 'JOB_NOT_FOUND', error: 'job not found', jobId: route.id, demo: true }
      }
      job.dismissed = true
      publish('architect')
      return { ok: true, jobId: job.id, persisted: true, demo: true }
    }
    case 'specs.launch': {
      const ids = Array.isArray(payload?.batchIds) ? payload.batchIds : []
      const created = []
      for (const id of ids) {
        if (state.tasks.some((t) => t.title.startsWith(`[${id}]`))) continue
        const batch = currentSpecs(state.now)
          .flatMap((s) => s.batches)
          .find((b) => b.id === id)
        const task = {
          id: `t_demo_${String(id).toLowerCase()}`,
          board: DEMO_BOARD,
          title: `[${id}] ${batch?.title ?? `Demo batch — ${id}`}`,
          status: 'ready',
          assignee: 'mobile',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          priority: 0,
        }
        state.tasks.unshift(task)
        created.push({ id: task.id, batchId: id })
      }
      if (created.length) {
        state.progress.batches = true
        publish('tasks')
        setTimeout(() => advanceBatches(state.gen), state.tickMs)
      }
      return { ok: true, created, skipped: [] }
    }
    case 'specs.reports':
      return { reports: state.report ? [{ ...state.report }] : [] }
    case 'live': {
      /*
       * V9 §3.2 / D43 + V10 §3.3 / D47: 本番 `live.snapshot` と同じ形
       * （`{ok, counts:{turns,tasks,architect}, turns, tasks, architect}`）を返す。
       * `counts.architect` は `running` / `awaiting_spec` だけを数え、一覧には
       * `awaiting_review`（判断待ち）も含める — デモでも LiveSheet の 3 列目が点灯する。
       * `ok` が無いと LiveSheet が「失敗」表示になる（実測）。
       */
      const at = Date.now()
      const architect = state.architect.jobs
        .filter((j) => !j.dismissed && ['running', 'awaiting_spec', 'awaiting_review'].includes(String(j.status)))
        .map((j) => demoLiveArchitect(j, at))
      const tasks = state.tasks
        .filter((t) => t.status === 'running')
        .map((t, i) => {
          const startedAt = Number(t.startedAt ?? t.createdAt ?? 0) || at
          return {
            id: t.id,
            board: DEMO_BOARD,
            boardName: DEMO_BOARD,
            title: t.title,
            assignee: t.assignee ?? 'mobile',
            startedAt,
            elapsedSec: Math.max(0, Math.round((at - startedAt) / 1000)),
            workerPid: 42400 + i,
          }
        })
      const architectRunning = architect.filter((j) => ['running', 'awaiting_spec'].includes(String(j.status))).length
      // 何か動いていればターン 1 本を見せる（Discord / PWA のターンに相当する行）
      const demoRecentTools = [
        { name: 'render_mocks', at: at - 4_000 },
        { name: 'vision_analyze', at: at - 11_000 },
        { name: 'edit_file', at: at - 19_000 },
        { name: 'read_file', at: at - 27_000 },
        { name: 'terminal', at: at - 36_000 },
      ]
      const turns =
        tasks.length || architectRunning
          ? [
              {
                profile: 'default',
                sessionId: DEMO_SESSION,
                title: 'Demo — A2B pipeline in four steps',
                source: 'mobile',
                platform: 'pwa',
                startedAt: at - 40_000,
                elapsedSec: 40,
                expiresInSec: 280,
                lastActivity: 'Running Pre-Flight Visual Gate',
                lastTool: demoRecentTools[0],
                recentTools: demoRecentTools,
                toolCount: 12,
                tokens: { input: 14200, output: 4200, total: 18400, cacheRead: 11000, costUsd: 0.04 },
              },
            ]
          : []
      const telemetry = {
        recentTools: turns[0]
          ? demoRecentTools.map((rt) => ({
              ...rt,
              sessionId: DEMO_SESSION,
              profile: 'default',
              taskTitle: tasks[0]?.title || architect[0]?.seed || 'Autopilot Demo Build',
            }))
          : [],
        toolCount: turns[0] ? 12 : 0,
        runTokens: turns[0] ? 18400 : 0,
        runCacheRead: turns[0] ? 11000 : 0,
        runCostUsd: turns[0] ? 0.04 : 0,
        cacheHitPct: turns[0] ? 37 : 0,
        activeTurns: turns.length,
        activeTasks: tasks.length,
        activeWorkers: turns.length + tasks.length,
        phaseLabel: architect[0]?.phase || (tasks.length || turns.length ? 'running' : 'idle'),
      }
      return {
        ok: true,
        counts: { turns: turns.length, tasks: tasks.length, architect: architectRunning },
        turns,
        tasks,
        architect,
        telemetry,
        demo: true,
      }
    }
    case 'usage': {
      /*
       * V10 §3.3 / D47: UsageSheet（`UsageSheet.jsx`）が読む形を本番 `usage.summary` と揃える。
       * `totals` / `models` / `topSessions` が無いとシートが「失敗」表示になる（実測）。
       */
      const hours = Number(route.params.get('hours')) || 24
      const at = Date.now()
      return {
        ok: true,
        hours,
        cacheHitRate: 0.994,
        totalTokens: 1_240_000,
        cost: 1.08,
        saved: 12.4,
        totals: {
          cost: 1.08,
          input: 1_232_500,
          output: 7_500,
          cacheRead: 1_225_100,
          calls: 42,
          sessions: 4,
          messages: 28,
          tools: 64,
        },
        models: [
          {
            model: 'deepseek/deepseek-v4.1-flash',
            calls: 34,
            input: 1_180_000,
            output: 6_400,
            cacheRead: 1_172_000,
            cost: 0.92,
          },
          {
            model: 'deepseek/deepseek-v4.1-pro',
            calls: 8,
            input: 52_500,
            output: 1_100,
            cacheRead: 53_100,
            cost: 0.16,
          },
        ],
        topSessions: [
          {
            id: DEMO_SESSION,
            profile: 'default',
            title: 'Demo — A2B pipeline in four steps',
            source: 'mobile',
            input: 980_000,
            output: 5_200,
            at: state.now - 4 * MIN,
            cost: 0.86,
          },
          {
            id: 'demo-review-01',
            profile: 'default',
            title: 'Quick Review — three design decisions',
            source: 'discord',
            input: 252_500,
            output: 2_300,
            at: state.now - 12 * MIN,
            cost: 0.22,
          },
        ],
        demo: true,
      }
    }
    case 'audit':
      return { lines: ['demo: audit log is generated in memory'] }
    case 'sessions':
      return {
        sessions: [
          {
            id: DEMO_SESSION,
            title: 'Demo — A2B pipeline in four steps',
            source: 'demo',
            profile: 'demo',
            messages: 6,
            updatedAt: state.now,
          },
        ],
      }
    case 'sessions.transcript':
      return {
        ok: true,
        messages: [
          { id: 'm1', role: 'user', text: 'File the batches for the demo spec.', at: state.now },
          {
            id: 'm2',
            role: 'assistant',
            text: 'Filed 3 batches. The visual gate is waiting for a redline stamp or an approval.',
            at: state.now + 1,
          },
        ],
        hasMore: false,
        oldestId: 'm1',
      }
    case 'snippets': {
      // 本物のブリッジと同じ形を返す（`items: []` だと定型チップ帯が空になり、
      // 「仕様策定」だけが残って見える・実測）。label/text は i18n の辞書に合わせる。
      // V10 §3.3 / D47: `kind === 'term'`（端末タブ）も本番と同じ構造で返す。
      const lang = String(route.params?.get('lang') || 'en').slice(0, 2) === 'ja' ? 'ja' : 'en'
      const set = (route.kind === 'term' ? DEMO_TERM_SNIPPETS : DEMO_SNIPPETS)[lang]
      return {
        snippets: set,
        allSnippets: set,
        overrides: {},
        custom: [],
        customMax: 16,
        hotLimit: 8,
        lang,
      }
    }
    case 'memos.list': {
      if (method === 'POST') {
        const nowIso = new Date().toISOString()
        const memo = {
          id: `m_${Math.random().toString(16).slice(2, 10)}`,
          title: String(payload?.title ?? '').trim(),
          body: String(payload?.body ?? '').trim(),
          tags: Array.isArray(payload?.tags) ? payload.tags.map((x) => String(x).replace(/^#+/, '').trim()).filter(Boolean) : [],
          pinned: Boolean(payload?.pinned),
          color: payload?.color || 'default',
          kind: payload?.kind || 'note',
          checklist: Array.isArray(payload?.checklist) ? payload.checklist : [],
          source: payload?.source || null,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        state.memos = [memo, ...(state.memos || [])]
        return { ok: true, memo }
      }
      const sorted = [...(state.memos || [])].sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
        return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
      })
      return { ok: true, memos: sorted }
    }
    case 'memos.item': {
      const list = state.memos || []
      const idx = list.findIndex((m) => m.id === route.id)
      if (idx === -1) return { ok: false, error: 'MEMO_NOT_FOUND' }
      if (method === 'DELETE') {
        state.memos = list.filter((m) => m.id !== route.id)
        return { ok: true, id: route.id }
      }
      if (method === 'PATCH') {
        const updated = { ...list[idx], ...(payload || {}), updatedAt: new Date().toISOString() }
        list[idx] = updated
        return { ok: true, memo: updated }
      }
      return { ok: true, memo: list[idx] }
    }
    case 'repos':
      return { repos: [{ id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)', path: '/demo/hermes-pilot', board: DEMO_BOARD }] }
    case 'repos.new': {
      const slug = String(payload?.name || 'new-app')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'new-app'
      return {
        ok: true,
        repo: { id: slug, label: payload?.name || slug, path: `/demo/${slug}`, boards: [{ slug, name: payload?.name || slug }] },
        board: { slug, name: payload?.name || slug, current: false },
        path: `/demo/${slug}`,
        repos: [{ id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)', path: '/demo/hermes-pilot', board: DEMO_BOARD }],
        scanDirs: ['/demo'],
      }
    }
    case 'receipt':
      return receiptBody()
    // V10 §3.3 / D47: 1 タップ環境最適化（SOUL.md ＋ 同梱 3 スキル）と専用プロファイル選択
    case 'pipeline.status':
      return demoPipelineStatus()
    case 'pipeline.profile': {
      const next = String(payload?.profile || '').trim()
      if (next) state.pipeline.profile = next === 'default' ? 'default' : next
      publish('pipeline')
      return {
        ok: true,
        pilotProfile: state.pipeline.profile,
        status: demoPipelineStatus(),
        demo: true,
      }
    }
    case 'pipeline.optimize': {
      // 本番は書き込み（専用プロファイル SOUL.md への冪等追記＋スキル配置）。デモはフラグを立てるだけ。
      if (typeof payload?.profile === 'string' && payload.profile.trim()) {
        state.pipeline.profile = payload.profile.trim()
      }
      const doSoul = payload?.soul !== false
      const doSkills = payload?.skills !== false
      if (doSoul && doSkills) state.pipeline.optimized = true
      publish('pipeline')
      return {
        ok: true,
        pilotProfile: state.pipeline.profile,
        soul: { ok: true, applied: doSoul, changed: doSoul },
        skills: { ok: true, placed: doSkills ? 3 : 0 },
        status: demoPipelineStatus(),
        demo: true,
      }
    }
    // V10 §3.3 / D47: ワンタップ QR ペアリング（`SettingsPane` のペアリングシート）
    case 'auth.pairing': {
      const targets = [
        {
          kind: 'tailscale',
          label: 'Tailscale HTTPS (demo)',
          url: 'https://demo.tailnet.ts.net:8444/?token=demo-only',
        },
        { kind: 'lan', label: 'LAN (demo)', url: 'http://192.168.1.42:4097/?token=demo-only' },
      ]
      return {
        ok: true,
        port: 4097,
        tlsPort: 8444,
        tailscale: true,
        dnsName: 'demo.tailnet.ts.net',
        lanIp: '192.168.1.42',
        targets,
        expiresAt: Date.now() + 300_000,
        qrRows: demoQrRows(),
        qrMargin: 4,
        demo: true,
      }
    }
    case 'logs':
      return demoLogText(route.params.get('file') || 'gateway', Number(route.params.get('lines') || 200))
    case 'search':
      return demoSearchHits(route.params.get('q') || '')
    case 'auth':
      return { ok: true, token: null, demo: true }
    // COH-2: Discord スレッドへのリンク。デモは「リンク無し」を明示する（本番 404 と同じ意味）。
    case 'discord.session':
      return { ok: true, found: false, link: null, demo: true }
    // COH-2: 緊急停止（新規作業のみ停止）。本番 `ops.pause()` / `ops.resume()` と同じ形の状態を返し、
    // `/api/overview` の `paused` とタスク一覧と連動させる（デモでも停止バナーが出る）。
    case 'gateway.pause':
    case 'gateway.resume': {
      const action = route.name === 'gateway.pause' ? 'pause' : 'resume'
      const expected = action.toUpperCase()
      // 本番は `confirm` が一致しないと 400（`CONFIRM_MISMATCH`）。デモも同じ扱いにする。
      if (String(payload?.confirm ?? '').toUpperCase() !== expected) {
        return { ok: false, code: 'CONFIRM_MISMATCH', expected, demo: true }
      }
      const nowIso = new Date().toISOString()
      state.demoOps.paused = action === 'pause'
        ? { engaged: true, reason: String(payload?.reason ?? 'mobile'), engagedAt: nowIso }
        : { engaged: false, reason: null, engagedAt: null }
      publish('overview')
      return { ok: true, action, state: state.demoOps.paused, output: 'demo', at: Date.now(), demo: true }
    }
    case 'gateway':
      return { ok: true, state: 'running', demo: true }
    // D90: 全タスク緊急停止（ESTOP ＋ 実行中一括中断）。本番 `ops.stopAll()` と同じ形を返し、
    // `/api/overview` の `paused` とタスク一覧へ連動させる（デモでも 1 タップ停止を体験できる）。
    case 'emergency.stopAll': {
      if (String(payload?.confirm ?? '').toUpperCase() !== 'STOP_ALL') {
        return { ok: false, code: 'CONFIRM_MISMATCH', params: { expected: 'STOP_ALL' }, demo: true }
      }
      const nowIso = new Date().toISOString()
      state.demoOps.paused = {
        engaged: true,
        reason: String(payload?.reason ?? 'mobile'),
        engagedAt: nowIso,
      }
      const running = state.tasks.filter((t) => t.status === 'running')
      for (const t of running) {
        t.status = 'blocked'
        t.updatedAt = Date.now()
      }
      publish('tasks')
      publish('overview')
      return {
        ok: true,
        paused: state.demoOps.paused,
        aborted: running.length,
        abortedTasks: running.map((t) => ({ board: t.board, id: t.id })),
        failed: [],
        remainingRunning: state.tasks.filter((t) => t.status === 'running').length,
        at: Date.now(),
        demo: true,
      }
    }
    case 'clientError':
      return { ok: true }
    default:
      // 未知のパスでも画面を壊さない（空の入れ物を返す）
      return { ok: true, items: [], turns: [], sessions: [], boards: [], reports: [], specs: [], demo: true }
  }
}
