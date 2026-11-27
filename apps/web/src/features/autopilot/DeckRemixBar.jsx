import React from 'react'
import { REMIX_CHIPS } from '../../lib/autopilotDeck.js'
import { StyleGachaBar } from './StyleGachaBar.jsx'

/**
 * Remix バー（提示専用の葉）。状態・副作用は持たず、親の pending / note と
 * コールバックだけで描画する。DOM は旧 AutopilotDeck.jsx と同一。
 */
export function DeckRemixBar({
  pending = null,
  noteMode = false,
  noteText = '',
  onNoteText,
  onBackToFirst,
  onChip,
  onSubmitNote,
  onRollStyle,
  gachaCount = 0,
  t,
}) {
  if (!pending) return null
  return (
    <div className="ap-remix-bar" role="region" aria-label={t('autopilot.btn.remix')}>
      {noteMode ? (
        <form
          className="ap-remix-note-row"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmitNote(noteText)
          }}
        >
          <input
            type="text"
            className="ap-remix-input"
            value={noteText}
            onChange={(e) => onNoteText(e.target.value)}
            placeholder={t('autopilot.remix.note')}
          />
          <button type="submit" className="ap-remix-send">{t('autopilot.btn.go')}</button>
        </form>
      ) : (
        <>
          <div className="ap-remix-chips">
            <button type="button" className="ap-remix-chip" onClick={onBackToFirst}>
              ↺ {t('autopilot.remix.backToFirst')}
            </button>
            {REMIX_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className="ap-remix-chip"
                onClick={() => onChip(chip.id)}
              >
                <span>{chip.icon}</span>
                <span>{t(chip.labelKey)}</span>
              </button>
            ))}
          </div>
          <StyleGachaBar usedCount={gachaCount} onRollStyle={onRollStyle} t={t} />
        </>
      )}
    </div>
  )
}
