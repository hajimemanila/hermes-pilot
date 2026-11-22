/**
 * blocked からのタスク遷移の正本（D99 / `docs/SPEC-spec-execution-mode-mode-zer.md` §3.4）。
 *
 * これまで `review.js`（回答・回答の再送・検収）と `review/media.js`（注釈・注釈の再送）の
 * 5 か所が「complete を試し、失敗時だけ unblock」「blocked なら unblock」をそれぞれ書いていた。
 * 判断は表（`TRANSITION_TABLE`）に集め、実行は `apply()` 1 つだけを通す。
 *
 * 規則（この 4 つが挙動の契約）:
 *  1. `bodyOf(id)` の status が `from` に無ければ **CLI を 1 回も呼ばない**
 *     （`{ code: 0, out: '', status, moved: null, skipped: 'not-in-from' }`）。
 *     同じ回答の再送・検収の再送がそのまま no-op になるのはこの分岐（冪等の本体）。
 *  2. `kind: 'unblock'` → `unblock` を 1 回だけ。
 *  3. `kind: 'complete-then-unblock'` → `complete` を試し、**失敗したときだけ** `unblock` を 1 回。
 *     complete が通れば unblock は呼ばない。
 *  4. 戻り値は `{ code, out, status, moved }`（`moved` は `'done'` / `'ready'` / `null`）。
 *     呼び出し側の既存分岐（`moved.code` / `moved.out` / `status`）を壊さない。
 *
 * i18n は持たない。`reason` は呼び出し側が `ops.<key>` で選んだ文字列を渡す（遷移モジュールは
 * 言語を知らない）。CLI に残る英語（`Visual check passed`・metadata）もここで固定する。
 */

import { outcomeOf, outputOf } from '../lib/cli.js'

/** 表: 遷移名 → { from, kind, result? }。kind は 'unblock' | 'complete-then-unblock'。 */
export const TRANSITION_TABLE = {
  approve: { from: ['blocked'], kind: 'complete-then-unblock', result: 'Visual check passed' },
  'answer.fresh': { from: ['blocked'], kind: 'unblock' },
  'answer.again': { from: ['blocked'], kind: 'unblock' },
  'annotation.fresh': { from: ['blocked'], kind: 'unblock' },
  'annotation.again': { from: ['blocked'], kind: 'unblock' },
}

/** `complete` に載せる metadata の既定値（検収の証跡）。 */
export const APPROVE_METADATA = { closed_from: 'review', approved_by: 'mobile' }

/**
 * 遷移を実行する 1 つの関数を作る。
 *
 * @param {object} ctx
 * @param {(args: string[]) => Promise<{code: number, stdout?: string, stderr?: string, out?: string}>} ctx.runKanban カンバン CLI（注入可・戻り値は `outcomeOf()` で統一形へ揃える）
 * @param {(id: string) => ({status?: string} | null)} ctx.bodyOf 現在のタスク行（status を読む）
 * @param {() => (string|Date)} [ctx.now] `approved_at` の時刻（テストで固定するため注入可）
 * @returns {{table: typeof TRANSITION_TABLE, canApply: (name: string, status: string) => boolean, apply: (name: string, options?: {id: string, reason?: string, metadata?: object}) => Promise<{code: number, out: string, status: string|null, moved: string|null, skipped?: string}>}}
 */
export function createReviewTransitions(ctx = {}) {
  const { runKanban, bodyOf, now } = ctx

  /** 注入された CLI の戻り値を統一形へ揃える（旧 `{code,out}` も吸収する・D102）。 */
  const cli = async (args) => outcomeOf(await runKanban(args))

  const stamp = () => {
    const v = typeof now === 'function' ? now() : new Date()
    return v instanceof Date ? v.toISOString() : String(v)
  }

  /** status が表の `from` に入っているか（呼び出し側の事前判定用・純関数）。 */
  function canApply(name, status) {
    const spec = TRANSITION_TABLE[name]
    return Boolean(spec && spec.from.includes(status))
  }

  /**
   * 遷移を 1 回実行する。
   *
   * @param {keyof typeof TRANSITION_TABLE} name 表の遷移名
   * @param {{id: string, reason?: string, metadata?: object}} options
   *   `reason` は unblock 理由（呼び出し側が言語を選ぶ）。`metadata` は complete の metadata 上書き。
   */
  async function apply(name, options = {}) {
    const spec = TRANSITION_TABLE[name]
    if (!spec) throw new RangeError(`unknown transition: ${name}`)
    const id = String(options.id ?? '').trim()
    const reason = String(options.reason ?? '')

    const b = typeof bodyOf === 'function' ? bodyOf(id) : null
    const status = b?.status ?? null
    if (!status || !spec.from.includes(status)) {
      return { code: 0, out: '', status, moved: null, skipped: 'not-in-from' }
    }

    if (spec.kind === 'unblock') {
      const freed = await cli(['unblock', id, '--reason', reason])
      const ok = freed.code === 0
      return { code: freed.code === null ? 1 : freed.code, out: outputOf(freed), status: ok ? 'ready' : status, moved: ok ? 'ready' : null }
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

  return { table: TRANSITION_TABLE, canApply, apply }
}
