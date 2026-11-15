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
 * ## 実行ランナーと境界（ToS / OAuth）
 *
 * - 既定は `hermes`（Hermes Native）。`hermes -z <prompt> --in <repo>` の**公式 CLI を子プロセス**で 1 回だけ起動する。
 * - `antigravity` は Opt-in。`agy` の**公式ローカル CLI を子プロセス**で起動するだけで、
 *   Antigravity の OAuth 認証ファイルの読み取り・トークン流用・
 *   非公式エンドポイントのプロキシは**一切行わない**。`hasAgyCli`（実行ファイルの存在）だけを見る。
 *   `scripts/check-oauth-boundary.mjs` がこの境界を機械的に検査する。
 *
 * ## ステータス遷移
 *
 * `running`（CLI 実行中）→ `awaiting_spec`（CLI 正常終了・SPEC 待ち）→ `spec_ready`（完成検知）
 * → `launched`（autoStart で起票済み）/ `failed`（CLI 異常終了）
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { listSpecs as scanSpecs, parseCreatedTask } from './specs.js'
import { appendChatReport } from './pipeline-watcher.js'
import { buildAugmentedPath, resolveAgyBin, resolveHermesBin } from './capabilities.js'

/** `chat-reports.jsonl` の行種別（仕様書が完成した）。 */
export const SPEC_READY_KIND = 'spec_ready'
/** `chat-reports.jsonl` の行種別（autoStart がバッチを起票した）。 */
export const SPEC_LAUNCH_KIND = 'spec_launch'

/** 選べるランナー。既定は Hermes Native（公開プラグインの単体完動性）。 */
export const RUNNERS = ['hermes', 'antigravity']

/** 0 行の種はインタビューにならない。長すぎる種はプロンプトを壊す。 */
export const SEED_MIN = 1
/** 種の最大文字数。 */
export const SEED_MAX = 4000
/** 保持するジョブ数（古いものから落とす）。 */
export const JOBS_MAX = 40
/** 「このジョブが作った SPEC」と見なす mtime の猶予（秒ズレ対策）。 */
export const SPEC_MTIME_SLACK_MS = 5000
/** ランナーの既定タイムアウト（ミリ秒）。 */
export const RUNNER_TIMEOUT_MS = 15 * 60 * 1000
/** ボード名の書式（`specs.launchSpec` と同じ）。 */
export const BOARD_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** ランナーの表示名。 */
export const RUNNER_LABELS = {
  hermes: 'Hermes Native',
  antigravity: 'Antigravity (agy)',
}

/**
 * ランナー ID を正規化する（未知は `hermes`）。
 * @param {unknown} value 入力
 * @returns {'hermes'|'antigravity'} ランナー
 */
export function sanitizeRunner(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return RUNNERS.includes(text) ? text : 'hermes'
}

/**
 * ランナーの表示名。
 * @param {unknown} value 入力
 * @returns {string} 表示名
 */
export function runnerLabel(value) {
  return RUNNER_LABELS[sanitizeRunner(value)]
}

/**
 * [`[ARCH]` タスクのタイトル]（カンバン起票に載る 1 行）。
 * @param {{seedText?: string, prompt?: string}} input 入力
 * @returns {string} タイトル
 */
export function buildArchitectTaskTitle({ seedText, prompt } = {}) {
  const line = String(seedText ?? prompt ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean)
  return `[ARCH] ${String(line ?? 'Spec seed').slice(0, 80)}`
}

/**
 * [`[ARCH]` タスクの本文]（spec-architect プロトコル＋実行契約）。
 *
 * カンバン起票に載せるので、ワーカーが**チャットを見なくても**完走できる内容にする。
 * @param {{prompt: string, board: string, repoPath: string, jobId: string}} input 入力
 * @returns {string} 本文
 */
export function buildArchitectTaskBody({ prompt, board, repoPath, jobId }) {
  return [
    `[hermes-pilot:architect job=${jobId}] Architect (Kanban native)`,
    '',
    prompt,
    '',
    '---',
    '[Hermes Pilot Execution Contract]',
    'Mode: zero-stop',
    'Follow the `spec-architect` skill protocol for the seed above.',
    'Round 1: write the Quick Review sheet and file it as a blocked `[review]` task. Do not wait in chat.',
    'Round 2: after the answers arrive, write `docs/SPEC-<SLUG>.md` with `### Batch <ID>: <Title>` sections,',
    'each carrying **Execution Mode** / **目的** / **変更・新規ファイル** / **受入条件（Verify）**.',
    'Stay inside the official local CLI: never read or reuse Antigravity OAuth credentials or profiles.',
    `Board: ${board}`,
    `Repository: ${repoPath}`,
  ].join('\n')
}

/**
 * `hermes kanban create` の引数（`specs.js` / `capture.js` と同じ正規ルート）。
 * @param {{board: string, title: string, body: string, assignee?: string}} input 入力
 * @returns {string[]} 引数
 */
export function buildKanbanCreateArgs({ board, title, body, assignee = 'mobile' }) {
  return ['kanban', '--board', String(board ?? ''), 'create', String(title ?? ''), '--json', '--body', String(body ?? ''), '--assignee', String(assignee ?? 'mobile')]
}

/**
 * 「[review] タスク」かどうか（タイトル・本文・ラベルを見る。読むだけ）。
 * @param {object} task タスク
 * @returns {boolean} review タスクなら true
 */
export function isReviewTask(task) {
  if (!task) return false
  const labels = [task.label, ...(Array.isArray(task.labels) ? task.labels : [])].filter(Boolean).map((l) => String(l))
  const text = [task.title, task.body].filter(Boolean).map((v) => String(v)).join('\n')
  return /\[review\]/i.test(text) || labels.some((l) => /^\[?review\]?$/i.test(l.trim()))
}

/**
 * ジョブが待っている Quick Review タスクを見つける（純関数）。
 *
 * 条件: ① `job.taskId` と一致するタスク、または `startedAt - 猶予` 以降に作られた `[review]` タスク。
 * ② そのタスクが `blocked` で、`[review]` の印を持つ（＝人の回答待ち）。
 *
 * @param {{taskId?: string|null, startedAt: number}} job ジョブ
 * @param {Array<object>} tasks ボードのタスク
 * @param {{slackMs?: number}} [opts] 制約
 * @returns {{taskId: string, title: string, status: string}|null} 待機中タスク（無ければ null）
 */
export function findJobReviewTask(job, tasks, { slackMs = SPEC_MTIME_SLACK_MS } = {}) {
  const since = Number(job?.startedAt ?? 0) - slackMs
  const ownId = job?.taskId ? String(job.taskId) : ''
  const list = Array.isArray(tasks) ? tasks : []
  for (const task of list) {
    if (!task || !task.id) continue
    const same = ownId && String(task.id) === ownId
    const fresh = Number(task.createdAt ?? 0) >= since
    if (!same && !fresh) continue
    if (!isReviewTask(task)) continue
    if (String(task.status ?? '') !== 'blocked') continue
    return { taskId: String(task.id), title: String(task.title ?? ''), status: 'blocked' }
  }
  return null
}

/**
 * ジョブ ID（`arch-<base36 時刻>-<乱数 4>`）。
 * @param {number} [ms] 時刻
 * @param {Function} [rand] 乱数（テスト用）
 * @returns {string} ジョブ ID
 */
export function makeJobId(ms = Date.now(), rand = Math.random) {
  const tail = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `arch-${ms.toString(36)}-${tail}`
}

/**
 * 種の本文を整える（前後の空白だけ落とし、改行は保つ）。
 * @param {unknown} value 入力
 * @returns {string} 本文（不正なら空文字）
 */
export function normalizeSeed(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (text.length < SEED_MIN) return ''
  return text.slice(0, SEED_MAX)
}

/**
 * Architect へ渡すプロンプト（`spec-architect` プロトコル）。
 *
 * 長文の質問を並べるのではなく、Quick Review シート → 1 タップ承認 → SPEC 生成、の順を固定する。
 * @param {{jobId: string, seedText: string, board: string, repoPath: string, autoStart?: boolean, lang?: string}} input 入力
 * @returns {string} プロンプト
 */
export function buildSeedPrompt({ jobId, seedText, board, repoPath, autoStart = false, lang = 'ja' }) {
  const auto = autoStart
    ? 'The PWA will file the batches automatically as soon as this SPEC appears, so do not file them yourself.'
    : 'Do not file anything yet: the user taps "File batches & start" once the SPEC is ready.'
  return [
    `[hermes-pilot:architect job=${jobId}]`,
    'You are the spec-architect. Follow the `spec-architect` skill protocol (Round 1 → Round 2).',
    '',
    'Seed (the user dictation, verbatim):',
    '"""',
    seedText,
    '"""',
    '',
    `Repository: ${repoPath}`,
    `Board: ${board}`,
    `UI language: ${lang}`,
    '',
    'Round 1 — instead of a wall of chat questions, write a Quick Review sheet with 2-5 design',
    'decisions (each option marked `recommended: true` for the best one) under review/sheets/,',
    'then file it as a blocked [review] kanban task so the phone gets it as a 1-tap form. Stop there.',
    'Round 2 — after the answers arrive, write docs/SPEC-<SLUG>.md. Every batch heading',
    '`### Batch <ID>: <Title>` must be followed by:',
    '  - **Execution Mode**: [Mode: Zero-Stop | Fast-Track Review | Visual Gate]',
    '  - **目的**: one paragraph of intent',
    '  - **変更・新規ファイル**: the exact paths to touch',
    '  - **受入条件（Verify）**: the command that proves it works',
    '',
    auto,
  ].join('\n')
}

/**
 * 既定のランナー実行（公式 CLI の子プロセス。シェルは介さない）。
 *
 * - `hermes`（既定）: `hermes kanban --board <b> create "[ARCH] …" --assignee mobile --json --body …`
 *   という**正規ルート**でカンバンに Architect タスクを起票する（自走ワーカーが着火する）。
 * - `antigravity`: `agy -p <prompt> --mode auto` を `cwd: repoPath` で実行する。
 *   どちらも `PATH` は `buildAugmentedPath()` で補う（`launchd` の狭い PATH 対策）。
 *
 * `agy` でもクレデンシャルには触れない: バイナリ名と引数だけを渡し、CLI 自身に認証を任せる。
 * @param {object} [cfg] 設定（`hermesBin` / `agyBin`）
 * @returns {Function} `({runnerId, prompt, repoPath, board, seedText, jobId, timeoutMs}) => Promise<{code,stdout,stderr}>`
 */
export function createCliRunner(cfg = {}) {
  return ({ runnerId, prompt, repoPath, board = '', seedText = '', jobId = '', timeoutMs = RUNNER_TIMEOUT_MS }) =>
    new Promise((resolve) => {
      const antigravity = sanitizeRunner(runnerId) === 'antigravity'
      let bin = ''
      let args = []
      if (antigravity) {
        bin = cfg.agyBin ?? resolveAgyBin()
        args = ['-p', prompt, '--mode', 'auto']
      } else {
        bin = cfg.hermesBin ?? resolveHermesBin()
        const title = buildArchitectTaskTitle({ seedText: seedText || prompt })
        const body = buildArchitectTaskBody({ prompt, board, repoPath, jobId })
        args = buildKanbanCreateArgs({ board, title, body })
      }
      execFile(
        bin,
        args,
        { cwd: repoPath, timeout: timeoutMs, maxBuffer: 4_000_000, env: { ...process.env, PATH: buildAugmentedPath() } },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), bin, args })
        },
      )
    })
}

/**
 * ジョブが作ったと見なせる SPEC を 1 つ選ぶ。
 *
 * 条件: バッチを持つ / `startedAt` 以降に更新された（猶予あり） / 他のジョブが先に取っていない。
 * @param {{startedAt: number}} job ジョブ
 * @param {Array<{path: string, title: string, mtime: number, batches: Array<object>}>} specs SPEC 一覧
 * @param {{taken?: Set<string>, slackMs?: number}} [opts] 制約
 * @returns {object|null} SPEC（無ければ null）
 */
export function findJobSpec(job, specs, { taken = new Set(), slackMs = SPEC_MTIME_SLACK_MS } = {}) {
  const since = Number(job?.startedAt ?? 0) - slackMs
  const candidates = (Array.isArray(specs) ? specs : []).filter(
    (s) => s && (s.batches ?? []).length > 0 && Number(s.mtime ?? 0) >= since && !taken.has(String(s.path)),
  )
  if (!candidates.length) return null
  // 一番新しいもの（同じ秒に複数あればパス順で安定させる）
  return [...candidates].sort((a, b) => Number(b.mtime) - Number(a.mtime) || String(a.path).localeCompare(String(b.path)))[0]
}

/**
 * タスク一覧から「起票済みのバッチ ID」を集める（**状態を問わない**）。
 *
 * 完了済み（`done`）を未起票と数えると、バナーが「起票して開始」を出して
 * 同じバッチをもう一度起票してしまう（`specs.launchSpec` がスキップするのは
 * **未完了**の重複だけ）。ここは「タスクが 1 つでもあるか」で数える。
 *
 * @param {Array<{title?: string}>} tasks ボードのタスク
 * @returns {Set<string>} バッチ ID
 */
export function filedBatchIds(tasks) {
  const out = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const m = /^\[([^\]]+)\]/.exec(String(task?.title ?? '').trim())
    if (m && m[1].trim()) out.add(m[1].trim())
  }
  return out
}

/**
 * 未起票の SPEC を数える（A2B の 1 タップ一括起票カード用）。
 * @param {Array<object>} specs `specs.listSpecs` の結果
 * @param {Array<{id: string, title: string, status?: string}>} tasks ボードのタスク
 * @returns {Array<{path: string, title: string, batchCount: number, pendingCount: number, pending: string[], mtime: number}>} 未起票ありの SPEC
 */
export function pendingSpecs(specs, tasks) {
  const filed = filedBatchIds(tasks)
  const out = []
  for (const spec of Array.isArray(specs) ? specs : []) {
    const batches = (spec?.batches ?? []).filter((b) => b?.id)
    if (!batches.length) continue
    const pending = batches.filter((b) => !filed.has(String(b.id))).map((b) => b.id)
    if (!pending.length) continue
    out.push({
      path: String(spec.path),
      title: String(spec.title ?? spec.path),
      batchCount: batches.length,
      pendingCount: pending.length,
      pending,
      mtime: Number(spec.mtime ?? 0),
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
}

/**
 * 保存するジョブの形（機密を持たない。種は先頭 400 字だけ）。
 * @param {object} job 内部ジョブ
 * @returns {object} 公開用
 */
export function publicJob(job) {
  return {
    id: job.id,
    board: job.board,
    status: job.status,
    stage: job.stage ?? job.status,
    runner: job.runner,
    runnerLabel: runnerLabel(job.runner),
    requestedRunner: job.requestedRunner ?? job.runner ?? null,
    fallbackFrom: job.fallbackFrom ?? null,
    fallbackReason: job.fallbackReason ?? null,
    taskId: job.taskId ?? null,
    taskStatus: job.taskStatus ?? null,
    reviewTaskId: job.reviewTaskId ?? null,
    reviewTitle: job.reviewTitle ?? null,
    autoStart: Boolean(job.autoStart),
    seed: String(job.seedText ?? '').slice(0, 400),
    lang: job.lang,
    chat: job.chat ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    spec: job.spec ?? null,
    completedSpec: job.completedSpec ?? null,
    launched: job.launched ?? null,
    error: job.error ?? null,
  }
}

/**
 * Architect を作る。
 *
 * @param {object} [cfg] 設定（`reviewDir` / `pluginDataDir` / `hermesBin` / `agyBin` / `dataDir`）
 * @param {object} [deps] 差し替え（テスト用）
 * @param {Function} [deps.runner] ランナー（`createCliRunner` の形）
 * @param {Function} [deps.listSpecs] SPEC 走査（既定 `specs.listSpecs`）
 * @param {Function} [deps.readTasks] ボードのタスク読み取り
 * @param {Function} [deps.launchSpec] 一括起票（既定 `specs.createSpecs().launchSpec`）
 * @param {Function} [deps.hasAgyCli] `agy` の存在確認（既定 false＝Opt-in していない）
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
  const hasAgyCli = deps.hasAgyCli ?? (() => false)
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

  /**
   * 設定（既定 `{runner:'hermes'}`）。壊れた JSON は既定へ戻す。
   * @returns {{runner: 'hermes'|'antigravity'}} 設定
   */
  function getConfig() {
    if (!configPath) return { runner: 'hermes' }
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return { runner: sanitizeRunner(raw?.runner) }
    } catch {
      return { runner: 'hermes' }
    }
  }

  /**
   * ランナーを保存する（`antigravity` は `agy` がある時だけ許可）。
   * @param {unknown} value ランナー
   * @returns {{ok: boolean, runner?: string, code?: string, error?: string}} 結果
   */
  function setConfig(value) {
    const runnerId = sanitizeRunner(value?.runner ?? value)
    if (runnerId === 'antigravity' && !hasAgyCli()) {
      return { ok: false, code: 'RUNNER_UNAVAILABLE', error: 'agy CLI was not found on this machine' }
    }
    if (configPath) {
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, `${JSON.stringify({ runner: runnerId }, null, 2)}\n`, { mode: 0o600 })
      } catch (e) {
        return { ok: false, code: 'WRITE_FAILED', error: e.message }
      }
    }
    return { ok: true, runner: runnerId }
  }

  /**
   * 仕様の種を撒く（202 で即答し、ランナーは背後で走る）。
   * @param {object} input `{repoPath, board, seedText, runner?, autoStart?, chat?, lang?}`
   * @returns {Promise<object>} `{ok, jobId, status, runner, autoStart}` または `{ok:false, code, error}`
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

    const runnerId = sanitizeRunner(input.runner ?? getConfig().runner)
    if (runnerId === 'antigravity' && !hasAgyCli()) {
      return { ok: false, code: 'RUNNER_UNAVAILABLE', error: 'agy CLI was not found on this machine' }
    }

    const startedAt = now()
    const job = {
      id: makeJobId(startedAt),
      board,
      repoPath,
      status: 'running',
      runner: runnerId,
      requestedRunner: runnerId,
      fallbackFrom: null,
      fallbackReason: null,
      taskId: null,
      taskStatus: null,
      reviewTaskId: null,
      reviewTitle: null,
      mode: runnerId === 'antigravity' ? 'cli' : 'kanban',
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

    const prompt = buildSeedPrompt({
      jobId: job.id,
      seedText,
      board,
      repoPath,
      autoStart: job.autoStart,
      lang: job.lang,
    })
    job.prompt = prompt

    // 背後の実行。落ちてもジョブに理由を残すだけで、呼び出し元は待たない。
    void Promise.resolve()
      .then(() => runner({ runnerId, prompt, repoPath, board, seedText, jobId: job.id }))
      .then(async (res) => {
        job.finishedAt = now()
        const code = typeof res?.code === 'number' ? res.code : 0
        const taskId = res?.taskId ?? parseCreatedTask(res?.stdout)?.id ?? null
        if (code !== 0) {
          const reason = String(res?.stderr || res?.stdout || `runner exited with ${code}`).trim()
          // agy の失敗は「停止」ではなくカンバン起票への自動フォールバックで救う（D28）
          if (runnerId === 'antigravity') {
            await fallbackToKanban(job, `exit-${code}: ${reason}`)
            return
          }
          job.status = 'failed'
          job.error = reason.slice(0, 600)
          return
        }
        if (taskId) job.taskId = taskId
        if (runnerId !== 'antigravity') {
          job.status = 'awaiting_spec'
          return
        }
        // agy が 0 で終わっても成果物（SPEC / Review タスク）が無いなら IDE ランチャー等の空振り。
        if (hasArtifacts(job)) {
          job.status = 'awaiting_spec'
          return
        }
        await fallbackToKanban(job, 'no-output: agy exited 0 without a SPEC or [review] task')
      })
      .catch((e) => {
        job.finishedAt = now()
        job.status = 'failed'
        job.error = String(e?.message ?? e).slice(0, 600)
      })

    return { ok: true, jobId: job.id, status: job.status, runner: runnerId, autoStart: job.autoStart }
  }

  /**
   * agy 失敗・無生成時の自動フォールバック（同一ジョブ内で Hermes カンバン Architect へ）。
   *
   * 起票自体が失敗したときだけ `failed` にする（ジョブを無音で止めない）。
   * @param {object} job ジョブ
   * @param {string} reason 短い理由（英語コード＋抜粋）
   * @returns {Promise<boolean>} 起票できたら true
   */
  async function fallbackToKanban(job, reason) {
    job.fallbackFrom = job.fallbackFrom ?? (job.runner === 'antigravity' ? 'antigravity' : null)
    job.fallbackReason = String(reason ?? '').slice(0, 200)
    try {
      const res = await runner({
        runnerId: 'hermes',
        prompt: job.prompt,
        repoPath: job.repoPath,
        board: job.board,
        seedText: job.seedText,
        jobId: job.id,
      })
      const code = typeof res?.code === 'number' ? res.code : 0
      const taskId = res?.taskId ?? parseCreatedTask(res?.stdout)?.id ?? null
      if (code !== 0) {
        job.status = 'failed'
        job.error = String(res?.stderr || res?.stdout || `kanban fallback exited with ${code}`)
          .trim()
          .slice(0, 600)
        return false
      }
      job.runner = 'hermes'
      job.mode = 'kanban'
      job.taskId = taskId
      job.status = 'awaiting_spec'
      job.error = null
      job.finishedAt = now()
      return true
    } catch (e) {
      job.status = 'failed'
      job.error = String(e?.message ?? e).slice(0, 600)
      return false
    }
  }

  /**
   * ジョブの成果物（新 SPEC / 待機中 Review タスク）が出ているか。
   * @param {object} job ジョブ
   * @returns {boolean} どちらかあれば true
   */
  function hasArtifacts(job) {
    try {
      if (findJobSpec(job, listSpecsFn(job.repoPath) ?? [])) return true
    } catch {
      /* 走査に失敗しても判定は続ける */
    }
    try {
      if (findJobReviewTask(job, readTasks(job.board) ?? [])) return true
    } catch {
      /* 同上 */
    }
    return false
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
   * @param {{board?: string, repoPath?: string, include?: {repoPath?: string, board?: string}}} [query] 絞り込み
   *   `include` はジョブが 1 つも無いボードでも「未起票 SPEC」を数えるための追加走査先
   * @returns {Promise<object>} `{ok, board, runner, capabilities, jobs, specReady, pending}`
   */
  async function jobsFor(query = {}) {
    const board = String(query.board ?? '').trim()
    const mine = [...jobs.values()]
      .filter((j) => (!board || j.board === board) && (!query.repoPath || j.repoPath === query.repoPath))
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

    // 先に「他のジョブが取った SPEC」を集める（新しいジョブが横取りしない）
    const taken = new Set()
    for (const job of [...mine].reverse()) {
      if (job.spec) taken.add(String(job.spec))
    }

    for (const job of [...mine].reverse()) {
      if (!['awaiting_spec', 'awaiting_review', 'running'].includes(job.status) || job.spec) continue
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

    // カンバンのタスク状態をジョブへ写す（`awaiting_review` 検知・failed 同期。SPEC V6 §3.2）
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

    for (const job of mine) {
      if (!['running', 'awaiting_spec', 'awaiting_review'].includes(job.status)) continue
      const tasks = tasksOf(job.board)
      const self = job.taskId ? tasks.find((t) => t && String(t.id) === String(job.taskId)) ?? null : null
      job.taskStatus = self?.status ? String(self.status) : null
      if (self && self.status === 'failed') {
        job.status = 'failed'
        job.error = String(self.result || job.error || 'Architect task failed').slice(0, 600)
        continue
      }
      if (job.spec) continue // 完成 SPEC を検知済み（spec_ready / launched）
      const review = findJobReviewTask(job, tasks)
      if (review) {
        job.status = 'awaiting_review'
        job.reviewTaskId = review.taskId
        job.reviewTitle = review.title
        continue
      }
      // 回答が返ってレビューが blocked でなくなったら「仕様書執筆中」へ戻す
      job.reviewTaskId = null
      job.reviewTitle = null
      if (job.status === 'awaiting_review') job.status = 'awaiting_spec'
    }

    // 公開表現の `stage`（カンバンタスクが動いている間は running として見せる）
    for (const job of mine) {
      job.stage =
        job.status === 'awaiting_spec' && ['running', 'claimed'].includes(String(job.taskStatus ?? ''))
          ? 'running'
          : job.status
    }

    // autoStart: 完成 SPEC の未起票バッチを 1 回だけ起票する
    for (const job of mine) {
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
          chat: job.chat ?? undefined,
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
    }

    // 未起票の SPEC（Seed と関係なくても、新しく置かれた SPEC を拾う）
    const pending = []
    const seenRepo = new Set()
    const scans = mine.map((job) => ({ repoPath: job.repoPath, board: job.board }))
    if (query.include?.repoPath) scans.push({ repoPath: query.include.repoPath, board: query.include.board ?? board })
    for (const scan of scans) {
      if (seenRepo.has(scan.repoPath)) continue
      seenRepo.add(scan.repoPath)
      let tasks = []
      try {
        tasks = readTasks(scan.board) ?? []
      } catch {
        tasks = []
      }
      for (const row of pendingSpecs(specsOf(scan.repoPath), tasks)) {
        pending.push({ ...row, board: scan.board, repoPath: scan.repoPath })
      }
    }

    const specReady = mine
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
      capabilities: { hasAgyCli: Boolean(hasAgyCli()) },
      jobs: mine.map(publicJob),
      specReady,
      pending,
    }
  }

  /** テスト用にジョブを捨てる。 */
  function reset() {
    jobs.clear()
  }

  return { seed, jobs: jobsFor, getConfig, setConfig, reset }
}
