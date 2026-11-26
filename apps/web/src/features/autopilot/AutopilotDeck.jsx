import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api.js'
import { useI18n } from '../../i18n/index.js'
import { haptic } from '../../lib/haptic.js'
import { celebrateAction } from '../../lib/vibe.js'
import { AnnotationEditor } from '../AnnotationEditor.jsx'
import {
  REMIX_CHIPS,
  buildRemixPayload,
  classifySwipe,
  createRemixPending,
  createUndoEntry,
  isInEdgeDeadZone,
  isUndoActive,
  resolveHoldOutcome,
} from '../../lib/autopilotDeck.js'

/**
 * 0 秒表示用の軽量テンプレートプレビュー（モック画像が無い・読込前の即時プレースホルダ）。
 */
function TemplatePreview({ kind, title, t }) {
  return (
    <div className={`ap-template-preview ap-tpl-${kind || 'layout-card'}`} aria-hidden="true">
      <div className="ap-tpl-bar">
        <span className="ap-tpl-dot" />
        <span className="ap-tpl-title">{title || t('autopilot.mockLabel')}</span>
      </div>
      <div className="ap-tpl-body">
        <div className="ap-tpl-hero" />
        <div className="ap-tpl-lines">
          <span />
          <span />
        </div>
        <div className="ap-tpl-cta" />
      </div>
    </div>
  )
}

/**
 * Autopilot 4 方向スワイプデッキ（AP-3）。
 */
export function AutopilotDeck({
  cards = [],
  onCommitAction,
  onRemixCard,
  onSaveMemo,
  onUndoAction,
  onSwitchCockpit,
  notify,
}) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [drag, setDrag] = useState({ active: false, dx: 0, dy: 0 })
  const [undo, setUndo] = useState(null)
  const [remixPending, setRemixPending] = useState(null)
  const [remixNoteMode, setRemixNoteMode] = useState(false)
  const [remixNoteText, setRemixNoteText] = useState('')
  const [annotatingCard, setAnnotatingCard] = useState(null)
  const gestureRef = useRef({ active: false, startX: 0, startY: 0, pointerId: null })

  const card = cards[index] || null
  const swipe = classifySwipe(drag.dx, drag.dy)

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

  const commit = (direction) => {
    if (!card) return
    if (direction === 'up') {
      haptic('action')
      setAnnotatingCard(card)
      return
    }
    if (direction === 'left') {
      haptic('action')
      setRemixPending(createRemixPending(card))
      setRemixNoteMode(false)
      setRemixNoteText('')
      setIndex((i) => i + 1)
      onCommitAction?.(card, 'remix')
      return
    }
    if (direction === 'down') {
      haptic('action')
      const outcome = resolveHoldOutcome(card)
      if (outcome.kind === 'memo') onSaveMemo?.(outcome.memoText, card)
      setUndo(createUndoEntry(card, 'hold'))
      setIndex((i) => i + 1)
      onCommitAction?.(card, 'hold', outcome)
      return
    }
    haptic('success')
    celebrateAction('approve', { sfx: true })
    setUndo(createUndoEntry(card, 'go'))
    setIndex((i) => i + 1)
    onCommitAction?.(card, 'go')
  }

  const handlePointerDown = (e) => {
    if (!card || e.button > 0) return
    if (isInEdgeDeadZone(e.clientX, typeof window !== 'undefined' ? window.innerWidth : 0)) return
    gestureRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    }
    e.currentTarget?.setPointerCapture?.(e.pointerId)
    setDrag({ active: true, dx: 0, dy: 0 })
  }

  const handlePointerMove = (e) => {
    const g = gestureRef.current
    if (!g.active || g.pointerId !== e.pointerId) return
    setDrag({ active: true, dx: e.clientX - g.startX, dy: e.clientY - g.startY })
  }

  const handlePointerEnd = (e) => {
    const g = gestureRef.current
    if (!g.active || g.pointerId !== e.pointerId) return
    gestureRef.current.active = false
    const finalSwipe = classifySwipe(e.clientX - g.startX, e.clientY - g.startY)
    setDrag({ active: false, dx: 0, dy: 0 })
    if (finalSwipe.committed && finalSwipe.direction) {
      commit(finalSwipe.direction)
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
    onUndoAction?.(prev)
  }

  const shotUrl = card?.visualMock?.shot && card?.taskId
    ? `/api/review/${encodeURIComponent(card.taskId)}/thumb/${card.visualMock.shot}`
    : null
  const rotDeg = drag.active ? Math.max(-14, Math.min(14, drag.dx / 18)) : 0
  const cardStyle = drag.active
    ? { transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0) rotate(${rotDeg}deg)` }
    : undefined

  return (
    <section className="ap-deck-shell" aria-label={t('autopilot.deckAria')}>
      <div className="ap-deck-stage">
        {card ? (
          <article
            className={`ap-card${drag.active ? ' dragging' : ''}`}
            style={cardStyle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          >
            {swipe.stamp && (
              <div
                className={`ap-stamp ap-stamp-${swipe.direction}`}
                style={{ opacity: Math.min(1, 0.25 + swipe.progress * 0.75) }}
              >
                {swipe.stamp}
              </div>
            )}

            <header className="ap-card-head">
              <span className="ap-card-counter">
                {index + 1} / {cards.length}
              </span>
              {card.title && <span className="ap-card-topic">{card.title}</span>}
            </header>

            <div className="ap-card-media">
              {shotUrl ? (
                <img src={shotUrl} alt={card.text || card.title} className="ap-card-shot" />
              ) : (
                <TemplatePreview kind={card.templateKind} title={card.title} t={t} />
              )}
            </div>

            <div className="ap-card-copy">
              <h2 className="ap-card-q">{card.text}</h2>
              {card.options?.length > 0 && (
                <ul className="ap-card-opts">
                  {card.options.slice(0, 3).map((opt) => (
                    <li key={opt.id} className={`ap-card-opt${opt.recommended ? ' rec' : ''}`}>
                      <span className="ap-opt-id">{opt.id}</span>
                      <span className="ap-opt-label">{opt.label}</span>
                      {opt.recommended && <span className="ap-opt-rec">{t('review.recommended')}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        ) : (
          <div className="ap-empty-card">
            <div className="ap-empty-icon">✨</div>
            <h2 className="ap-empty-title">{t('autopilot.allClearTitle')}</h2>
            <p className="ap-empty-sub">{t('autopilot.allClearSub')}</p>
            {onSwitchCockpit && (
              <button type="button" className="ap-empty-cockpit-btn" onClick={onSwitchCockpit}>
                {t('autopilot.openCockpit')}
              </button>
            )}
          </div>
        )}
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
              <button type="submit" className="ap-remix-send">
                {t('autopilot.btn.go')}
              </button>
            </form>
          ) : (
            <div className="ap-remix-chips">
              {REMIX_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="ap-remix-chip"
                  onClick={() => {
                    if (chip.id === 'note') {
                      setRemixNoteMode(true)
                    } else {
                      sendRemix(remixPending.card, chip.id, '')
                    }
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
          disabled={!card}
          onClick={() => commit('left')}
        >
          <span>↩</span>
          <span>{t('autopilot.btn.remix')}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-hold"
          disabled={!card}
          onClick={() => commit('down')}
        >
          <span>⏸</span>
          <span>{t('autopilot.btn.hold')}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-annotate"
          disabled={!card}
          onClick={() => commit('up')}
        >
          <span>🖍</span>
          <span>{t('autopilot.btn.annotate')}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-go"
          disabled={!card}
          onClick={() => commit('right')}
        >
          <span>✓</span>
          <span>{t('autopilot.btn.go')}</span>
        </button>
      </footer>
      {annotatingCard && (
        <AnnotationEditor
          item={{ id: annotatingCard.taskId, title: annotatingCard.text || annotatingCard.title }}
          imageSrc={
            annotatingCard.visualMock?.shot && annotatingCard.taskId
              ? `/api/review/${encodeURIComponent(annotatingCard.taskId)}/thumb/${annotatingCard.visualMock.shot}`
              : null
          }
          onClose={() => setAnnotatingCard(null)}
          onCollectAnnotation={(ann) => {
            const target = annotatingCard
            setAnnotatingCard(null)
            celebrateAction('approve', { sfx: true })
            setUndo(createUndoEntry(target, 'annotate'))
            setIndex((i) => i + 1)
            onCommitAction?.(target, 'annotate', { annotation: ann })
          }}
          notify={notify}
        />
      )}
    </section>
  )
}
