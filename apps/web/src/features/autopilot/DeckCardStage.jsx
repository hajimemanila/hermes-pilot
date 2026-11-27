import React from 'react'
import { MockCompareStage } from './MockCompareStage.jsx'

/**
 * デッキのステージ（スタック 3 枚 ＋ 前面カード）だけを持つ提示専用の葉。
 * 状態・副作用は親（AutopilotDeck.jsx）に残し、ここは受け取った view 値を
 * そのまま描く。DOM は旧 AutopilotDeck.jsx と同一。
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
  )
}
