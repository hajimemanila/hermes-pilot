/**
 * blocked からの遷移 ＋ 承認待ちクローズ／再開の正本（D99・D104）。
 *
 * これまで `review.js`（回答・回答の再送・検収）・`review/media.js`（注釈・注釈の再送）・
 * `inbox.js`（close done / close cancel / unblock）の遷移判断と CLI 呼び出しが分かれていた。
 * 判断は表（`TRANSITION_TABLE`）に集め、実行は `apply()` 1 つだけを通す。
 *
 * 規則（挙動の契約）:
 *  1. `bodyOf(id)` の status が `noop` に含まれていれば CLI を呼ばず `{ code: 0, out: '', status, moved: null, skipped: 'noop' }`。
 *  2. `from` に無ければ CLI を 1 回も呼ばず `{ code: 0, out: '', status, moved: null, skipped: 'not-in-from' }`。
 *  3. `kind: 'unblock'` → `unblock` を 1 回だけ。
 *  4. `kind: 'complete'` → `complete` を 1 回だけ。
 *  5. `kind: 'complete-then-unblock'` → `complete` を試し、失敗したときだけ `unblock` を 1 回。
 *  6. `kind: 'comment-then-archive'` → コメントがあれば先に付け（失敗しても継続）、`archive` を 1 回。
 *  7. `kind: 'request-changes'` → `request-changes` を 1 回だけ（成功で `review` へ戻る）。
 *  8. 戻り値は `{ code, out, status, moved, skipped? }`（`moved` は `'done'` / `'ready'` / `'review'` / `'archived'` / `null`）。
 *
 * 状態を問わず動く遷移（`reopen`）は `from: '*'` で受ける。狭めると既存フローが静かに止まる（D109）。
 */

import { outcomeOf, outputOf } from '../lib/cli.js'

/** 表: 遷移名 → { from, noop?, kind, result? }。from='*' は noop 以外の全状態。 */
export const TRANSITION_TABLE = {
  approve: { from: ['blocked'], noop: [], kind: 'complete-then-unblock', result: 'Visual check passed' },
  'answer.fresh': { from: ['blocked'], noop: [], kind: 'unblock' },
  'answer.again': { from: ['blocked'], noop: [], kind: 'unblock' },
  'annotation.fresh': { from: ['blocked'], noop: [], kind: 'unblock' },
  'annotation.again': { from: ['blocked'], noop: [], kind: 'unblock' },
  'close.done': {
    from: '*',
    noop: ['done'],
    kind: 'complete',
  },
  'close.cancel': { from: '*', noop: ['archived'], kind: 'comment-then-archive' },
  unblock: { from: ['blocked'], noop: ['ready', 'running'], kind: 'unblock' },
  // 反映が違うとき review へ戻す（`review.js` の `reopen()` が唯一の呼び出し元・D109）。
  // 状態を問わず動く（現行挙動の保存）。archived だけは CLI を呼ばない。
  reopen: { from: '*', noop: ['archived'], kind: 'request-changes' },
}

/** `request-changes` に載せる理由の最後の砦（言語別の既定は `review.js` が渡す）。 */
const REOPEN_FALLBACK_REASON = 'Please re-check and update the implementation'

/** `complete` に載せる metadata の既定値（検収の証跡）。 */
export const APPROVE_METADATA = { closed_from: 'review', approved_by: 'mobile' }

/**
 * 遷移を実行する 1 つの関数を作る。
 *
 * @param {object} ctx
 * @param {(args: string[]) => Promise<{code: number, stdout?: string, stderr?: string, out?: string}>} ctx.runKanban カンバン CLI（注入可・戻り値は `outcomeOf()` で統一形へ揃える）
 * @param {(id: string) => ({status?: string} | null)} ctx.bodyOf 現在のタスク行（status を読む）
 * @param {() => (string|Date)} [ctx.now] `approved_at` の時刻（テストで固定するため注入可）
 * @returns {{table: typeof TRANSITION_TABLE, canApply: (name: string, status: string) => boolean, isNoop: (name: string, status: string) => boolean, apply: (name: string, options?: {id: string, reason?: string, result?: string, comment?: string, author?: string, metadata?: object}) => Promise<{code: number, out: string, status: string|null, moved: string|null, skipped?: string}>}}
 */
export function createReviewTransitions(ctx = {}) {
  const { runKanban, bodyOf, now } = ctx

  /** 注入された CLI の戻り値を統一形へ揃える（旧 `{code,out}` も吸収する・D102）。 */
  const cli = async (args) => outcomeOf(await runKanban(args))

  const stamp = () => {
    const v = typeof now === 'function' ? now() : new Date()
    return v instanceof Date ? v.toISOString() : String(v)
  }

  /** status が表の `noop` に含まれるか（純関数）。 */
  function isNoop(name, status) {
    const spec = TRANSITION_TABLE[name]
    return Boolean(spec && status && Array.isArray(spec.noop) && spec.noop.includes(status))
  }

  /** status が表の `from` に入っているか（呼び出し側の事前判定用・純関数）。 */
  function canApply(name, status) {
    const spec = TRANSITION_TABLE[name]
    if (!spec || !status) return false
    if (isNoop(name, status)) return false
    if (spec.from === '*') return true
    return Array.isArray(spec.from) && spec.from.includes(status)
  }

  /**
   * 遷移を 1 回実行する。
   *
   * @param {keyof typeof TRANSITION_TABLE} name 表の遷移名
   * @param {{id: string, reason?: string, result?: string, comment?: string, author?: string, metadata?: object}} options
   */
  async function apply(name, options = {}) {
    const spec = TRANSITION_TABLE[name]
    if (!spec) throw new RangeError(`unknown transition: ${name}`)
    const id = String(options.id ?? '').trim()
    const reason = String(options.reason ?? '')

    const b = typeof bodyOf === 'function' ? bodyOf(id) : null
    const status = b?.status ?? null
    if (!status) return { code: 0, out: '', status, moved: null, skipped: 'not-in-from' }
    if (isNoop(name, status)) return { code: 0, out: '', status, moved: null, skipped: 'noop', noop: true }
    if (!canApply(name, status)) {
      return { code: 0, out: '', status, moved: null, skipped: 'not-in-from' }
    }

    if (spec.kind === 'unblock') {
      const freed = await cli(['unblock', id, '--reason', reason])
      const ok = freed.code === 0
      return { code: freed.code === null ? 1 : freed.code, out: outputOf(freed), status: ok ? 'ready' : status, moved: ok ? 'ready' : null }
    }

    if (spec.kind === 'complete') {
      const metadata =
        options.metadata && typeof options.metadata === 'object' ? options.metadata : { closed_from: 'mobile', closed_at: stamp() }
      const done = await cli([
        'complete',
        id,
        '--result',
        String(options.result ?? spec.result ?? 'Done'),
        '--metadata',
        JSON.stringify(metadata),
      ])
      const ok = done.code === 0
      return { code: done.code === null ? 1 : done.code, out: outputOf(done), status: ok ? 'done' : status, moved: ok ? 'done' : null }
    }

    if (spec.kind === 'comment-then-archive') {
      if (options.comment) {
        await cli(['comment', id, String(options.comment), '--author', String(options.author ?? 'mobile')])
      }
      const arch = await cli(['archive', id])
      const ok = arch.code === 0
      return { code: arch.code === null ? 1 : arch.code, out: outputOf(arch), status: ok ? 'archived' : status, moved: ok ? 'archived' : null }
    }

    if (spec.kind === 'request-changes') {
      const text = String(options.reason ?? '').trim() || spec.result || REOPEN_FALLBACK_REASON
      const back = await cli(['request-changes', id, text])
      const ok = back.code === 0
      return { code: back.code === null ? 1 : back.code, out: outputOf(back), status: ok ? 'review' : status, moved: ok ? 'review' : null }
    }

    if (spec.kind !== 'complete-then-unblock') throw new RangeError(`unknown kind: ${spec.kind}`)

    const metadata = {
      ...APPROVE_METADATA,
      approved_at: stamp(),
      ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
    }
    const done = await cli([
      'complete',
      id,
      '--result',
      spec.result ?? 'Visual check passed',
      '--metadata',
      JSON.stringify(metadata),
    ])
    if (done.code === 0) return { code: 0, out: outputOf(done), status: 'done', moved: 'done' }

    // complete が通らない（ワーカーが抱えたまま等）ときだけ unblock に落とす。unblock は最大 1 回。
    const freed = await cli(['unblock', id, '--reason', reason])
    const ok = freed.code === 0
    return {
      code: freed.code === null ? 1 : freed.code,
      out: `${outputOf(done)}\n${outputOf(freed)}`.trim(),
      status: ok ? 'ready' : status,
      moved: ok ? 'ready' : null,
    }
  }

  return { table: TRANSITION_TABLE, canApply, isNoop, apply }
}
