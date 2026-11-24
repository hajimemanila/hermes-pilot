import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 使用量（コスト・トークン）の集計。
 *
 * `~/.hermes/state.db` を **読み取り専用** で開き、`sessions` と
 * `session_model_usage` を集計するだけ。本文は一切読まない。
 * リアルタイム性は不要なので、結果を 30 秒キャッシュする。
 */

const CACHE_MS = 30_000

export function createUsage(cfg = {}) {
  const dbPath = cfg.stateDb ?? path.join(cfg.home ?? '', '.hermes', 'state.db')
  let cache = { at: 0, key: null, data: null }

  /**
   * 1つの DB から期間内の使用量を読む。
   * @param {{profile: string, path: string}} target DB情報
   * @param {number} since 開始秒
   * @returns {{totals: object, models: Array<object>, topSessions: Array<object>}} 部分集計
   */
  function summarizeOne(target, since) {
    let db
    try {
      db = new DatabaseSync(target.path, { readOnly: true, timeout: 3000 })
      const t = db
        .prepare(
          `SELECT COUNT(*) AS sessions,
                  COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
                  COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
                  COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
                  COALESCE(SUM(estimated_cost_usd), 0) AS cost,
                  COALESCE(SUM(api_call_count), 0) AS calls,
                  COALESCE(SUM(message_count), 0) AS messages,
                  COALESCE(SUM(tool_call_count), 0) AS tools
             FROM sessions
            WHERE last_activity_at > ?`,
        )
        .get(since)

      const models = db
        .prepare(
          `SELECT u.model,
                  COALESCE(SUM(u.input_tokens), 0) AS input,
                  COALESCE(SUM(u.output_tokens), 0) AS output,
                  COALESCE(SUM(u.cache_read_tokens), 0) AS cacheRead,
                  COALESCE(SUM(u.estimated_cost_usd), 0) AS cost,
                  COALESCE(SUM(u.api_call_count), 0) AS calls
             FROM session_model_usage u
             JOIN sessions s ON s.id = u.session_id
            WHERE s.last_activity_at > ?
            GROUP BY u.model
            ORDER BY cost DESC`,
        )
        .all(since)

      const top = db
        .prepare(
          `SELECT id, title, source, estimated_cost_usd AS cost, input_tokens AS input,
                  output_tokens AS output, last_activity_at AS at
             FROM sessions
            WHERE last_activity_at > ?
            ORDER BY estimated_cost_usd DESC
            LIMIT 5`,
        )
        .all(since)

      return {
        totals: {
          sessions: Number(t?.sessions ?? 0),
          input: Number(t?.input ?? 0),
          output: Number(t?.output ?? 0),
          cacheRead: Number(t?.cacheRead ?? 0),
          cacheWrite: Number(t?.cacheWrite ?? 0),
          reasoning: Number(t?.reasoning ?? 0),
          cost: Number(t?.cost ?? 0),
          calls: Number(t?.calls ?? 0),
          messages: Number(t?.messages ?? 0),
          tools: Number(t?.tools ?? 0),
        },
        models: models.map((m) => ({
          model: m.model ?? '—',
          input: Number(m.input ?? 0),
          output: Number(m.output ?? 0),
          cacheRead: Number(m.cacheRead ?? 0),
          cost: Number(m.cost ?? 0),
          calls: Number(m.calls ?? 0),
        })),
        topSessions: top.map((s) => ({
          profile: target.profile || 'default',
          id: s.id,
          title: s.title || s.id,
          source: s.source ?? '',
          cost: Number(s.cost ?? 0),
          input: Number(s.input ?? 0),
          output: Number(s.output ?? 0),
          at: Math.round(Number(s.at ?? 0) * 1000),
        })),
      }
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * 期間内の合計と内訳を返す。
   * @param {{hours?: number, dbs?: Array<{profile: string, path: string}>}} [opts] 条件（既定24時間）
   * @returns {object} 集計
   */
  function summary(opts = {}) {
    const hours = Math.min(Math.max(Number(opts.hours ?? 24) || 24, 1), 24 * 30)
    const rawDbs = Array.isArray(opts.dbs) && opts.dbs.length ? opts.dbs : [{ profile: 'default', path: dbPath }]
    const targets = rawDbs.filter((d) => d?.path && fs.existsSync(d.path))
    if (!targets.length) return { ok: false, code: 'DB_NOT_FOUND', reason: 'Hermes state.db was not found' }

    const cacheKey = `${hours}:${targets.map((d) => d.path).join('|')}`
    if (cache.data && cache.key === cacheKey && Date.now() - cache.at < CACHE_MS) return cache.data

    const since = Date.now() / 1000 - hours * 3600
    const totals = {
      sessions: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      cost: 0,
      calls: 0,
      messages: 0,
      tools: 0,
    }
    const modelMap = new Map()
    const topSessions = []
    let firstErr = null
    let succeeded = 0

    for (const target of targets) {
      try {
        const part = summarizeOne(target, since)
        succeeded++
        for (const k of Object.keys(totals)) totals[k] += part.totals[k]
        for (const m of part.models) {
          const prev = modelMap.get(m.model) ?? { model: m.model, input: 0, output: 0, cacheRead: 0, cost: 0, calls: 0 }
          prev.input += m.input
          prev.output += m.output
          prev.cacheRead += m.cacheRead
          prev.cost += m.cost
          prev.calls += m.calls
          modelMap.set(m.model, prev)
        }
        topSessions.push(...part.topSessions)
      } catch (e) {
        if (!firstErr) firstErr = e
      }
    }

    if (!succeeded && firstErr) {
      return { ok: false, code: 'AGG_FAILED', reason: `Could not aggregate the usage data: ${firstErr.message}` }
    }

    const denom = totals.input + totals.cacheRead
    const data = {
      ok: true,
      hours,
      since: Math.round(since * 1000),
      totals,
      cacheHitRate: denom > 0 ? totals.cacheRead / denom : null,
      models: [...modelMap.values()].sort((a, b) => b.cost - a.cost),
      topSessions: topSessions.sort((a, b) => b.cost - a.cost).slice(0, 5),
    }
    cache = { at: Date.now(), key: cacheKey, data }
    return data
  }

  /**
   * スコープ（セッション ID 群 or 時間範囲）に限定した使用量を返す（SPEC-PILOT-V7 §3.2 ②）。
   *
   * 完了レシート・完了報告の `apiCalls` / `totalTokens` は「その Spec / Run の分だけ」で
   * なければ意味がないため、全期間合算の `summary()` とは別に用意する。
   *
   * 絞り込み規則:
   *  - `sessionIds` があれば **そのセッション群のみ**
   *  - 無ければ `sinceMs`〜`untilMs`（Run の実区間）で時間窓フォールバック（`scope.fallback: true`）
   *  - どちらも無ければ `ok: false`（誤って全体を混ぜない）
   *
   * @param {{sessionIds?: Array<string>, sinceMs?: number, untilMs?: number, dbs?: Array<{profile: string, path: string}>}} [opts] スコープ
   * @returns {{
   *   ok: boolean, reason?: string, apiCalls?: number, totalTokens?: number,
   *   cacheHitRate?: number|null, scope?: object, totals?: object
   * }} スコープ集計
   */
  function scoped(opts = {}) {
    const ids = [
      ...new Set(
        (Array.isArray(opts.sessionIds) ? opts.sessionIds : [])
          .map((v) => String(v ?? '').trim())
          .filter(Boolean),
      ),
    ].slice(0, 500)
    const sinceMs = Number(opts.sinceMs) || 0
    const untilMs = Number(opts.untilMs) || 0
    const rawDbs = Array.isArray(opts.dbs) && opts.dbs.length ? opts.dbs : [{ profile: 'default', path: dbPath }]
    const targets = rawDbs.filter((d) => d?.path && fs.existsSync(d.path))
    if (!targets.length) return { ok: false, code: 'DB_NOT_FOUND', reason: 'Hermes state.db was not found' }
    if (!ids.length && !sinceMs) return { ok: false, code: 'SCOPE_MISSING', reason: 'No aggregation scope was specified' }

    const totals = { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 }
    let succeeded = 0
    let firstErr = null
    for (const target of targets) {
      let db
      try {
        db = new DatabaseSync(target.path, { readOnly: true, timeout: 3000 })
        const where = []
        const params = []
        if (ids.length) {
          // セッション ID が特定できたらその群のみ（時間窓は使わない）
          where.push(`id IN (${ids.map(() => '?').join(',')})`)
          params.push(...ids)
        } else {
          // 特定できなければ Run の有効時間範囲でフォールバック
          where.push(
            `COALESCE(last_activity_at, started_at) >= ?${untilMs > 0 ? ' AND COALESCE(last_activity_at, started_at) <= ?' : ''}`,
          )
          params.push(sinceMs / 1000)
          if (untilMs > 0) params.push(untilMs / 1000)
        }
        const rowSql = (whereSql) =>
          `SELECT COUNT(*) AS sessions,
                  COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
                  COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
                  COALESCE(SUM(estimated_cost_usd), 0) AS cost,
                  COALESCE(SUM(api_call_count), 0) AS calls
             FROM sessions
            WHERE ${whereSql}`
        let row
        try {
          row = db.prepare(rowSql(where.join(' OR '))).get(...params)
        } catch {
          // `started_at` が無い古いスキーマ・テスト用 DB は last_activity_at だけで絞る
          const simple = where
            .map((w) => w.replaceAll('COALESCE(last_activity_at, started_at)', 'last_activity_at'))
            .join(' OR ')
          row = db.prepare(rowSql(simple)).get(...params)
        }
        succeeded += 1
        totals.sessions += Number(row?.sessions ?? 0)
        totals.input += Number(row?.input ?? 0)
        totals.output += Number(row?.output ?? 0)
        totals.cacheRead += Number(row?.cacheRead ?? 0)
        totals.cacheWrite += Number(row?.cacheWrite ?? 0)
        totals.cost += Number(row?.cost ?? 0)
        totals.calls += Number(row?.calls ?? 0)
      } catch (e) {
        if (!firstErr) firstErr = e
      } finally {
        try {
          db?.close()
        } catch {
          /* noop */
        }
      }
    }
    if (!succeeded && firstErr) return { ok: false, code: 'AGG_FAILED', reason: `Could not aggregate the usage data: ${firstErr.message}` }

    const denom = totals.input + totals.cacheRead
    return {
      ok: true,
      scope: {
        sessionIds: ids.length,
        sinceMs: sinceMs || null,
        untilMs: untilMs || null,
        fallback: ids.length === 0,
      },
      apiCalls: totals.calls,
      totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
      cacheHitRate: denom > 0 ? totals.cacheRead / denom : null,
      totals,
    }
  }

  return { summary, scoped }
}
