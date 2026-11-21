import React, { useEffect, useState } from 'react'
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
 * 意図しない退避を防ぐため、カード上の「📦 アーカイブ」は 2 タップ確認式（5 秒で自動リセット）。
 *
 * @param {{banner: object, onFile: Function, busy?: boolean, onDismiss?: Function,
 *          onPreview?: Function, onArchive?: Function}} props バナーと起票処理・仕様書プレビュー（D30 ③）・退避
 * @returns {any|null} カード
 */
export function SpecReadyBanner({ banner, onFile, busy = false, onDismiss, onPreview, onArchive }) {
  const { t } = useI18n()
  const [confirmArchive, setConfirmArchive] = useState(false)

  useEffect(() => {
    setConfirmArchive(false)
  }, [banner?.path])

  useEffect(() => {
    if (!confirmArchive) return undefined
    const id = setTimeout(() => setConfirmArchive(false), 5000)
    return () => clearTimeout(id)
  }, [confirmArchive])

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
      {/* 狭幅 390px では主文の下へ折り返す（ボタンを 1 行に詰めない・D30） */}
      <div className="spec-banner-actions">
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
        {onPreview ? (
          <button
            type="button"
            className="spec-banner-btn ghost"
            onClick={() => {
              haptic('tap')
              onPreview(banner)
            }}
          >
            {`📄 ${t('seed.bannerPreview')}`}
          </button>
        ) : null}
        {onArchive ? (
          <button
            type="button"
            className="spec-banner-btn ghost"
            disabled={busy}
            onClick={() => {
              haptic('tap')
              if (!confirmArchive) {
                setConfirmArchive(true)
                return
              }
              setConfirmArchive(false)
              onArchive(banner)
            }}
          >
            {confirmArchive ? t('seed.bannerArchiveConfirm') : `📦 ${t('seed.bannerArchive')}`}
          </button>
        ) : null}
      </div>
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
