import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { useI18n } from '../../i18n/index.js'
import { buildAnswerPayload, buildDeckFromSheet } from '../../lib/autopilotDeck.js'
import { readActiveChatId } from '../../lib/chatReports.js'
import { haptic } from '../../lib/haptic.js'
import { buildSeedPayload, pickActiveArchitectJob } from '../../lib/specSeed.js'
import { refreshSync, subscribeSync, tickSync } from '../../lib/syncSources.js'
import { celebrate } from '../../lib/vibe.js'
import { AutopilotDeck } from './AutopilotDeck.jsx'

/**
 * `[✨ Autopilot | 🎛 Cockpit]` 2 段階ゼロフォーク切替ピル（AP-5）。
 */
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

/**
 * Cockpit 側（ReviewPane / TasksPane）から Autopilot デッキへ戻る導線（AP-5）。
 */
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
 * 進行中のモック ↔ 実装スクショのワイプ比較ライブ進捗カード（AP-5）。
 */
function LiveWipeCard({ item }) {
  const { t } = useI18n()
  const [split, setSplit] = useState(50)
  if (!item) return null
  const afterSrc = `/api/review/${encodeURIComponent(item.id)}/image`
  const beforeSrc = item.review?.hasCompare ? `${afterSrc}?compare=1` : afterSrc
  return (
    <section className="ap-wipe-card" aria-label={t('autopilot.wipe.aria')}>
      <header className="ap-wipe-head">
        <span className="ap-wipe-badge">{t('autopilot.wipe.live')}</span>
        <span className="ap-wipe-title">{item.title}</span>
        <span className="ap-wipe-pct">{split}%</span>
      </header>
      <div className="ap-wipe-stage">
        <img src={afterSrc} alt={t('autopilot.wipe.after')} className="ap-wipe-img" />
        <div className="ap-wipe-before" style={{ width: `${split}%` }}>
          <img src={beforeSrc} alt={t('autopilot.wipe.before')} className="ap-wipe-img" />
        </div>
        <div className="ap-wipe-divider" style={{ left: `${split}%` }} aria-hidden="true" />
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label={t('autopilot.wipe.sliderAria')}
        className="ap-wipe-slider"
      />
    </section>
  )
}

/**
 * Zero-Fork Autopilot 投影ビュー（`syncSources.reviewWaiting` 購読のみ・独自ポーリング無し）。
 */
export function AutopilotView({ overview, notify, onSwitchCockpit }) {
  const { t, lang } = useI18n()
  const [items, setItems] = useState([])
  const [jobs, setJobs] = useState([])
  const [sheetById, setSheetById] = useState({})
  const [decisions, setDecisions] = useState({})

  const applyItems = useCallback((res) => {
    setItems(Array.isArray(res?.items) ? res.items : [])
  }, [])
  const applyJobs = useCallback((res) => {
    setJobs(Array.isArray(res?.jobs) ? res.jobs : [])
  }, [])

  useEffect(() => {
    const offReview = subscribeSync('reviewWaiting', applyItems)
    const offJobs = subscribeSync('architectJobs', applyJobs)
    tickSync('reviewWaiting')
    tickSync('architectJobs')
    return () => {
      offReview()
      offJobs()
    }
  }, [applyItems, applyJobs])

  const activeJob = useMemo(() => pickActiveArchitectJob(jobs), [jobs])

  const waiting = useMemo(() => items.filter((x) => x.status === 'blocked'), [items])
  const liveCompareItem = useMemo(
    () => items.find((x) => x.status !== 'blocked' && x.review?.image && x.review?.hasCompare) || null,
    [items],
  )

  useEffect(() => {
    let alive = true
    for (const item of waiting) {
      if (sheetById[item.id]) continue
      if (item.review?.mode === 'annotation') continue
      api(`/api/review/${encodeURIComponent(item.id)}/data`)
        .then((res) => {
          if (!alive) return
          setSheetById((prev) => ({ ...prev, [item.id]: res }))
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [waiting, sheetById])

  const cards = useMemo(() => {
    const out = []
    for (const item of waiting) {
      out.push(...buildDeckFromSheet(item, sheetById[item.id] || null))
    }
    return out
  }, [waiting, sheetById])

  const handleCommitAction = async (card, action, extra = {}) => {
    if (action === 'remix') return
    const next = {
      ...decisions,
      [card.key]: {
        action,
        choice: action === 'hold' ? null : card.recommendedId || 'A',
        annotation: extra?.annotation || null,
      },
    }
    setDecisions(next)
    const taskCards = cards.filter((c) => c.taskId === card.taskId)
    const allDecided = taskCards.length > 0 && taskCards.every((c) => next[c.key])
    if (allDecided && card.taskId) {
      const payload = buildAnswerPayload(taskCards, next)
      try {
        await api(`/api/review/${encodeURIComponent(card.taskId)}/answer`, {
          method: 'POST',
          body: payload,
        })
        notify?.(t('autopilot.answered'))
        refreshSync('reviewWaiting')
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
        board: overview?.board || '',
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
      {liveCompareItem && <LiveWipeCard item={liveCompareItem} />}
      <AutopilotDeck
        cards={cards}
        activeJob={activeJob}
        onStartSeed={handleStartSeed}
        onCommitAction={handleCommitAction}
        onSaveMemo={handleSaveMemo}
        onUndoAction={(entry) => {
          setDecisions((prev) => {
            const copy = { ...prev }
            delete copy[entry.cardKey]
            return copy
          })
        }}
        onSwitchCockpit={onSwitchCockpit}
        notify={notify}
      />
    </div>
  )
}
