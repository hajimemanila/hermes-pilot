import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Loader, Sheet, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import {
  RECEIPT_H,
  RECEIPT_SCALE,
  RECEIPT_W,
  buildShareText,
  drawReceipt,
  receiptBatches,
  receiptFilename,
  receiptHeading,
  receiptKpis,
} from '../lib/receiptCanvas.js'
import { useI18n } from '../i18n/index.js'

/**
 * 現在の Vibe（`html[data-vibe]`）。Vibe Mode 未実装の環境では既定 `dopamine`。
 *
 * `lib/vibe.js` を import せず DOM だけを見る（Vibe Mode と独立に動かせるようにする）。
 * @returns {'dopamine'|'serotonin'} Vibe
 */
function currentVibe() {
  try {
    const v = document.documentElement?.dataset?.vibe
    return v === 'serotonin' ? 'serotonin' : 'dopamine'
  } catch {
    return 'dopamine'
  }
}

/**
 * 1200×630 の PNG Blob を作る（Retina で描いて等倍へ縮小）。
 *
 * @param {object} receipt `/api/telemetry/receipt` の応答
 * @param {{lang: string, vibe: string}} opts 言語と Vibe
 * @returns {Promise<Blob|null>} PNG（失敗時 null）
 */
async function renderReceiptBlob(receipt, opts) {
  if (typeof document === 'undefined') return null
  const retina = document.createElement('canvas')
  retina.width = RECEIPT_W * RECEIPT_SCALE
  retina.height = RECEIPT_H * RECEIPT_SCALE
  const rctx = retina.getContext('2d')
  if (!rctx) return null
  rctx.scale(RECEIPT_SCALE, RECEIPT_SCALE)
  drawReceipt(rctx, receipt, opts)

  const out = document.createElement('canvas')
  out.width = RECEIPT_W
  out.height = RECEIPT_H
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.drawImage(retina, 0, 0, RECEIPT_W, RECEIPT_H)
  return new Promise((resolve) => {
    try {
      out.toBlob((blob) => resolve(blob ?? null), 'image/png')
    } catch {
      resolve(null)
    }
  })
}

/**
 * 完了レシート（`🏆 Completion Receipt Card`・SPEC-PILOT-V5 §3.3 ③ / D26③）。
 *
 * V4 の統合レポート（Chat / Tasks）と `UsageSheet` から 1 タップで開く。
 *  - サーバ集計 `GET /api/telemetry/receipt`（コスト/キャッシュ率/節約見込/操作メトリクス）
 *  - `data-vibe` で Dopamine（ホログラム調）⇄ Serotonin（端正な監査サマリ）を切り替える
 *  - `📸 PNG画像を保存`（1200×630）と `📋 シェア用テキストをコピー`
 *
 * @param {{
 *   board?: string|null,
 *   spec?: string|null,
 *   hours?: number,
 *   onClose: Function,
 *   notify?: (text: string) => void,
 * }} props
 */
export function MissionReceiptSheet({ board = null, spec = null, hours = 24, onClose, notify }) {
  const { t, lang } = useI18n()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [vibe, setVibe] = useState(currentVibe)
  const [previewUrl, setPreviewUrl] = useState(null)

  // Vibe の切替（V5-2 の設定トグル）にその場で追随する
  useEffect(() => {
    const onVibe = () => setVibe(currentVibe())
    window.addEventListener('hm:vibe', onVibe)
    return () => window.removeEventListener('hm:vibe', onVibe)
  }, [])

  // 集計（シートを開いたときだけ 1 回）
  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams({ hours: String(hours) })
    if (board) qs.set('board', board)
    if (spec) qs.set('spec', spec)
    setLoading(true)
    api(`/api/telemetry/receipt?${qs}`)
      .then((r) => {
        if (!alive) return
        setData(r)
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        setError(e?.message ?? t('receipt.failed'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // 言語は描画だけに効くので依存に入れない（取り直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, spec, hours])

  // プレビューは「保存される PNG そのもの」を <img> で出す（WYSIWYG・Canvas の再描画差異なし）
  useEffect(() => {
    if (!data) return undefined
    let alive = true
    let url = null
    renderReceiptBlob(data, { lang, vibe })
      .then((blob) => {
        if (!alive || !blob) return
        url = URL.createObjectURL(blob)
        setPreviewUrl(url)
      })
      .catch(() => {})
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [data, lang, vibe])

  const kpis = data ? receiptKpis(data, lang) : []
  const shareText = data ? buildShareText(data, { lang }) : ''
  const missing = Array.isArray(data?.missing) ? data.missing : []
  // Spec スコープの内訳（どのセッション・タスクを合算したか）を 1 行で出す（V7-2）
  const scope = data?.scope ?? null
  const scopeLine = scope
    ? [
        t('receipt.scope.usage', { sessions: Number(scope.usage?.sessionIds ?? data?.kpi?.sessions ?? 0), tasks: Number(scope.tasks ?? 0) }),
        scope.usage?.fallback ? t('receipt.scope.fallback') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  /** 1 タップで PNG を保存（共有シート対応端末では共有も選べる）。 */
  const savePng = useCallback(async () => {
    if (!data || busy) return
    haptic('tap')
    setBusy(true)
    try {
      const blob = await renderReceiptBlob(data, { lang, vibe })
      if (!blob) throw new Error(t('receipt.failed'))
      const name = receiptFilename(data)
      const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null
      if (file && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: t('receipt.title'), text: shareText })
          haptic('success')
          return
        } catch {
          // 共有をキャンセルしただけのこともあるので、ダウンロードへフォールバックする
        }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      haptic('success')
      notify?.(name)
    } catch (e) {
      haptic('error')
      notify?.(e?.message ?? t('receipt.failed'))
    } finally {
      setBusy(false)
    }
  }, [data, busy, lang, vibe, shareText, notify, t])

  /** シェア文をクリップボードへ（非対応環境は一時 textarea）。 */
  const copyShare = useCallback(async () => {
    if (!shareText) return
    haptic('tap')
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText)
      } else {
        const ta = document.createElement('textarea')
        ta.value = shareText
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      haptic('success')
      notify?.(t('receipt.copied'))
    } catch {
      haptic('error')
      notify?.(t('receipt.copyFailed'))
    }
  }, [shareText, notify, t])

  return (
    <Sheet title={t('receipt.title')} onClose={onClose}>
      <div className={`receipt-sheet is-${vibe}`}>
        {loading ? (
          <Loader label={t('receipt.loading')} />
        ) : error ? (
          <div className="empty">{error}</div>
        ) : !data ? (
          <div className="empty">{t('receipt.failed')}</div>
        ) : (
          <>
            <div className="receipt-head">
              <span className="receipt-head-icon" aria-hidden="true">
                🏆
              </span>
              <span className="receipt-head-main">
                <span className="receipt-head-title">{receiptHeading(data)}</span>
                <span className="receipt-head-sub">
                  {[
                    receiptBatches(data),
                    data.spec,
                    t('receipt.canvas.window', { hours: data.windowHours ?? hours }),
                    relTime(data.generatedAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </div>

            {previewUrl ? (
              <img
                className="receipt-preview"
                src={previewUrl}
                width={RECEIPT_W}
                height={RECEIPT_H}
                alt={t('receipt.title')}
              />
            ) : (
              <div className="receipt-preview receipt-preview-empty" aria-hidden="true" />
            )}

            <div className="receipt-kpis">
              {kpis.map((k) => (
                <div key={k.key} className="receipt-kpi">
                  <span className="receipt-kpi-label">{k.label}</span>
                  <span className="receipt-kpi-value">{k.value}</span>
                  {k.note ? <span className="receipt-kpi-note">{k.note}</span> : null}
                </div>
              ))}
            </div>
            {scopeLine ? <div className="receipt-note receipt-scope">{scopeLine}</div> : null}

            <div className="receipt-actions">
              <button type="button" className="receipt-btn primary" onClick={savePng} disabled={busy}>
                {busy ? t('receipt.saving') : t('receipt.savePng')}
              </button>
              <button type="button" className="receipt-btn" onClick={copyShare}>
                {t('receipt.copyShare')}
              </button>
            </div>
            <div className="receipt-note">{t('receipt.shareNote')}</div>

            {missing.length ? (
              <div className="receipt-note warn">{t('receipt.partial', { sources: missing.join(', ') })}</div>
            ) : null}
            <div className="receipt-note">{t('receipt.savedNote', { pct: Math.round((data?.kpi?.savedRatio ?? 0.9) * 100) })}</div>
          </>
        )}
      </div>
    </Sheet>
  )
}
