import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { useI18n } from '../../i18n/index.js'
import {
  AUTOPILOT_RECIPES,
  buildAnswerPayload,
  buildDeckFromSheet,
  projectStudioStage,
} from '../../lib/autopilotDeck.js'
import { readActiveChatId } from '../../lib/chatReports.js'
import { haptic } from '../../lib/haptic.js'
import { buildSeedPayload } from '../../lib/specSeed.js'
import { refreshSync, setSyncParams, subscribeSync, tickSync } from '../../lib/syncSources.js'
import { celebrate } from '../../lib/vibe.js'
import { MissionReceiptSheet } from '../MissionReceiptSheet.jsx'
import { CompletionCard, LiveStudioCard, StarterStage } from './AutopilotCards.jsx'
import { AutopilotDeck } from './AutopilotDeck.jsx'

export function AutopilotLensToggle({ lens, onChange, waitingCount = 0 }) {
  const { t } = useI18n()
  return (
    <div className="ap-lens-toggle" role="tablist" aria-label={t('autopilot.lens.aria')}>
      <button
        type="button"
        role="tab"
        aria-selected={lens === 'autopilot'}
        className={`ap-lens-btn${lens === 'autopilot' ? ' active' : ''}`}
        onClick={() => {
          haptic('tap')
          onChange('autopilot')
        }}
      >
        <span>✨ {t('autopilot.lens.autopilot')}</span>
        {waitingCount > 0 && <span className="ap-lens-badge">{waitingCount}</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={lens === 'cockpit'}
        className={`ap-lens-btn${lens === 'cockpit' ? ' active' : ''}`}
        onClick={() => {
          haptic('tap')
          onChange('cockpit')
        }}
      >
        <span>🎛 {t('autopilot.lens.cockpit')}</span>
      </button>
    </div>
  )
}

export function AutopilotSwipeLink({ count = 0 }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="ap-swipe-link"
      onClick={() => {
        haptic('tap')
        emitHmEvent(HM_EVENTS.OPEN_AUTOPILOT)
      }}
    >
      <span>✨ {t('autopilot.swipeLink', { n: count })}</span>
    </button>
  )
}

/**
 * Zero-Fork Autopilot 統合ビュー（4 幕スタジオ投影）。
 */
export function AutopilotView({ overview, notify, onSwitchCockpit }) {
  const { t, lang } = useI18n()
  const [board, setBoard] = useState(overview?.board || null)
  const [items, setItems] = useState([])
  const [jobs, setJobs] = useState([])
  const [live, setLive] = useState(null)
  const [tasks, setTasks] = useState([])
  const [specReports, setSpecReports] = useState([])
  const [sheetById, setSheetById] = useState({})
  const [decisions, setDecisions] = useState({})
  const [dismissedCompleteId, setDismissedCompleteId] = useState(null)
  const [receiptOpen, setReceiptOpen] = useState(false)

  useEffect(() => {
    if (board) {
      setSyncParams({ board, architectBoard: board })
      tickSync('tasks')
      tickSync('specReports')
      tickSync('architectJobs')
      return undefined
    }
    let alive = true
    api('/api/boards')
      .then((res) => {
        if (!alive) return
        const first = Array.isArray(res?.boards) ? res.boards[0]?.slug : null
        if (first) setBoard(first)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [board])

  const onReview = useCallback((r) => setItems(Array.isArray(r?.items) ? r.items : []), [])
  const onJobs = useCallback((r) => setJobs(Array.isArray(r?.jobs) ? r.jobs : []), [])
  const onLive = useCallback((r) => setLive(r || null), [])
  const onTasks = useCallback((r) => setTasks(Array.isArray(r?.tasks) ? r.tasks : []), [])
  const onReports = useCallback((r) => setSpecReports(Array.isArray(r?.reports) ? r.reports : []), [])

  useEffect(() => {
    const offs = [
      subscribeSync('reviewWaiting', onReview),
      subscribeSync('architectJobs', onJobs),
      subscribeSync('live', onLive),
      subscribeSync('tasks', onTasks),
      subscribeSync('specReports', onReports),
    ]
    tickSync('reviewWaiting')
    tickSync('architectJobs')
    tickSync('live')
    if (board) {
      tickSync('tasks')
      tickSync('specReports')
    }
    return () => offs.forEach((off) => off?.())
  }, [onReview, onJobs, onLive, onTasks, onReports, board])

  const waiting = useMemo(() => items.filter((x) => x.status === 'blocked'), [items])

  useEffect(() => {
    let alive = true
    for (const item of waiting) {
      if (sheetById[item.id] || item.review?.mode === 'annotation') continue
      api(`/api/review/${encodeURIComponent(item.id)}/data`)
        .then((res) => {
          if (alive) setSheetById((prev) => ({ ...prev, [item.id]: res }))
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [waiting, sheetById])

  const cards = useMemo(() => {
    const out = []
    for (const item of waiting) out.push(...buildDeckFromSheet(item, sheetById[item.id] || null))
    return out
  }, [waiting, sheetById])

  const stage = useMemo(
    () =>
      projectStudioStage({
        cards,
        jobs,
        live,
        tasks,
        specReports,
        reviewItems: items,
        dismissedCompleteId,
      }),
    [cards, jobs, live, tasks, specReports, items, dismissedCompleteId],
  )

  const handleCommitAction = async (question, action, extra = {}) => {
    if (action === 'remix') return
    const next = {
      ...decisions,
      [question.key]: {
        action,
        choice: action === 'hold' ? null : (extra?.choice || question.recommendedId || 'A'),
        shot: extra?.shot || question.visualMock?.shot || null,
        annotation: extra?.annotation || null,
      },
    }
    setDecisions(next)
    const taskCards = cards.filter((c) => c.taskId === question.taskId)
    if (taskCards.length > 0 && taskCards.every((c) => next[c.key]) && question.taskId) {
      const payload = buildAnswerPayload(taskCards, next)
      try {
        await api(`/api/review/${encodeURIComponent(question.taskId)}/answer`, {
          method: 'POST',
          body: payload,
        })
        notify?.(t('autopilot.answered'))
        refreshSync('reviewWaiting')
        refreshSync('architectJobs')
        if (board) refreshSync('tasks')
      } catch (e) {
        notify?.(e?.message || t('review.sendFailed'))
      }
    }
  }

  const handleSaveMemo = async (memoText) => {
    if (!memoText) return
    try {
      await api('/api/memos', {
        method: 'POST',
        body: { title: memoText.slice(0, 48), body: memoText, tags: ['autopilot', 'idea'] },
      })
      emitHmEvent(HM_EVENTS.MEMOS_CHANGED)
      notify?.(t('autopilot.memoSaved'))
    } catch {
      /* noop */
    }
  }

  const handleStartSeed = async (seedText) => {
    const res = await api('/api/architect/seed', {
      method: 'POST',
      body: buildSeedPayload({
        seedText,
        autoStart: true,
        executionPolicy: 'visual-gate',
        autopilot: true,
        board: board || overview?.board || '',
        repo: overview?.repo || null,
        chat: readActiveChatId(),
        lang,
      }),
    })
    try {
      celebrate('launch')
    } catch {
      /* noop */
    }
    notify?.(t('seed.toast'))
    refreshSync('architectJobs')
    refreshSync('reviewWaiting')
    return res
  }

  return (
    <div className="ap-view">
      {stage.act === 'deck' && (
        <AutopilotDeck
          cards={stage.cards}
          onCommitAction={handleCommitAction}
          onSaveMemo={handleSaveMemo}
          onUndoAction={(entry) => {
            setDecisions((prev) => {
              const copy = { ...prev }
              delete copy[entry.cardKey]
              return copy
            })
          }}
          notify={notify}
        />
      )}
      {stage.act === 'live' && (
        <LiveStudioCard
          stage={stage}
          onSwitchCockpit={onSwitchCockpit}
          onSaveMemo={handleSaveMemo}
        />
      )}
      {stage.act === 'complete' && (
        <CompletionCard
          deliverable={stage.deliverable}
          onOpenReceipt={() => setReceiptOpen(true)}
          onStartNew={() => setDismissedCompleteId(stage.deliverable.id)}
          onSwitchCockpit={onSwitchCockpit}
          notify={notify}
        />
      )}
      {stage.act === 'start' && (
        <StarterStage
          recipes={AUTOPILOT_RECIPES}
          onStartSeed={handleStartSeed}
          onSwitchCockpit={onSwitchCockpit}
          notify={notify}
        />
      )}
      {receiptOpen && (
        <MissionReceiptSheet
          board={board}
          spec={stage?.deliverable?.spec || null}
          onClose={() => setReceiptOpen(false)}
          notify={notify}
        />
      )}
    </div>
  )
}
