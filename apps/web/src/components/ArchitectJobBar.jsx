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
  jobQueueKey,
  jobRunnerKey,
  jobTitleKey,
} from '../lib/specSeed.js'

/**
 * Architect の進行バー（SPEC-PILOT-V6 §3.3 ② / D28・SPEC-PILOT-V7 §3.3 ③ / D33）。
 *
 * Seed を送ったあと、シートが閉じても「今どこまで進んだか」が画面から消えないよう、
 * `TasksPane` と `ChatPane` の上部（`SpecReadyBanner` の上）に 1 行で出す。
 *
 * - `running` / `awaiting_spec`: スピナー・状態・経過時間・ランナーピル・種の 1 行要約
 *   - Bridge の `queueState` が `queued`（親タスクが `ready`＝キュー待ち）なら
 *     ⏳ と「キュー待ち」、`running`（実行中）ならスピナーと「実行中」チップで区別する
 * - `awaiting_review`: インタビューシート到着 → **1 タップで Quick Review**（`hm:open-review`）
 * - `failed`: 止まった理由（2 行まで）＋ **1 タップで Hermes Native 再試行** ＋ `×` で閉じる
 *
 * 再試行は `POST /api/architect/seed` を `runner: 'hermes'` で撃ち直す（既存 API のまま）。
 * 全文は `job.seed`（公開用に 400 字へ切った要約）で送るので、長い種は要約で再開する。
 * `×` は**サーバー側にも破棄を永続化**する（`POST /api/architect/jobs/:id/dismiss`）ので、
 * リロードしても進行バーに戻ってこない。
 *
 * @param {{job: object|null, board?: string, repo?: string|null, chat?: string|null,
 *          onRetried?: Function, onDismiss?: Function, notify?: Function}} props
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

export function ArchitectJobBar({ job, board = '', repo = null, chat = null, onRetried, onDismiss, notify }) {
  const { t, lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const status = String(job?.status ?? '')
  const ticking = status === 'running' || status === 'awaiting_spec'
  const queued = isQueuedJob(job)
  const queueKey = jobQueueKey(job)

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
        new CustomEvent('hm:open-review', {
          detail: { taskId: job?.reviewTaskId ?? null, jobId: job?.id ?? null },
        }),
      )
    } catch {
      /* 遷移できなくても画面は壊さない */
    }
  }, [job?.reviewTaskId, job?.id])

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

  /** 止まったジョブを Hermes Native で撃ち直す（既存の seed API をそのまま使う）。 */
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
          runner: 'hermes',
          board: board || job.board,
          repo,
          chat: chat ?? job.chat ?? null,
          lang,
        }),
      })
      notify?.(t('seed.retried'))
      await onRetried?.(job)
    } catch (e) {
      setError(e?.message ?? t('seed.retryFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, job, board, repo, chat, lang, notify, onRetried, t])

  if (!job) return null

  if (ticking) {
    return (
      <div
        className={`job-bar${queued ? ' queued' : ''}`}
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
          <span className="job-bar-runner">{t(jobRunnerKey(job))}</span>
        </div>
        {job.seed ? <div className="job-bar-sub">{seedLine(job.seed)}</div> : null}
        {/* 進行中の表示にも × を置く。`awaiting_spec` のまま放置したジョブは
            終わらないので、閉じる手段が無いとバーが画面に残り続ける（実測）。 */}
        {onDismiss ? (
          <button type="button" className="job-bar-x" aria-label={t('seed.jobDismiss')} onClick={dismiss}>
            ×
          </button>
        ) : null}
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
        </div>
      </div>
    )
  }

  // 残るのは failed（`pickActiveArchitectJob` が 4 状態だけ通す）
  return (
    <div className="job-bar failed" role="alert" aria-label={t('seed.jobAria')}>
      <div className="job-bar-row">
        <span className="job-bar-title">⚠️ {t('seed.statusFailed')}</span>
      </div>
      <div className="job-bar-sub job-bar-error">{error ?? job.error ?? t('seed.statusFailed')}</div>
      <div className="job-bar-actions">
        <button type="button" className="job-bar-btn" disabled={busy} onClick={retry}>
          {busy ? `⏳ ${t('seed.retrying')}` : `🔄 ${t('seed.retryHermes')}`}
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
