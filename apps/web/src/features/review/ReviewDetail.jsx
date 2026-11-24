/**
 * レビューの読み取り専用詳細（`ReviewPane.jsx` から切り出し）。
 * 判断待ち以外（進行中・完了）の項目を出す。回答フォームは出さない。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api.js'
import { Spinner, relTime } from '../../components/Ui.jsx'
import { haptic } from '../../lib/haptic.js'
import { answerRows, repoLabel, reviewChipKey } from '../../lib/reviewView.js'
import { useI18n } from '../../i18n/index.js'
import { Chip } from './Chip.jsx'

/** レビュー待ち以外（進行中・完了）の読み取り専用ビュー。回答フォームは出さない。 */
export function ReadOnlyDetail({ item, data, answer, notify, onStartAnnotation, onReopened, onOpenChat }) {
  const { t } = useI18n()
  const ak = item.review || {}
  const chipKey = reviewChipKey(item)
  const label = chipKey ? t(chipKey) : item.status
  const answered = ak.answeredAt ? relTime(Date.parse(ak.answeredAt)) : null
  const [anno, setAnno] = useState(null)
  const [zoomImg, setZoomImg] = useState(false)
  // Before ↔ After（SPEC §5.2.2）。比較相手が無ければトグルを出さない
  const [showBefore, setShowBefore] = useState(false)
  const [reopenReason, setReopenReason] = useState('')
  const [reopenBusy, setReopenBusy] = useState(false)

  useEffect(() => {
    setAnno(null)
    setZoomImg(false)
    setShowBefore(false)
    setReopenReason('')
    if (ak.mode !== 'annotation') return undefined
    let alive = true
    api(`/api/review/${item.id}/annotation`)
      .then((r) => alive && setAnno(r?.data ?? null))
      .catch(() => alive && setAnno(null))
    return () => {
      alive = false
    }
  }, [item.id, ak.mode])

  async function submitReopen() {
    if (reopenBusy) return
    setReopenBusy(true)
    try {
      const r = await api(`/api/review/${item.id}/reopen`, {
        method: 'POST',
        body: { reason: reopenReason.trim() || t('review.reopenReasonDefault') },
      })
      if (!r?.ok) throw new Error(t('review.reopenFailed'))
      notify?.(t('review.reopened'))
      onReopened?.()
    } catch (e) {
      notify?.(e?.message || t('review.reopenFailed'))
    } finally {
      setReopenBusy(false)
    }
  }

  // 回答の履歴（グローバル注記: 完了したレビュー項目から回答内容を参照したい）
  const history = answerRows(data, answer)
  const hasHistory = history.rows.some((r) => r.choice || r.note) || Boolean(history.global)
  const imgSrc = ak.image
    ? `/api/review/${item.id}/image${showBefore ? '?compare=1' : '?annotated=1'}`
    : null

  return (
    <div className="ak-form">
      <div className="ak-readonly">
        <Chip tone={item.status === 'done' ? 'good' : ''}>{label}</Chip>
        <span className="ak-label">{ak.label || item.id}</span>
        {ak.repo ? <span>{repoLabel(ak.repo)}</span> : null}
        {ak.round ? <span>r{ak.round}</span> : null}
        {ak.questions ? <span>{t('review.questionsCount', { n: ak.questions })}</span> : null}
        {answered ? <span>{t('review.answeredAtLabel', { time: answered })}</span> : null}
        {item.completedAt ? <span>{t('review.completedLabel', { time: relTime(item.completedAt) })}</span> : null}
      </div>
      <p className="ak-hint">
        {t('review.readonlyHint', { label })}
        {item.result ? (
          <>
            <br />
            {item.result}
          </>
        ) : null}
      </p>
      {imgSrc ? (
        <div className="ak-anno-preview">
          {ak.hasCompare ? (
            <button
              className={`ak-compare-pill${showBefore ? ' on' : ''}`}
              type="button"
              aria-pressed={showBefore}
              title={t('annot.compareAria')}
              onClick={() => {
                haptic('tap')
                setShowBefore((v) => !v)
              }}
            >
              {showBefore ? t('annot.compareBefore') : t('annot.compareAfter')}
            </button>
          ) : null}
          <button
            type="button"
            className="ak-anno-preview-btn"
            onClick={() => {
              haptic('tap')
              setZoomImg(true)
            }}
          >
            <img src={imgSrc} alt={t('review.imageAlt', { title: ak.title || item.title })} />
          </button>
          {anno ? (
            <div className="ak-anno-preview-meta">
              <span>{t('review.annotationMeta', { n: Array.isArray(anno.marks) ? anno.marks.length : 0 })}</span>
              {anno.note ? <span>{t('review.annotationNote', { note: anno.note })}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {hasHistory ? (
        <details className="ak-answers">
          <summary>{t('review.answersSummary')}</summary>
          <ol className="ak-answer-list">
            {history.rows.map((r, i) => (
              <li key={r.id || i}>
                <div className="ak-answer-q">{r.question || r.id}</div>
                <div className="ak-answer-a">
                  {r.choice ? `${r.choice}. ${r.label}` : t('review.delegated')}
                </div>
                {r.note ? <div className="ak-answer-note">{r.note}</div> : null}
              </li>
            ))}
          </ol>
          {history.global ? <div className="ak-answer-global">{t('review.globalNote', { text: history.global })}</div> : null}
        </details>
      ) : null}

      <div className="ak-followup">
        <button
          type="button"
          className="btn"
          onClick={() => {
            haptic('tap')
            onStartAnnotation?.(ak.target || '')
          }}
        >
          {t('review.addAnnotation')}
        </button>
        {ak.chat ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              haptic('tap')
              onOpenChat?.(ak.chat)
            }}
          >
            {t('review.openOriginChat')}
          </button>
        ) : null}
      </div>

      {item.status === 'done' ? (
        <details className="ak-reopen">
          <summary>{t('review.reopenSummary')}</summary>
          <textarea
            className="inp"
            rows={2}
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value.slice(0, 400))}
            placeholder={t('review.reopenPlaceholder')}
          />
          <button
            type="button"
            className="btn hm-btn-inner"
            disabled={reopenBusy}
            aria-busy={reopenBusy}
            onClick={() => {
              haptic('action')
              submitReopen()
            }}
          >
            {reopenBusy ? <Spinner size={14} /> : null}
            <span>{reopenBusy ? t('review.sending') : t('review.reopenSubmit')}</span>
          </button>
        </details>
      ) : null}

      {zoomImg && imgSrc
        ? createPortal(
            <div
              className="ak-zoom"
              role="dialog"
              aria-modal="true"
              aria-label={t('review.zoomAria')}
              onClick={() => setZoomImg(false)}
            >
              <figure onClick={(e) => e.stopPropagation()}>
                <img src={imgSrc} alt={t('review.zoomAlt', { title: ak.title || item.title })} />
                <figcaption>
                  <b>{ak.title || item.title}</b>
                  {anno?.note ? <span>{anno.note}</span> : null}
                </figcaption>
              </figure>
              <button className="ak-zoom-close" type="button" onClick={() => setZoomImg(false)}>
                {t('common.close')}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
