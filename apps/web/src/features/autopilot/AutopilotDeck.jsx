import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api.js'
import { useI18n } from '../../i18n/index.js'
import {
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
import { DeckActionBar } from './DeckActionBar.jsx'
import { DeckCardStage } from './DeckCardStage.jsx'
import { DeckRemixBar } from './DeckRemixBar.jsx'

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
  const [liveSandbox, setLiveSandbox] = useState(false)
  const [annotationsByVariant, setAnnotationsByVariant] = useState({})
  const [gachaCountByCard, setGachaCountByCard] = useState({})
  const gestureRef = useRef({ active: false, startX: 0, startY: 0, pointerId: null })
  const flyTimerRef = useRef(null)

  const question = cards[index] || null
  const cardView = currentOptionCard(question, optIndex)
  const nextQuestion = !cardView?.isLastOption ? question : cards[index + 1] || null
  const nextOptionView = nextQuestion
    ? currentOptionCard(nextQuestion, !cardView?.isLastOption ? optIndex + 1 : 0)
    : null
  const thirdQuestion = cards[index + (!cardView?.isLastOption ? 1 : 2)] || null
  const swipe = classifySwipe(drag.dx, drag.dy, undefined, { horizontalOnly: true })

  useEffect(() => {
    setOptIndex(0)
  }, [question?.key])

  useEffect(() => {
    setLiveSandbox(false)
  }, [question?.key, optIndex])

  useEffect(() => () => {
    if (flyTimerRef.current) clearTimeout(flyTimerRef.current)
  }, [])

  useEffect(() => {
    if (!undo) return undefined
    const ms = Math.max(0, undo.expiresAt - Date.now())
    const id = setTimeout(() => setUndo(null), ms)
    return () => clearTimeout(id)
  }, [undo])

  const sendRemix = async (targetCard, reason, hint = '', stylePreset = null) => {
    setRemixPending(null)
    setRemixNoteMode(false)
    setRemixNoteText('')
    const payload = buildRemixPayload(targetCard, reason, hint, stylePreset)
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
    if (!remixPending || remixNoteMode || !remixPending.autoFire) return undefined
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
    const activeVariantKey = `${question.key}:${res.choice}`
    const savedAnnotation = annotationsByVariant[activeVariantKey] || null
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
      onCommitAction?.(question, savedAnnotation ? 'annotate' : 'go', {
        choice: res.choice,
        shot: cardView.shot,
        ...(savedAnnotation ? { annotation: savedAnnotation } : {}),
      })
    }, FLY_MS)
  }

  const handlePointerDown = (e) => {
    if (!cardView || flying || e.button > 0) return
    if (e.target?.closest?.('button, a, input, textarea, iframe, .ap-sandbox-active, .ap-stage-ctl, .ap-card-copy')) return
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
    const gx = Math.max(10, Math.min(90, Math.round(50 + dx / 5)))
    setDrag({ active: true, dx, dy: 0, gx, gy: 35 })
  }

  const handlePointerEnd = (e) => {
    const g = gestureRef.current
    if (!g.active || g.pointerId !== e.pointerId) return
    gestureRef.current.active = false
    const finalSwipe = classifySwipe(e.clientX - g.startX, e.clientY - g.startY, undefined, { horizontalOnly: true })
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
  const undoActive = isUndoActive(undo)
  // 葉（DeckActionBar）へ渡す訳文。i18n キーは親に残す（SPEC §3.2）。
  const actionLabels = {
    aria: t('autopilot.actionsAria'),
    remix: t('autopilot.btn.remix'),
    nextOpt: t('autopilot.btn.nextOpt'),
    hold: t('autopilot.btn.hold'),
    annotate: t('autopilot.btn.annotate'),
    go: t('autopilot.btn.go'),
  }

  return (
    <section className="ap-deck-shell" aria-label={t('autopilot.deckAria')}>
      <DeckCardStage
        thirdQuestion={thirdQuestion}
        nextOptionView={nextOptionView}
        cardView={cardView}
        question={question}
        index={index}
        cards={cards}
        optIndex={optIndex}
        drag={drag}
        swipe={swipe}
        stackLift={stackLift}
        frontStyle={frontStyle}
        glowCls={glowCls}
        flyCls={flyCls}
        shotUrl={shotUrl}
        annotationsByVariant={annotationsByVariant}
        liveSandbox={liveSandbox}
        remixPending={remixPending}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerEnd={handlePointerEnd}
        onSelectOption={setOptIndex}
        onPickVariant={(idx) => {
          haptic('tap')
          setOptIndex(idx)
        }}
        onToggleSandbox={() => setLiveSandbox((v) => !v)}
        onToggleGacha={() => {
          haptic('tap')
          setRemixNoteMode(false)
          setRemixPending((cur) =>
            cur && cur.cardKey === question.key ? null : createRemixPending(question, Date.now(), 60_000, false),
          )
        }}
        t={t}
      />

      <DeckRemixBar
        pending={remixPending}
        noteMode={remixNoteMode}
        noteText={remixNoteText}
        onNoteText={setRemixNoteText}
        onBackToFirst={() => {
          haptic('tap')
          setRemixPending(null)
          setOptIndex(0)
        }}
        onChip={(chipId) => {
          if (chipId === 'note') setRemixNoteMode(true)
          else sendRemix(remixPending.card, chipId, '')
        }}
        onSubmitNote={(text) => sendRemix(remixPending.card, 'note', text)}
        onRollStyle={(presetId) => {
          const key = remixPending.card.key
          setGachaCountByCard((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }))
          sendRemix(remixPending.card, 'style_gacha', presetId, presetId)
        }}
        gachaCount={gachaCountByCard[remixPending?.card?.key] || 0}
        t={t}
      />

      <DeckActionBar
        undo={undoActive ? undo : null}
        undoLabel={undoActive ? t('autopilot.undoPrompt', { action: undo.action.toUpperCase() }) : ''}
        undoActionLabel={t('autopilot.undo')}
        isLastOption={cardView.isLastOption}
        labels={actionLabels}
        onOutcome={applyOutcome}
        onUndo={handleUndo}
      />

      {annotating && (
        <AnnotationEditor
          item={{ id: annotating.question.taskId, title: annotating.option?.label || annotating.question.text }}
          imageSrc={shotUrlFor(annotating.shot, annotating.question.taskId)}
          onClose={() => setAnnotating(null)}
          onCollectAnnotation={(ann) => {
            const target = annotating
            const variantKey = `${target.question.key}:${target.option?.id || 'A'}`
            setAnnotationsByVariant((prev) => ({ ...prev, [variantKey]: ann }))
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
