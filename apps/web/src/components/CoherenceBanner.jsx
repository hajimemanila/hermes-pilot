import React from 'react'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'

/**
 * Coherence recommendation banner shown on Tasks tab when idle (SPEC-COHERENCE D83).
 *
 * @param {{view: object, open: boolean, onToggle: Function, onOpenSweep: Function, onDismiss: Function}} props
 * @returns {any|null}
 */
export function CoherenceBanner({ view, open, onToggle, onOpenSweep, onDismiss }) {
  const { t } = useI18n()
  if (!view?.show) return null
  return (
    <section className={`coh-banner${open ? ' is-open' : ''}`} aria-label={t('coherence.bannerAria')}>
      <div className="coh-banner-row">
        <button
          type="button"
          className="coh-banner-head"
          aria-expanded={open}
          onClick={() => {
            haptic('tap')
            onToggle?.()
          }}
        >
          <span className="coh-banner-icon" aria-hidden="true">
            🩺
          </span>
          <span className="coh-banner-main">
            <span className="coh-banner-title">{t('coherence.bannerTitle')}</span>
            <span className="coh-banner-sub">
              {t('coherence.bannerSummary', {
                hard: view.summary.hardFailCount,
                soft: view.summary.softSignalCount,
                hotspots: view.summary.hotspotCount,
              })}
            </span>
          </span>
          <span className="coh-banner-chev" aria-hidden="true">
            {open ? '▴' : '▾'}
          </span>
        </button>
        <button
          type="button"
          className="coh-banner-close"
          aria-label={t('coherence.bannerDismiss')}
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
      {open ? (
        <div className="coh-banner-body">
          {view.highlights.length ? (
            <ul className="coh-banner-list">
              {view.highlights.map((h, i) => (
                <li key={`${i}-${h}`}>{h}</li>
              ))}
            </ul>
          ) : null}
          <div className="coh-banner-actions">
            <button type="button" className="btn primary" onClick={onOpenSweep}>
              {t('coherence.bannerOpen')}
            </button>
            <button type="button" className="btn" onClick={onDismiss}>
              {t('coherence.bannerHide')}
            </button>
          </div>
        </div>
      ) : (
        <div className="coh-banner-actions is-inline">
          <button type="button" className="btn primary" onClick={onOpenSweep}>
            {t('coherence.bannerOpen')}
          </button>
        </div>
      )}
    </section>
  )
}
