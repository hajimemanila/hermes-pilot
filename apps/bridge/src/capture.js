import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { ApiError } from './api-errors.js'

/**
 * クイック起票。
 *
 * カンバン DB には直接書かず、**`hermes kanban create` を CLI で実行**する
 * （盤面のロック・イベント・通知の整合性は本体に任せる）。
 * 連打や二重送信は idempotency key で吸収する（既定10分の窓）。
 */

const TITLE_MAX = 200
const BODY_MAX = 4000
const DEDUPE_MS = 10 * 60_000

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
 * 冪等キー（未指定なら内容と10分窓から導く）。
 * @param {object} c 正規化済み入力
 * @param {string|null} explicit 明示キー
 * @returns {string} キー
 */
export function dedupeKey(c, explicit) {
  const given = String(explicit ?? '').trim().slice(0, 128)
  if (given) return `k:${given}`
  const bucket = Math.floor(Date.now() / DEDUPE_MS)
  return crypto
    .createHash('sha1')
    .update(`${c.board}|${c.title}|${c.body}|${c.priority}|${c.assignee ?? ''}|${bucket}`)
    .digest('hex')
}

export function createCapture(cfg = {}) {
  /** @type {Map<string, {at: number, task: object}>} */
  const seen = new Map()

  /** 既定の実行（テストでは差し替え可能）。 */
  const run =
    cfg.runner ??
    ((args) =>
      new Promise((resolve) => {
        execFile(
          cfg.hermesBin ?? 'hermes',
          args,
          { timeout: 30_000, maxBuffer: 1_000_000, env: { ...process.env } },
          (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          },
        )
      }))

  function sweep() {
    const now = Date.now()
    for (const [k, v] of seen) if (now - v.at > DEDUPE_MS) seen.delete(k)
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
    seen.set(key, { at: Date.now(), task: out })
    return { ok: true, created: true, task: out }
  }

  return { create }
}
