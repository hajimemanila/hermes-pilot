import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Sheet, relTime } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'

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

  return (
    <Sheet title={t('live.title')} onClose={onClose}>
      {data && !data.ok ? <div className="empty">{data.reason}</div> : null}

      <div className="strip" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className={`stat ${turns.length ? 'warn' : ''}`}>
          <span className="stat-k">{t('live.turns')}</span>
          <span className="stat-v">{turns.length}</span>
        </div>
        <div className={`stat ${tasks.length ? 'warn' : ''}`}>
          <span className="stat-k">{t('live.tasks')}</span>
          <span className="stat-v">{tasks.length}</span>
        </div>
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
                {turn.profile && turn.profile !== 'default' ? ` ・ ${turn.profile}` : ''} ・ {fmtElapsed(turn.elapsedSec)}
                {turn.lastTool ? ` ・ tool: ${turn.lastTool.name}` : turn.lastActivity ? ` ・ ${turn.lastActivity}` : ''}
              </span>
              {turn.lastTool?.at ? (
                <span className="row-sub" style={{ opacity: 0.75 }}>
                  {t('live.lastTool', { time: relTime(turn.lastTool.at) })}
                  {turn.expiresInSec != null ? ` ・ ${t('live.lease', { time: fmtElapsed(turn.expiresInSec) })}` : ''}
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
                {task.boardName || task.board} ・ {fmtElapsed(task.elapsedSec)}
                {task.workerPid ? ` ・ pid ${task.workerPid}` : ''}
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
