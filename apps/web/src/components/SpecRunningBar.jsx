import React from 'react'
import { Spinner } from './Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'

/** Trim long titles cleanly so 390px cards stay inside bounds. */
function clipLine(text, max = 40) {
  const s = String(text ?? '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Active SPEC batch execution card shown at the top of Tasks tab.
 *
 * Renders the running/queued status, completed count, inspect task button, and
 * batch launcher sheet trigger.
 *
 * @param {{summary: object|null, onInspect?: Function, onOpenBatches?: Function}} props
 * @returns {any|null}
 */
export function SpecRunningBar({ summary, onInspect, onOpenBatches }) {
  const { t } = useI18n()
  if (!summary) return null
  const running = summary.running > 0
  return (
    <div
      className={`job-bar${running ? '' : ' queued'}`}
      role="status"
      aria-live="polite"
      aria-label={t('tasks.specRunAria')}
    >
      <div className="job-bar-row">
        {running ? (
          <Spinner size={14} />
        ) : (
          <span className="job-bar-wait" aria-hidden="true">
            ⏳
          </span>
        )}
        <span className="job-bar-title">
          {running ? `⚡ ${t('tasks.specRunRunning')}` : t('tasks.specRunQueued')}
        </span>
        <span className="job-bar-runner">
          {t('tasks.specRunProgress', { done: summary.done, total: summary.total })}
        </span>
      </div>
      {summary.title ? <div className="job-bar-sub">{clipLine(summary.title)}</div> : null}
      <div className="job-bar-actions">
        <button
          type="button"
          className="job-bar-btn"
          onClick={() => {
            haptic('tap')
            onInspect?.(summary.primaryTask)
          }}
        >
          {`🔍 ${t('seed.inspect')}`}
        </button>
        <button
          type="button"
          className="job-bar-btn"
          onClick={() => {
            haptic('tap')
            onOpenBatches?.(summary.spec)
          }}
        >
          {`📋 ${t('tasks.specRunBatches')}`}
        </button>
      </div>
    </div>
  )
}
