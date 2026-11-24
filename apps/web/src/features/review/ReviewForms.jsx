/**
 * レビューの回答フォーム（`ReviewPane.jsx` から切り出し）。
 * 標準は設問 JSON からネイティブに描き、JSON が無いシートは sandbox iframe＋貼り付け回答で受ける。
 * どの項目を開いているか・送信後の遷移は `ReviewPane.jsx` 側の責務のまま置く。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, withLang } from '../../api.js'
import { Spinner } from '../../components/Ui.jsx'
import { haptic } from '../../lib/haptic.js'
import { readActiveChatId } from '../../lib/chatReports.js'
import { parsePastedReply } from '../../lib/reviewPaste.js'
import { thumbCaption } from '../../lib/reviewView.js'
import { useI18n } from '../../i18n/index.js'
import { Chip } from './Chip.jsx'

/**
 * 挿絵の拡大用データ。キャプションは「Q2 A. 塗りのボタン」＋問いの文。
 * ラベルだけだと何の話か分からない（注釈 review-empty-01: この文言はなんですか？）。
 */
function toZoom(taskId, option, qIndex, question, thumb) {
  const { head, sub } = thumbCaption(`Q${qIndex + 1}`, option, question?.text)
  return { src: `/api/review/${taskId}/thumb/${thumb}`, head, sub }
}

export function StandardForm({ item, data, onSubmitted }) {
  const { t } = useI18n()
  const questions = data.questions || []
  const [answers, setAnswers] = useState(() => {
    const init = {}
    for (const q of questions) init[q.id] = { choice: null, note: '' }
    return init
  })
  const [global, setGlobal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // 挿絵は 72px 固定だと判断できない（レビュー回答の全体メモ）。タップで原寸表示する。
  const [zoom, setZoom] = useState(null)

  const setChoice = (qid, value) =>
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], choice: value } }))
  const setNote = (qid, value) =>
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], note: value } }))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const payload = {
        answers: questions.map((q) => ({
          id: q.id,
          choice: answers[q.id]?.choice ?? null,
          note: answers[q.id]?.note ?? '',
        })),
        global,
        by: 'mobile',
        chat: readActiveChatId(),
      }
      const r = await api(`/api/review/${item.id}/answer`, { method: 'POST', body: payload })
      onSubmitted?.(r)
    } catch (e) {
      setError(e?.message || t('review.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ak-form">
      {questions.map((q, i) => (
        <section className="ak-q" key={q.id}>
          <div className="ak-q-head">
            <span className="ak-q-no">Q{i + 1}</span>
            <span className="ak-q-text">{q.text}</span>
          </div>
          <div className="ak-opts">
            {(q.options || []).map((o) => {
              const on = answers[q.id]?.choice === o.id
              return (
                <button
                  key={o.id}
                  type="button"
                  className={`ak-opt${on ? ' on' : ''}`}
                  onClick={() => setChoice(q.id, on ? null : o.id)}
                >
                  <span className="ak-opt-head">
                    <b>{o.id}</b>
                    <span>{o.label}</span>
                    {o.recommended ? <Chip tone="rec">{t('review.recommended')}</Chip> : null}
                    <span className="ak-opt-check" aria-hidden="true">✓</span>
                  </span>
                  {o.detail ? <span className="ak-opt-detail">{o.detail}</span> : null}
                  {o.thumb ? (
                    <span
                      className="ak-thumb-btn"
                      role="button"
                      tabIndex={0}
                      aria-label={t('review.thumbZoomAria', { head: thumbCaption(`Q${i + 1}`, o).head })}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setZoom(toZoom(item.id, o, i, q, o.thumb))
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return
                        e.preventDefault()
                        e.stopPropagation()
                        setZoom(toZoom(item.id, o, i, q, o.thumb))
                      }}
                    >
                      <img className="ak-opt-thumb" src={`/api/review/${item.id}/thumb/${o.thumb}`} alt="" />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <input
            className="ak-note"
            value={answers[q.id]?.note || ''}
            onChange={(e) => setNote(q.id, e.target.value)}
            placeholder={t('review.notePlaceholder')}
          />
        </section>
      ))}
      <section className="ak-q">
        <div className="ak-q-head">
          <span className="ak-q-no">{t('review.globalNo')}</span>
          <span className="ak-q-text">{t('review.globalTitle')}</span>
        </div>
        <textarea
          className="ak-global"
          value={global}
          onChange={(e) => setGlobal(e.target.value)}
          placeholder={t('review.globalPlaceholder')}
          rows={3}
        />
      </section>
      {error ? <div className="ak-error">{error}</div> : null}
      <div className="ak-actions">
        <button
          className="btn primary hm-btn-inner"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => {
            haptic('action')
            submit()
          }}
        >
          {busy ? <Spinner size={15} /> : null}
          <span>{busy ? t('review.sending') : t('review.submitAnswer')}</span>
        </button>
      </div>
      <p className="ak-hint">{t('review.formHint')}</p>
      {zoom
        ? createPortal(
            <div
              className="ak-zoom"
              role="dialog"
              aria-modal="true"
              aria-label={t('review.thumbAlt', { head: zoom.head })}
              onClick={() => setZoom(null)}
            >
              <figure onClick={(e) => e.stopPropagation()}>
                <img src={zoom.src} alt={t('review.thumbAlt', { head: zoom.head })} />
                <figcaption>
                  <b>{zoom.head}</b>
                  {zoom.sub ? <span>{zoom.sub}</span> : null}
                </figcaption>
              </figure>
              <button className="ak-zoom-close" type="button" onClick={() => setZoom(null)}>
                {t('common.close')}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

export function IframeForm({ item, onSubmitted, notify }) {
  const { t } = useI18n()
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // シート自身の [貼り付ける文章を作る] が postMessage で回答を送ってくる
  useEffect(() => {
    const onMessage = async (ev) => {
      const d = ev.data
      if (!d || d.type !== 'review:reply' || String(d.taskId) !== String(item.id)) return
      setBusy(true)
      setError(null)
      try {
        const parsed = parsePastedReply(d.text)
        const r = await api(`/api/review/${item.id}/answer`, {
          method: 'POST',
          body: { ...parsed, by: 'mobile', chat: readActiveChatId() },
        })
        notify?.(r?.duplicate ? t('review.duplicate') : t('review.receivedFromSheet'))
        onSubmitted?.(r)
      } catch (e) {
        setError(e?.message || t('review.sendFailed'))
      } finally {
        setBusy(false)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [item.id])

  async function submitPasted() {
    if (!pasted.trim()) return
    setBusy(true)
    setError(null)
    try {
      const parsed = parsePastedReply(pasted)
      const r = await api(`/api/review/${item.id}/answer`, {
        method: 'POST',
        body: { ...parsed, by: 'mobile', chat: readActiveChatId() },
      })
      onSubmitted?.(r)
    } catch (e) {
      setError(e?.message || t('review.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ak-form">
      <iframe
        className="ak-iframe"
        title={t('review.sheetIframeTitle')}
        src={withLang(`/api/review/${item.id}/sheet`)}
        sandbox="allow-scripts allow-forms"
      />
      <details className="ak-paste">
        <summary>{t('review.pasteSummary')}</summary>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={t('review.pastePlaceholder')}
          rows={6}
        />
        {error ? <div className="ak-error">{error}</div> : null}
        <button
          className="btn primary hm-btn-inner"
          type="button"
          disabled={busy || !pasted.trim()}
          aria-busy={busy}
          onClick={() => {
            haptic('action')
            submitPasted()
          }}
        >
          {busy ? <Spinner size={15} /> : null}
          <span>{busy ? t('review.sending') : t('review.submitPasted')}</span>
        </button>
      </details>
    </div>
  )
}

/**
 * 詳細シート（`/api/review/:id/view` ラッパー経由）への導線。**ドロワーの先頭に固定して出す**。
 *
 * 判断待ちのドロワーはネイティブの設問フォームが主で、前提・挿絵・前回の回答といった
 * シートの全体像は見えない。リンクをフォームの末尾に置くと、設問が増えた時点で
 * スクロールの下に隠れて「導線が無い」と読める（実測: Q3+挿絵で 390x844 の1画面を超える）。
 * 完了（ReadOnlyDetail）でも同じ位置に出す — 同じ操作は同じ場所に置く。
 *
 * リンク先は `/sheet` ではなく `/view`（D57）。シートは常に sandbox で配信されるので
 * 単体タブでは回答を POST できない。`/view` が same-origin の親として中継する。
 */
export function SheetLink({ item }) {
  const { t } = useI18n()
  return (
    <div className="ak-sheetlink">
      <a className="ak-link" href={withLang(`/api/review/${item.id}/view`)} target="_blank" rel="noreferrer">
        {t('review.openSheet')}
      </a>
    </div>
  )
}
