import React, { useEffect, useId, useState } from 'react'
import { useI18n } from '../../i18n/index.js'
import { RADAR_CENTER, RADAR_SIZE, RING_RADII, buildRadarSummary } from '../../lib/liveRadar.js'
import { haptic } from '../../lib/haptic.js'
import { subscribeSync, tickSync } from '../../lib/syncSources.js'
import '../../styles/autopilot-radar.css'

/**
 * Panoptes 着想の純粋 React + SVG コンパクト動的レーダー BI（AP3-3 / sync-owner 準拠）。
 * 独自のタイマーポーリングは持たず、subscribeSync('live' | 'usage' | 'reviewWaiting') のみ購読する。
 * 各ドットをタップすると下のインスペクタへツール名・担当タスク・経過時間を表示する。
 */
export function LiveRadarCard({ initialLive = null, tasks = [], activeJob = null }) {
  const { t } = useI18n()
  const [live, setLive] = useState(initialLive)
  const [usage, setUsage] = useState(null)
  const [reviewItems, setReviewItems] = useState([])
  const [selectedId, setSelectedId] = useState(null)
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
    tasks,
    activeJob,
  })
  const gradId = `radar-sweep-${sweepId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const selectedBlip = summary.blips.find((b) => b.id === selectedId) || summary.blips[0] || null
  const compactFeed = summary.feed.slice(0, 2)

  return (
    <div className="ap-radar-card" aria-label={t('autopilot.radar.aria')}>
      <div className="ap-radar-stage">
        <svg
          className="ap-radar-svg"
          width="160"
          height="160"
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

          <text x={RADAR_CENTER} y={RADAR_CENTER - RING_RADII.explore - 4} textAnchor="middle" className="ap-radar-ring-label">
            {t('autopilot.radar.ringExplore')}
          </text>
          <text x={RADAR_CENTER} y={RADAR_CENTER - RING_RADII.verify - 4} textAnchor="middle" className="ap-radar-ring-label">
            {t('autopilot.radar.ringVerify')}
          </text>
          <text x={RADAR_CENTER} y={RADAR_CENTER - RING_RADII.core - 4} textAnchor="middle" className="ap-radar-ring-label">
            {t('autopilot.radar.ringCore')}
          </text>

          <g className="ap-radar-sweep">
            <path
              d={`M ${RADAR_CENTER} ${RADAR_CENTER} L ${RADAR_CENTER} ${RADAR_CENTER - RING_RADII.explore} A ${RING_RADII.explore} ${RING_RADII.explore} 0 0 1 ${RADAR_CENTER + RING_RADII.explore} ${RADAR_CENTER} Z`}
              fill={`url(#${gradId})`}
            />
          </g>

          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r="4.5" className="ap-radar-core-dot" />

          {summary.blips.map((b) => {
            const isSelected = selectedBlip?.id === b.id
            return (
              <g
                key={b.id}
                role="button"
                tabIndex={0}
                className="ap-radar-blip-node"
                aria-label={`${t(b.ringLabelKey)}: ${b.name}`}
                onClick={() => {
                  haptic('tap')
                  setSelectedId(b.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    haptic('tap')
                    setSelectedId(b.id)
                  }
                }}
              >
                <circle cx={b.cx} cy={b.cy} r="18" fill="transparent" className="ap-radar-blip-hit" />
                {b.isLatest && <circle cx={b.cx} cy={b.cy} r="8" className="ap-radar-ping" />}
                {isSelected && <circle cx={b.cx} cy={b.cy} r="9" className="ap-radar-selected-ring" />}
                <circle
                  cx={b.cx}
                  cy={b.cy}
                  r={isSelected ? 6 : b.isLatest ? 5 : 4}
                  opacity={isSelected ? 1 : b.freshness}
                  className={`ap-radar-blip ap-radar-blip-${b.ring}`}
                >
                  <title>{`${b.name} (${b.ageSec}s)`}</title>
                </circle>
              </g>
            )
          })}
        </svg>
      </div>

      {selectedBlip && (
        <div className="ap-radar-inspector" role="status">
          <div className="ap-radar-insp-top">
            <span className={`ap-radar-dot ${selectedBlip.ring}`} aria-hidden="true" />
            <span className="ap-radar-insp-ring">{t(selectedBlip.ringLabelKey)}</span>
            <span className="ap-radar-insp-tool">{selectedBlip.name}</span>
            <span className="ap-radar-age">{t('autopilot.radar.ago', { s: selectedBlip.ageSec })}</span>
          </div>
          {(selectedBlip.taskTitle || summary.blips.length > 1) && (
            <div className="ap-radar-insp-sub">
              <span className="ap-radar-insp-task">{selectedBlip.taskTitle || t('autopilot.live.building')}</span>
              {summary.blips.length > 1 && <span className="ap-radar-insp-hint">{t('autopilot.radar.tapHint')}</span>}
            </div>
          )}
        </div>
      )}

      <div className="ap-radar-metrics">
        <span className="ap-radar-stat">
          {summary.activeWorkers > 1
            ? `⚡ ${t('autopilot.radar.parallelBadge', { n: summary.activeWorkers })}`
            : `⚡ ${t('autopilot.radar.workers')}: ${summary.activeWorkers}`}
        </span>
        <span className="ap-radar-stat">
          🛠 {t('autopilot.radar.tools')}: {summary.toolCount}
        </span>
        <span className="ap-radar-stat">
          🪙 {summary.tokenMode === 'run' ? t('autopilot.radar.runTokens') : t('autopilot.radar.tokens')}:{' '}
          {summary.tokenLabel}
        </span>
        {summary.waitingCount > 0 && (
          <span className="ap-radar-stat waiting">
            🔔 {t('autopilot.radar.waiting', { n: summary.waitingCount })}
          </span>
        )}
      </div>

      {compactFeed.length > 0 ? (
        <ol className="ap-radar-feed">
          {compactFeed.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`ap-radar-feed-row${selectedBlip?.id === entry.id ? ' selected' : ''}`}
                onClick={() => {
                  haptic('tap')
                  setSelectedId(entry.id)
                }}
              >
                <span className="ap-radar-feed-main">
                  <span className={`ap-radar-dot ${entry.ring}`} aria-hidden="true" />
                  <span className="ap-radar-tool">{entry.name}</span>
                </span>
                <span className="ap-radar-age">{t('autopilot.radar.ago', { s: entry.ageSec })}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ap-radar-empty">{t('autopilot.radar.scanning')}</p>
      )}
    </div>
  )
}
