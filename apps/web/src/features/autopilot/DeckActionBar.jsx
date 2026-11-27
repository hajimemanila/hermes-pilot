import React from 'react'

/**
 * undo ピル ＋ アクションバー（提示専用の葉）。状態・副作用は持たず、
 * 親が確定した undo / 文言とコールバックだけを受け取る。
 * i18n キーは親に残す（`labels` に訳文を入れて渡す）。DOM は旧 AutopilotDeck.jsx と同一。
 */
export function DeckActionBar({
  undo = null,
  undoLabel = '',
  undoActionLabel = '',
  isLastOption = false,
  labels,
  onOutcome,
  onUndo,
}) {
  return (
    <>
      {undo && (
        <div className="ap-undo-pill" role="status">
          <span className="ap-undo-label">{undoLabel}</span>
          <button type="button" className="ap-undo-btn" onClick={onUndo}>
            {undoActionLabel}
          </button>
        </div>
      )}

      <footer className="ap-action-bar" aria-label={labels.aria}>
        <button
          type="button"
          className="ap-act-btn ap-act-remix"
          onClick={(e) => onOutcome('left', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">✕</span>
          <span className="ap-act-lbl">
            {isLastOption ? labels.remix : labels.nextOpt}
          </span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-hold"
          onClick={(e) => onOutcome('down', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">⏸</span>
          <span className="ap-act-lbl">{labels.hold}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-annotate"
          onClick={(e) => onOutcome('up', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">🖍</span>
          <span className="ap-act-lbl">{labels.annotate}</span>
        </button>
        <button
          type="button"
          className="ap-act-btn ap-act-go"
          onClick={(e) => onOutcome('right', e.currentTarget.getBoundingClientRect())}
        >
          <span className="ap-act-ico">♥</span>
          <span className="ap-act-lbl">{labels.go}</span>
        </button>
      </footer>
    </>
  )
}
