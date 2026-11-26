import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api.js'
import { useI18n } from '../../i18n/index.js'
import {
  REMIX_CHIPS,
  buildRemixPayload,
  classifySwipe,
  createRemixPending,
  createUndoEntry,
  currentOptionCard,
  isInEdgeDeadZone,
  isUndoActive,
  resolveOptionSwipe,
} from '../../lib/autopilotDeck.js'
import { haptic } from '../../lib/haptic.js'
import { celebrateAction } from '../../lib/vibe.js'
import { AnnotationEditor } from '../AnnotationEditor.jsx'
import { OptionMockPreview } from './AutopilotCards.jsx'

const FLY_MS = 220

/**
 * Autopilot Option-Cycle スワイプデッキ（1 選択肢 = 1 カード / 3 枚スタック物理 / きらめき）。
 */
export function AutopilotDeck({
  cards = [],
  onCommitAction,
  onRemixCard,
  onSaveMemo,
  onUndoAction,
  notify,
}) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [optIndex, setOptIndex] = useState(0)
  const [drag, setDrag] = useState({ active: false, dx: 0, dy: 0, gx: 50, gy: 35 })
  const [flying, setFlying] = useState(null)
  const [undo, setUndo] = useState(null)
  const [remixPending, setRemixPending] = useState(null)
  const [remixNoteMode, setRemixNoteMode] = useState(false)
  const [remixNoteText, setRemixNoteText] = useState('')
  const [annotating, setAnnotating] = useState(null)
  const gestureRef = useRef({ active: false, startX: 0, startY: 0, pointerId: null })
  const flyTimerRef = useRef(null)

  const question = cards[index] || null
  const cardView = currentOptionCard(question, optIndex)
  const nextQuestion = !cardView?.isLastOption ? question : cards[index + 1] || null
  const nextOptionView = nextQuestion
    ? currentOptionCard(nextQuestion, !cardView?.isLastOption ? optIndex + 1 : 0)
    : null
  const thirdQuestion = cards[index + (!cardView?.isLastOption ? 1 : 2)] || null
  const swipe = classifySwipe(drag.dx, drag.dy)

  useEffect(() => {
    setOptIndex(0)
  }, [question?.key])

  useEffect(() => () => {
    if (flyTimerRef.current) clearTimeout(flyTimerRef.current)
  }, [])

  useEffect(() => {
    if (!undo) return undefined
    const ms = Math.max(0, undo.expiresAt - Date.now())
    const id = setTimeout(() => setUndo(null), ms)
    return () => clearTimeout(id)
  }, [undo])

  const sendRemix = async (targetCard, reason, hint = '') => {
    setRemixPending(null)
    setRemixNoteMode(false)
    setRemixNoteText('')
    const payload = buildRemixPayload(targetCard, reason, hint)
    if (onRemixCard) {
      await onRemixCard(targetCard, payload)
      return
    }
    if (targetCard?.taskId) {
      await api(`/api/review/${encodeURIComponent(targetCard.taskId)}/remix`, {
        method: 'POST',
        body: payload,
      })
    }
  }

  useEffect(() => {
    if (!remixPending || remixNoteMode) return undefined
    const ms = Math.max(0, remixPending.expiresAt - Date.now())
    const id = setTimeout(() => {
      sendRemix(remixPending.card, 'alternative', '')
    }, ms)
    return () => clearTimeout(id)
  }, [remixPending, remixNoteMode])

  const shotUrlFor = (shot, taskId) =>
    shot && taskId ? `/api/review/${encodeURIComponent(taskId)}/thumb/${shot}` : null

  const applyOutcome = (direction, rect) => {
    if (!question || !cardView) return
    const res = resolveOptionSwipe(question, optIndex, direction)
    if (!res) return

    if (res.type === 'annotate') {
      haptic('action')
      setAnnotating({ question, option: cardView.option, shot: cardView.shot })
      return
    }

    if (res.type === 'next-option') {
      haptic('tap')
      setFlying('left')
      flyTimerRef.current = setTimeout(() => {
        setFlying(null)
        setOptIndex(res.nextOptionIndex)
      }, FLY_MS)
      return
    }

    if (res.type === 'remix-chips') {
      haptic('action')
      setFlying('left')
      flyTimerRef.current = setTimeout(() => {
        setFlying(null)
        setRemixPending(createRemixPending(question))
        setRemixNoteMode(false)
        setRemixNoteText('')
      }, FLY_MS)
      return
    }

    if (res.type === 'hold') {
      haptic('action')
      setFlying('down')
      flyTimerRef.current = setTimeout(() => {
        setFlying(null)
        if (res.outcome.kind === 'memo') onSaveMemo?.(res.outcome.memoText, question)
        setUndo(createUndoEntry(question, 'hold', Date.now(), 3000, optIndex))
        setIndex((i) => i + 1)
        setOptIndex(0)
        onCommitAction?.(question, 'hold', res.outcome)
      }, FLY_MS)
      return
    }

    // 右スワイプ（採用）
    haptic('success')
    celebrateAction('approve', {
      x: rect ? Math.round(rect.left + rect.width / 2) : null,
      y: rect ? Math.round(rect.top + rect.height / 2) : null,
      sfx: true,
    })
    setFlying('right')
    flyTimerRef.current = setTimeout(() => {
      setFlying(null)
      setUndo(createUndoEntry(question, 'go', Date.now(), 3000, optIndex))
      setIndex((i) => i + 1)
      setOptIndex(0)
      onCommitAction?.(question, 'go', { choice: res.choice, shot: cardView.shot })
    }, FLY_MS)
  }

  const handlePointerDown = (e) => {
    if (!cardView || flying || e.button > 0) return
    if (e.target?.closest?.('button, a, input, textarea')) return
    if (isInEdgeDeadZone(e.clientX, typeof window !== 'undefined' ? window.innerWidth : 0)) return
    gestureRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    }
    e.currentTarget?.setPointerCapture?.(e.pointerId)
    setDrag({ active: true, dx: 0, dy: 0, gx: 50, gy: 35 })
  }

  const handlePointerMove = (e) => {
    const g = gestureRef.current
    if (!g.active || g.pointerId !== e.pointerId) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    const gx = Math.max(10, Math.min(90, Math.round(50 + dx / 5)))
    const gy = Math.max(10, Math.min(90, Math.round(35 + dy / 5)))
    setDrag({ active: true, dx, dy, gx, gy })
  }

  const handlePointerEnd = (e) => {
    const g = gestureRef.current
    if (!g.active || g.pointerId !== e.pointerId) return
    gestureRef.current.active = false
    const finalSwipe = classifySwipe(e.clientX - g.startX, e.clientY - g.startY)
    const rect = e.currentTarget?.getBoundingClientRect?.()
    setDrag({ active: false, dx: 0, dy: 0, gx: 50, gy: 35 })
    if (finalSwipe.committed && finalSwipe.direction) {
      applyOutcome(finalSwipe.direction, rect)
    }
  }

  const handleUndo = () => {
    if (!isUndoActive(undo)) {
      setUndo(null)
      return
    }
    haptic('tap')
    const prev = undo
    setUndo(null)
    setIndex((i) => Math.max(0, i - 1))
    setOptIndex(prev.prevOptionIndex || 0)
    onUndoAction?.(prev)
  }

  if (!cardView) return null

  const rotDeg = drag.active ? Math.max(-14, Math.min(14, drag.dx / 16)) : 0
  const stackLift = drag.active ? Math.min(1, Math.hypot(drag.dx, drag.dy) / 90) : 0
  const frontStyle = {
    '--ap-glint-x': `${drag.gx}%`,
    '--ap-glint-y': `${drag.gy}%`,
    ...(drag.active
      ? { transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0) rotate(${rotDeg}deg)` }
      : {}),
  }
  const glowCls = swipe.direction ? ` glow-${swipe.direction}` : ''
  const flyCls = flying ? ` fly-${flying}` : ''
  const shotUrl = shotUrlFor(cardView.shot, question.taskId)

  return (
    <section className="ap-deck-shell" aria-label={t('autopilot.deckAria')}>
      <div className="ap-deck-stage">
        {thirdQuestion && (
          <div className="ap-card ap-stack-back ap-stack-3" aria-hidden="true" />
        )}
        {nextOptionView && (
          <div
            className="ap-card ap-stack-back ap-stack-2"
            style={{
              transform: `scale(${0.94 + stackLift * 0.04}) translate3d(0, ${14 - stackLift * 10}px, 0)`,
            }}
            aria-hidden="true"
          >
            <header className="ap-card-head">
              <span className="ap-opt-pill">{nextOptionView.option.id}</span>
              <span className="ap-card-topic">{nextOptionView.option.label}</span>
            </header>
          </div>
        )}

        <article
          className={`ap-card ap-card-front${drag.active ? ' dragging' : ''}${glowCls}${flyCls}`}
          style={frontStyle}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <div className="ap-card-glint" aria-hidden="true" />

          {swipe.stamp && (
            <div
              className={`ap-stamp ap-stamp-${swipe.direction}`}
              style={{ opacity: Math.min(1, 0.3 + swipe.progress * 0.7) }}
            >
              {swipe.direction === 'left' && !cardView.isLastOption
                ? `${t('autopilot.btn.nextOpt')} ${question.options[optIndex + 1]?.id || ''}`
                : swipe.stamp}
            </div>
          )}

          <header className="ap-card-head">
            <span className="ap-card-counter">
              Q{index + 1} / {cards.length}
            </span>
            <div className="ap-variant-dots" role="tablist" aria-label={t('autopilot.variantAria')}>
              {question.options.map((opt, idx) => (
                <button
                  key={opt.id}
                  type="button"
                  role="tab"
                  aria-selected={idx === optIndex}
                  className={`ap-var-pill${idx === optIndex ? ' active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    haptic('tap')
                    setOptIndex(idx)
                  }}
                >
                  {opt.id}
                </button>
              ))}
            </div>
            {cardView.option.recommended && (
              <span className="ap-rec-badge">★ {t('review.recommended')}</span>
            )}
          </header>

          <div className="ap-card-media">
            <OptionMockPreview
              option={cardView.option}
              question={question}
              shotUrl={shotUrl}
              layoutVariant={cardView.layoutVariant}
              theme={cardView.theme}
              t={t}
            />
          </div>

          <div className="ap-card-copy">
            <p className="ap-card-q-sub">{question.text}</p>
            <h2 className="ap-card-opt-hero">
              <span className="ap-opt-id-chip">{cardView.option.id}</span>
              <span>{cardView.option.label}</span>
            </h2>
            {cardView.option.detail && <p className="ap-card-opt-detail">{cardView.option.detail}</p>}
          </div>
        </article>
      </div>

      {remixPending && (
        <div className="ap-remix-bar" role="region" aria-label={t('autopilot.btn.remix')}>
          {remixNoteMode ? (
            <form
              className="ap-remix-note-row"
              onSubmit={(e) => {
                e.preventDefault()
                sendRemix(remixPending.card, 'note', remixNoteText)
              }}
            >
              <input
                type="text"
                className="ap-remix-input"
                value={remixNoteText}
                onChange={(e) => setRemixNoteText(e.target.value)}
                placeholder={t('autopilot.remix.note')}
              />
              <button type="submit" className="ap-remix-send">{t('autopilot.btn.go')}</button>
            </form>
          ) : (
            <div className="ap-remix-chips">
              <button
                type="button"
                className="ap-remix-chip"
                onClick={() => {
                  haptic('tap')
                  setRemixPending(null)
                  setOptIndex(0)
                }}
              >
                ↺ {t('autopilot.remix.backToFirst')}
              </button>
              {REMIX_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="ap-remix-chip"
                  onClick={() => {
                    if (chip.id === 'note') setRemixNoteMode(true)
                    else sendRemix(remixPending.card, chip.id, '')
                  }}
                >
                  <span>{chip.icon}</span>
                  <span>{t(chip.labelKey)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isUndoActive(undo) && (
        <div className="ap-undo-pill" role="status">
          <span className="ap-undo-label">{t('autopilot.undoPrompt', { action: undo.action.toUpperCase() })}</span>
          <button type="button" className="ap-undo-btn" onClick={handleUndo}>
            {t('autopilot.undo')}
          </button>
        </div>
      )}

      <footer className="ap-action-bar" aria-label={t('autopilot.actionsAria')}>
        <button
          type="button"
          className="ap-act-btn ap-act-remix"
          onClick={(e) => applyOutcome('left', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">✕</span>
          <span className="ap-act-lbl">
            {cardView.isLastOption ? t('autopilot.btn.remix') : t('autopilot.btn.nextOpt')}
          </span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-hold"
          onClick={(e) => applyOutcome('down', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">⏸</span>
          <span className="ap-act-lbl">{t('autopilot.btn.hold')}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-annotate"
          onClick={(e) => applyOutcome('up', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">🖍</span>
          <span className="ap-act-lbl">{t('autopilot.btn.annotate')}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-go"
          onClick={(e) => applyOutcome('right', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">♥</span>
          <span className="ap-act-lbl">{t('autopilot.btn.go')}</span>
        </button>
      </footer>

      {annotating && (
        <AnnotationEditor
          item={{ id: annotating.question.taskId, title: annotating.option?.label || annotating.question.text }}
          imageSrc={shotUrlFor(annotating.shot, annotating.question.taskId)}
          onClose={() => setAnnotating(null)}
          onCollectAnnotation={(ann) => {
            const target = annotating
            setAnnotating(null)
            celebrateAction('approve', { sfx: true })
            setUndo(createUndoEntry(target.question, 'annotate', Date.now(), 3000, optIndex))
            setIndex((i) => i + 1)
            setOptIndex(0)
            onCommitAction?.(target.question, 'annotate', {
              choice: target.option?.id,
              shot: target.shot,
              annotation: ann,
            })
          }}
          notify={notify}
        />
      )}
    </section>
  )
}
