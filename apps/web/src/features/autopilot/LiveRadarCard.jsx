import React, { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../../i18n/index.js'
import { RADAR_CENTER, RADAR_SIZE, buildRadarSummary } from '../../lib/liveRadar.js'
import { haptic } from '../../lib/haptic.js'
import { subscribeSync, tickSync } from '../../lib/syncSources.js'
import '../../styles/autopilot-radar.css'

const EYE_RING_R = 26
const EYE_RING_C = Math.round(2 * Math.PI * EYE_RING_R * 10) / 10
const SHORT_STATION_CODE = {
  BROWSER: 'MOCK',
  AGENTS: 'AGENT',
  MEMORY: 'MEM',
}

/**
 * Panoptes 着想の純粋 React + SVG 軌道レーダー BI（SPEC-PANOPTES-RADAR + SPEC-AUTOPILOT-XRAY）。
 * 独自のタイマー・fetch は持たず、`subscribeSync('live' | 'usage' | 'reviewWaiting')` と親クロックで駆動する。
 */
export function LiveRadarCard({
  initialLive = null,
  tasks = [],
  activeJob = null,
  runStartedAt = null,
  runId = '',
  persistedMaxTokens = 0,
  onObservedTokens = null,
  clockNow = null,
  previewShotUrl = null,
  onFocusReview = null,
  nudges = [],
}) {
  const { t } = useI18n()
  const [live, setLive] = useState(initialLive)
  const [usage, setUsage] = useState(null)
  const [reviewItems, setReviewItems] = useState([])
  const [coreMode, setCoreMode] = useState('context')
  const [selectedStationId, setSelectedStationId] = useState(null)
  const [peekMode, setPeekMode] = useState('none')
  const sweepId = useId()
  const highWaterRef = useRef({ key: '', maxTokens: 0, reported: 0 })

  useEffect(() => {
    const offs = [
      subscribeSync('live', (v) => setLive(v || null)),
      subscribeSync('usage', (v) => setUsage(v || null)),
      subscribeSync('reviewWaiting', (v) => setReviewItems(Array.isArray(v?.items) ? v.items : [])),
    ]
    tickSync('usage')
    return () => offs.forEach((off) => off?.())
  }, [])

  const runTracked = Boolean(runStartedAt) || Number(persistedMaxTokens) > 0
  const hwKey = String(runId || activeJob?.id || (runStartedAt ? String(runStartedAt) : 'default'))
  if (highWaterRef.current.key !== hwKey) {
    const initialFloor = Math.max(0, Number(persistedMaxTokens) || 0)
    highWaterRef.current = { key: hwKey, maxTokens: initialFloor, reported: initialFloor }
  } else if (Number(persistedMaxTokens) > highWaterRef.current.maxTokens) {
    highWaterRef.current.maxTokens = Number(persistedMaxTokens)
  }

  const summary = buildRadarSummary({
    live: live ?? initialLive,
    usage,
    reviewItems,
    tasks,
    activeJob,
    now: Number(clockNow) || Date.now(),
    runTracked,
    minRunTokens: highWaterRef.current.maxTokens,
    nudges,
  })
  if (runTracked && summary.runTokens > highWaterRef.current.maxTokens) {
    highWaterRef.current.maxTokens = summary.runTokens
  }

  useEffect(() => {
    if (!runTracked) return
    if (summary.runTokens > highWaterRef.current.reported) {
      highWaterRef.current.reported = summary.runTokens
      onObservedTokens?.(summary.runTokens)
    }
  }, [runTracked, summary.runTokens, onObservedTokens])

  const gradId = `radar-sweep-${sweepId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const stations = summary.stations || []
  const stationById = Object.fromEntries(stations.map((s) => [s.id, s]))
  const workers = summary.workers || []
  const selectedStation =
    stations.find((s) => s.id === selectedStationId) ||
    stations.find((s) => s.id === summary.eye?.activeStationId) ||
    stations[0] ||
    null
  const compactFeed = (summary.feed || []).slice(0, 3)

  const isContextCore = coreMode === 'context'
  const ringPct = isContextCore ? summary.eye?.contextPct ?? 0 : summary.eye?.cacheHitPct ?? 0
  const ringDashOffset =
    Math.round(EYE_RING_C * (1 - Math.max(0, Math.min(100, ringPct)) / 100) * 10) / 10
  const eyeTone = isContextCore ? summary.eye?.tone || 'ok' : 'ok'

  const peekForStation = (st, toggleIfSame = false) => {
    if (!st) return 'none'
    let next = 'none'
    if (st.hasError && st.latestError) next = 'error'
    else if (st.id === 'browser') next = 'browser'
    else if (st.id === 'files') next = 'files'
    else if (st.id === 'shell') next = 'shell'
    else if (st.id === 'you' && (summary.nudges?.length || st.hasNudgePin)) next = 'nudge'
    if (toggleIfSame && selectedStationId === st.id && peekMode === next) return 'none'
    return next
  }

  const handleStationActivate = (st) => {
    haptic('tap')
    setSelectedStationId(st.id)
    if (st.id === 'you' && summary.waitingCount > 0) {
      setPeekMode('none')
      onFocusReview?.()
      return
    }
    setPeekMode(peekForStation(st, true))
  }

  const toggleCoreMode = () => {
    haptic('tap')
    setCoreMode((m) => (m === 'context' ? 'cache' : 'context'))
  }

  const filesPreview = (() => {
    const lt = selectedStation?.latestTool
    if (lt?.filePath) {
      return [{ file: lt.filePath, added: lt.addedLines || 0, removed: lt.removedLines || 0 }]
    }
    return (summary.fileChanges?.items || []).slice(0, 2)
  })()

  return (
    <div className="ap-radar-card" aria-label={t('autopilot.radar.aria')}>
      <div className="ap-radar-stage">
        <svg
          className="ap-radar-svg"
          width="192"
          height="192"
          viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
          role="img"
          aria-label={t('autopilot.radar.aria')}
        >
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r="78" className="ap-radar-ring" />
          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r="48" className="ap-radar-ring-inner" />

          <g className="ap-radar-sweep">
            <path
              d={`M ${RADAR_CENTER} ${RADAR_CENTER} L ${RADAR_CENTER} ${RADAR_CENTER - 78} A 78 78 0 0 1 ${RADAR_CENTER + 78} ${RADAR_CENTER} Z`}
              fill={`url(#${gradId})`}
            />
          </g>

          {stations.map((st) => (
            <g key={`spoke-${st.id}`}>
              <line
                x1={RADAR_CENTER}
                y1={RADAR_CENTER}
                x2={st.cx}
                y2={st.cy}
                strokeWidth={st.strokeWidth}
                className={`ap-radar-spoke${st.active ? ' active' : ''}${st.workerColorKey ? ` worker-${st.workerColorKey}` : ''}${st.hasError ? ' error' : ''}`}
              />
              {workers.length < 2 && st.active && (
                <line
                  x1={RADAR_CENTER}
                  y1={RADAR_CENTER}
                  x2={st.cx}
                  y2={st.cy}
                  className="ap-radar-pulse-line worker-w1"
                />
              )}
            </g>
          ))}

          {workers.length >= 2 &&
            workers.map((w) => {
              const target = stationById[w.stationId]
              if (!target) return null
              return (
                <line
                  key={`wpulse-${w.id}`}
                  x1={RADAR_CENTER}
                  y1={RADAR_CENTER}
                  x2={target.cx}
                  y2={target.cy}
                  className={`ap-radar-pulse-line worker-${w.colorKey}`}
                />
              )
            })}

          {stations.map((st) => {
            const isSelected = selectedStation?.id === st.id
            const shortLbl = SHORT_STATION_CODE[st.code] || st.code
            const wCls = st.workerColorKey ? ` worker-${st.workerColorKey}` : ''
            return (
              <g
                key={st.id}
                role="button"
                tabIndex={0}
                data-station={st.id}
                className={`ap-radar-station-node${st.active ? ' active' : ''}${st.attention ? ' attention' : ''}${isSelected ? ' selected' : ''}${st.hasError ? ' error' : ''}${wCls}`}
                aria-label={`${st.code}: ${t(st.stageKey)}`}
                onClick={() => handleStationActivate(st)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleStationActivate(st)
                  }
                }}
              >
                <circle cx={st.cx} cy={st.cy} r="18" fill="transparent" className="ap-radar-station-hit" />
                {st.attention && <circle cx={st.cx} cy={st.cy} r="15.5" className="ap-radar-you-pulse" />}
                {st.active && <circle cx={st.cx} cy={st.cy} r="15" className={`ap-radar-ping${wCls}`} />}
                <circle cx={st.cx} cy={st.cy} r={st.active || isSelected ? 13 : 11} className="ap-radar-station-disc" />
                <text x={st.cx} y={st.cy + 2.6} textAnchor="middle" className="ap-radar-station-lbl">
                  {shortLbl}
                </text>
                {workers.length >= 2 && st.workerBadge && (
                  <text
                    x={st.cx}
                    y={st.cy + (st.cy >= RADAR_CENTER ? 18.5 : -14.5)}
                    textAnchor="middle"
                    className={`ap-radar-worker-tag${wCls}`}
                  >
                    {st.workerBadge}
                  </text>
                )}
                {st.hasError && (
                  <circle cx={st.cx + 10} cy={st.cy - 10} r="4.2" className="ap-radar-err-dot" />
                )}
                {st.hasNudgePin && (
                  <circle cx={st.cx + 10} cy={st.cy + 10} r="4.2" className="ap-radar-nudge-pin" />
                )}
              </g>
            )
          })}

          <g
            role="button"
            tabIndex={0}
            className="ap-radar-eye"
            aria-label={t('autopilot.radar.coreToggleHint')}
            onClick={toggleCoreMode}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleCoreMode()
              }
            }}
          >
            <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r={EYE_RING_R} className="ap-radar-iris-track" />
            <circle
              cx={RADAR_CENTER}
              cy={RADAR_CENTER}
              r={EYE_RING_R}
              transform={`rotate(-90 ${RADAR_CENTER} ${RADAR_CENTER})`}
              strokeDasharray={EYE_RING_C}
              strokeDashoffset={ringDashOffset}
              className={`ap-radar-iris-arc tone-${eyeTone}`}
            />
            <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r="21" className="ap-radar-sclera" />
            <g key={`blink-${summary.eye?.blinkCount || 0}`} className="ap-radar-eye-lid">
              <g
                className="ap-radar-pupil-track"
                style={{
                  transform: `translate(${summary.eye?.pupilDx ?? 0}px, ${summary.eye?.pupilDy ?? 0}px)`,
                }}
              >
                <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r="9" className={`ap-radar-pupil tone-${eyeTone}`} />
                <circle cx={RADAR_CENTER - 2.5} cy={RADAR_CENTER - 2.5} r="2" className="ap-radar-glint" />
              </g>
            </g>
            <text x={RADAR_CENTER} y={RADAR_CENTER - 1} textAnchor="middle" className="ap-radar-eye-val">
              {isContextCore ? `${summary.eye?.contextPct ?? 0}%` : `${summary.eye?.cacheHitPct ?? 0}%`}
            </text>
            <text x={RADAR_CENTER} y={RADAR_CENTER + 9.5} textAnchor="middle" className="ap-radar-eye-sub">
              {isContextCore ? t('autopilot.radar.ctxLabel') : summary.eye?.costLabel || '$0.00'}
            </text>
          </g>
        </svg>
      </div>

      {workers.length >= 2 && (
        <div className="ap-radar-workers-row" aria-label={t('autopilot.radar.parallelBadge', { n: workers.length })}>
          {workers.map((w) => (
            <span key={w.id} className={`ap-radar-worker-chip worker-${w.colorKey}`}>
              <span className="ap-radar-worker-dot" aria-hidden="true" />
              <span>{w.label}</span>
              <span className="ap-radar-worker-st">{w.stationId.toUpperCase()}</span>
            </span>
          ))}
        </div>
      )}

      {selectedStation && (
        <div className="ap-radar-inspector" role="status">
          <div className="ap-radar-insp-top">
            <span className={`ap-radar-dot${selectedStation.hasError ? ' error' : selectedStation.active ? ' core' : ' explore'}`} aria-hidden="true" />
            <span className="ap-radar-insp-ring">{selectedStation.code}</span>
            <span className="ap-radar-insp-tool">
              {selectedStation.latestTool?.name || t(selectedStation.stageKey)}
            </span>
            {selectedStation.latestTool?.durationLabel ? (
              <span className="ap-radar-age">{selectedStation.latestTool.durationLabel}</span>
            ) : selectedStation.count > 0 ? (
              <span className="ap-radar-age">{t('autopilot.radar.callsLabel', { n: selectedStation.count })}</span>
            ) : null}
          </div>
          <div className="ap-radar-insp-sub">
            <span className="ap-radar-insp-task">{t(selectedStation.stageKey)}</span>
            <span className="ap-radar-insp-hint">
              {selectedStation.id === 'you' && summary.waitingCount > 0
                ? t('autopilot.radar.youFocusHint')
                : t('autopilot.radar.coreToggleHint')}
            </span>
          </div>

          {peekMode === 'browser' && (
            <div className="ap-radar-peek">
              <div className="ap-radar-peek-title">🖼 {t('autopilot.radar.browserPeekTitle')}</div>
              {previewShotUrl ? (
                <img src={previewShotUrl} alt={t('autopilot.radar.browserPeekTitle')} className="ap-radar-peek-img" />
              ) : (
                <div className="ap-radar-peek-empty">{t('autopilot.radar.browserPeekEmpty')}</div>
              )}
            </div>
          )}

          {peekMode === 'files' && (
            <div className="ap-radar-peek files">
              {filesPreview.length > 0 ? (
                filesPreview.map((fc) => {
                  const total = Math.max(1, (fc.added || 0) + (fc.removed || 0))
                  const addPct = Math.round(((fc.added || 0) / total) * 100)
                  return (
                    <div key={fc.file} className="ap-xray-row">
                      <span className="ap-xray-file">📄 {fc.file}</span>
                      <span className="ap-xray-diff">
                        <span className="add">+{fc.added || 0}</span>
                        <span className="del">-{fc.removed || 0}</span>
                      </span>
                      <span className="ap-xray-diffbar" aria-hidden="true">
                        <span className="add" style={{ width: `${addPct}%` }} />
                      </span>
                    </div>
                  )
                })
              ) : (
                <div className="ap-radar-peek-empty">{t('autopilot.radar.xrayNoFiles')}</div>
              )}
            </div>
          )}

          {peekMode === 'shell' && (
            <div className="ap-radar-peek shell">
              <div className="ap-xray-row">
                <span className="ap-xray-intent">
                  {t(selectedStation.latestTool?.commandIntentKey || 'autopilot.radar.cmdIntentGeneric')}
                </span>
                <span className={`ap-xray-badge ${selectedStation.hasError ? 'err' : 'ok'}`}>
                  {selectedStation.hasError ? `✕ ${t('autopilot.radar.xrayFail')}` : `✓ ${t('autopilot.radar.xrayPass')}`}
                </span>
              </div>
              {selectedStation.latestTool?.command ? (
                <code className="ap-xray-cmd">{selectedStation.latestTool.command}</code>
              ) : (
                <div className="ap-radar-peek-empty">{t('autopilot.radar.xrayNoCmd')}</div>
              )}
              {selectedStation.latestError?.errorTail && (
                <pre className="ap-radar-err-tail">{selectedStation.latestError.errorTail}</pre>
              )}
            </div>
          )}

          {peekMode === 'nudge' && (
            <div className="ap-radar-peek nudge">
              <div className="ap-radar-peek-title">📌 {t('autopilot.radar.xrayNudgeTitle')}</div>
              {(summary.nudges || []).slice(-3).reverse().map((n) => (
                <div key={n.id} className="ap-xray-row">
                  <span className="ap-xray-file">{n.text}</span>
                  <span className={`ap-xray-badge ${n.status === 'applied' ? 'ok' : 'warn'}`}>
                    {n.status === 'applied' ? t('autopilot.radar.xrayApplied') : t('autopilot.radar.xrayQueued')}
                  </span>
                </div>
              ))}
            </div>
          )}

          {peekMode === 'error' && selectedStation.latestError?.errorTail && (
            <div className="ap-radar-peek error">
              <div className="ap-radar-peek-title">
                ⚠ {t('autopilot.radar.errorTitle')}: {selectedStation.latestError.name}
              </div>
              <pre className="ap-radar-err-tail">{selectedStation.latestError.errorTail}</pre>
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
          <button
            type="button"
            className="ap-radar-stat waiting ap-radar-stat-btn"
            onClick={() => {
              haptic('tap')
              onFocusReview?.()
            }}
          >
            🔔 {t('autopilot.radar.waiting', { n: summary.waitingCount })}
          </button>
        )}
      </div>

      {compactFeed.length > 0 ? (
        <ol className="ap-radar-feed">
          {compactFeed.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`ap-radar-feed-row${selectedStation?.id === entry.stationId ? ' selected' : ''}${entry.failed ? ' error' : ''}`}
                onClick={() => {
                  haptic('tap')
                  setSelectedStationId(entry.stationId)
                  setPeekMode(peekForStation(stationById[entry.stationId], false))
                }}
              >
                <span className="ap-radar-feed-main">
                  <span className={`ap-radar-dot${entry.failed ? ' error' : ` ${entry.ring}`}`} aria-hidden="true" />
                  <span className="ap-radar-feed-code">{entry.stationCode}</span>
                  <span className="ap-radar-tool">{entry.name}</span>
                </span>
                <span className="ap-radar-age">
                  {entry.durationLabel || t('autopilot.radar.ago', { s: entry.ageSec })}
                </span>
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
