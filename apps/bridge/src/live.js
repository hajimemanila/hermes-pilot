import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * ライブ進捗（いま何が動いているか）。
 *
 * - 実行中ターン: `state.db` の `session_turn_leases`（本体が張るリース）を読むだけ
 * - 最後のツール: そのセッションの直近 `messages.tool_name`
 * - 実行中タスク: カンバン（既存の kanban モジュール）から status='running'
 *
 * 書き込みはしない。5秒ポーリング前提なので、DB は毎回開いて閉じる（読取のみ・数ms）。
 */

/** holder 文字列から platform を取り出す（例: "pid=123:turn=…:platform=discord"）。 */
export function platformOf(holder) {
  const m = /platform=([a-z0-9_-]+)/i.exec(String(holder ?? ''))
  return m ? m[1] : null
}

/** `recentTools` 配列に積む直近ツール履歴の上限。 */
export const RECENT_TOOLS_LIMIT = 6
const TOOL_SAMPLE_LIMIT = 12
const TELEMETRY_HISTORY_LIMIT = 24
const MAX_TOOL_DURATION_MS = 600_000
const DEFAULT_CONTEXT_WINDOW = 200_000

const HARMLESS_ZERO_ERR_RE = /\b(?:0\s+(?:fail(?:ed|ures?)?|errors?)|failed\s*:\s*0|errors?\s*:\s*0)\b/gi
const TOOL_ERROR_RE =
  /(?:\bexit(?:\s+code)?\s+[1-9]\d*\b|\btraceback\b|\bsyntaxerror\b|\btypeerror\b|\breferenceerror\b|\bassertionerror\b|\bcommand failed\b|\benoent\b|\berror\s*:|\bfailed\b)/i

/** Detect tool errors from message content while ignoring `"0 fail"` / `"0 errors"`. */
export function detectToolError(content) {
  const raw = String(content ?? '').trim()
  if (!raw) return { failed: false, errorTail: null }
  const normalized = raw.replace(HARMLESS_ZERO_ERR_RE, ' ')
  if (!TOOL_ERROR_RE.test(normalized)) return { failed: false, errorTail: null }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const errorTail = lines.slice(-3).join('\n').slice(0, 220) || null
  return { failed: true, errorTail }
}

/** リース期限の猶予（秒）。更新が数秒遅れても「終わった」と誤判定しない。 */
const LEASE_GRACE_SEC = 60

/**
 * Architect（仕様策定）ジョブのうち **LiveSheet の一覧に載せる** 状態。
 *
 * `awaiting_review`（赤ペン待ち）は 🔔 判断待ちピルが受け持つので件数には数えないが、
 * 「いま何が動いているか」を見る場所としては一覧に出す（SPEC-PILOT-V9 §3.2）。
 */
export const ARCHITECT_LIST_STATUSES = ['running', 'awaiting_spec', 'awaiting_review']

/** `counts.architect`（⚡ 実行中）に数える状態。 */
export const ARCHITECT_RUNNING_STATUSES = ['running', 'awaiting_spec']

/**
 * 停滞とみなす経過（3分）。`architect.js` の `STALLED_AFTER_MS` と同値で、
 * あちらが `stalled` を返すようになったらそちらを優先する（この値はその手前の保険）。
 */
export const ARCHITECT_STALLED_MS = 180_000

/**
 * ジョブの状態 → フェーズの控えめな写像。
 *
 * 正規のフェーズ算出は `architect.js#computePhase`（V9-B1）が持ち、`job.phase` があれば
 * そちらをそのまま使う。ここは B1 未適用でも `phase` が空にならないためのフォールバック。
 *
 * @param {string} status ジョブ状態
 * @returns {string} フェーズ名
 */
export function phaseOfStatus(status) {
  const s = String(status ?? '')
  if (['awaiting_review', 'spec_ready', 'launched', 'failed'].includes(s)) return s
  return 'spawning'
}

/**
 * Architect ジョブを LiveSheet 用に整形する（機密は持たない）。
 *
 * @param {object} job `architect.jobs()` の 1 件（`publicJob` の形）
 * @param {number} [at] 現在時刻
 * @returns {object} LiveSheet 用
 */
export function shapeArchitectJob(job, at = Date.now()) {
  const status = String(job?.status ?? '')
  const started = Number(job?.startedAt ?? job?.createdAt ?? 0) || 0
  // 停滞判定は architect.js が持つ。無い場合だけ 3 分ルールをここで当てる（SPEC V9 §3.1 と同じ条件）。
  const stalled =
    typeof job?.stalled === 'boolean'
      ? job.stalled
      : ARCHITECT_RUNNING_STATUSES.includes(status) &&
        job?.queueState !== 'queued' &&
        started > 0 &&
        at - started >= ARCHITECT_STALLED_MS
  return {
    id: job?.id ?? null,
    board: job?.board ?? null,
    runner: job?.runner ?? null,
    runnerLabel: job?.runnerLabel ?? job?.runner ?? null,
    status,
    phase: typeof job?.phase === 'string' && job.phase ? job.phase : phaseOfStatus(status),
    stalled,
    taskId: job?.taskId ?? null,
    reviewTaskId: job?.reviewTaskId ?? null,
    reviewBoard: job?.reviewBoard ?? null,
    seed: String(job?.seed ?? '').slice(0, 200),
    startedAt: started || null,
    elapsedSec: started ? Math.max(0, Math.round((at - started) / 1000)) : null,
  }
}

export function createLive(cfg, kanban, deps = {}) {
  const dbPath = cfg.stateDb ?? path.join(cfg.home ?? '', '.hermes', 'state.db')
  const sinceTotalsBySnap = new WeakMap()
  const samplesByTurn = new WeakMap()

  /**
   * Query cumulative session tokens started since `sinceMs` (epoch ms),
   * covering finished Round 1 / child worker sessions as well as active ones.
   *
   * @param {DatabaseSync} db
   * @param {number} sinceMs
   * @returns {{total: number, cacheRead: number, costUsd: number}|null}
   */
  function querySinceTotals(db, sinceMs) {
    if (!Number.isFinite(sinceMs) || sinceMs <= 0) return null
    const sinceSec = sinceMs / 1000
    const runQuery = (col) =>
      db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
                  COALESCE(SUM(estimated_cost_usd), 0) AS costUsd
             FROM sessions
            WHERE ${col} >= ?`,
        )
        .get(sinceSec)
    let row
    try {
      row = runQuery('started_at')
    } catch (err) {
      if (!/no such column/i.test(String(err?.message || ''))) throw err
      try {
        row = runQuery('last_activity_at')
      } catch (err2) {
        if (!/no such column/i.test(String(err2?.message || ''))) throw err2
        return { total: 0, cacheRead: 0, costUsd: 0 }
      }
    }
    const input = Number(row?.input ?? 0) || 0
    const output = Number(row?.output ?? 0) || 0
    return {
      total: input + output,
      cacheRead: Number(row?.cacheRead ?? 0) || 0,
      costUsd: Number(row?.costUsd ?? 0) || 0,
    }
  }

  /**
   * 1つの DB から実行中ターンを読む。
   *
   * **期限切れのリースは実行中ではない。** ターンは 5 分のリースを更新しながら走るので、
   * `expires_at` を過ぎた行は「終わったが行が残っている」もの（実測: 前日のリースが
   * `expiresInSec=-79488` で稼働中として並んだ）。更新の遅れを吸収するため 60 秒だけ猶予を置く。
   *
   * @param {{profile: string, path: string}} target DB情報
   * @param {number} at 現在時刻
   * @returns {Array<object>} ターン一覧
   */
  function tableCols(db, tableName) {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => String(c?.name ?? '')))
    } catch {
      return new Set()
    }
  }

  function queryLeaseRows(db, threshold, sessCols) {
    const hasTokens = sessCols.has('input_tokens') && sessCols.has('output_tokens')
    const hasContext = sessCols.has('context_tokens') && sessCols.has('max_context_tokens')
    const extra = [
      ...(hasTokens ? ['s.input_tokens', 's.output_tokens', 's.cache_read_tokens', 's.estimated_cost_usd'] : []),
      ...(hasContext ? ['s.context_tokens', 's.max_context_tokens'] : []),
    ]
    const extraSql = extra.length ? `, ${extra.join(', ')}` : ''
    return db
      .prepare(
        `SELECT l.conversation_id, l.holder, l.acquired_at, l.expires_at,
                s.title, s.source, s.chat_type, s.last_activity_description,
                s.last_activity_at${extraSql}
           FROM session_turn_leases l
           LEFT JOIN sessions s ON s.id = l.conversation_id
          WHERE l.expires_at > ?
          ORDER BY l.acquired_at DESC`,
      )
      .all(threshold)
  }

  function turnsFrom(target, at, sinceMs = 0) {
    let db
    try {
      db = new DatabaseSync(target.path, { readOnly: true, timeout: 3000 })
      const sinceTotals = querySinceTotals(db, sinceMs)
      const sessCols = tableCols(db, 'sessions')
      const msgCols = tableCols(db, 'messages')
      const rows = queryLeaseRows(db, at / 1000 - LEASE_GRACE_SEC, sessCols)
      const hasContent = msgCols.has('content')
      const timelineStmt = db.prepare(
        `SELECT tool_name, timestamp${hasContent ? ', content' : ''} FROM messages
          WHERE session_id = ?
          ORDER BY id DESC LIMIT 24`,
      )
      const toolCountStmt = db.prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE session_id = ? AND tool_name IS NOT NULL`,
      )
      const turns = rows.map((r) => {
        let toolSamples = []
        let toolCount = 0
        try {
          const timeline = timelineStmt.all(r.conversation_id)
          for (let i = 0; i < timeline.length; i += 1) {
            const msg = timeline[i]
            if (!msg?.tool_name) continue
            const ts = Math.round(Number(msg.timestamp) * 1000)
            const nextMsg = i > 0 ? timeline[i - 1] : null
            const nextTs = nextMsg?.timestamp ? Math.round(Number(nextMsg.timestamp) * 1000) : 0
            const diff = nextTs > ts && nextTs - ts <= MAX_TOOL_DURATION_MS ? nextTs - ts : null
            const { failed, errorTail } = hasContent ? detectToolError(msg.content) : { failed: false, errorTail: null }
            toolSamples.push({
              name: String(msg.tool_name),
              at: ts,
              durationMs: diff,
              failed,
              errorTail,
            })
            if (toolSamples.length >= TOOL_SAMPLE_LIMIT) break
          }
        } catch (err) {
          void err
          toolSamples = []
        }
        const recentTools = toolSamples.slice(0, RECENT_TOOLS_LIMIT)
        try {
          const cnt = toolCountStmt.get(r.conversation_id)
          toolCount = Number(cnt?.n ?? recentTools.length) || recentTools.length
        } catch (err) {
          void err
          toolCount = recentTools.length
        }
        const lastTool = recentTools[0] ?? null
        const acquired = Math.round(Number(r.acquired_at ?? 0) * 1000)
        const expires = Math.round(Number(r.expires_at ?? 0) * 1000)
        const input = Number(r.input_tokens ?? 0) || 0
        const output = Number(r.output_tokens ?? 0) || 0
        const cacheRead = Number(r.cache_read_tokens ?? 0) || 0
        const costUsd = Number(r.estimated_cost_usd ?? 0) || 0
        const ctxTokens = Number(r.context_tokens ?? 0) || 0
        const maxCtxTokens = Number(r.max_context_tokens ?? 0) || 0
        const contextPct =
          ctxTokens > 0 && maxCtxTokens > 0
            ? Math.max(0, Math.min(100, Math.round((ctxTokens / maxCtxTokens) * 100)))
            : input + cacheRead > 0
              ? Math.max(1, Math.min(100, Math.round(((input + cacheRead) / DEFAULT_CONTEXT_WINDOW) * 100)))
              : 0
        const turnObj = {
          profile: target.profile || 'default',
          sessionId: r.conversation_id,
          title: r.title || r.conversation_id,
          source: r.source ?? '',
          platform: platformOf(r.holder),
          startedAt: acquired || null,
          elapsedSec: acquired ? Math.max(0, Math.round((at - acquired) / 1000)) : null,
          expiresInSec: expires ? Math.round((expires - at) / 1000) : null,
          lastActivity: r.last_activity_description ?? null,
          lastTool,
          recentTools,
          toolCount,
          contextPct,
          tokens: { input, output, total: input + output, cacheRead, costUsd },
        }
        samplesByTurn.set(turnObj, toolSamples)
        return turnObj
      })
      return { turns, sinceTotals }
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  function buildTelemetry(turns, tasks, jobs = [], sinceTotals = null) {
    const toolHistory = []
    let toolCount = 0
    let activeTokens = 0
    let activeCacheRead = 0
    let activeCostUsd = 0
    let contextPct = 0
    const primaryTaskTitle = tasks[0]?.title || jobs[0]?.seed || null
    for (const turn of turns) {
      toolCount += Number(turn?.toolCount ?? turn?.recentTools?.length ?? (turn?.lastTool ? 1 : 0)) || 0
      activeTokens += Number(turn?.tokens?.total ?? 0) || 0
      activeCacheRead += Number(turn?.tokens?.cacheRead ?? 0) || 0
      activeCostUsd += Number(turn?.tokens?.costUsd ?? 0) || 0
      contextPct = Math.max(contextPct, Number(turn?.contextPct ?? 0) || 0)
      const list = samplesByTurn.get(turn) ?? (Array.isArray(turn?.recentTools) ? turn.recentTools : turn?.lastTool ? [turn.lastTool] : [])
      for (const tool of list) {
        if (!tool?.name) continue
        toolHistory.push({
          name: String(tool.name),
          at: Number(tool.at) || 0,
          durationMs: Number.isFinite(Number(tool.durationMs)) ? Number(tool.durationMs) : null,
          failed: Boolean(tool.failed),
          errorTail: tool.errorTail ?? null,
          sessionId: turn.sessionId ?? null,
          profile: turn.profile || 'default',
          taskTitle: primaryTaskTitle,
        })
      }
    }
    const runTokens = sinceTotals ? sinceTotals.total : activeTokens
    const runCacheRead = sinceTotals ? sinceTotals.cacheRead : activeCacheRead
    const runCostUsd = sinceTotals ? sinceTotals.costUsd : activeCostUsd
    const runTokenScope = sinceTotals ? 'since' : 'active'
    toolHistory.sort((a, b) => b.at - a.at)
    const recentTools = toolHistory.slice(0, RECENT_TOOLS_LIMIT)
    const failedTools = toolHistory.filter((t) => t.failed).slice(0, 4)
    const activeTurns = turns.length
    const activeTasks = tasks.length
    const activeWorkers = activeTurns + activeTasks
    const activeJob = Array.isArray(jobs)
      ? jobs.find((j) => ARCHITECT_RUNNING_STATUSES.includes(String(j?.status ?? ''))) || jobs[0] || null
      : null
    const phaseLabel =
      activeJob?.phase || (activeTurns > 0 || activeTasks > 0 ? 'running' : 'idle')
    const cacheDenom = runTokens + runCacheRead
    const cacheHitPct = cacheDenom > 0 ? Math.round((runCacheRead / cacheDenom) * 100) : 0
    return {
      recentTools,
      toolHistory: toolHistory.slice(0, TELEMETRY_HISTORY_LIMIT),
      failedTools,
      toolCount,
      contextPct,
      runTokens,
      runCacheRead,
      runCostUsd: Math.round(runCostUsd * 10000) / 10000,
      runTokenScope,
      cacheHitPct,
      activeTurns,
      activeTasks,
      activeWorkers,
      phaseLabel,
    }
  }

  /**
   * いま動いているもの。
   * @param {{dbs?: Array<{profile: string, path: string}>}} [opts] 条件
   * @returns {object} スナップショット
   */
  function baseSnapshot(opts = {}) {
    const at = Date.now()
    const out = {
      ok: true,
      at,
      turns: [],
      tasks: [],
      architect: [],
      counts: { turns: 0, tasks: 0, architect: 0 },
      telemetry: { recentTools: [], toolCount: 0, activeTurns: 0, activeTasks: 0, phaseLabel: 'idle' },
    }

    // 実行中タスク（ボード横断）
    try {
      const runs = []
      for (const b of kanban.boards()) {
        for (const t of kanban.tasks(b.slug, { limit: 80 })) {
          if (t.status !== 'running') continue
          runs.push({
            id: t.id,
            title: t.title,
            board: b.slug,
            boardName: b.name,
            elapsedSec: t.elapsedSec,
            workerPid: t.workerPid,
          })
        }
      }
      out.tasks = runs.sort((a, b) => (b.elapsedSec ?? 0) - (a.elapsedSec ?? 0))
      out.counts.tasks = runs.length
    } catch {
      out.tasks = []
    }

    // 実行中ターン（リース）
    const rawDbs = Array.isArray(opts.dbs) && opts.dbs.length ? opts.dbs : [{ profile: 'default', path: dbPath }]
    const targets = rawDbs.filter((d) => d?.path && fs.existsSync(d.path))
    if (!targets.length) {
      out.ok = false
      out.code = 'DB_NOT_FOUND'
      out.reason = 'Hermes state.db was not found'
      return out
    }
    const sinceMs = Number(opts.since ?? 0) || 0
    const turns = []
    let sinceTotals = sinceMs > 0 ? { total: 0, cacheRead: 0, costUsd: 0 } : null
    let firstErr = null
    let succeeded = 0
    for (const target of targets) {
      try {
        const res = turnsFrom(target, at, sinceMs)
        turns.push(...res.turns)
        if (sinceTotals && res.sinceTotals) {
          sinceTotals.total += res.sinceTotals.total
          sinceTotals.cacheRead += res.sinceTotals.cacheRead
          sinceTotals.costUsd += res.sinceTotals.costUsd
        }
        succeeded++
      } catch (e) {
        if (!firstErr) firstErr = e
      }
    }
    if (!succeeded && firstErr) {
      out.ok = false
      out.code = 'READ_FAILED'
      out.reason = `Could not read the data: ${firstErr.message}`
      return out
    }
    turns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    out.turns = turns
    out.counts.turns = turns.length
    if (sinceTotals) sinceTotalsBySnap.set(out, sinceTotals)
    out.telemetry = buildTelemetry(out.turns, out.tasks, out.architect, sinceTotals)
    return out
  }

  /**
   * アクティブな Architect ジョブを一覧と件数へ落とし込む。
   *
   * - 一覧（`out.architect`）: `running` / `awaiting_spec` / `awaiting_review` で未破棄のもの
   * - 件数（`out.counts.architect`）: そのうち `running` / `awaiting_spec` だけ
   *   （`awaiting_review` は 🔔 判断待ちピルが数えるので二重計上しない）
   *
   * @param {object} out スナップショット
   * @param {Array<object>|unknown} raw `architect.jobs()` の `jobs`
   * @returns {object} 同じ `out`
   */
  function withArchitect(out, raw) {
    const at = Number(out.at) || Date.now()
    const list = Array.isArray(raw) ? raw : []
    const jobs = []
    for (const job of list) {
      if (!job || job.dismissed) continue
      if (!ARCHITECT_LIST_STATUSES.includes(String(job.status ?? ''))) continue
      jobs.push(shapeArchitectJob(job, at))
    }
    jobs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    out.architect = jobs
    out.counts = {
      ...(out.counts ?? {}),
      architect: jobs.filter((j) => ARCHITECT_RUNNING_STATUSES.includes(j.status)).length,
    }
    out.telemetry = buildTelemetry(out.turns ?? [], out.tasks ?? [], out.architect, sinceTotalsBySnap.get(out) ?? null)
    return out
  }

  /**
   * Architect ジョブの供給元を決める（`opts.architect` → `opts.architectJobs` → `deps.architectJobs`）。
   * @param {object} opts snapshot 引数
   * @returns {Array<object>|Promise<Array<object>>|Function|null} 一覧・Promise・関数
   */
  function architectSource(opts) {
    const given = opts.architect !== undefined ? opts.architect : opts.architectJobs
    if (given !== undefined) return given
    return typeof deps.architectJobs === 'function' ? deps.architectJobs : null
  }

  /**
   * いま動いているもの（ターン・タスク・Architect ジョブ）。
   *
   * Architect の一覧を **配列**で渡せば同期に、**Promise** で渡せば同じ結果を `await` で返す
   * （`server.js` は `await architect.jobs()` の結果を配列で渡す・SPEC V9 §3.2）。
   *
   * @param {{dbs?: Array<{profile: string, path: string}>, architect?: unknown, architectJobs?: unknown}} [opts] 条件
   * @returns {object|Promise<object>} スナップショット（Promise を渡したときだけ Promise）
   */
  function snapshot(opts = {}) {
    let source = null
    try {
      source = architectSource(opts)
      if (typeof source === 'function') source = source()
    } catch {
      source = []
    }
    if (source && typeof source.then === 'function') {
      const base = baseSnapshot(opts)
      return Promise.resolve(source)
        .then((list) => withArchitect(base, list))
        .catch(() => withArchitect(base, []))
    }
    return withArchitect(baseSnapshot(opts), source)
  }

  return { snapshot }
}
