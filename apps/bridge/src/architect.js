/**
 * Architect ランナー（SPEC V5 §3.2 / D23・D25・D26①）— 「仕様の種」から仕様書まで。
 *
 * 役割は 4 つだけ。どれも**観測できる状態**を返し、PWA が固まらないように即答する。
 *  1. `seed()`   … 1 行メモ（または音声の書き起こし）を受けて Architect を**背後で**起動し、
 *                 `202` で `jobId` を返す（タイムアウト待ちで画面を固めない）
 *  2. `jobs()`   … ジョブの進み具合と、**完成した新しい SPEC** を返す（A2B の「仕様書の準備が完了」）
 *  3. `jobs()`   … 未起票の SPEC を数えて返す（1 タップ一括起票カードの材料）
 *  4. `autoStart` … ON のジョブだけ、完成 SPEC の未起票バッチを**1 回だけ**起票する（冪等）
 *
 * ## スタックしないための終端判定（SPEC V7 §3.1）
 *
 * - 親 `[ARCH]` タスクが `done` / `archived` になったら、SPEC 未検知でもジョブは終端にして
 *   進行バー（`jobs`）から落とす。落とさないと「仕様書を書いています…」が残り続ける。
 * - `dismiss(jobId)` は破棄を**データストアに永続化**する（リロード・再起動で復活しない）。
 *   `jobs()` は破棄済みを既定で除外する（`includeDismissed: true` は監査・テスト用）。
 * - `queueState`（`queued` / `running`）で「キュー待ち」と「実行中」を区別できる形で返す。
 *
 * ## 実行ランナー
 *
 * ランナーは **`Hermes Native` の 1 本だけ**（`RUNNERS = ['hermes']`）。`hermes kanban create` で
 * `[ARCH]` タスクを起票する**公式ルート**を子プロセスで 1 回だけ呼び、あとはカンバンの
 * 自走ワーカーが仕様書を書く。外部 AI CLI の検出・パス解決・子プロセス起動は
 * SPEC V11 D50 で**完全に削除**した（サードパーティの CLI をラップ起動してサブスク枠を
 * 消費させる行為は規約違反＝BAN 対象）。`scripts/check-oauth-boundary.mjs` が再混入を機械検査する。
 * 旧 Opt-in ランナー名を指定された場合は `INVALID_RUNNER`（HTTP 400）で弾く。
 *
 * ## ステータス遷移
 *
 * `running`（CLI 実行中）→ `awaiting_spec`（CLI 正常終了・SPEC 待ち）→ `spec_ready`（完成検知）
 * → `launched`（autoStart で起票済み）/ `failed`（CLI 異常終了）
 *
 * ## 終了時の扱い（SPEC V9 D41 の決定を維持）
 *
 * ランナー（`hermes kanban create`）が非 0 終了したら `failed` に理由を残すだけで、
 * 裏で勝手に別経路の起票へ切り替えたりはしない（二重稼働・重複起票の根絶）。
 * 再試行は UI の明示操作（1 タップ再試行）だけ。
 *
 * ## ボード横断の Review 検知とフェーズ（SPEC V9 D42）
 *
 * `[review]` は `job.board` に加えて `mobile` ボードも走査する（`reviewBoardsFor`）。
 * `review/sheets/spec-*.json` の中間シートを `sheetPath` として観測し、
 * `phase`（`spawning`〜`failed`）と `stalled`（3 分無進展）を `publicJob()` で返す。
 */
import fs from 'node:fs'
import path from 'node:path'
import { listSpecs as scanSpecs, parseCreatedTask, taskStampMs } from './specs.js'
import { appendChatReport } from './pipeline-watcher.js'
import { outcomeOf, outputOf, runHermes } from './lib/cli.js'
import { DEFAULT_LANG } from './lang.js'
import { writeJsonAtomic } from './lib/atomic.js'
import { isJaLang, languageRule } from './language-rule.js'
import {
  ACTIVE_JOB_STATUSES,
  BOARD_RE,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_REVIEW_BOARD,
  DEFAULT_RUNNER,
  DISMISSED_MAX,
  JOBS_MAX,
  RUNNERS,
  RUNNER_TIMEOUT_MS,
  SPEC_LAUNCH_KIND,
  SPEC_MTIME_SLACK_MS,
  SPEC_READY_KIND,
  TERMINAL_TASK_STATUSES,
  isSupportedRunner,
  normalizeExecutionPolicy,
  pilotAssigneeOf,
  sanitizeRunner,
} from './architect/labels.js'
import {
  buildArchitectTaskTitle,
  buildSeedPrompt,
  makeJobId,
  normalizeSeed,
  recentSpecPaths,
  seedHashOf,
  suggestSpecSlug,
} from './architect/seed.js'
import { buildArchitectTaskBody, buildKanbanCreateArgs, findJobSpec, syncJobFromKanban } from './architect/task.js'
import { pendingSpecs, syncCompletedSpec, usedBatchIdPrefixes } from './architect/batch.js'
import { findRecentSheet, formatDismissedData, parseDismissedData, publicJob } from './architect/job-view.js'

/*
 * 分割したモジュールの再エクスポート。`./architect.js` からの import 契約は 1 つも変えない
 * （呼び出し側 = `server.js` / テストは従来どおりこのファイルだけを見る）。
 */
export {
  ACTIVE_JOB_STATUSES,
  ARCHITECT_PHASES,
  BOARD_RE,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_REVIEW_BOARD,
  DEFAULT_RUNNER,
  DISMISSED_MAX,
  EXECUTION_POLICIES,
  JOBS_MAX,
  RUNNERS,
  RUNNER_LABELS,
  RUNNER_TIMEOUT_MS,
  SEED_MAX,
  SEED_MIN,
  SPEC_LAUNCH_KIND,
  SPEC_MTIME_SLACK_MS,
  SPEC_READY_KIND,
  STALLED_AFTER_MS,
  TERMINAL_TASK_STATUSES,
  executionModeLabel,
  executionPolicyLines,
  isSupportedRunner,
  normalizeExecutionPolicy,
  pilotAssigneeOf,
  runnerLabel,
  sanitizeRunner,
} from './architect/labels.js'
export { buildAutopilotDeliverableLines, buildAutopilotRound1Lines } from './architect/autopilot.js'
export { EXISTING_SPECS_MAX, SPEC_SLUG_MAX, buildArchitectTaskTitle, buildSeedPrompt, makeJobId, normalizeSeed, recentSpecPaths, seedHashOf, suggestSpecSlug } from './architect/seed.js'
export {
  buildArchitectTaskBody,
  buildKanbanCreateArgs,
  findActiveJobReviewTask,
  findJobReviewTask,
  findJobSpec,
  isReviewTask,
  reviewSheetReady,
} from './architect/task.js'
export {
  batchIdPrefixForSlug,
  batchIdPrefixOf,
  filedBatchIds,
  filedBatchIdsForSpec,
  pendingSpecs,
  queueStateOf,
  reviewBoardsFor,
  usedBatchIdPrefixes,
} from './architect/batch.js'
export { computePhase, findRecentSheet, isJobStalled, publicJob } from './architect/job-view.js'

/**
 * 既定のランナー実行（公式 CLI の子プロセス。シェルは介さない）。
 *
 * `hermes kanban --board <b> create "[ARCH] …" --assignee mobile --json --body …` という
 * **正規ルート**でカンバンに Architect タスクを起票する（自走ワーカーが着火する）。
 * 外部 AI CLI のラッパー起動は SPEC V11 D50 で廃止した（`RUNNERS = ['hermes']` の 1 本だけ）。
 * `PATH` は `lib/cli.js` の `runHermes()` が `buildAugmentedPath()` で補う（`launchd` の狭い PATH 対策）。
 * @param {object} [cfg] 設定（`hermesBin`）
 * @returns {Function} `({runnerId, prompt, repoPath, board, seedText, jobId, executionPolicy, suggestedSlug, existingSpecs, timeoutMs}) => Promise<{ok,code,stdout,stderr,timedOut,bin,args}>`
 */
export function createCliRunner(cfg = {}) {
  return ({
    runnerId, prompt, repoPath, board = '', seedText = '', jobId = '',
    executionPolicy = DEFAULT_EXECUTION_POLICY, autopilot = false, lang = DEFAULT_LANG,
    suggestedSlug, existingSpecs, usedBatchPrefixes, timeoutMs = RUNNER_TIMEOUT_MS,
  }) => {
    const slug = String(suggestedSlug ?? '').trim() || suggestSpecSlug(seedText || prompt, jobId)
    const title = buildArchitectTaskTitle({ seedText: seedText || prompt })
    const body = buildArchitectTaskBody({
      prompt, board, repoPath, jobId, executionPolicy, autopilot: Boolean(autopilot),
      suggestedSlug: slug, existingSpecs, usedBatchPrefixes, lang,
    })
    const args = buildKanbanCreateArgs({ board, title, body, assignee: pilotAssigneeOf(cfg) })
    // `bin` / `args` は新形（`lib/cli.js` の統一形）から取る。
    return runHermes(args, { bin: cfg.hermesBin, cwd: repoPath, timeoutMs, maxBuffer: 4_000_000 })
  }
}
/**
 * Architect を作る。
 *
 * @param {object} [cfg] 設定（`reviewDir` / `pluginDataDir` / `hermesBin` / `dataDir`）
 * @param {object} [deps] 差し替え（テスト用）
 * @param {Function} [deps.runner] ランナー（`createCliRunner` の形）
 * @param {Function} [deps.listSpecs] SPEC 走査（既定 `specs.listSpecs`）
 * @param {Function} [deps.readTasks] ボードのタスク読み取り
 * @param {Function} [deps.launchSpec] 一括起票（既定 `specs.createSpecs().launchSpec`）
 * @param {Function} [deps.appendReport] `chat-reports.jsonl` 追記
 * @param {Function} [deps.now] 時刻
 * @param {Function} [deps.statSync] ディレクトリ確認
 * @returns {{seed: Function, jobs: Function, getConfig: Function, setConfig: Function, reset: Function}} 操作
 */
export function createArchitect(cfg = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const runner = deps.runner ?? createCliRunner(cfg)
  const listSpecsFn = deps.listSpecs ?? ((repoPath) => scanSpecs(repoPath))
  const readTasks = deps.readTasks ?? (() => [])
  const statSync = deps.statSync ?? ((p) => fs.statSync(p))
  const report =
    deps.appendReport ??
    ((row) => {
      try {
        return appendChatReport(cfg, row)
      } catch {
        return null // 記録に失敗しても起票や検知は止めない
      }
    })

  // 一括起票は specs.js の実装を使う（起票・スキップ判定・ラン記録を二重実装しない）
  let launchSpec = deps.launchSpec ?? null

  /** @type {Map<string, object>} */
  const jobs = new Map()

  const configPath = cfg.dataDir ? path.join(cfg.dataDir, 'architect-config.json') : null

  // 破棄したジョブ（リロード・再起動で復活させない・種ハッシュも含め D105）。SPEC V7 §3.1②
  const dismissedPath = cfg.dataDir ? path.join(cfg.dataDir, 'architect-dismissed.json') : null
  const { ids: dismissedIds, seeds: dismissedSeeds } = loadDismissed()

  /** 破棄済み ID / 種ハッシュを読む（壊れた JSON・不在は空集合）。 */
  function loadDismissed() {
    if (!dismissedPath) return parseDismissedData(null)
    try {
      return parseDismissedData(JSON.parse(fs.readFileSync(dismissedPath, 'utf8')))
    } catch {
      return parseDismissedData(null)
    }
  }

  /** 破棄済み ID / 種ハッシュを保存する（最新 `DISMISSED_MAX` 件）。 */
  function saveDismissed() {
    if (!dismissedPath) return true
    try {
      writeJsonAtomic(dismissedPath, formatDismissedData(dismissedIds, dismissedSeeds, DISMISSED_MAX), { newline: true })
      return true
    } catch {
      return false // 保存に失敗してもジョブはメモリ上で破棄済みにする（再取得で戻るのは次善）
    }
  }

  /** ジョブが破棄済みか。 */
  function isDismissed(job) {
    return (
      Boolean(job?.dismissed) ||
      dismissedIds.has(String(job?.id ?? '')) ||
      Boolean(job?.seedHash && dismissedSeeds.has(String(job.seedHash)))
    )
  }

  /** ジョブが終端（親 [ARCH] が done / archived）か。 */
  function isTerminal(job) {
    return TERMINAL_TASK_STATUSES.includes(String(job?.status ?? ''))
  }

  /**
   * 設定（既定 `{runner:'hermes'}`）。壊れた JSON も未知の値も既定へ戻す。
   * @returns {{runner: 'hermes'}} 設定
   */
  function getConfig() {
    if (!configPath) return { runner: DEFAULT_RUNNER }
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return { runner: sanitizeRunner(raw?.runner) }
    } catch {
      return { runner: DEFAULT_RUNNER }
    }
  }

  /**
   * ランナーを保存する（**`hermes` 以外は受け付けない**。SPEC V11 D50）。
   * @param {unknown} value ランナー
   * @returns {{ok: boolean, runner?: string, code?: string, error?: string}} 結果
   */
  function setConfig(value) {
    const raw = value?.runner ?? value
    if (!isSupportedRunner(raw)) {
      return { ok: false, code: 'INVALID_RUNNER', error: 'Only the Hermes Native runner is supported' }
    }
    if (configPath) {
      try {
        writeJsonAtomic(configPath, { runner: DEFAULT_RUNNER }, { newline: true })
      } catch (e) {
        return { ok: false, code: 'WRITE_FAILED', error: e.message }
      }
    }
    return { ok: true, runner: DEFAULT_RUNNER }
  }

  /**
   * 仕様の種を撒く（202 で即答し、ランナーは背後で走る）。
   * @param {object} input `{repoPath, board, seedText, runner?, autoStart?, executionPolicy?, chat?, lang?}`
   * @returns {Promise<object>} `{ok, jobId, status, runner, executionPolicy, autoStart}` または `{ok:false, code, error}`
   */
  async function seed(input = {}) {
    const seedText = normalizeSeed(input.seedText)
    if (!seedText) return { ok: false, code: 'INVALID_SEED', error: 'seedText is required' }

    const board = String(input.board ?? '').trim()
    if (!BOARD_RE.test(board)) return { ok: false, code: 'INVALID_BOARD', error: 'board is invalid' }

    const repoPath = String(input.repoPath ?? '').trim()
    if (!repoPath || !path.isAbsolute(repoPath)) {
      return { ok: false, code: 'INVALID_REPO', error: 'repoPath must be an absolute path' }
    }
    try {
      if (!statSync(repoPath)?.isDirectory?.()) {
        return { ok: false, code: 'INVALID_REPO', error: 'repoPath is not a directory' }
      }
    } catch {
      return { ok: false, code: 'INVALID_REPO', error: 'repoPath does not exist' }
    }

    if (!isSupportedRunner(input.runner ?? getConfig().runner)) {
      return { ok: false, code: 'INVALID_RUNNER', error: 'Only the Hermes Native runner is supported' }
    }
    const runnerId = DEFAULT_RUNNER

    const startedAt = now()
    const executionPolicy = normalizeExecutionPolicy(input.executionPolicy)
    const seedHash = seedHashOf(seedText)
    // 明示的に再投入・再試行された種ハッシュは過去の破棄記録から外す（再試行直後に消えない）
    if (dismissedSeeds.delete(seedHash)) saveDismissed()
    const job = {
      id: makeJobId(startedAt, Math.random, seedHash),
      seedHash,
      board,
      repoPath,
      status: 'running',
      runner: runnerId,
      requestedRunner: runnerId,
      fallbackFrom: null,
      fallbackReason: null,
      taskId: null,
      taskStatus: null,
      queueState: null,
      executionPolicy,
      dismissed: false,
      reviewTaskId: null,
      reviewTitle: null,
      mode: 'kanban',
      prompt: '',
      autoStart: Boolean(input.autoStart),
      seedText,
      lang: input.lang === 'en' ? 'en' : 'ja',
      chat: input.chat ? String(input.chat).slice(0, 128) : null,
      createdAt: startedAt,
      startedAt,
      finishedAt: null,
      spec: null,
      completedSpec: null,
      launched: null,
      launchStarted: false,
      error: null,
    }
    jobs.set(job.id, job)
    trimJobs()

    // SPEC V11 D54: 推奨スラッグと既存 SPEC 一覧を先に決めてプロンプトへ入れる
    // （Round 1 の探索ターンとファイル名衝突を減らす）。
    // D91: アクティブ SPEC で使用済みのバッチ ID 接頭辞も渡し、ID の衝突を防ぐ。
    const suggestedSlug = suggestSpecSlug(seedText, job.id)
    let specScan = []
    try {
      specScan = listSpecsFn(repoPath) ?? []
    } catch {
      specScan = []
    }
    const existingSpecs = recentSpecPaths(() => specScan, repoPath)
    const usedBatchPrefixes = usedBatchIdPrefixes(specScan)
    job.suggestedSlug = suggestedSlug

    const prompt = buildSeedPrompt({
      jobId: job.id, seedText, board, repoPath, autoStart: job.autoStart,
      executionPolicy, autopilot: Boolean(input.autopilot), lang: job.lang,
      suggestedSlug, existingSpecs, usedBatchPrefixes,
    })
    job.prompt = prompt

    // 背後の実行。落ちてもジョブに理由を残すだけで、呼び出し元は待たない。
    void Promise.resolve()
      .then(() =>
        runner({
          runnerId, prompt, repoPath, board, seedText, jobId: job.id,
          executionPolicy, autopilot: Boolean(input.autopilot), lang: job.lang,
          suggestedSlug, existingSpecs, usedBatchPrefixes,
        }),
      )
      .then(async (res) => {
        job.finishedAt = now()
        // 注入ランナーの旧形（`{code,stdout}`）も統一形へ揃えてから判定する。
        const outcome = outcomeOf(res)
        const code = typeof outcome.code === 'number' ? outcome.code : (outcome.ok ? 0 : 1)
        const taskId = res?.taskId ?? parseCreatedTask(outcome.stdout)?.id ?? null
        if (code !== 0) {
          // 失敗しても自動で別経路の起票へ切り替えない（二重稼働・重複起票を根絶）。
          // 再試行は UI の明示操作（1 タップ再試行）だけ。
          const reason = String(outputOf(outcome) || `runner exited with ${code}`).trim()
          job.status = 'failed'
          job.error = reason.slice(0, 600)
          return
        }
        if (taskId) job.taskId = taskId
        job.status = 'awaiting_spec'
      })
      .catch((e) => {
        job.finishedAt = now()
        job.status = 'failed'
        job.error = String(e?.message ?? e).slice(0, 600)
      })

    return {
      ok: true,
      jobId: job.id,
      status: job.status,
      runner: runnerId,
      executionPolicy,
      autoStart: job.autoStart,
    }
  }

  /** 古いジョブを落とす（メモリだけの保持）。 */
  function trimJobs() {
    if (jobs.size <= JOBS_MAX) return
    const ordered = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
    while (ordered.length > JOBS_MAX) {
      const old = ordered.shift()
      jobs.delete(old.id)
    }
  }

  /**
   * ジョブの進み具合と、完成 SPEC・未起票 SPEC を返す。
   * @param {{board?: string, repoPath?: string, include?: {repoPath?: string, board?: string}, includeDismissed?: boolean, strictBoard?: boolean}} [query] 絞り込み
   *   `include` はジョブが 1 つも無いボードでも「未起票 SPEC」を数えるための追加走査先
   *   `includeDismissed` は破棄済みジョブも返す（監査・テスト用。既定は除外）
   *   `strictBoard` は選択中ボードと完全一致するジョブだけに絞る（V7 互換。既定はボード横断）
   * @returns {Promise<object>} `{ok, board, runner, capabilities, jobs, specReady, pending}`
   */
  async function jobsFor(query = {}) {
    const board = String(query.board ?? '').trim()
    const at = now()
    // D42: 既定は「アクティブで未破棄なジョブ」をボード・リポジトリ横断で返す。
    // 別ボードで撒いた種でも進行バーが消えないようにするため（`strictBoard: true` で V7 互換）。
    const mine = [...jobs.values()]
      .filter((j) => {
        const sameBoard = !board || j.board === board
        const sameRepo = !query.repoPath || j.repoPath === query.repoPath
        if (query.strictBoard === true) return sameBoard && sameRepo
        if (sameBoard && sameRepo) return true
        if (query.includeDismissed) return true
        return !isDismissed(j) && !isTerminal(j) && ACTIVE_JOB_STATUSES.includes(String(j.status ?? '').trim())
      })
      .sort((a, b) => b.createdAt - a.createdAt)

    // リポジトリごとに 1 回だけ SPEC を走査する
    const specsByRepo = new Map()
    const specsOf = (repoPath) => {
      if (!specsByRepo.has(repoPath)) {
        let list = []
        try {
          list = listSpecsFn(repoPath) ?? []
        } catch {
          list = []
        }
        specsByRepo.set(repoPath, Array.isArray(list) ? list : [])
      }
      return specsByRepo.get(repoPath)
    }

    // カンバンのタスク状態を先にジョブへ写す（Round 2 実行中のフライング SPEC 検知を防ぐ・問題②/⑤）
    const tasksByBoard = new Map()
    const tasksOf = (slug) => {
      const key = String(slug ?? '')
      if (!tasksByBoard.has(key)) {
        let list = []
        try {
          list = readTasks(key) ?? []
        } catch {
          list = []
        }
        tasksByBoard.set(key, Array.isArray(list) ? list : [])
      }
      return tasksByBoard.get(key)
    }

    if (cfg.reviewDir) {
      for (const job of mine) {
        if (job.sheetPath || !['running', 'awaiting_spec', 'awaiting_review'].includes(job.status)) continue
        try {
          job.sheetPath = findRecentSheet(cfg.reviewDir, job)
        } catch {
          job.sheetPath = null
        }
      }
    }

    const revBoard = String(cfg.reviewBoard ?? DEFAULT_REVIEW_BOARD).trim() || DEFAULT_REVIEW_BOARD
    const writerActiveJobs = new Set()
    const justDoneJobs = new Set()
    const activeWriterSinceByRepo = new Map()
    const markWriter = (job) => {
      writerActiveJobs.add(job.id)
      const cur = activeWriterSinceByRepo.get(job.repoPath)
      if (cur === undefined || Number(job.startedAt) < cur) activeWriterSinceByRepo.set(job.repoPath, Number(job.startedAt))
    }

    for (const job of mine) {
      const wasActive = ['running', 'awaiting_spec', 'awaiting_review'].includes(job.status)
      if (syncJobFromKanban(job, { tasksOf, reviewDir: cfg.reviewDir, revBoard, at })) markWriter(job)
      else if (wasActive && job.status === 'done' && !job.spec) justDoneJobs.add(job.id)
    }

    // 先に「他のジョブが取った SPEC」を集める（新しいジョブが横取りしない）
    const taken = new Set()
    for (const job of [...mine].reverse()) {
      if (job.spec) taken.add(String(job.spec))
    }

    // 執筆タスク完了後だけ SPEC 完成へ遷移させる（Round 2 中の部分ファイル検知を防ぐ・問題⑤）
    for (const job of [...mine].reverse()) {
      const readyToCheck = ['awaiting_spec', 'awaiting_review', 'running'].includes(job.status) || justDoneJobs.has(job.id)
      if (!readyToCheck || job.spec) continue
      if (writerActiveJobs.has(job.id)) continue
      const found = findJobSpec(job, specsOf(job.repoPath), { taken })
      if (!found) continue
      taken.add(String(found.path))
      job.spec = found.path
      job.status = 'spec_ready'
      job.completedSpec = {
        path: found.path,
        title: found.title,
        batchCount: (found.batches ?? []).length,
        batches: (found.batches ?? []).map((b) => ({ id: b.id, title: b.title, mode: b.mode ?? null })),
      }
      report({
        kind: SPEC_READY_KIND,
        board: job.board,
        jobId: job.id,
        spec: found.path,
        title: found.title,
        batchCount: job.completedSpec.batchCount,
        autoStart: job.autoStart,
        originSessionId: job.chat,
        at: now(),
      })
    }

    // 公開表現の `stage`（カンバンタスクが動いている間は running として見せる）
    for (const job of mine) {
      job.stage =
        job.status === 'awaiting_spec' && ['running', 'claimed'].includes(String(job.taskStatus ?? ''))
          ? 'running'
          : job.status
    }

    // 進行バーに出すジョブ（破棄済み・終端は既定で落とす）。SPEC V7 §3.1②
    const visible = mine.filter((job) => !isTerminal(job) && (query.includeDismissed || !isDismissed(job)))

    // autoStart: 完成 SPEC の未起票バッチを 1 回だけ起票する
    for (const job of visible) {
      if (!job.autoStart || job.status !== 'spec_ready' || job.launchStarted) continue
      job.launchStarted = true
      let tasks = []
      try {
        tasks = readTasks(job.board) ?? []
      } catch {
        tasks = []
      }
      const spec = specsOf(job.repoPath).find((s) => s.path === job.spec) ?? null
      const pending = spec ? pendingSpecs([spec], tasks) : []
      if (!spec || !pending.length) {
        // 既に起票済み（別経路で人が起票した）なら成功と同じ扱いで閉じる
        job.status = 'launched'
        job.launched = { ok: true, created: [], skipped: [], failed: [], reason: 'nothing-pending' }
        continue
      }
      try {
        if (!launchSpec) {
          const { createSpecs } = await import('./specs.js')
          launchSpec = createSpecs(cfg, { tasks: readTasks }).launchSpec
        }
        const res = await launchSpec({
          repoPath: job.repoPath,
          board: job.board,
          specRelPath: job.spec,
          batchIds: pending[0].pending,
          assignee: pilotAssigneeOf(cfg),
          chat: job.chat ?? undefined, lang: job.lang,
        })
        job.status = 'launched'
        job.launched = {
          ok: Boolean(res?.ok),
          runId: res?.runId ?? null,
          created: (res?.created ?? []).map((c) => ({ id: c.id, taskId: c.taskId ?? null })),
          skipped: (res?.skipped ?? []).map((s) => ({ id: s.id, taskId: s.taskId ?? null })),
          failed: res?.failed ?? [],
          error: res?.error ?? null,
        }
        report({
          kind: SPEC_LAUNCH_KIND,
          board: job.board,
          jobId: job.id,
          spec: job.spec,
          created: job.launched.created.length,
          skipped: job.launched.skipped.length,
          failed: job.launched.failed.length,
          autoStart: true,
          originSessionId: job.chat,
          at: now(),
        })
      } catch (e) {
        job.status = 'spec_ready'
        job.launched = { ok: false, created: [], skipped: [], failed: [], error: String(e?.message ?? e).slice(0, 400) }
      }
      tasksByBoard.delete(job.board)
    }

    // 手動起票後に残る凍結バナーを防ぎ、最新バッチ構成へ同期する（問題③・⑤）
    for (const job of visible) {
      if (job.status === 'spec_ready' && job.spec) {
        syncCompletedSpec(job, specsOf(job.repoPath), tasksOf(job.board))
      }
    }

    // 未起票の SPEC（Seed と関係なくても、新しく置かれた SPEC を拾う。執筆中の未完成 SPEC は除外）
    const pending = []
    const seenRepo = new Set()
    const scans = visible.map((job) => ({ repoPath: job.repoPath, board: job.board }))
    if (query.include?.repoPath) scans.push({ repoPath: query.include.repoPath, board: query.include.board ?? board })
    for (const scan of scans) {
      if (seenRepo.has(scan.repoPath)) continue
      seenRepo.add(scan.repoPath)
      const writingSince = activeWriterSinceByRepo.get(scan.repoPath)
      const repoSpecs =
        writingSince === undefined
          ? specsOf(scan.repoPath)
          : specsOf(scan.repoPath).filter((s) => !(Number(s?.mtime ?? 0) >= writingSince - SPEC_MTIME_SLACK_MS))
      for (const row of pendingSpecs(repoSpecs, tasksOf(scan.board))) {
        pending.push({ ...row, board: scan.board, repoPath: scan.repoPath })
      }
    }

    const specReady = visible
      .filter((j) => j.completedSpec && (j.status === 'spec_ready' || j.status === 'launched'))
      .map((j) => ({
        jobId: j.id,
        board: j.board,
        repoPath: j.repoPath,
        spec: j.completedSpec.path,
        title: j.completedSpec.title,
        batchCount: j.completedSpec.batchCount,
        batches: j.completedSpec.batches,
        autoStart: j.autoStart,
        launched: j.status === 'launched',
        launchedCount: j.launched?.created?.length ?? 0,
      }))

    return {
      ok: true,
      board: board || null,
      runner: getConfig().runner,
      jobs: visible.map((job) => publicJob(job, { at })),
      specReady,
      pending,
    }
  }

  /**
   * ジョブを破棄する（サーバー側に永続化し、リロード・再起動で復活させない）。SPEC V7 §3.1②。
   *
   * 破棄は**監査のための記録**であってタスクの削除ではない（カンバン側は触らない）。
   * @param {unknown} jobId ジョブ ID
   * @returns {{ok: boolean, jobId?: string, persisted?: boolean, code?: string, error?: string}} 結果
   */
  function dismiss(jobId) {
    const id = String(jobId ?? '').trim()
    if (!id) return { ok: false, code: 'INVALID_JOB_ID', error: 'jobId is required' }
    const job = jobs.get(id) ?? null
    if (!job && !dismissedIds.has(id)) return { ok: false, code: 'JOB_NOT_FOUND', error: 'job not found' }
    if (job) {
      job.dismissed = true
      job.dismissedAt = now()
      const hasNewerSameSeed =
        job.seedHash &&
        [...jobs.values()].some((o) => o && o.id !== id && o.seedHash === job.seedHash && !o.dismissed && !isTerminal(o))
      if (job.seedHash && !hasNewerSameSeed) dismissedSeeds.add(String(job.seedHash))
    }
    dismissedIds.add(id)
    trimDismissed()
    const persisted = saveDismissed() && dismissedPath !== null
    return { ok: true, jobId: id, persisted }
  }

  /** 破棄 ID / 種ハッシュの保持数を上限へ丸める（古いものから落とす）。 */
  function trimDismissed() {
    for (const set of [dismissedIds, dismissedSeeds]) {
      while (set.size > DISMISSED_MAX) {
        const oldest = set.values().next().value
        if (oldest == null) break
        set.delete(oldest)
      }
    }
  }

  /** テスト用にジョブを捨てる。 */
  function reset() {
    jobs.clear()
    dismissedIds.clear()
    dismissedSeeds.clear()
  }

  return { seed, jobs: jobsFor, dismiss, getConfig, setConfig, reset }
}
