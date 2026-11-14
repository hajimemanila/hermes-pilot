import React from 'react'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'

/**
 * A2B クイック起票カード（SPEC V5 §3.2・§3.3 ① / D23）。
 *
 * 「仕様書の準備が完了しました — N バッチを起票して自走開始」を Chat / Tasks の
 * どちらにも同じ見た目で出す。押すと `POST /api/specs/launch` で**未起票バッチだけ**を
 * 起票する（既起票はブリッジ側でスキップされるため二重起票にならない）。
 *
 * `Seed` シートで「承認後に自動でバッチを起票」を ON にしていた場合は、ここに来る前に
 * ブリッジが起票済みなので、このカードは自動で消える（`launched` は出さない）。
 *
 * @param {{banner: object, onFile: Function, busy?: boolean, onDismiss?: Function}} props バナーと起票処理
 * @returns {any|null} カード
 */
export function SpecReadyBanner({ banner, onFile, busy = false, onDismiss }) {
  const { t } = useI18n()
  if (!banner) return null
  const ready = banner.kind === 'ready'
  return (
    <div className="spec-banner" role="region" aria-label={t('seed.bannerAria')}>
      <div className="spec-banner-main">
        <span className="spec-banner-title">
          {ready ? t('seed.bannerTitle', { n: banner.count }) : t('seed.bannerPending', { n: banner.count })}
        </span>
        <span className="spec-banner-sub">{banner.title}</span>
      </div>
      <button
        type="button"
        className="spec-banner-btn"
        disabled={busy}
        onClick={() => {
          haptic('action')
          onFile?.(banner)
        }}
      >
        {busy ? t('seed.submitting') : `🚀 ${t('seed.bannerAction')}`}
      </button>
      {onDismiss ? (
        <button
          type="button"
          className="attach-x"
          aria-label={t('seed.bannerLater')}
          onClick={() => {
            haptic('tap')
            onDismiss(banner)
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
