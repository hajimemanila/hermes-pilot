import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { HM_STORAGE } from '../../contracts/storage.js'
import { useI18n } from '../../i18n/index.js'
import {
  AUTOPILOT_RECIPES,
  buildAnswerPayload,
  buildDeckFromSheet,
  projectStudioStage,
} from '../../lib/autopilotDeck.js'
import {
  clearAutopilotRunAnchor,
  readAutopilotRunAnchor,
  writeAutopilotRunAnchor,
} from '../../lib/autopilot/studio.js'
import { readActiveChatId } from '../../lib/chatReports.js'
import { haptic } from '../../lib/haptic.js'
import { buildSeedPayload } from '../../lib/specSeed.js'
import { refreshSync, setSyncParams, setSyncState, subscribeSync, tickSync } from '../../lib/syncSources.js'
import { celebrate } from '../../lib/vibe.js'
import { MissionReceiptSheet } from '../MissionReceiptSheet.jsx'
import {
  AutopilotProjectBar,
  AutopilotProjectSheet,
  CompletionCard,
  LiveStudioCard,
  StarterStage,
} from './AutopilotCards.jsx'
import { AutopilotDeck } from './AutopilotDeck.jsx'

const AP_BOARD_KEY = HM_STORAGE.BOARD

export function AutopilotLensToggle({ lens, onChange, waitingCount = 0, runningCount = 0 }) {
  const { t } = useI18n()
  return (
    <div className="ap-lens-toggle" role="tablist" aria-label={t('autopilot.lens.aria')}>
      <button
        type="button"
        role="tab"
        aria-selected={lens === 'autopilot'}
        className={`ap-lens-btn${lens === 'autopilot' ? ' active' : ''}`}
        onClick={(e) => {
          haptic('tap')
          onChange('autopilot', e)
        }}
      >
        <span>✨ {t('autopilot.lens.autopilot')}</span>
        {lens !== 'autopilot' && runningCount > 0 && <span className="ap-lens-live-dot" aria-hidden="true" />}
        {waitingCount > 0 && <span className="ap-lens-badge">{waitingCount}</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={lens === 'cockpit'}
        className={`ap-lens-btn${lens === 'cockpit' ? ' active' : ''}`}
        onClick={(e) => {
          haptic('tap')
          onChange('cockpit', e)
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
      <span aria-hidden="true">→</span>
    </button>
  )
}

/**
 * Zero-Fork Autopilot 統合ビュー（4 幕スタジオ投影）。
 */
export function AutopilotView({ overview, notify, onSwitchCockpit }) {
  const { t, lang } = useI18n()
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(() => {
    try {
      return localStorage.getItem(AP_BOARD_KEY) || overview?.board || null
    } catch {
      return overview?.board || null
    }
  })
  const [preview, setPreview] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [items, setItems] = useState([])
  const [jobs, setJobs] = useState([])
  const [live, setLive] = useState(null)
  const [tasks, setTasks] = useState([])
  const [specReports, setSpecReports] = useState([])
  const [sheetById, setSheetById] = useState({})
  const [decisions, setDecisions] = useState({})
  const [dismissedCompleteId, setDismissedCompleteId] = useState(null)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [runAnchor, setRunAnchor] = useState(() => readAutopilotRunAnchor(board || overview?.board || 'default'))

  const selectBoard = useCallback((slug) => {
    const next = slug || null
    setBoard(next)
    setPreview(null)
    setTasks([])
    setSpecReports([])
    setDecisions({})
    setDismissedCompleteId(null)
    setRunAnchor(readAutopilotRunAnchor(next || 'default'))
    try {
      if (next) localStorage.setItem(AP_BOARD_KEY, next)
    } catch {
      /* noop */
    }
  }, [])

  const loadBoards = useCallback(async () => {
    try {
      const res = await api('/api/boards')
      const list = Array.isArray(res?.boards) ? res.boards : []
      setBoards(list)
      if (!board && list[0]?.slug) selectBoard(list[0].slug)
    } catch {
      /* noop */
    }
  }, [board, selectBoard])

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  useEffect(() => {
    if (!board) return undefined
    setSyncParams({ board, architectBoard: board })
    tickSync('tasks')
    tickSync('specReports')
    tickSync('architectJobs')
    return undefined
  }, [board])

  useEffect(() => {
    setSyncParams({ liveSince: runAnchor?.startedAt || null })
    if (runAnchor?.startedAt) refreshSync('live')
    return () => setSyncParams({ liveSince: null })
  }, [runAnchor?.startedAt])

  useEffect(() => {
    const busyJob = (Array.isArray(jobs) ? jobs : []).find(
      (j) => j && !j.dismissed && ['running', 'awaiting_spec'].includes(String(j.status)),
    )
    setSyncState({ architectBusy: Boolean(busyJob) })
    const reviewJob = (Array.isArray(jobs) ? jobs : []).find(
      (j) => j && !j.dismissed && String(j.status) === 'awaiting_review' && j.reviewTaskId,
    )
    if (reviewJob && !items.some((it) => it?.id === reviewJob.reviewTaskId)) {
      refreshSync('reviewWaiting')
    }
  }, [jobs, items])

  useEffect(() => {
    if (!board) return undefined
    let alive = true
    api(`/api/boards/${encodeURIComponent(board)}/preview`)
      .then((res) => {
        if (alive) setPreview(res?.ok ? res : null)
      })
      .catch(() => {
        if (alive) setPreview(null)
      })
    return () => {
      alive = false
    }
  }, [board, tasks.length, specReports.length])

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
      if (Object.prototype.hasOwnProperty.call(sheetById, item.id) || item.review?.mode === 'annotation') continue
      api(`/api/review/${encodeURIComponent(item.id)}/data`)
        .then((res) => {
          if (alive) setSheetById((prev) => ({ ...prev, [item.id]: res }))
        })
        .catch(() => {
          if (alive) setSheetById((prev) => ({ ...prev, [item.id]: null }))
        })
    }
    return () => {
      alive = false
    }
  }, [waiting, sheetById])

  const cards = useMemo(() => {
    const out = []
    for (const item of waiting) {
      if (item.review?.mode !== 'annotation' && !Object.prototype.hasOwnProperty.call(sheetById, item.id)) continue
      out.push(...buildDeckFromSheet(item, sheetById[item.id] || null))
    }
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
        preview,
        dismissedCompleteId,
        runStartedAt: runAnchor?.startedAt || null,
      }),
    [cards, jobs, live, tasks, specReports, items, preview, dismissedCompleteId, runAnchor?.startedAt],
  )

  useEffect(() => {
    const boardKey = board || overview?.board || 'default'
    const jobList = (Array.isArray(jobs) ? jobs : []).filter((j) => j && !j.dismissed)
    const activeJob =
      jobList.find((j) => ['running', 'awaiting_spec', 'awaiting_review', 'spec_ready'].includes(String(j.status))) || null
    const hasOpenWork = stage.act === 'live' || Boolean(activeJob) || waiting.length > 0

    if (hasOpenWork) {
      const inferredStart = Number(stage.runStartedAt || activeJob?.startedAt || activeJob?.createdAt || 0) || Date.now()
      const inferredId = String(activeJob?.id || stage.runKey || `run-${inferredStart}`)
      const activeTaskId = stage.activeTask?.id ? String(stage.activeTask.id) : null
      setRunAnchor((prev) => {
        if (!prev) {
          const created = { runId: inferredId, startedAt: inferredStart, maxTokens: 0, nudges: [] }
          writeAutopilotRunAnchor(boardKey, created)
          return created
        }
        const jobCreated = Number(activeJob?.createdAt || 0)
        if (activeJob?.id && activeJob.id !== prev.runId && jobCreated > prev.startedAt + 15_000) {
          const reset = { runId: activeJob.id, startedAt: jobCreated, maxTokens: 0, nudges: [] }
          writeAutopilotRunAnchor(boardKey, reset)
          return reset
        }
        const prevNudges = Array.isArray(prev.nudges) ? prev.nudges : []
        if (activeTaskId && prevNudges.some((n) => n.status === 'queued' && n.taskId && n.taskId !== activeTaskId)) {
          const nextNudges = prevNudges.map((n) =>
            n.status === 'queued' && n.taskId && n.taskId !== activeTaskId ? { ...n, status: 'applied' } : n,
          )
          const updated = { ...prev, nudges: nextNudges }
          writeAutopilotRunAnchor(boardKey, updated)
          return updated
        }
        return prev
      })
    } else if (stage.act === 'complete' || stage.act === 'start') {
      setRunAnchor((prev) => {
        if (!prev) return prev
        clearAutopilotRunAnchor(boardKey)
        return null
      })
    }
  }, [board, overview?.board, stage.act, stage.runStartedAt, stage.runKey, stage.activeTask?.id, jobs, waiting.length])

  const handleFocusReview = useCallback(() => {
    refreshSync('reviewWaiting')
    if (waiting.length === 0) onSwitchCockpit?.()
  }, [waiting.length, onSwitchCockpit])

  const handleObservedTokens = useCallback(
    (tokens) => {
      const n = Math.max(0, Number(tokens) || 0)
      const boardKey = board || overview?.board || 'default'
      setRunAnchor((prev) => {
        if (!prev || n <= (prev.maxTokens || 0)) return prev
        const next = { ...prev, maxTokens: n }
        writeAutopilotRunAnchor(boardKey, next)
        return next
      })
    },
    [board, overview?.board],
  )

  const handleSendNudge = useCallback(
    async (text) => {
      const clean = String(text || '').trim()
      if (!clean) return
      const boardKey = board || overview?.board || 'default'
      const openTaskId =
        stage.activeTask?.id ||
        tasks.find((tk) => ['running', 'ready', 'blocked', 'in_progress'].includes(String(tk?.status || '').toLowerCase()))?.id ||
        null

      try {
        await api('/api/memos', {
          method: 'POST',
          body: { title: clean.slice(0, 48), body: clean, tags: ['autopilot', 'nudge'] },
        })
        emitHmEvent(HM_EVENTS.MEMOS_CHANGED)
      } catch {
        /* best effort memo persistence */
      }
      if (board && openTaskId) {
        try {
          await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(openTaskId)}/comment`, {
            method: 'POST',
            body: { body: `[LIVE NUDGE] ${clean}`, by: 'mobile' },
          })
        } catch {
          /* task comment may fail if task just completed; memo still holds nudge */
        }
      }
      const entry = {
        id: `n-${Date.now()}`,
        text: clean,
        at: Date.now(),
        taskId: openTaskId,
        status: 'queued',
      }
      setRunAnchor((prev) => {
        const base = prev || {
          runId: String(stage.runKey || 'live'),
          startedAt: Number(stage.runStartedAt) || Date.now(),
          maxTokens: 0,
          nudges: [],
        }
        const next = { ...base, nudges: [...(base.nudges || []).slice(-9), entry] }
        writeAutopilotRunAnchor(boardKey, next)
        return next
      })
      notify?.(t('autopilot.nudge.queuedToast'))
    },
    [board, overview?.board, stage.activeTask?.id, stage.runKey, stage.runStartedAt, tasks, notify, t],
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
        setDecisions((prev) => {
          const copy = { ...prev }
          for (const c of taskCards) delete copy[c.key]
          return copy
        })
        notify?.(t('autopilot.answered'))
        await Promise.all([
          refreshSync('reviewWaiting'),
          refreshSync('architectJobs'),
          refreshSync('live'),
          refreshSync('overview'),
          board ? refreshSync('tasks') : Promise.resolve(),
        ])
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
    const boardKey = board || overview?.board || 'default'
    const seedStart = Date.now()
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
    const startedAt = Number(res?.job?.createdAt) || seedStart
    const nextAnchor = { runId: String(res?.job?.id || `seed-${startedAt}`), startedAt, maxTokens: 0 }
    writeAutopilotRunAnchor(boardKey, nextAnchor)
    setRunAnchor(nextAnchor)
    setSyncParams({ liveSince: startedAt })
    try {
      celebrate('launch')
    } catch {
      /* noop */
    }
    notify?.(t('seed.toast'))
    refreshSync('architectJobs')
    refreshSync('reviewWaiting')
    refreshSync('live')
    return res
  }

  return (
    <div className="ap-view">
      <AutopilotProjectBar
        boards={boards}
        board={board}
        preview={preview}
        onOpenPicker={() => setPickerOpen(true)}
      />
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
          runStartedAt={runAnchor?.startedAt || stage.runStartedAt || null}
          runId={runAnchor?.runId || stage.runKey}
          persistedMaxTokens={runAnchor?.maxTokens || 0}
          nudges={runAnchor?.nudges || []}
          reviewItems={items}
          onObservedTokens={handleObservedTokens}
          onSendNudge={handleSendNudge}
          onFocusReview={handleFocusReview}
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
          onOpenPicker={() => setPickerOpen(true)}
          onSwitchCockpit={onSwitchCockpit}
          notify={notify}
        />
      )}
      {pickerOpen && (
        <AutopilotProjectSheet
          boards={boards}
          board={board}
          onSelectBoard={selectBoard}
          onCreatedProject={async (slug) => {
            await loadBoards()
            selectBoard(slug)
          }}
          onClose={() => setPickerOpen(false)}
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
