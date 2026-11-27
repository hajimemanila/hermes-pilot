import React, { useState } from 'react'
import { haptic } from '../../lib/haptic.js'
import '../../styles/autopilot-radar.css'

/**
 * 完了カード用のビフォー・アフター タイムラプス比較（AP2-5・ゼロ外部依存・CSSクロスフェード）。
 */
export function BeforeAfterTimelapse({ beforeUrl = null, afterUrl = null, title = '', t }) {
  const [split, setSplit] = useState(50)
  const [playing, setPlaying] = useState(false)

  if (!afterUrl) return null

  if (!beforeUrl || beforeUrl === afterUrl) {
    return (
      <div className="ap-complete-shot">
        <img src={afterUrl} alt={title} className="ap-card-shot" />
      </div>
    )
  }

  return (
    <div className="ap-timelapse" aria-label={t('autopilot.timelapse.aria')}>
      <div className="ap-timelapse-controls">
        <div className="ap-timelapse-tabs">
          <button
            type="button"
            className={`ap-timelapse-btn${!playing && split >= 85 ? ' active' : ''}`}
            onClick={() => {
              haptic('tap')
              setPlaying(false)
              setSplit(100)
            }}
          >
            {t('autopilot.timelapse.before')}
          </button>
          <button
            type="button"
            className={`ap-timelapse-btn${!playing && split <= 15 ? ' active' : ''}`}
            onClick={() => {
              haptic('tap')
              setPlaying(false)
              setSplit(0)
            }}
          >
            {t('autopilot.timelapse.after')}
          </button>
        </div>
        <button
          type="button"
          className={`ap-timelapse-btn${playing ? ' active' : ''}`}
          onClick={() => {
            haptic('action')
            setPlaying((v) => !v)
          }}
        >
          {playing ? `⏸ ${t('autopilot.timelapse.pause')}` : `▶ ${t('autopilot.timelapse.play')}`}
        </button>
      </div>

      <div className="ap-timelapse-stage">
        <img src={afterUrl} alt={`${title} (${t('autopilot.timelapse.after')})`} className="ap-timelapse-img" />
        {playing ? (
          <div className="ap-timelapse-layer-after-fade playing">
            <img src={beforeUrl} alt={`${title} (${t('autopilot.timelapse.before')})`} className="ap-timelapse-img" />
          </div>
        ) : (
          <div className="ap-timelapse-layer-before" style={{ width: `${split}%` }}>
            <img src={beforeUrl} alt={`${title} (${t('autopilot.timelapse.before')})`} className="ap-timelapse-img" />
          </div>
        )}
        <span className="ap-timelapse-tag left">{t('autopilot.timelapse.before')}</span>
        <span className="ap-timelapse-tag right">{t('autopilot.timelapse.after')}</span>
      </div>

      <input
        type="range"
        min="0"
        max="100"
        value={split}
        onChange={(e) => {
          setPlaying(false)
          setSplit(Number(e.target.value))
        }}
        aria-label={t('autopilot.timelapse.aria')}
        className="ap-timelapse-slider"
      />
    </div>
  )
}
