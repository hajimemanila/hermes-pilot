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
  function turnsFrom(target, at) {
    let db
    try {
      db = new DatabaseSync(target.path, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT l.conversation_id, l.holder, l.acquired_at, l.expires_at,
                  s.title, s.source, s.chat_type, s.last_activity_description,
                  s.last_activity_at
             FROM session_turn_leases l
             LEFT JOIN sessions s ON s.id = l.conversation_id
            WHERE l.expires_at > ?
            ORDER BY l.acquired_at DESC`,
        )
        .all(at / 1000 - LEASE_GRACE_SEC)
      const lastToolStmt = db.prepare(
        `SELECT tool_name, timestamp FROM messages
          WHERE session_id = ? AND tool_name IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      return rows.map((r) => {
        let lastTool = null
        try {
          const t = lastToolStmt.get(r.conversation_id)
          if (t?.tool_name) lastTool = { name: t.tool_name, at: Math.round(Number(t.timestamp) * 1000) }
        } catch {
          /* noop */
        }
        const acquired = Math.round(Number(r.acquired_at ?? 0) * 1000)
        const expires = Math.round(Number(r.expires_at ?? 0) * 1000)
        return {
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
        }
      })
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * いま動いているもの。
   * @param {{dbs?: Array<{profile: string, path: string}>}} [opts] 条件
   * @returns {object} スナップショット
   */
  function baseSnapshot(opts = {}) {
    const at = Date.now()
    const out = { ok: true, at, turns: [], tasks: [], architect: [], counts: { turns: 0, tasks: 0, architect: 0 } }

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
      out.reason = 'state.db が見つかりません'
      return out
    }
    const turns = []
    let firstErr = null
    let succeeded = 0
    for (const target of targets) {
      try {
        turns.push(...turnsFrom(target, at))
        succeeded++
      } catch (e) {
        if (!firstErr) firstErr = e
      }
    }
    if (!succeeded && firstErr) {
      out.ok = false
      out.code = 'READ_FAILED'
      out.reason = `読み取りに失敗しました: ${firstErr.message}`
      return out
    }
    turns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    out.turns = turns
    out.counts.turns = turns.length
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
