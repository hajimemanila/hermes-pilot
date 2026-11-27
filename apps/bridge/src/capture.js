import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ApiError } from './api-errors.js'
import { writeJsonAtomic } from './lib/atomic.js'
import { outcomeOf, runHermes } from './lib/cli.js'

/**
 * クイック起票。
 *
 * カンバン DB には直接書かず、**`hermes kanban create` を CLI で実行**する
 * （盤面のロック・イベント・通知の整合性は本体に任せる）。
 * 連打や二重送信は「内容ベースの冪等キー + `capture-state.json` 永続化」で吸収する（D105）。
 */

const TITLE_MAX = 200
const BODY_MAX = 4000
export const DEDUPE_MS = 10 * 60_000
const CAPTURE_STATE_MAX = 500

/**
 * 入力を検証・正規化する。
 * @param {object} input 入力
 * @returns {{board: string, title: string, body: string, priority: number, assignee: string|null}} 正規化
 */
export function normalizeCapture(input = {}) {
  const board = String(input.board ?? '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(board)) {
    throw new ApiError('BOARD_NAME_INVALID', {}, 400)
  }
  const title = String(input.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) throw new ApiError('TASK_TITLE_REQUIRED', {}, 400)
  if (title.length > TITLE_MAX) {
    throw new ApiError('TASK_TITLE_TOO_LONG', { max: TITLE_MAX }, 400)
  }
  const body = String(input.body ?? '').trim().slice(0, BODY_MAX)
  const p = Number(input.priority ?? 0)
  const priority = Number.isFinite(p) ? Math.min(9, Math.max(0, Math.trunc(p))) : 0
  const rawAssignee = String(input.assignee ?? '').trim()
  const assignee = rawAssignee && /^[\w.@-]{1,64}$/.test(rawAssignee) ? rawAssignee : null
  return { board, title, body, priority, assignee }
}

/**
 * CLI に渡す引数を組み立てる。
 * @param {object} c 正規化済み入力
 * @returns {string[]} 引数
 */
export function buildCreateArgs(c) {
  const args = ['kanban', '--board', c.board, 'create', c.title, '--json']
  if (c.body) args.push('--body', c.body)
  if (c.priority) args.push('--priority', String(c.priority))
  if (c.assignee) args.push('--assignee', c.assignee)
  return args
}

/**
 * 冪等キー（未指定なら時刻バケットを含めない内容ハッシュから導く・D105）。
 * @param {object} c 正規化済み入力
 * @param {string|null} explicit 明示キー
 * @returns {string} キー
 */
export function dedupeKey(c, explicit) {
  const given = String(explicit ?? '').trim().slice(0, 128)
  if (given) return `k:${given}`
  return crypto
    .createHash('sha1')
    .update(`${c.board}|${c.title}|${c.body}|${c.priority}|${c.assignee ?? ''}`)
    .digest('hex')
}

export function createCapture(cfg = {}) {
  const now = typeof cfg.now === 'function' ? cfg.now : () => Date.now()
  const statePath = cfg.dataDir ? path.join(String(cfg.dataDir), 'capture-state.json') : null

  /** @type {Map<string, {at: number, task: object}>} */
  const seen = new Map()

  function loadState() {
    if (!statePath || !fs.existsSync(statePath)) return
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      const rows = Array.isArray(raw?.seen) ? raw.seen : []
      const t = now()
      for (const r of rows) {
        if (!r || typeof r.key !== 'string' || !Number.isFinite(Number(r.at)) || !r.task) continue
        if (t - Number(r.at) <= DEDUPE_MS) seen.set(r.key, { at: Number(r.at), task: r.task })
      }
      trimSeen()
    } catch {
      /* 壊れた JSON でも空で立ち上がる（throw しない） */
      seen.clear()
    }
  }

  function trimSeen() {
    while (seen.size > CAPTURE_STATE_MAX) {
      const oldest = seen.keys().next().value
      if (oldest == null) break
      seen.delete(oldest)
    }
  }

  function saveState() {
    if (!statePath) return
    trimSeen()
    try {
      const entries = [...seen.entries()].map(([key, v]) => ({ key, at: v.at, task: v.task }))
      writeJsonAtomic(statePath, { version: 1, seen: entries }, { mode: 0o600 })
    } catch (error) {
      const msg = String(error?.message ?? error).slice(0, 200)
      console.warn(`[capture.saveState] ${msg}`)
    }
  }

  loadState()

  /** 既定の実行（テストでは差し替え可能）。戻り値は `lib/cli.js` の統一形。 */
  const run =
    cfg.runner
      ? (args) => Promise.resolve(cfg.runner(args)).then((res) => outcomeOf(res))
      : (args) => runHermes(args, { bin: cfg.hermesBin, timeoutMs: 30_000, maxBuffer: 1_000_000 })

  function sweep() {
    const t = now()
    for (const [k, v] of seen) if (t - v.at > DEDUPE_MS) seen.delete(k)
  }

  /**
   * 起票する。
   * @param {object} input 入力（board/title/body/priority/assignee/idempotencyKey）
   * @returns {Promise<{ok: boolean, created: boolean, task?: object, error?: string}>} 結果
   */
  async function create(input = {}) {
    let c
    try {
      c = normalizeCapture(input)
    } catch (e) {
      return { ok: false, created: false, code: e.code, params: e.params, error: e.message }
    }
    sweep()
    const key = dedupeKey(c, input.idempotencyKey)
    const hit = seen.get(key)
    if (hit) return { ok: true, created: false, task: { ...hit.task, deduped: true } }

    const res = await run(buildCreateArgs(c))

    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || '').trim().slice(0, 400)
      return { ok: false, created: false, code: 'CREATE_FAILED', error: msg }
    }

    let task = null
    try {
      const at = res.stdout.indexOf('{')
      task = JSON.parse(at >= 0 ? res.stdout.slice(at) : res.stdout)
    } catch {
      const m = /Created (t_[0-9a-f]+)/.exec(res.stdout)
      task = m ? { id: m[1] } : null
    }
    if (!task?.id) {
      return { ok: false, created: false, code: 'TASK_ID_MISSING' }
    }

    const out = {
      id: task.id,
      title: task.title ?? c.title,
      status: task.status ?? 'ready',
      priority: Number(task.priority ?? c.priority),
      assignee: task.assignee ?? c.assignee,
      board: c.board,
    }
    seen.set(key, { at: now(), task: out })
    saveState()
    return { ok: true, created: true, task: out }
  }

  return { create }
}
