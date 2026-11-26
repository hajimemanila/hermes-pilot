/**
 * Autopilot 左スワイプでの別案再生成リクエスト（`.remix.json` 保存 + unblock）。
 * `review.js` の 800 行ラチェットを守るため独立モジュールとして分離。
 */
import path from 'node:path'
import { writeJsonAtomic } from '../lib/atomic.js'
import { parseReviewLine, sheetPaths } from './parse.js'
import { opsText } from './text.js'

/**
 * `remix` ハンドラを生成する。
 * @param {object} ctx `review.js` の共有コンテキスト
 */
export function createReviewRemix(ctx) {
  const {
    bodyOf,
    transitions,
    rememberTaskChat,
    resolveInside,
    writeRootFor,
    runKanban,
    reviewAssignee,
  } = ctx

  /**
   * @param {string} id タスク ID
   * @param {{questionId?: string, reason?: string, hint?: string, by?: string, chat?: string}} [payload]
   * @param {'ja'|'en'} [lang]
   */
  async function remix(id, payload = {}, lang = 'en') {
    const ops = opsText(lang)
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }
    if (!transitions.canApply('answer.fresh', b.status)) {
      return {
        ok: false,
        code: 'NOT_WAITING',
        status: b.status,
        params: { status: b.status },
      }
    }
    if (payload?.chat) rememberTaskChat(id, payload.chat)

    const questionId = String(payload?.questionId ?? '').trim().slice(0, 64)
    const reason = String(payload?.reason ?? '').trim().slice(0, 80)
    const hint = String(payload?.hint ?? '').trim().slice(0, 400)
    const by = String(payload?.by ?? 'mobile').slice(0, 40)

    const { dataRel } = sheetPaths(ak.sheet)
    const extras = b.workdir ? [b.workdir] : []
    const dataAbs = resolveInside(dataRel, extras)
    const remixRel = dataRel.replace(/\.json$/i, '.remix.json')
    const targetRoot = writeRootFor(dataAbs ? dataRel : ak.sheet, b)
    const remixFile = path.resolve(targetRoot, remixRel)

    const record = {
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      task_id: id,
      questionId: questionId || null,
      reason: reason || 'alternative',
      hint,
      requested_by: by,
      requested_at: new Date().toISOString(),
    }
    writeJsonAtomic(remixFile, record)

    const summary = ops.remixSummary(questionId, reason, hint, remixRel)
    await runKanban(['comment', id, summary, '--author', by])
    const moved = await transitions.apply('answer.fresh', { id, reason: ops.remixRequested })
    const status = moved.code === 0 ? moved.status || b.status : b.status
    if (status === 'ready' && !String(b.assignee ?? '').trim()) {
      const who = String(reviewAssignee() ?? '').trim()
      if (who) await runKanban(['assign', id, who])
    }
    return {
      ok: moved.code === 0,
      taskId: id,
      status,
      moved: status,
      files: { remix: remixRel },
      record,
      output: moved.out.slice(0, 400),
    }
  }

  return { remix }
}
