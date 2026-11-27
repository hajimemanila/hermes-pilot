import React from 'react'
import { MAX_STYLE_GACHA, STYLE_GACHA_PRESETS } from '../../lib/autopilotDeck.js'
import { haptic } from '../../lib/haptic.js'

/**
 * スタイル・ガチャバー（AP2-4）。1タップで方向転換（カードあたり最大3回）。
 */
export function StyleGachaBar({ usedCount = 0, maxCount = MAX_STYLE_GACHA, onRollStyle, t }) {
  const remaining = Math.max(0, maxCount - usedCount)
  const exhausted = remaining <= 0
  return (
    <div className="ap-gacha-bar" role="region" aria-label={t('autopilot.gacha.title')}>
      <div className="ap-gacha-head">
        <span className="ap-gacha-title">🎲 {t('autopilot.gacha.title')}</span>
        <span className={`ap-gacha-count${exhausted ? ' exhausted' : ''}`}>
          {exhausted
            ? t('autopilot.gacha.limitReached')
            : t('autopilot.gacha.remaining', { left: remaining, max: maxCount })}
        </span>
      </div>
      <div className="ap-gacha-chips">
        {STYLE_GACHA_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="ap-gacha-chip"
            disabled={exhausted}
            onClick={(e) => {
              e.stopPropagation()
              if (exhausted) return
              haptic('action')
              onRollStyle?.(preset.id)
            }}
          >
            <span aria-hidden="true">{preset.icon}</span>
            <span>{t(preset.labelKey)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
