import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApiError } from './api-errors.js'
import { outcomeOf, outputOf, runHermes as runHermesCli } from './lib/cli.js'
import { safeList } from './lib/safe.js'
import { createReviewTransitions } from './review/transitions.js'

/**
 * 承認待ちインボックス。
 *
 * ボード横断で `status='blocked'` のタスクを集め、**エージェントからの質問を読んで
 * コメントで答える**だけの画面を作る。ステータスは変えない（再開は Discord / ダッシュボード）。
 *
 * 読み取りは SQLite を readOnly、書き込み（コメント）は `hermes kanban comment` を CLI で実行する。
 */

const TEXT_MAX = 2000

/** 閉じる操作。done=完了 / cancel=アーカイブ（一覧から外す）。 */
const CLOSE_ACTIONS = new Set(['done', 'cancel'])

/**
 * ボードスラッグを検証する（DB パスに混ぜるので厳しめ）。
 * @param {unknown} board 入力
 * @returns {string} 検証済みスラッグ
 */
function assertBoard(board) {
  const slug = String(board ?? '')
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(slug)) {
    throw new ApiError('BOARD_NAME_INVALID', {}, 400)
  }
  return slug
}

/**
 * タスクIDを検証する。
 * @param {unknown} id 入力
 * @returns {string} 検証済みID
 */
function assertTaskId(id) {
  const tid = String(id ?? '')
  if (!/^t_[0-9a-z]+$/i.test(tid)) {
    throw new ApiError('TASK_ID_INVALID', {}, 400)
  }
  return tid
}

/**
 * コメント本文を検証する。
 * @param {unknown} raw 入力
 * @returns {string} 正規化済み本文
 */
/**
 * カンバンへ書き込む運用メモ（人の目にも触れる）。
 * 英語 UI のときに日本語を残さないため、UI 言語で選ぶ（既定 en）。
 */
const CLOSE_TEXT = {
  en: {
    cancel: 'Archived from PWA',
    done: 'Completed from PWA (no extra work)',
    resume: 'Resumed from PWA',
  },
  ja: {
    cancel: 'PWAから取消（アーカイブ）',
    done: 'PWAから完了（追加作業なし）',
    resume: 'PWAから再開',
  },
}

export function normalizeComment(raw) {
  const body = String(raw ?? '').trim()
  if (!body) throw new ApiError('COMMENT_REQUIRED', {}, 400)
  if (body.length > TEXT_MAX) return body.slice(0, TEXT_MAX)
  return body
}

export function createInbox(cfg, kanban) {
  const boardsRoot = path.join(cfg.kanbanRoot, 'boards')

  /**
   * 1ボードの blocked タスク（理由・直近コメント付き）。
   *
   * **レビュー待ちは除く**（本文に `[review]` を持つ blocked）。レビューはレビュータブが受け持つ別の
   * 待ち行列で、承認待ちの数字に混ぜると「同じ 1 件を 2 か所で数える」ことになる（実測: レビューの
   * シート待ちが立っている間、承認待ちが 1 件から 3 件に増えていた）。レビュー待ちはコメントでは
   * 答えられず、注釈シート / 回答フォームで答えるものなので、この一覧に出す意味も無い。
   */
  function boardItems(slug, name) {
    const dbPath = path.join(boardsRoot, slug, 'kanban.db')
    if (!fs.existsSync(dbPath)) return []
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT id, title, status, block_kind, block_recurrences, last_failure_error,
                  worker_pid, created_at, started_at, completed_at, session_id
             FROM tasks
            WHERE status = 'blocked'
              AND COALESCE(body, '') NOT LIKE '%[review]%'
              AND COALESCE(body, '') NOT LIKE '%[akapen]%'
            ORDER BY COALESCE(completed_at, started_at, created_at) DESC
            LIMIT 30`,
        )
        .all()
      const commentStmt = db.prepare(
        'SELECT author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      )
      const eventStmt = db.prepare(
        `SELECT payload, created_at FROM task_events
          WHERE task_id = ? AND kind IN ('blocked', 'failed', 'needs_input')
          ORDER BY id DESC LIMIT 1`,
      )
      return rows.map((r) => {
        let lastComment = null
        let reason = r.last_failure_error ?? null
        let blockedAt = null
        try {
          const c = commentStmt.get(r.id)
          if (c) {
            lastComment = {
              author: c.author ?? '',
              body: String(c.body ?? '').slice(0, 600),
              at: Math.round(Number(c.created_at ?? 0) * 1000),
            }
          }
        } catch {
          /* noop */
        }
        try {
          const e = eventStmt.get(r.id)
          if (e) {
            blockedAt = Math.round(Number(e.created_at ?? 0) * 1000)
            try {
              const p = JSON.parse(e.payload)
              const msg = p?.message ?? p?.reason ?? p?.summary
              if (typeof msg === 'string' && msg.trim()) reason = msg.trim()
            } catch {
              /* payload が JSON でない場合は無視 */
            }
          }
        } catch {
          /* noop */
        }
        return {
          id: r.id,
          title: r.title,
          board: slug,
          boardName: name,
          status: r.status,
          blockKind: r.block_kind ?? null,
          recurrences: Number(r.block_recurrences ?? 0),
          reason: reason ? String(reason).slice(0, 400) : null,
          blockedAt: blockedAt ?? (r.completed_at ? Number(r.completed_at) * 1000 : null),
          createdAt: r.created_at ? Number(r.created_at) * 1000 : null,
          sessionId: r.session_id ?? null,
          lastComment,
        }
      })
    } catch (err) {
      return safeList('inbox.boardItems', () => { throw err }, [])
    } finally {
      try {
        db?.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * 承認待ちの一覧（ボード横断）。
   * @returns {{ok: boolean, at: number, items: Array<object>, counts: Record<string, number>}} 一覧
   */
  function list() {
    const items = []
    let boards = []
    try {
      boards = kanban.boards().filter((b) => !b.archived)
    } catch {
      boards = []
    }
    for (const b of boards) items.push(...boardItems(b.slug, b.name))
    items.sort((a, b) => (b.blockedAt ?? 0) - (a.blockedAt ?? 0))
    /** @type {Record<string, number>} */
    const counts = {}
    for (const it of items) counts[it.blockKind ?? 'untyped'] = (counts[it.blockKind ?? 'untyped'] ?? 0) + 1
    return { ok: true, at: Date.now(), items, counts }
  }

  /**
   * コメントを付ける（ステータスは変えない）。
   * @param {string} board ボード
   * @param {string} id タスクID
   * @param {string} text 本文
   * @param {string} by 実行者
   * @returns {Promise<object>} 結果
   */
  async function comment(board, id, text, by = 'mobile') {
    const body = normalizeComment(text)
    if (!/^t_[0-9a-z]+$/i.test(String(id))) {
      throw new ApiError('TASK_ID_INVALID', {}, 400)
    }
    const res = await run(cfg, ['kanban', '--board', board, 'comment', id, body, '--author', String(by).slice(0, 40)])
    if (res.code !== 0) {
      throw new ApiError('COMMENT_FAILED', {}, 502)
    }
    return { ok: true, id, output: outputOf(res).slice(0, 400), at: Date.now() }
  }

  /** CLI 実行（runner で差し替え可）。戻り値は `lib/cli.js` の統一形。 */
  function run(c, args) {
    if (c.runner) return Promise.resolve(c.runner(args)).then((res) => outcomeOf(res))
    return runHermesCli(args, { bin: c.hermesBin, timeoutMs: 20_000, maxBuffer: 500_000 })
  }

  /** 1タスクの現在の status（読めなければ null）。 */
  function statusOf(board, id) {
    let db
    try {
      db = new DatabaseSync(path.join(boardsRoot, board, 'kanban.db'), { readOnly: true })
    } catch {
      return null
    }
    try {
      const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)
      return r?.status ?? null
    } catch {
      return null
    } finally {
      try {
        db.close()
      } catch {
        /* noop */
      }
    }
  }

  /** ボード単位の遷移実行器（状態表 D104 が唯一の正本）。 */
  function boardTransitions(board) {
    return createReviewTransitions({
      runKanban: (args) => run(cfg, ['kanban', '--board', board, ...args]),
      bodyOf: (tid) => {
        const s = statusOf(board, tid)
        return s == null ? null : { status: s }
      },
      now: cfg.now,
    })
  }

  /**
   * 判断待ちを閉じる。
   *
   * `done` = 完了（result に理由を残す）/ `cancel` = アーカイブ（一覧から消える）。
   * 既に閉じている場合は CLI を呼ばず `noop` を返す（連打しても二重に閉じない）。
   *
   * @param {string} board ボード
   * @param {string} id タスクID
   * @param {'done'|'cancel'} action 閉じ方
   * @param {string} [note] 理由・結果（400字まで）
   * @param {string} [by] 実行者
   * @returns {Promise<object>} 結果
   */
  async function close(board, id, action, note = '', by = 'mobile', lang = 'en') {
    const b = assertBoard(board)
    const tid = assertTaskId(id)
    const act = String(action ?? '')
    if (!CLOSE_ACTIONS.has(act)) {
      throw new ApiError('ACTION_INVALID', { action: act }, 400)
    }
    const before = statusOf(b, tid)
    if (before == null) {
      throw new ApiError('TASK_NOT_FOUND', {}, 404)
    }
    const actor = String(by ?? 'mobile').slice(0, 40)
    const text = String(note ?? '').trim().slice(0, 400)
    // カンバンに残す運用メモも UI 言語に合わせる（英語 UI に日本語のコメントを残さない）
    const L = CLOSE_TEXT[lang] ?? CLOSE_TEXT.en
    const transitions = boardTransitions(b)
    const name = act === 'done' ? 'close.done' : 'close.cancel'
    if (transitions.isNoop(name, before)) {
      return { ok: true, board: b, id: tid, action: act, status: before, noop: true, at: Date.now() }
    }
    if (!transitions.canApply(name, before)) {
      throw new ApiError('TASK_STATE_LOCKED', { status: before }, 409)
    }
    const res =
      act === 'done'
        ? await transitions.apply('close.done', {
            id: tid,
            result: text || L.done,
            metadata: { closed_from: 'mobile', closed_by: actor, closed_at: new Date().toISOString() },
          })
        : await transitions.apply('close.cancel', {
            id: tid,
            comment: `${L.cancel}${text ? `: ${text}` : ''}`,
            author: actor,
          })
    if (res.code !== 0) {
      throw new ApiError('CLI_FAILED', {}, 502)
    }
    const after = statusOf(b, tid)
    return {
      ok: true,
      board: b,
      id: tid,
      action: act,
      status: after ?? null,
      changed: after !== before,
      output: String(res.out ?? '').slice(0, 400),
      at: Date.now(),
    }
  }

  /**
   * blocked のタスクを再開（ready へ戻す）。
   * 下書きコメントがあれば先に記録してから unblock する。
   * @param {string} board ボード
   * @param {string} id タスクID
   * @param {string} [note] コメント／理由（400字まで）
   * @param {string} [by] 実行者
   * @returns {Promise<object>} 結果
   */
  async function unblock(board, id, note = '', by = 'mobile', lang = 'en') {
    const b = assertBoard(board)
    const tid = assertTaskId(id)
    const before = statusOf(b, tid)
    if (before == null) {
      throw new ApiError('TASK_NOT_FOUND', {}, 404)
    }
    const transitions = boardTransitions(b)
    if (transitions.isNoop('unblock', before)) {
      return { ok: true, board: b, id: tid, status: before, noop: true, at: Date.now() }
    }
    if (!transitions.canApply('unblock', before)) {
      throw new ApiError('TASK_STATE_LOCKED', { status: before }, 409)
    }
    const actor = String(by ?? 'mobile').slice(0, 40)
    const text = String(note ?? '').trim().slice(0, 400)
    // カンバンに残す運用メモも UI 言語に合わせる（英語 UI に日本語のコメントを残さない）
    const L = CLOSE_TEXT[lang] ?? CLOSE_TEXT.en
    if (text) {
      const cRes = await run(cfg, ['kanban', '--board', b, 'comment', tid, text, '--author', actor])
      if (cRes.code !== 0) {
        throw new ApiError('COMMENT_FAILED', {}, 502)
      }
    }
    const res = await transitions.apply('unblock', { id: tid, reason: text || L.resume })
    if (res.code !== 0) {
      throw new ApiError('CLI_FAILED', {}, 502)
    }
    const after = statusOf(b, tid)
    return {
      ok: true,
      board: b,
      id: tid,
      status: after ?? null,
      changed: after !== before,
      output: String(res.out ?? '').slice(0, 400),
      at: Date.now(),
    }
  }

  return { list, comment, close, unblock }
}
