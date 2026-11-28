/**
 * デモの Architect ジョブ進行（Seed → SPEC → Review → 起票）。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import {
  DEMO_BOARD,
  DEMO_REPO_PATH,
  MIN,
  DEMO_SESSION,
  DEMO_SPEC_PATH,
  SPEC_MTIME_SLACK_MS,
  demoRunnerLabel,
  demoTaskSpecOf,
  demoTaskStampMs,
} from './fixtures.js'
import { advanceBatches } from './payloads.js'
import { currentSpecs, demoSpecsWithArchive, publish, state } from './store.js'

/* ------------------------------------------------------------------ *
 * V6: Architect（Seed → 仕様書 → Review → 起票）の進行
 * ------------------------------------------------------------------ */

/** 停滞とみなす無進展時間（本番 `architect.js` の `STALLED_AFTER_MS` と同じ 3 分）。 */
export const DEMO_STALLED_AFTER_MS = 180_000

/**
 * 公開用のジョブ（形は `architect.publicJob` + V6 の追加フィールド）。
 *
 * V9 §3.1 / D42・D43: ブリッジと同じ `phase` / `stalled` / `sheetPath` / `reviewBoard` を
 * 返す（デモでも進行バーがフェーズ・停滞警告・進捗詳細を本番と同じ見た目で出せる）。
 */
export function demoPublicJob(job) {
  return {
    ...job,
    runnerLabel: demoRunnerLabel(),
    phase: demoJobPhase(job),
    stalled: demoJobStalled(job),
    sheetPath: job.sheetPath ?? null,
    reviewBoard: job.reviewTaskId ? DEMO_BOARD : null,
  }
}

/**
 * ジョブの現在フェーズ（本番 `architect.computePhase` と同じ規則・SPEC-PILOT-V9 §3.1 / D42）。
 * @param {object} job ジョブ
 * @returns {'spawning'|'round1_sheet'|'awaiting_review'|'round2_spec'|'spec_ready'|'launched'|'failed'} フェーズ
 */
export function demoJobPhase(job) {
  const status = String(job?.status ?? '')
  if (status === 'failed') return 'failed'
  if (status === 'launched') return 'launched'
  if (status === 'spec_ready') return 'spec_ready'
  if (status === 'awaiting_review') return 'awaiting_review'
  // 一度 Review まで行って回答後に戻ったジョブは Round 2（仕様書の執筆）
  if (job?.reviewSeenOnce) return 'round2_spec'
  if (job?.sheetPath) return 'round1_sheet'
  return 'spawning'
}

/**
 * 停滞しているか（本番 `architect.isJobStalled` と同じ規則・180 秒）。
 * @param {object} job ジョブ
 * @param {number} [at] 現在時刻
 * @returns {boolean} 停滞なら true
 */
export function demoJobStalled(job, at = Date.now()) {
  const status = String(job?.status ?? '')
  if (!['running', 'awaiting_spec'].includes(status)) return false
  // キュー待ちはディスパッチャ待ちなので「停滞」ではない
  if (String(job?.queueState ?? '') === 'queued') return false
  const start = Number(job?.startedAt ?? job?.createdAt ?? 0)
  if (!Number.isFinite(start) || start <= 0) return false
  return at - start >= DEMO_STALLED_AFTER_MS
}

/**
 * `/api/live` の Architect 行（本番 `live.snapshot` の整形と同じ形・V9 §3.2 / D43）。
 * @param {object} job ジョブ
 * @param {number} [at] 現在時刻
 * @returns {object} 行
 */
export function demoLiveArchitect(job, at = Date.now()) {
  const startedAt = Number(job.startedAt ?? job.createdAt ?? 0) || null
  return {
    id: job.id,
    board: job.board,
    runner: job.runner,
    runnerLabel: demoRunnerLabel(),
    status: job.status,
    phase: demoJobPhase(job),
    stalled: demoJobStalled(job, at),
    taskId: job.taskId ?? null,
    reviewTaskId: job.reviewTaskId ?? null,
    reviewBoard: job.reviewTaskId ? DEMO_BOARD : null,
    seed: String(job.seed ?? '').slice(0, 200),
    startedAt,
    elapsedSec: startedAt ? Math.max(0, Math.round((at - startedAt) / 1000)) : null,
  }
}

/**
 * 実行方針を正規化する（本番 `architect.js` の `normalizeExecutionPolicy` と同じ規則:
 * 未指定・不正値は `zero-stop`）。
 * @param {unknown} value 入力
 * @returns {'zero-stop'|'visual-gate'} 実行方針
 */
export function normalizeDemoExecutionPolicy(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  return text === 'visual-gate' ? 'visual-gate' : 'zero-stop'
}

/**
 * 実行方針に対応する SPEC バッチの `Execution Mode` 表記（本番 `executionModeLabel` と同じ）。
 * @param {unknown} value 実行方針
 * @returns {'Visual Gate'|'Zero-Stop'} バッチのモード表記
 */
export function demoExecutionMode(value) {
  return normalizeDemoExecutionPolicy(value) === 'visual-gate' ? 'Visual Gate' : 'Zero-Stop'
}

/**
 * Seed を受けてジョブを 1 件作る（`POST /api/architect/seed` のデモ実装）。
 *
 * 本物は 202 で即返り、背後で SPEC を書く。デモも同じで、`tickMs` ごとに
 * `running -> awaiting_spec -> spec_ready`（`autoStart` なら `launched`）と進める。
 *
 * V11 §3.3 / D51: ランナーは `Hermes Native` 固定（外部 CLI は起動しない）。
 * 送られてきた `runner` は見ない（本番ブリッジも `hermes` 以外を 400 で弾く）。
 *
 * @param {object} input 種（`seedText` / `autoStart` / `executionPolicy` / `lang` / `chat`）
 * @returns {object} 作ったジョブ
 */
export function startDemoArchitectJob(input = {}) {
  const now = Date.now()
  const runner = 'hermes'
  const executionPolicy = normalizeDemoExecutionPolicy(input.executionPolicy)
  const seq = ++state.architect.seq
  const seedText = String(input.seedText ?? '').slice(0, 400)
  // Hermes Native は必ず `[ARCH] ...` の実行中タスクを 1 件立てる（`taskId` で進捗詳細から開ける）
  const taskId = `t_demo_arch_${seq}`
  const job = {
    id: `j_demo_${seq}`,
    board: DEMO_BOARD,
    status: 'running',
    runner,
    requestedRunner: runner,
    runnerLabel: demoRunnerLabel(),
    fallbackFrom: null,
    fallbackReason: null,
    autoStart: Boolean(input.autoStart),
    autopilot: Boolean(input.autopilot),
    // V7 §3.3 ①: 選んだ実行方針（`zero-stop` / `visual-gate`）をジョブに残す
    executionPolicy,
    dismissed: false,
    seed: seedText,
    lang: input.lang === 'en' ? 'en' : 'ja',
    chat: input.chat ? String(input.chat).slice(0, 128) : DEMO_SESSION,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    spec: null,
    completedSpec: null,
    launched: null,
    error: null,
    // Round 1（設問シート）→ Round 2（SPEC 執筆）の通過フラグ（`advanceArchitectJob` が立てる）
    sheetPath: null,
    reviewSeenOnce: false,
    taskId,
    reviewTaskId: null,
    reviewTitle: null,
  }
  if (taskId) {
    state.tasks.unshift({
      id: taskId,
      board: DEMO_BOARD,
      title: `[ARCH] ${seedText.slice(0, 48)}`,
      status: 'running',
      assignee: 'architect',
      body: seedText,
      events: [{ kind: 'spawned', at: now }],
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      priority: 0,
    })
  }
  state.architect.jobs.unshift(job)
  if (state.architect.jobs.length > 8) state.architect.jobs.length = 8
  publish('architect')
  setTimeout(() => advanceArchitectJob(job.id, state.gen), state.tickMs)
  return job
}

/**
 * ジョブを 1 段進める（V10 §3.3 / D47・本番 `architect` の段階遷移に合わせる）。
 *
 * `running` →（Round 1 の設問シート）`awaiting_spec` + `sheetPath` →（Round 2 の SPEC 執筆）
 * `reviewSeenOnce` → `spec_ready`（`autoStart` なら `launched`）。各段の間は `tickMs`。
 *
 * テストから段階を手で進められるよう公開している（タイマーだと速すぎて観測できない）。
 *
 * @param {string} id ジョブ ID
 * @param {number} [gen] ツアー世代（作り直されたら古いタイマーは降りる）
 * @returns {object|null} 進めた後のジョブ（見つからなければ null）
 */
export function advanceArchitectJob(id, gen = state.gen) {
  if (gen !== state.gen) return null
  const job = state.architect.jobs.find((j) => j.id === id)
  if (!job) return null
  const key = Number(String(job.id).replace(/[^0-9]/g, '')) || 1
  // Autopilot seed: stop at awaiting_review with an interview sheet so the swipe deck renders
  if (job.autopilot && job.status === 'running' && !job.sheetPath) {
    const now = Date.now()
    const reviewTaskId = `t_demo_review_${key}`
    const seedTitle = String(job.seed || 'New feature spec').slice(0, 48)
    job.sheetPath = `sheets/spec-demo-seed-${key}-1.json`
    job.reviewTaskId = reviewTaskId
    job.reviewTitle = `[SEED${key}-1] ${seedTitle}`
    job.status = 'awaiting_review'
    if (!state.reviewItems.some((r) => r.id === reviewTaskId)) {
      state.reviewItems.unshift({
        id: reviewTaskId,
        board: DEMO_BOARD,
        title: job.reviewTitle,
        status: 'blocked',
        assignee: 'mobile',
        createdAt: now,
        completedAt: null,
        result: null,
        progress: { lastEvent: 'blocked', lastEventAt: now, heartbeatAt: now, startedAt: now },
        review: {
          label: `demo-seed-${key}`,
          image: null,
          hasCompare: false,
          target: 'hermes-pilot-demo',
          repo: { id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)' },
          chat: DEMO_SESSION,
          mode: 'standard',
          round: 1,
          sheet: null,
          exists: true,
          title: seedTitle,
          topic: 'Swipe to decide layout and interaction.',
        },
      })
    }
    const archTask = job.taskId ? state.tasks.find((t) => t.id === job.taskId) : null
    if (archTask) {
      archTask.status = 'blocked'
      archTask.updatedAt = now
      archTask.result = `Round 1 sheet filed: review ${reviewTaskId}`
    }
    publish('architect')
    publish('review')
    publish('tasks')
    return job
  }
  // 段 1: 設問シートを作る（`phase` は `sheetPath` から `round1_sheet` になる）
  if (job.status === 'running' && !job.sheetPath) {
    job.sheetPath = `sheets/spec-demo-seed-${key}-1.json`
    job.status = 'awaiting_spec'
    publish('architect')
    setTimeout(() => advanceArchitectJob(id, gen), state.tickMs)
    return job
  }
  // 段 2: 回答を受けて SPEC を書き始める（`phase` は `round2_spec`）
  if (job.status === 'awaiting_spec' && !job.reviewSeenOnce) {
    job.reviewSeenOnce = true
    publish('architect')
    setTimeout(() => advanceArchitectJob(id, gen), state.tickMs)
    return job
  }
  if (job.status !== 'awaiting_spec') return job
  // 段 3: 仕上げ（Seed から生まれた SPEC を公開する）
  // バッチの Execution Mode は選んだ実行方針に従う（本番の生成 SPEC と同じ表記）
  const mode = demoExecutionMode(job.executionPolicy)
  const spec = {
    path: `docs/SPEC-DEMO-SEED-${key}.md`,
    title: `SPEC: Demo seed — ${String(job.seed || 'seeded idea').slice(0, 48)}`,
    mtime: Date.now(),
    valid: true,
    batches: [
      {
        id: `SEED${key}-1`,
        title: 'Interview questions',
        objective: 'Ask only what the machine cannot decide.',
        mode,
        section: '- 3 questions\n- each option shows both pictures',
      },
      {
        id: `SEED${key}-2`,
        title: 'Implementation and verify',
        objective: 'Ship the change with a receipt.',
        mode,
        section: '- `npm run verify`\n- completion report',
      },
    ],
  }
  if (!state.seededSpecs.some((s) => s.path === spec.path)) state.seededSpecs.push(spec)
  job.spec = spec.path
  job.completedSpec = {
    path: spec.path,
    title: spec.title,
    batchCount: spec.batches.length,
    batches: spec.batches.map((b) => ({ id: b.id, title: b.title, mode: b.mode ?? null })),
  }
  job.finishedAt = Date.now()
  job.status = job.autoStart ? 'launched' : 'spec_ready'
  // Hermes Native が立てた `[ARCH]` タスクも SPEC が出来た時点で終わらせる
  // （残すと `/api/live` の実行中タスクに居座り、進捗詳細の状態も嘘になる）
  const archTask = job.taskId ? state.tasks.find((t) => t.id === job.taskId) : null
  if (archTask) {
    archTask.status = 'done'
    archTask.updatedAt = Date.now()
    archTask.result = `SPEC written: ${spec.path}`
    archTask.events = [...(archTask.events ?? []), { kind: 'done', at: Date.now(), payload: { spec: spec.path } }]
  }
  if (job.autoStart) {
    const res = launchDemoSpecBatches(
      spec.path,
      spec.batches.map((b) => b.id),
      { parallel: job.autopilot ? 2 : 1, skipReviewCreation: true },
    )
    job.launched = { ok: true, created: res.created, skipped: res.skipped, failed: [], reason: 'demo' }
  }
  publish('architect')
  return job
}

/**
 * Launch demo batches onto the mobile board, starting workers and syncing `spec_ready` jobs.
 * For Cockpit launches of generated `SEED*-1` interview batches, queues a blocked Review item.
 */
export function launchDemoSpecBatches(specRelPath, batchIds = [], { parallel = 1, skipReviewCreation = false } = {}) {
  const ids = Array.isArray(batchIds) ? batchIds : []
  const now = Date.now()
  const specs = currentSpecs(state.now)
  const created = []
  const skipped = []
  let runningBudget = Math.max(0, Number(parallel) || 1)
  let createdReview = false

  for (const id of ids) {
    if (state.tasks.some((t) => t.status !== 'archived' && t.title.startsWith(`[${id}]`))) {
      skipped.push({ batchId: id })
      continue
    }
    const owningSpec = specs.find((s) => Array.isArray(s.batches) && s.batches.some((b) => b.id === id)) || null
    const batch = owningSpec?.batches?.find((b) => b.id === id) || null
    const startRunning = runningBudget > 0
    if (startRunning) runningBudget -= 1
    const task = {
      id: `t_demo_${String(id).toLowerCase()}`,
      board: DEMO_BOARD,
      spec: specRelPath || owningSpec?.path || DEMO_SPEC_PATH,
      title: `[${id}] ${batch?.title ?? `Demo batch — ${id}`}`,
      status: startRunning ? 'running' : 'ready',
      assignee: 'mobile',
      createdAt: now,
      ...(startRunning ? { startedAt: now } : {}),
      updatedAt: now,
      priority: 0,
    }
    state.tasks.unshift(task)
    created.push({ id: task.id, batchId: id })

    if (!skipReviewCreation && /^SEED\d+-1$/i.test(String(id))) {
      const reviewId = `t_demo_review_${String(id).toLowerCase()}`
      if (!state.reviewItems.some((r) => r.id === reviewId)) {
        state.reviewItems.unshift({
          id: reviewId,
          board: DEMO_BOARD,
          title: `[${id}] ${batch?.title ?? 'Spec design interview'}`,
          status: 'blocked',
          assignee: 'mobile',
          createdAt: now,
          completedAt: null,
          result: null,
          progress: { lastEvent: 'blocked', lastEventAt: now, heartbeatAt: now, startedAt: now },
          review: {
            label: `demo-${String(id).toLowerCase()}`,
            image: null,
            hasCompare: false,
            target: 'hermes-pilot-demo',
            repo: { id: 'hermes-pilot-demo', label: 'hermes-pilot (demo)' },
            chat: DEMO_SESSION,
            mode: 'standard',
            round: 1,
            sheet: null,
            exists: true,
            title: batch?.title ?? 'Spec design interview',
            topic: batch?.objective ?? 'Review the generated interview questions.',
          },
        })
        createdReview = true
      }
    }
  }

  for (const job of state.architect.jobs) {
    if (
      job.status === 'spec_ready' &&
      (!specRelPath || job.spec === specRelPath || job.completedSpec?.path === specRelPath)
    ) {
      job.status = 'launched'
      job.launched = { ok: true, created, skipped, failed: [], reason: 'demo' }
    }
  }

  if (created.length) {
    if (state.report) state.report = null
    state.progress.batches = true
    publish('tasks')
    publish('architect')
    if (createdReview) publish('review')
    setTimeout(() => advanceBatches(state.gen), state.tickMs)
  } else if (createdReview) {
    publish('review')
  }
  return { ok: true, created, skipped }
}

/**
 * Advance linked Architect jobs & Autopilot demo pipeline after a Review item is answered/approved.
 */
export function advanceJobAfterReview(item) {
  if (!item) return
  const now = Date.now()
  const job = state.architect.jobs.find(
    (j) => j && !j.dismissed && j.reviewTaskId === item.id && j.status === 'awaiting_review',
  )
  if (job) {
    job.status = 'awaiting_spec'
    job.reviewSeenOnce = true
    job.sheetPath = job.sheetPath || 'sheets/demo-review-01.json'
    job.startedAt = now
    const archTask = job.taskId ? state.tasks.find((t) => t.id === job.taskId) : null
    if (archTask) {
      archTask.status = 'running'
      archTask.startedAt = now
      archTask.updatedAt = now
      archTask.result = 'Answers received — writing SPEC'
    }
    publish('architect')
    publish('tasks')

    const gen = state.gen
    if (job.id === 'j_demo_0') {
      setTimeout(() => {
        if (gen !== state.gen || job.status !== 'awaiting_spec') return
        const doneAt = Date.now()
        const primarySpec = currentSpecs(state.now).find((s) => s.path === DEMO_SPEC_PATH)
        job.spec = DEMO_SPEC_PATH
        if (primarySpec) {
          job.completedSpec = {
            path: primarySpec.path,
            title: primarySpec.title,
            batchCount: primarySpec.batches.length,
            batches: primarySpec.batches.map((b) => ({ id: b.id, title: b.title, mode: b.mode ?? null })),
          }
        }
        job.finishedAt = doneAt
        job.status = state.progress.batches ? 'launched' : 'spec_ready'
        if (archTask) {
          archTask.status = 'done'
          archTask.updatedAt = doneAt
          archTask.result = `SPEC ready: ${DEMO_SPEC_PATH}`
        }
        publish('architect')
        publish('tasks')
      }, state.tickMs * 4)
    } else {
      setTimeout(() => advanceArchitectJob(job.id, gen), state.tickMs * 2)
    }
  }

  if (state.progress.review && state.progress.visual && !state.progress.batches) {
    launchDemoSpecBatches(DEMO_SPEC_PATH, ['DEMO-1', 'DEMO-2', 'DEMO-3'], { parallel: 2 })
  }
}

/**
 * 指定 SPEC に起票済みのバッチ ID（`architect.filedBatchIdsForSpec` と同じ規則・D91/D92）。
 *
 * - 別 SPEC に属する `[ID]` は除外する（未スコープの照合で他 SPEC の同名バッチを
 *   「起票済み」に見せない）。
 * - `archived`（破棄済み）は起票済みに数えない（再起票できる）。
 * - 無印（Spec 行の無い）タスクは、対象 SPEC の mtime 以降に触られたものだけを数える。
 *
 * @param {Array<object>} tasks デモのタスク
 * @param {string|null} [specPath] 対象 SPEC の相対パス
 * @param {{specMtime?: number|null, slackMs?: number}} [opts] 無印タスクの時刻ガード
 * @returns {Set<string>} バッチ ID
 */
function filedBatchIdsForSpec(tasks, specPath = null, opts = {}) {
  const want = String(specPath ?? '').trim() || null
  const specMtime = Number(opts?.specMtime)
  const slack = Number.isFinite(Number(opts?.slackMs)) ? Number(opts.slackMs) : SPEC_MTIME_SLACK_MS
  const since = want && Number.isFinite(specMtime) && specMtime > 0 ? specMtime - slack : null
  const out = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task) continue
    if (String(task.status ?? '').trim().toLowerCase() === 'archived') continue
    const m = /^\[([^\]]+)\]/.exec(String(task?.title ?? '').trim())
    if (!m || !m[1].trim()) continue
    if (want) {
      const ts = demoTaskSpecOf(task)
      if (ts && ts !== want) continue
      if (!ts && since !== null && !(demoTaskStampMs(task) >= since)) continue
    }
    out.add(m[1].trim())
  }
  return out
}

/** `GET /api/architect/jobs` のデモ応答。 */
export function demoArchitectJobs(board = DEMO_BOARD) {
  const slug = String(board ?? '').trim() || DEMO_BOARD
  const jobs = state.architect.jobs.filter((j) => !slug || j.board === slug).map(demoPublicJob)
  const specReady = jobs
    .filter((j) => j.completedSpec && (j.status === 'spec_ready' || j.status === 'launched'))
    .map((j) => ({
      jobId: j.id,
      board: j.board,
      repoPath: DEMO_REPO_PATH,
      spec: j.completedSpec.path,
      title: j.completedSpec.title,
      batchCount: j.completedSpec.batchCount,
      batches: j.completedSpec.batches,
      autoStart: j.autoStart,
      launched: j.status === 'launched',
      launchedCount: j.launched?.created?.length ?? 0,
    }))
  const pending = []
  for (const spec of demoSpecsWithArchive(state.now)) {
    if (!spec || spec.archived) continue
    // 未起票の判定は SPEC スコープで行う（別 SPEC の同名バッチを「起票済み」にしない・D91）。
    const filed = filedBatchIdsForSpec(state.tasks, spec.path, { specMtime: spec.mtime })
    const ids = spec.batches.map((b) => b.id).filter((id) => !filed.has(id))
    if (!ids.length) continue
    pending.push({
      path: spec.path,
      title: spec.title,
      batchCount: spec.batches.length,
      pendingCount: ids.length,
      pending: ids,
      mtime: spec.mtime,
      board: slug,
      repoPath: DEMO_REPO_PATH,
    })
  }
  pending.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  return {
    ok: true,
    board: slug,
    runner: state.architect.runner,
    jobs,
    specReady,
    pending,
    demo: true,
  }
}


