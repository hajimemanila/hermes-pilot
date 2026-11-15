import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Spinner } from './Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { api } from '../api.js'
import { haptic } from '../lib/haptic.js'
import { buildSeedPayload, elapsedParts, jobRunnerKey, jobStatusKey } from '../lib/specSeed.js'

/**
 * Architect の進行バー（SPEC-PILOT-V6 §3.3 ② / D28）。
 *
 * Seed を送ったあと、シートが閉じても「今どこまで進んだか」が画面から消えないよう、
 * `TasksPane` と `ChatPane` の上部（`SpecReadyBanner` の上）に 1 行で出す。
 *
 * - `running` / `awaiting_spec`: スピナー・状態・経過時間・ランナーピル・種の 1 行要約
 * - `awaiting_review`: インタビューシート到着 → **1 タップで Quick Review**（`hm:open-review`）
 * - `failed`: 止まった理由（2 行まで）＋ **1 タップで Hermes Native 再試行** ＋ `×` で閉じる
 *
 * 再試行は `POST /api/architect/seed` を `runner: 'hermes'` で撃ち直す（既存 API のまま）。
 * 全文は `job.seed`（公開用に 400 字へ切った要約）で送るので、長い種は要約で再開する。
 *
 * @param {{job: object|null, board?: string, repo?: string|null, chat?: string|null,
 *          onRetried?: Function, onDismiss?: Function, notify?: Function}} props
 *        ジョブと、再試行に要る文脈（ボード・リポジトリ・起票元チャット）
 * @returns {any|null} バー
 */
export function ArchitectJobBar({ job, board = '', repo = null, chat = null, onRetried, onDismiss, notify }) {
  const { t, lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const status = String(job?.status ?? '')
  const ticking = status === 'running' || status === 'awaiting_spec'

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
    return parts.h > 0 ? t('seed.elapsedHour', parts) : t('seed.elapsed', parts)
  }, [ticking, job?.startedAt, job?.createdAt, now, t])

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
      <div className="job-bar" role="status" aria-live="polite" aria-label={t('seed.jobAria')}>
        <div className="job-bar-row">
          <Spinner size={14} />
          <span className="job-bar-title">{t(jobStatusKey(status))}</span>
          {elapsed ? <span className="job-bar-elapsed">{elapsed}</span> : null}
          <span className="job-bar-runner">{t(jobRunnerKey(job))}</span>
        </div>
        {job.seed ? <div className="job-bar-sub">{job.seed}</div> : null}
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
          <button
            type="button"
            className="job-bar-x"
            aria-label={t('seed.jobDismiss')}
            onClick={() => {
              haptic('tap')
              onDismiss(job.id)
            }}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  )
}
