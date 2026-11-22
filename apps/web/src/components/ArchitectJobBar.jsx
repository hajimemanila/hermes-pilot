import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Spinner } from './Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { api } from '../api.js'
import { haptic } from '../lib/haptic.js'
import {
  buildSeedPayload,
  dismissJobPath,
  elapsedParts,
  isQueuedJob,
  jobPhaseKey,
  jobQueueKey,
  jobRunnerKey,
  jobSheetName,
  jobTitleKey,
  shouldOfferHermesRetry,
} from '../lib/specSeed.js'
import { HM_EVENTS } from '../contracts/events.js'

/**
 * Architect の進行バー（SPEC-PILOT-V6 §3.3 ② / D28・V7 §3.3 ③ / D33・
 * SPEC-PILOT-V9 §3.3 ② / D43 後半）。
 *
 * Seed を送ったあと、シートが閉じても「今どこまで進んだか」が画面から消えないよう、
 * `TasksPane` と `ChatPane` の上部（`SpecReadyBanner` の上）に 1 行で出す。
 *
 * - `running` / `awaiting_spec`: スピナー・状態・**現在フェーズ**・経過時間・ランナーピル・
 *   種の 1 行要約・検知済みシート名（`job.sheetPath`）
 *   - Bridge の `queueState` が `queued`（親タスクが `ready`＝キュー待ち）なら
 *     ⏳ と「キュー待ち」、`running`（実行中）ならスピナーと「実行中」チップで区別する
 * - `job.stalled`（3 分以上無進展）ならバーを警告トーンにし、明示の警告文を出す
 * - **🔍 進捗詳細**: `onInspect` があればそれを呼ぶ。無ければ `job.taskId` ありは
 *   `hm:open-task`、タスクを持たないジョブは `hm:open-live` を発火する
 *   （カンバンタスクを作らないジョブでも死活監視を 1 タップで開ける）
 * - `awaiting_review`: インタビューシート到着 → **1 タップで Quick Review**（`hm:open-review`）
 * - `failed` / `stalled`: **明示の「🔄 再試行」**（`shouldOfferHermesRetry`）。
 *   ランナーは `Hermes Native` だけなので、止まったジョブはこのボタンで同じ種を撃ち直す
 *   （SPEC-PILOT-V11 §3.1 / D54）。
 *
 * 再試行は `POST /api/architect/seed` を撃ち直し、**成功後に旧ジョブを
 * 破棄**する（残すと 2 本並ぶ＝二重稼働になる）。全文は `job.seed`（公開用に 400 字へ切った
 * 要約）で送るので、長い種は要約で再開する。
 * `×` は**サーバー側にも破棄を永続化**する（`POST /api/architect/jobs/:id/dismiss`）ので、
 * リロードしても進行バーに戻ってこない。
 *
 * @param {{job: object|null, board?: string, repo?: string|null, chat?: string|null,
 *          onRetried?: Function, onDismiss?: Function, onInspect?: Function, notify?: Function}} props
 *        ジョブと、再試行に要る文脈（ボード・リポジトリ・起票元チャット）
 * @returns {any|null} バー
 */
/**
 * 種の 1 行要約を表示用に切る。
 *
 * 全文（最大 400 字）をそのまま置くと、390px 幅で 1 行が箱より広くなり
 * 「文字切れ」監査に落ちる（実測: textWidth 366 > clientWidth 362）。
 * 表示は 40 文字で十分（全文はシートで読める）。
 *
 * @param {string} text 種
 * @returns {string} 切り詰めた要約
 */
function seedLine(text) {
  const s = String(text ?? '').trim()
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

export function ArchitectJobBar({
  job,
  board = '',
  repo = null,
  chat = null,
  onRetried,
  onDismiss,
  onInspect,
  notify,
}) {
  const { t, lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const status = String(job?.status ?? '')
  const ticking = status === 'running' || status === 'awaiting_spec'
  const queued = isQueuedJob(job)
  const queueKey = jobQueueKey(job)
  const phaseKey = jobPhaseKey(job)
  const sheetName = jobSheetName(job)
  const stalled = Boolean(job?.stalled)
  const offerRetry = shouldOfferHermesRetry(job)

  // 経過時間は進行中だけ 1 秒で進める（人待ちのジョブを無駄に再描画しない）
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking, job?.id])

  // ジョブが変われば前のエラーは関係ない
  useEffect(() => {
    setError(null)
  }, [job?.id])

  const elapsed = useMemo(() => {
    const start = Number(job?.startedAt ?? job?.createdAt ?? 0)
    if (!ticking || !start) return null
    const parts = elapsedParts(now - start)
    // キュー待ちは「作業時間」ではなく「開始待ちの経過」なので文言を分ける
    if (queued) return parts.h > 0 ? t('seed.elapsedWaitingHour', parts) : t('seed.elapsedWaiting', parts)
    return parts.h > 0 ? t('seed.elapsedHour', parts) : t('seed.elapsed', parts)
  }, [ticking, queued, job?.startedAt, job?.createdAt, now, t])

  /** Quick Review へ 1 タップで遷移する（App が `hm:open-review` を受けて Review タブへ切り替える）。 */
  const openReview = useCallback(() => {
    haptic('tap')
    try {
      window.dispatchEvent(
        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
          detail: { taskId: job?.reviewTaskId ?? null, jobId: job?.id ?? null },
        }),
      )
    } catch {
      /* 遷移できなくても画面は壊さない */
    }
  }, [job?.reviewTaskId, job?.id])

  /**
   * 🔍 進捗詳細を開く（D43 後半）。
   *
   * 呼び出し元（`TasksPane` / `ChatPane`）が `onInspect` を渡していればそれに委ねる。
   * 渡していない場合は、タスクを持つジョブはタスク詳細（`hm:open-task`）、
   * タスクを持たないジョブは全体の `LiveSheet`（`hm:open-live`）へ振る。
   */
  const inspect = useCallback(() => {
    if (!job) return
    haptic('tap')
    if (onInspect) {
      onInspect(job)
      return
    }
    try {
      const event = job.taskId ? HM_EVENTS.OPEN_TASK : HM_EVENTS.OPEN_LIVE
      window.dispatchEvent(
        new CustomEvent(event, {
          detail: { taskId: job.taskId ?? null, board: job.board ?? board ?? null, jobId: job.id ?? null },
        }),
      )
    } catch {
      /* 開けなくても画面は壊さない */
    }
  }, [job, board, onInspect])

  /**
   * × でジョブを閉じる。
   *
   * ローカル状態（`onDismiss`）だけだと再読込で復活するので、**サーバー側の破棄を
   * 先に永続化**してから画面から消す。旧ブリッジ（404）でも閉じる動作は保つ。
   */
  const dismiss = useCallback(async () => {
    if (!job) return
    haptic('tap')
    const id = String(job.id)
    try {
      await api(dismissJobPath(id), { method: 'POST' })
    } catch {
      /* 旧ブリッジ・オフラインでも、この画面では閉じる（次の取得で再評価される） */
    }
    onDismiss?.(id)
  }, [job, onDismiss])

  /**
   * Hermes Native で撃ち直す（明示ボタン専用・SPEC-PILOT-V11 §3.1 / D54）。
   *
   * 順序は「seed → 旧ジョブの dismiss」。逆にすると seed が失敗したときに
   * 進行バーごと消えて理由が読めなくなる（実測）。成功後に旧ジョブを破棄するので、
   * 画面にもサーバーにも同じ種のジョブが 2 本残らない。
   */
  const retry = useCallback(async () => {
    if (busy || !job) return
    haptic('action')
    setBusy(true)
    setError(null)
    try {
      await api('/api/architect/seed', {
        method: 'POST',
        body: buildSeedPayload({
          seedText: job.seed,
          autoStart: Boolean(job.autoStart),
          // 選んだ実行方針を落とさない（Visual-gate で回したジョブを Zero-stop で再開しない）
          executionPolicy: job.executionPolicy,
          board: board || job.board,
          repo,
          chat: chat ?? job.chat ?? null,
          lang,
        }),
      })
      // 旧ジョブは破棄（ローカルにも即時に隠す＝旧ブリッジで dismiss が 404 でも二重表示しない）
      try {
        await api(dismissJobPath(String(job.id)), { method: 'POST' })
      } catch {
        /* 破棄できなくても新ジョブは動いている（次の取得で評価される） */
      }
      onDismiss?.(String(job.id))
      notify?.(t('seed.retried'))
      await onRetried?.(job)
    } catch (e) {
      setError(e?.message ?? t('seed.retryFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, job, board, repo, chat, lang, notify, onRetried, onDismiss, t])

  if (!job) return null

  if (ticking) {
    return (
      <div
        className={`job-bar${queued ? ' queued' : ''}${stalled ? ' stalled' : ''}`}
        role="status"
        aria-live="polite"
        aria-label={t('seed.jobAria')}
      >
        <div className="job-bar-row">
          {/* キュー待ちは「まだ動いていない」のでスピナーを回さない */}
          {queued ? (
            <span className="job-bar-wait" aria-hidden="true">
              ⏳
            </span>
          ) : (
            <Spinner size={14} />
          )}
          <span className="job-bar-title">{t(jobTitleKey(job))}</span>
          {queueKey ? (
            <span className={`job-bar-state${queued ? ' queued' : ' running'}`}>{t(queueKey)}</span>
          ) : null}
          {elapsed ? <span className="job-bar-elapsed">{elapsed}</span> : null}
          <span className="job-bar-runner">{t(jobRunnerKey())}</span>
        </div>
        {/* 現在フェーズと、検知済みのシート名（D42 の中間進捗を画面に出す） */}
        {phaseKey || sheetName ? (
          <div className="job-bar-row job-bar-meta">
            {phaseKey ? (
              <span className="job-bar-phase" aria-label={t('seed.phaseAria')}>
                {t(phaseKey)}
              </span>
            ) : null}
            {sheetName ? (
              <span className="job-bar-file" title={String(job.sheetPath ?? '')}>
                {t('seed.sheetLabel', { name: sheetName })}
              </span>
            ) : null}
          </div>
        ) : null}
        {job.seed ? <div className="job-bar-sub">{seedLine(job.seed)}</div> : null}
        {stalled ? <div className="job-bar-sub job-bar-warn">{t('seed.stalled')}</div> : null}
        <div className="job-bar-actions">
          <button type="button" className="job-bar-btn" onClick={inspect} aria-label={t('seed.inspectAria')}>
            🔍 {t('seed.inspect')}
          </button>
          {/* 停滞（3 分以上無進展）したときは、明示の逃げ道（例: 再試行）を出す */}
          {offerRetry ? (
            <button type="button" className="job-bar-btn" disabled={busy} onClick={retry}>
              {busy ? `⏳ ${t('seed.retrying')}` : `🔄 ${t('seed.retryHermes')}`}
            </button>
          ) : null}
          {onDismiss ? (
            <button type="button" className="job-bar-x" aria-label={t('seed.jobDismiss')} onClick={dismiss}>
              ×
            </button>
          ) : null}
        </div>
        {error ? <div className="job-bar-sub job-bar-error">{error}</div> : null}
      </div>
    )
  }

  if (status === 'awaiting_review') {
    return (
      <div className="job-bar review" role="status" aria-live="polite" aria-label={t('seed.jobAria')}>
        <div className="job-bar-row">
          <span className="job-bar-title">📝 {t('seed.statusAwaitingReview')}</span>
          {job.taskId ? <span className="job-bar-runner">{t('seed.jobTask', { id: job.taskId })}</span> : null}
        </div>
        <div className="job-bar-sub">{job.reviewTitle || job.seed}</div>
        <div className="job-bar-actions">
          <button type="button" className="job-bar-btn" onClick={openReview}>
            🔍 {t('seed.openReview')}
          </button>
          <button type="button" className="job-bar-btn" onClick={inspect} aria-label={t('seed.inspectAria')}>
            {t('seed.inspect')}
          </button>
        </div>
      </div>
    )
  }

  // 残るのは failed（`pickActiveArchitectJob` が 4 状態だけ通す）
  return (
    <div className={`job-bar failed${stalled ? ' stalled' : ''}`} role="alert" aria-label={t('seed.jobAria')}>
      <div className="job-bar-row">
        <span className="job-bar-title">⚠️ {t('seed.statusFailed')}</span>
        {phaseKey ? <span className="job-bar-phase">{t(phaseKey)}</span> : null}
      </div>
      <div className="job-bar-sub job-bar-error">{error ?? job.error ?? t('seed.statusFailed')}</div>
      <div className="job-bar-actions">
        <button type="button" className="job-bar-btn" disabled={busy} onClick={retry}>
          {busy ? `⏳ ${t('seed.retrying')}` : `🔄 ${t('seed.retryHermes')}`}
        </button>
        <button type="button" className="job-bar-btn" onClick={inspect} aria-label={t('seed.inspectAria')}>
          {t('seed.inspect')}
        </button>
        {onDismiss ? (
          <button type="button" className="job-bar-x" aria-label={t('seed.jobDismiss')} onClick={dismiss}>
            ×
          </button>
        ) : null}
      </div>
    </div>
  )
}
