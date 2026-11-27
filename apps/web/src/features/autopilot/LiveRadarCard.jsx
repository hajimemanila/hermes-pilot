import React, { useEffect, useId, useState } from 'react'
import { useI18n } from '../../i18n/index.js'
import { RADAR_CENTER, RADAR_SIZE, RING_RADII, buildRadarSummary } from '../../lib/liveRadar.js'
import { subscribeSync, tickSync } from '../../lib/syncSources.js'
import '../../styles/autopilot-radar.css'

/**
 * Panoptes 着想の純粋 React + SVG 動的レーダー BI（AP2-5 / sync-owner 準拠）。
 * 独自のタイマーポーリングは持たず、subscribeSync('live' | 'usage' | 'reviewWaiting') のみ購読する。
 */
export function LiveRadarCard({ initialLive = null }) {
  const { t } = useI18n()
  const [live, setLive] = useState(initialLive)
  const [usage, setUsage] = useState(null)
  const [reviewItems, setReviewItems] = useState([])
  const sweepId = useId()

  useEffect(() => {
    const offs = [
      subscribeSync('live', (v) => setLive(v || null)),
      subscribeSync('usage', (v) => setUsage(v || null)),
      subscribeSync('reviewWaiting', (v) => setReviewItems(Array.isArray(v?.items) ? v.items : [])),
    ]
    tickSync('usage')
    return () => offs.forEach((off) => off?.())
  }, [])

  const summary = buildRadarSummary({
    live: live ?? initialLive,
    usage,
    reviewItems,
  })
  const gradId = `radar-sweep-${sweepId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  return (
    <div className="ap-radar-card" aria-label={t('autopilot.radar.aria')}>
      <div className="ap-radar-stage">
        <svg
          className="ap-radar-svg"
          viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
          role="img"
          aria-label={t('autopilot.radar.aria')}
        >
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r={RING_RADII.explore} className="ap-radar-ring" />
          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r={RING_RADII.verify} className="ap-radar-ring" />
          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r={RING_RADII.core} className="ap-radar-ring" />

          <line
            x1={RADAR_CENTER}
            y1={RADAR_CENTER - RING_RADII.explore}
            x2={RADAR_CENTER}
            y2={RADAR_CENTER + RING_RADII.explore}
            className="ap-radar-axis"
          />
          <line
            x1={RADAR_CENTER - RING_RADII.explore}
            y1={RADAR_CENTER}
            x2={RADAR_CENTER + RING_RADII.explore}
            y2={RADAR_CENTER}
            className="ap-radar-axis"
          />

          <g className="ap-radar-sweep">
            <path
              d={`M ${RADAR_CENTER} ${RADAR_CENTER} L ${RADAR_CENTER} ${RADAR_CENTER - RING_RADII.explore} A ${RING_RADII.explore} ${RING_RADII.explore} 0 0 1 ${RADAR_CENTER + RING_RADII.explore} ${RADAR_CENTER} Z`}
              fill={`url(#${gradId})`}
            />
          </g>

          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r="4.5" className="ap-radar-core-dot" />

          {summary.blips.map((b) => (
            <g key={b.id}>
              {b.isLatest && <circle cx={b.cx} cy={b.cy} r="7" className="ap-radar-ping" />}
              <circle
                cx={b.cx}
                cy={b.cy}
                r={b.isLatest ? 5 : 4}
                opacity={b.freshness}
                className={`ap-radar-blip ap-radar-blip-${b.ring}`}
              >
                <title>{`${b.name} (${b.ageSec}s)`}</title>
              </circle>
            </g>
          ))}
        </svg>
      </div>

      <div className="ap-radar-metrics">
        <span className="ap-radar-stat">
          ⚡ {t('autopilot.radar.workers')}: {summary.activeWorkers}
        </span>
        <span className="ap-radar-stat">
          🛠 {t('autopilot.radar.tools')}: {summary.toolCount}
        </span>
        <span className="ap-radar-stat">
          🪙 {t('autopilot.radar.tokens')}: {summary.tokenLabel}
        </span>
        {summary.waitingCount > 0 && (
          <span className="ap-radar-stat waiting">
            🔔 {t('autopilot.radar.waiting', { n: summary.waitingCount })}
          </span>
        )}
      </div>

      {summary.feed.length > 0 ? (
        <ol className="ap-radar-feed">
          {summary.feed.map((entry) => (
            <li key={entry.id} className="ap-radar-feed-row">
              <span className="ap-radar-feed-main">
                <span className={`ap-radar-dot ${entry.ring}`} aria-hidden="true" />
                <span className="ap-radar-tool">{entry.name}</span>
              </span>
              <span className="ap-radar-age">{t('autopilot.radar.ago', { s: entry.ageSec })}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ap-radar-empty">{t('autopilot.radar.scanning')}</p>
      )}
    </div>
  )
}
