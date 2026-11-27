import React, { useEffect, useRef, useState } from 'react'
import { MockCompareStage } from './MockCompareStage.jsx'

/**
 * デッキのステージ（スタック 3 枚 ＋ 前面カード）だけを持つ提示専用の葉。
 * 下部テキスト領域（`.ap-card-copy`）は独立縦スクロール＋可視スクロールノブを持ち、
 * 横スワイプと干渉せず快適に全文を読める（AP3-4）。
 */
export function DeckCardStage({
  thirdQuestion,
  nextOptionView,
  cardView,
  question,
  index,
  cards,
  optIndex,
  drag,
  swipe,
  stackLift,
  frontStyle,
  glowCls,
  flyCls,
  shotUrl,
  annotationsByVariant,
  liveSandbox,
  remixPending,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onSelectOption,
  onPickVariant,
  onToggleSandbox,
  onToggleGacha,
  t,
}) {
  const copyRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [scrollState, setScrollState] = useState({ hasOverflow: false, thumbPct: 0, ratioPct: 40 })

  const syncScrollMetrics = () => {
    const el = copyRef.current
    if (!el) return
    const sh = el.scrollHeight
    const ch = el.clientHeight
    const maxScroll = Math.max(0, sh - ch)
    const hasOverflow = maxScroll > 2
    const ratioPct = sh > 0 ? Math.max(22, Math.min(85, Math.round((ch / sh) * 100))) : 100
    const thumbPct = maxScroll > 0 ? Math.round((el.scrollTop / maxScroll) * (100 - ratioPct)) : 0
    setScrollState({ hasOverflow, thumbPct, ratioPct })
  }

  useEffect(() => {
    setExpanded(false)
    if (copyRef.current) copyRef.current.scrollTop = 0
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(syncScrollMetrics) : 0
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    }
  }, [question?.key, optIndex])

  useEffect(() => {
    syncScrollMetrics()
  }, [expanded])

  return (
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
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
                  onPickVariant(idx)
                }}
              >
                {opt.id}
              </button>
            ))}
          </div>
          {cardView.option.recommended && (
            <span className="ap-rec-badge">★ {t('review.recommended')}</span>
          )}
          <button
            type="button"
            className={`ap-gacha-btn${remixPending ? ' active' : ''}`}
            aria-label={t('autopilot.gacha.title')}
            title={t('autopilot.gacha.title')}
            onClick={(e) => {
              e.stopPropagation()
              onToggleGacha()
            }}
          >
            🎲
          </button>
        </header>

        <div className="ap-card-media">
          <MockCompareStage
            question={question}
            cardView={cardView}
            optIndex={optIndex}
            shotUrl={shotUrl}
            mockUrl={cardView.mockUrl}
            annotationCount={(() => {
              const ann = annotationsByVariant[`${question.key}:${cardView.option.id}`]
              if (!ann) return 0
              return Array.isArray(ann.marks) && ann.marks.length > 0 ? ann.marks.length : 1
            })()}
            onSelectOption={onSelectOption}
            onToggleSandbox={onToggleSandbox}
            liveSandbox={liveSandbox}
            t={t}
          />
        </div>

        <div className="ap-card-copy-wrap">
          <div
            ref={copyRef}
            className={`ap-card-copy${expanded ? ' expanded' : ''}`}
            onScroll={syncScrollMetrics}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <p className="ap-card-q-sub">{question.text}</p>
            <h2 className="ap-card-opt-hero">
              <span className="ap-opt-id-chip">{cardView.option.id}</span>
              <span>{cardView.option.label}</span>
            </h2>
            {cardView.option.detail && <p className="ap-card-opt-detail">{cardView.option.detail}</p>}
          </div>

          {scrollState.hasOverflow && (
            <div
              className="ap-copy-scrollbar"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation()
                const el = copyRef.current
                if (!el) return
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = rect.height > 0 ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0
                el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight)
              }}
            >
              <span
                className="ap-copy-thumb"
                style={{ top: `${scrollState.thumbPct}%`, height: `${scrollState.ratioPct}%` }}
              />
            </div>
          )}

          {(scrollState.hasOverflow || expanded) && (
            <button
              type="button"
              className="ap-copy-more-btn"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
            >
              {expanded ? t('autopilot.copy.less') : t('autopilot.copy.more')}
            </button>
          )}
        </div>
      </article>
    </div>
  )
}
