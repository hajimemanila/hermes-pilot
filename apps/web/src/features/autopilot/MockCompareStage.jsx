import React, { useEffect, useRef, useState } from 'react'
import { currentOptionCard, nextOptionIndex, resolveStoryTapZone } from '../../lib/autopilotDeck.js'
import { haptic } from '../../lib/haptic.js'
import { OptionMockPreview } from './AutopilotCards.jsx'

const PEEK_HOLD_MS = 240
const TAP_SLOP_PX = 10

/**
 * Autopilot カード内のモック比較ステージ（AP2-4）。
 * - ストーリープログレスバー + 左右45%タップ 0.1 秒フリック比較
 * - 長押し一時比較（Peek）
 * - `▶ 触ってみる` サンドボックス iframe トグル（`sandbox="allow-scripts allow-forms"` のみ）
 */
export function MockCompareStage({
  question,
  cardView,
  optIndex = 0,
  shotUrl = null,
  mockUrl = null,
  annotationCount = 0,
  onSelectOption,
  onToggleSandbox,
  liveSandbox = false,
  t,
}) {
  const [peekingIndex, setPeekingIndex] = useState(null)
  const tapRef = useRef({ pointerId: null, startX: 0, startY: 0, moved: false, timer: null })

  const clearPeekTimer = () => {
    if (tapRef.current.timer) {
      clearTimeout(tapRef.current.timer)
      tapRef.current.timer = null
    }
  }

  useEffect(() => () => clearPeekTimer(), [])
  useEffect(() => {
    clearPeekTimer()
    setPeekingIndex(null)
  }, [question?.key, optIndex, liveSandbox])

  if (!cardView) return null

  const activeIdx = peekingIndex !== null ? peekingIndex : optIndex
  const displayView = peekingIndex !== null ? currentOptionCard(question, peekingIndex) || cardView : cardView
  const displayShotUrl =
    peekingIndex !== null
      ? displayView.shot && question?.taskId
        ? `/api/review/${encodeURIComponent(question.taskId)}/thumb/${displayView.shot}`
        : null
      : shotUrl

  const canFlick = cardView.optionCount > 1 && !liveSandbox

  const handleStagePointerDown = (e) => {
    if (!canFlick || e.button > 0) return
    if (e.target?.closest?.('.ap-stage-ctl, button, iframe')) return
    clearPeekTimer()
    const startX = e.clientX
    const startY = e.clientY
    tapRef.current = { pointerId: e.pointerId, startX, startY, moved: false, timer: null }
    tapRef.current.timer = setTimeout(() => {
      if (tapRef.current.moved || tapRef.current.pointerId !== e.pointerId) return
      haptic('tap')
      setPeekingIndex(nextOptionIndex(optIndex, cardView.optionCount, 1))
    }, PEEK_HOLD_MS)
  }

  const handleStagePointerMove = (e) => {
    const s = tapRef.current
    if (s.pointerId !== e.pointerId) return
    if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) >= TAP_SLOP_PX) {
      s.moved = true
      clearPeekTimer()
      if (peekingIndex !== null) setPeekingIndex(null)
    }
  }

  const handleStagePointerEnd = (e) => {
    const s = tapRef.current
    if (s.pointerId !== e.pointerId) return
    clearPeekTimer()
    s.pointerId = null
    if (peekingIndex !== null) {
      setPeekingIndex(null)
      return
    }
    if (s.moved || !canFlick) return
    const zone = resolveStoryTapZone(e.clientX, e.currentTarget?.getBoundingClientRect?.())
    if (zone === 'prev') {
      haptic('tap')
      onSelectOption?.(nextOptionIndex(optIndex, cardView.optionCount, -1))
    } else if (zone === 'next') {
      haptic('tap')
      onSelectOption?.(nextOptionIndex(optIndex, cardView.optionCount, 1))
    }
  }

  return (
    <div
      className="ap-media-stage"
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={handleStagePointerEnd}
      onPointerCancel={handleStagePointerEnd}
    >
      {cardView.optionCount > 1 && (
        <div className="ap-story-bars" role="group" aria-label={t('autopilot.variantAria')}>
          {question.options.map((opt, idx) => (
            <button
              key={opt.id}
              type="button"
              className={`ap-story-seg ap-stage-ctl${idx === activeIdx ? ' active' : ''}`}
              aria-label={`${opt.id}: ${opt.label || ''}`}
              onClick={(e) => {
                e.stopPropagation()
                haptic('tap')
                onSelectOption?.(idx)
              }}
            />
          ))}
        </div>
      )}

      {liveSandbox && mockUrl ? (
        <div className="ap-sandbox-wrap ap-sandbox-active" onPointerDown={(e) => e.stopPropagation()}>
          <iframe
            className="ap-sandbox-frame"
            src={mockUrl}
            sandbox="allow-scripts allow-forms"
            title={t('autopilot.sandbox.iframeTitle')}
          />
        </div>
      ) : (
        <OptionMockPreview
          option={displayView.option}
          question={question}
          shotUrl={displayShotUrl}
          layoutVariant={displayView.layoutVariant}
          theme={displayView.theme}
          t={t}
        />
      )}

      {peekingIndex !== null && (
        <div className="ap-peek-badge" role="status">
          👁 {t('autopilot.flick.peek', { id: displayView.option.id })}
        </div>
      )}

      {annotationCount > 0 && !liveSandbox && (
        <span className="ap-ann-badge" aria-label={`${t('autopilot.btn.annotate')} ${annotationCount}`}>
          🖍 {annotationCount}
        </span>
      )}

      {mockUrl && (
        <button
          type="button"
          className={`ap-sandbox-toggle ap-stage-ctl${liveSandbox ? ' active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            haptic('action')
            onToggleSandbox?.()
          }}
        >
          {liveSandbox ? `🖼 ${t('autopilot.sandbox.backToShot')}` : `▶ ${t('autopilot.sandbox.tryLive')}`}
        </button>
      )}
    </div>
  )
}
