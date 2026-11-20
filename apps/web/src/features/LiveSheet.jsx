import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Sheet, relTime } from '../components/Ui.jsx'
import { localizeError } from '../i18n/lang.js'
import { useI18n } from '../i18n/index.js'
import { sep } from '../lib/format.js'

/** 秒を「12m34s」形式に。 */
function fmtElapsed(sec) {
  if (sec == null) return '—'
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * Architect ジョブのフェーズ → i18n キー。
 * 未知の値はフェーズ名をそのまま出す（辞書に無いキーを t() に投げない）。
 */
const PHASE_KEYS = {
  spawning: 'live.architectPhaseSpawning',
  round1_sheet: 'live.architectPhaseRound1Sheet',
  awaiting_review: 'live.architectPhaseAwaitingReview',
  round2_spec: 'live.architectPhaseRound2Spec',
  spec_ready: 'live.architectPhaseSpecReady',
  launched: 'live.architectPhaseLaunched',
  failed: 'live.architectPhaseFailed',
}

/** フェーズの表示名。 */
function phaseLabel(t, phase) {
  const key = PHASE_KEYS[String(phase ?? '')]
  return key ? t(key) : String(phase ?? '—')
}

/** 種（seed）の 1 行要約。プロンプト全体は長いので先頭行だけを短く出す。 */
function seedSummary(seed) {
  const line = String(seed ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  return line ? line.slice(0, 72) : ''
}

/** ジョブの状態 → 行のドット。 */
function jobDot(job) {
  if (job.stalled) return 'blocked'
  if (job.status === 'awaiting_review') return 'ready'
  if (job.status === 'failed') return 'failed'
  return 'running'
}

/**
 * ライブ進捗シート。「いま何が動いているか」を5秒ごとに更新する。
 * 実行中ターン（Discord 等のセッション）と実行中タスクを並べ、タスクはその場で中断できる。
 */
export function LiveSheet({ onClose, notify, onAbortTask }) {
  const { t } = useI18n()
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api('/api/live')
      setData(d)
    } catch (e) {
      setData({ ok: false, reason: e.message, turns: [], tasks: [] })
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    return () => clearInterval(id)
  }, [load])

  const abort = async (task) => {
    setBusy(true)
    try {
      await api(`/api/boards/${encodeURIComponent(task.board)}/tasks/${encodeURIComponent(task.id)}/abort`, {
        method: 'POST',
        body: { reason: t('live.abortReason') },
      })
      notify?.(t('live.aborted', { id: task.id }))
      await load()
      onAbortTask?.()
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusy(false)
    }
  }

  const turns = data?.turns ?? []
  const tasks = data?.tasks ?? []
  const architect = data?.architect ?? []

  /**
   * Architect ジョブの「🔍 Quick Review」。赤ペン待ちのシートへ 1 タップで飛ぶ。
   * 遷移はアプリ共通のイベント（`hm:open-review`）に任せ、このシートは閉じる。
   */
  const openReview = (job) => {
    window.dispatchEvent(
      new CustomEvent('hm:open-review', {
        detail: { taskId: job.reviewTaskId ?? null, board: job.reviewBoard ?? job.board ?? null },
      }),
    )
    onClose?.()
  }

  /** 「📋 タスク」。ボード切替とタスク詳細はアプリ側（`hm:open-task`）が受ける。 */
  const openTask = (job) => {
    window.dispatchEvent(
      new CustomEvent('hm:open-task', { detail: { board: job.board ?? null, taskId: job.taskId } }),
    )
    onClose?.()
  }

  /**
   * 「✕ 終了」。ジョブを破棄して（カンバン側は触らない）一覧を取り直す。
   * 取り消しはできないが、破棄は**記録**であってタスク削除ではない（`architect.dismiss`）。
   */
  const dismissJob = async (job) => {
    if (!job?.id) return
    setBusy(true)
    try {
      await api(`/api/architect/jobs/${encodeURIComponent(job.id)}/dismiss`, { method: 'POST' })
      notify?.(t('live.architectDismissed', { id: job.id }))
      await load()
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={t('live.title')} onClose={onClose}>
      {data && !data.ok ? <div className="empty">{localizeError(data) || t('live.failed')}</div> : null}

      <div
        className="strip"
        style={{ gridTemplateColumns: architect.length ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)' }}
      >
        <div className={`stat ${turns.length ? 'warn' : ''}`}>
          <span className="stat-k">{t('live.turns')}</span>
          <span className="stat-v">{turns.length}</span>
        </div>
        <div className={`stat ${tasks.length ? 'warn' : ''}`}>
          <span className="stat-k">{t('live.tasks')}</span>
          <span className="stat-v">{tasks.length}</span>
        </div>
        {architect.length ? (
          <div className={`stat ${architect.some((j) => j.stalled) ? 'bad' : 'warn'}`}>
            <span className="stat-k">{t('live.architectShort')}</span>
            <span className="stat-v">{architect.length}</span>
          </div>
        ) : null}
      </div>

      <div className="list-head">
        <span>{t('live.architect')}</span>
      </div>
      <div className="list">
        {architect.map((job) => (
          <div key={job.id ?? `${job.board}:${job.startedAt}`} className="row static">
            <span className={`dot ${jobDot(job)}`} />
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">
                {seedSummary(job.seed) || job.runnerLabel || job.board || job.id}
              </span>
              <span className="row-sub">
                {[job.runnerLabel, job.board, phaseLabel(t, job.phase), fmtElapsed(job.elapsedSec)]
                  .filter(Boolean)
                  .join(' ${sep()} ')}
              </span>
              {job.stalled ? (
                <span className="row-sub" style={{ color: 'var(--bad)' }}>
                  {t('live.architectStalled')}
                </span>
              ) : null}
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {job.status === 'awaiting_review' ? (
                  <button className="chip on" onClick={() => openReview(job)}>
                    {t('live.architectQuickReview')}
                  </button>
                ) : null}
                {job.taskId ? (
                  <button className="chip" onClick={() => openTask(job)}>
                    {t('live.architectOpenTask')}
                  </button>
                ) : null}
                <button className="chip" disabled={busy} onClick={() => dismissJob(job)}>
                  {t('live.architectDismiss')}
                </button>
              </span>
            </span>
          </div>
        ))}
        {!architect.length ? <div className="empty">{t('live.architectNone')}</div> : null}
      </div>

      <div className="list-head">
        <span>{t('live.turn')}</span>
      </div>
      <div className="list">
        {turns.map((turn) => (
          <div key={`${turn.profile ?? 'default'}:${turn.sessionId}`} className="row static">
            <span className="dot running" />
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">{turn.title}</span>
              <span className="row-sub">
                {turn.platform || turn.source || '—'}
                {turn.profile && turn.profile !== 'default' ? ` ${sep()} ${turn.profile}` : ''} ${sep()} {fmtElapsed(turn.elapsedSec)}
                {turn.lastTool ? ` ${sep()} tool: ${turn.lastTool.name}` : turn.lastActivity ? ` ${sep()} ${turn.lastActivity}` : ''}
              </span>
              {turn.lastTool?.at ? (
                <span className="row-sub" style={{ opacity: 0.75 }}>
                  {t('live.lastTool', { time: relTime(turn.lastTool.at) })}
                  {turn.expiresInSec != null ? ` ${sep()} ${t('live.lease', { time: fmtElapsed(turn.expiresInSec) })}` : ''}
                </span>
              ) : null}
            </span>
            {turn.discordUrl ? (
              <button
                className="link"
                onClick={() => window.open(turn.discordUrl, '_blank', 'noopener')}
                aria-label={t('live.openInDiscord')}
              >
                #
              </button>
            ) : null}
          </div>
        ))}
        {!turns.length ? <div className="empty">{t('live.noTurns')}</div> : null}
      </div>

      <div className="list-head">
        <span>{t('live.task')}</span>
      </div>
      <div className="list">
        {tasks.map((task) => (
          <div key={`${task.board}:${task.id}`} className="row static">
            <span className="dot running" />
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">{task.title}</span>
              <span className="row-sub">
                {task.boardName || task.board} ${sep()} {fmtElapsed(task.elapsedSec)}
                {task.workerPid ? ` ${sep()} pid ${task.workerPid}` : ''}
              </span>
            </span>
          </div>
        ))}
        {!tasks.length ? <div className="empty">{t('live.noTasks')}</div> : null}
      </div>

      {tasks.length ? (
        <div style={{ marginTop: 12 }}>
          <HoldButton
            label={t('live.abortAll', { count: tasks.length })}
            sub={t('live.abortAllSub')}
            tone="danger"
            disabled={busy}
            onFire={async () => {
              for (const task of tasks) await abort(task)
            }}
          />
        </div>
      ) : null}

      <div className="row-sub" style={{ padding: '12px 2px 18px', lineHeight: 1.7 }}>
        {t('live.note')}
      </div>
    </Sheet>
  )
}
