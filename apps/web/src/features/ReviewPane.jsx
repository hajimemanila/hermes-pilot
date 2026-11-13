import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import { CloseActions } from '../components/CloseActions.jsx'
import { Icon, Loader, RefreshButton, Sheet, Spinner, fmtTime, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { readActiveChatId } from '../lib/chatReports.js'
import { AnnotationEditor } from './AnnotationEditor.jsx'
import { answerRows, capturedLabel, DONE_LIMIT, doneHint, groupItems, isWaiting, nextWaiting, repoLabel, thumbCaption } from '../lib/reviewView.js'
import { parsePastedReply } from '../lib/reviewPaste.js'
import { t } from '../i18n/lang.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'

export { parsePastedReply }

/**
 * 挿絵の拡大用データ。キャプションは「Q2 A. 塗りのボタン」＋問いの文。
 * ラベルだけだと何の話か分からない（注釈 review-empty-01: この文言はなんですか？）。
 */
function toZoom(taskId, option, qIndex, question, thumb) {
  const { head, sub } = thumbCaption(`Q${qIndex + 1}`, option, question?.text)
  return { src: `/api/review/${taskId}/thumb/${thumb}`, head, sub }
}

/**
 * レビュー（review）ビュー。
 *
 * 契約: `~/Projects/review/CONTRACT.md`。カンバン board `mobile` の状態が真実で、
 * 標準モードは sheet.json から**ネイティブフォーム**を描き（=モバイルで一番速い）、
 * 指摘/添削モードはシート自体を iframe で開く（注釈UIは再現しない）。
 *
 * 送信は `POST /api/review/:id/answer` のみ。サーバが回答ファイルを書き、
 * カンバンを comment → unblock するので、この画面は状態を推測しない。
 *
 * 表示仕様は `docs/REVIEW-VIEW.md`（レビュー akapen-view-01 の回答で確定）:
 * 既定は「判断待ち」だけを見せ、送信後は次の判断待ちへ移る。
 */

/** 状態 → 辞書キー（未知は生の値）。 */
const STATUS_KEY = {
  review: 'review.status.review',
  ready: 'review.status.ready',
  running: 'review.status.running',
  blocked: 'review.status.blocked',
  done: 'review.status.done',
}

const TABS = [
  { id: 'waiting', key: 'review.tab.waiting' },
  { id: 'active', key: 'review.tab.active' },
  { id: 'done', key: 'review.tab.done' },
]

/** 進行状況の1行（「動いているのか」を数字で示す）。 */
function progressText(item) {
  const pr = item.progress || {}
  const now = Date.now()
  const ago = (ts) => {
    if (!ts) return null
    const s = Math.max(0, Math.round((now - ts) / 1000))
    if (s < 90) return t('review.ago.seconds', { n: s })
    if (s < 3600) return t('review.ago.minutes', { n: Math.round(s / 60) })
    return t('review.ago.hours', { n: Math.round(s / 3600) })
  }
  if (item.status === 'running') {
    const beat = ago(pr.heartbeatAt)
    const since = ago(pr.startedAt)
    return [
      t('review.progress.reflecting'),
      since ? t('review.progress.since', { ago: since }) : '',
      beat ? t('review.progress.beat', { ago: beat }) : '',
    ].join('')
  }
  if (item.status === 'ready') return t('review.progress.ready')
  if (item.status === 'blocked' && item.review?.label) {
    const at = ago(pr.lastEventAt)
    return t('review.progress.waiting') + (at ? t('review.progress.presented', { ago: at }) : '')
  }
  if (item.status === 'done') return t('review.progress.done') + (pr.lastEventAt ? ` ・ ${ago(pr.lastEventAt)}` : '')
  return ''
}

function Chip({ tone, children }) {
  return <span className={`ak-chip ${tone || ''}`}>{children}</span>
}

function ItemRow({ item, onOpen }) {
  const { t } = useI18n()
  const ak = item.review || {}
  const waiting = isWaiting(item)
  const age = item.completedAt || item.createdAt ? relTime(item.completedAt || item.createdAt) : ''
  return (
    <button
      className="ak-row"
      onClick={() => {
        haptic('tap')
        onOpen(item)
      }}
      type="button"
    >
      <div className="ak-row-main">
        <div className="ak-row-title">{ak.title || item.title}</div>
        <div className="ak-row-sub">
          <span className="ak-label">{ak.label || item.id}</span>
          {ak.round ? <span>r{ak.round}</span> : null}
          {ak.questions ? <span>{t('review.questionsCount', { n: ak.questions })}</span> : null}
          {ak.mode && ak.mode !== 'standard' ? <span>{ak.mode}</span> : null}
          <span>{age}</span>
        </div>
        {progressText(item) ? <div className="ak-row-phase">{progressText(item)}</div> : null}
      </div>
      <div className="ak-row-side">
        <Chip tone={waiting ? 'warn' : item.status === 'done' ? 'good' : ''}>
          {waiting ? t('review.progress.waiting') : STATUS_KEY[item.status] ? t(STATUS_KEY[item.status]) : item.status}
        </Chip>
      </div>
    </button>
  )
}

/**
 * 貼り付け回答の解析は `lib/reviewPaste.js` に移した（形式は外部と共有するデータなので
 * 日本語のまま。互換のためここから再エクスポートする）。
 */


/** worker（profile mobile）の進行。反映中でも「何をしているか」が見えるようにする。 */
function WorkerFeed({ taskId, open }) {
  const { t } = useI18n()
  const [feed, setFeed] = useState(null)
  const [error, setError] = useState(null)
  const boxRef = React.useRef(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await api(`/api/review/${taskId}/worker?limit=30`)
        if (!alive) return
        setFeed(r)
        setError(null)
      } catch (e) {
        if (alive) setError(e?.message || t('review.loadFailed'))
      }
    }
    load()
    // 進行中だけライブ更新。完了後は開いたときの1回で足りる
    const id = open
      ? setInterval(() => {
          if (document.visibilityState === 'visible') load()
        }, 5000)
      : null
    return () => {
      alive = false
      if (id) clearInterval(id)
    }
  }, [open, taskId])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feed])

  const msgs = (feed?.feed?.messages || []).filter((m) => m.role !== 'user')
  return (
    <details className="ak-worker" open={open}>
      <summary>
        {t('review.workerProgress')}
        {feed?.status ? t('review.workerStatus', { status: feed.status === 'running' ? t('review.status.running') : feed.status }) : ''}
        {msgs.length ? t('review.workerSteps', { n: msgs.length }) : ''}
      </summary>
      {error ? <div className="ak-error">{error}</div> : null}
      {!error && !msgs.length ? <div className="ak-worker-empty">{t('review.workerEmpty')}</div> : null}
      <div className="ak-worker-log" ref={boxRef}>
        {msgs.map((m) => {
          const time = fmtTime(m.at)
          const label = m.role === 'tool' ? m.toolName || 'tool' : 'agent'
          const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 220)
          return (
            <div className={`ak-worker-row ${m.role}`} key={m.id}>
              <span className="ak-worker-time">{time}</span>
              <span className="ak-worker-tag">{label}</span>
              <span className="ak-worker-text">{text}</span>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function StandardForm({ item, data, onSubmitted }) {
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

function IframeForm({ item, onSubmitted, notify }) {
  const { t } = useI18n()
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // シート自身の [貼り付ける文章を作る] が postMessage で回答を送ってくる
  useEffect(() => {
    const onMessage = async (ev) => {
      const d = ev.data
      // 旧シート（`akapen:reply`）も受ける。新しい注入スクリプトは `review:reply` を送る。
      if (!d || (d.type !== 'review:reply' && d.type !== 'akapen:reply') || String(d.taskId) !== String(item.id)) return
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
        src={`/api/review/${item.id}/sheet`}
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
 * 詳細シート（`/api/review/:id/sheet`）への導線。**ドロワーの先頭に固定して出す**。
 *
 * 判断待ちのドロワーはネイティブの設問フォームが主で、前提・挿絵・前回の回答といった
 * シートの全体像は見えない。リンクをフォームの末尾に置くと、設問が増えた時点で
 * スクロールの下に隠れて「導線が無い」と読める（実測: Q3+挿絵で 390x844 の1画面を超える）。
 * 完了（ReadOnlyDetail）でも同じ位置に出す — 同じ操作は同じ場所に置く。
 */
function SheetLink({ item }) {
  const { t } = useI18n()
  return (
    <div className="ak-sheetlink">
      <a className="ak-link" href={`/api/review/${item.id}/sheet`} target="_blank" rel="noreferrer">
        {t('review.openSheet')}
      </a>
    </div>
  )
}

/** レビュー待ち以外（進行中・完了）の読み取り専用ビュー。回答フォームは出さない。 */
function ReadOnlyDetail({ item, data, answer, notify, onStartAnnotation, onReopened, onOpenChat }) {
  const { t } = useI18n()
  const ak = item.review || {}
  const label = STATUS_KEY[item.status] ? t(STATUS_KEY[item.status]) : item.status
  const answered = ak.answeredAt ? relTime(Date.parse(ak.answeredAt)) : null
  const [anno, setAnno] = useState(null)
  const [zoomImg, setZoomImg] = useState(false)
  const [reopenReason, setReopenReason] = useState('')
  const [reopenBusy, setReopenBusy] = useState(false)

  useEffect(() => {
    setAnno(null)
    setZoomImg(false)
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
  const imgSrc = ak.image ? `/api/review/${item.id}/image?annotated=1` : null

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


/** 端末画像を長辺1600px / JPEG 0.85 に縮小して dataURL にする。 */
function downscaleFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight)
      const scale = Math.min(1, 1600 / long)
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(t('review.imageLoadFailed')))
    }
    img.src = url
  })
}

/** 「＋ 注釈」: 端末の画像 / library・直近スクショ から注釈タスクを作る。 */
function NewAnnotationSheet({ onCreated, onClose, notify, initialTarget = '' }) {
  const { t } = useI18n()
  const [items, setItems] = useState(null)
  const [targets, setTargets] = useState([])
  const [target, setTarget] = useState('')
  const [repoOnly, setRepoOnly] = useState(Boolean(initialTarget))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = React.useRef(null)

  useEffect(() => {
    api('/api/review/library?limit=36')
      .then((r) => setItems(r.items || []))
      .catch((e) => {
        setItems([])
        setError(e?.message || t('review.listFailed'))
      })
    api('/api/review/targets')
      .then((r) => {
        const list = r.targets || []
        setTargets(list)
        const hit = initialTarget
          ? list.find((x) => x.path.toLowerCase() === String(initialTarget).toLowerCase())
          : null
        // 既定は指定リポジトリまたは hermes-mobile-pwa（サーバ側で先頭に並ぶ）
        setTarget((prev) => prev || hit?.path || list[0]?.path || '')
      })
      .catch(() => setTargets([]))
  }, [initialTarget])

  async function create(body) {
    setBusy(true)
    setError(null)
    try {
      // 起票元の会話（完了報告を戻す宛先 `chat=`）。新規会話未送信中でも直前の会話 ID を引き継ぐ。
      const chat = readActiveChatId()
      const r = await api('/api/review/annotation/new', { method: 'POST', body: { ...body, chat } })
      if (!r?.ok) throw new Error(r?.message || t('review.createFailed'))
      notify?.(t('review.createdAnno', { image: r.image }))
      onCreated?.(r)
    } catch (e) {
      setError(e?.message || t('review.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function onPick(ev) {
    const f = ev.target.files?.[0]
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      const dataUrl = await downscaleFile(f)
      await create({ source: 'upload', image: dataUrl, title: f.name.replace(/\.[a-z]+$/i, ''), slug: f.name, target })
    } catch (e) {
      setError(e?.message || t('review.importFailed'))
      setBusy(false)
    }
  }

  const selectedTarget = targets.find((tg) => tg.path === target) || null
  const shownItems =
    repoOnly && selectedTarget && items
      ? items.filter((it) => it.repo?.id === selectedTarget.id)
      : items

  return (
    <Sheet title={t('review.newAnnoTitle')} onClose={onClose}>
      <div className="ak-new">
        <button className="btn primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t('review.pickFromDevice')}
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        <label className="ak-new-target-row">
          <span>{t('review.target')}</span>
          <select className="ak-new-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((tg) => (
              <option key={tg.path} value={tg.path}>
                {t('review.targetOption', { label: tg.label, id: tg.id })}
              </option>
            ))}
          </select>
        </label>
        {selectedTarget && items?.length ? (
          <div className="chips" style={{ padding: 0 }}>
            <button
              type="button"
              className={`chip${repoOnly ? ' on' : ''}`}
              onClick={() => {
                haptic('tap')
                setRepoOnly(true)
              }}
            >
              {t('review.onlyRepo', { id: selectedTarget.id })}
            </button>
            <button
              type="button"
              className={`chip${!repoOnly ? ' on' : ''}`}
              onClick={() => {
                haptic('tap')
                setRepoOnly(false)
              }}
            >
              {t('review.all')}
            </button>
          </div>
        ) : null}
        {error ? <div className="ak-error">{error}</div> : null}
        <div className="ak-new-sub">{t('review.librarySub', { n: shownItems ? shownItems.length : '…' })}</div>
        {shownItems && !shownItems.length ? (
          <div className="ak-worker-empty">
            {repoOnly ? t('review.repoEmpty') : t('review.libraryEmpty')}
          </div>
        ) : null}
        <div className="ak-new-grid">
          {(shownItems || []).map((it) => (
            <button
              key={it.path}
              type="button"
              className="ak-new-item"
              disabled={busy}
              onClick={() => create({ source: it.source === 'capture' ? 'capture' : 'library', path: it.path, title: it.name.replace(/^\d{8}-\d{4}-/, '').replace(/\.[a-z]+$/i, ''), target })}
            >
              <span className="ak-new-thumb">
                <img src={`/api/review/library/file?path=${encodeURIComponent(it.path)}`} alt="" loading="lazy" />
                <span className="ak-new-tag">{it.source}</span>
              </span>
              {/* 取得日時とリポジトリ名: 同じ画面のショットが並ぶので、これが無いと選べない */}
              <span className="ak-new-cap">
                <span className="ak-new-when">{capturedLabel(it.mtime)}</span>
                <span className="ak-new-repo" title={`${repoLabel(it.repo)} · ${it.path}`}>
                  {repoLabel(it.repo)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="ak-hint">{t('review.newAnnoHint')}</p>
      </div>
    </Sheet>
  )
}

export function ReviewPane({ notify, focusRequest = null, onConsumedFocus }) {
  const { t } = useI18n()
  const [state, setState] = useState({ loading: true, items: [], error: null })
  const [tab, setTab] = useState('waiting')
  const [open, setOpen] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [newTarget, setNewTarget] = useState('')
  const [data, setData] = useState(null)
  const [answer, setAnswer] = useState(null)
  const [dataError, setDataError] = useState(null)
  const [closeNote, setCloseNote] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)
  // 作業フィード（監視 cron が書く 1 行ログ）。完了・停止を端末で気づくために出す。
  const [feed, setFeed] = useState([])
  const feedNotifiedRef = useRef(0)

  const lastLoadOkRef = useRef(true)
  const load = useCallback(async () => {
    try {
      const r = await api('/api/review')
      const items = r.items || []
      lastLoadOkRef.current = true
      setState({ loading: false, items, error: null })
      // 下部ナビの丸バッジ（注釈 1377.jpg の赤）を、この一覧と同じデータで同期する
      try {
        window.dispatchEvent(new CustomEvent('hm:review-items', { detail: { items } }))
      } catch {
        /* noop */
      }
      return items
    } catch (e) {
      lastLoadOkRef.current = false
      setState({ loading: false, items: [], error: e?.message || t('review.loadFailed') })
      return []
    }
  }, [])

  const refreshReview = useCallback(async () => {
    await load()
    return lastLoadOkRef.current
  }, [load])

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 15000)
    return () => clearInterval(id)
  }, [load])

  const groups = useMemo(
    () => groupItems(state.items, showAllDone ? Number.MAX_SAFE_INTEGER : DONE_LIMIT),
    [state.items, showAllDone],
  )
  const counts = { waiting: groups.waiting.length, active: groups.active.length }

  const openItem = useCallback(async (item) => {
    setOpen(item)
    setData(null)
    setAnswer(null)
    setDataError(null)
    setCloseNote('')
    const ak = item.review || {}
    if (ak.mode && ak.mode !== 'standard') return
    // 進行中・完了も読むだけ開く（bridge の answer() はレビュー待ち以外を 409 で拒否する）。
    // 完了した項目は「レビュー回答（履歴）」を出すため sheet.json と answer.json を取る。
    try {
      const r = await api(`/api/review/${item.id}/data`)
      setData(r.data)
      setAnswer(r.answer ?? null)
    } catch (e) {
      // レビュー待ちなら理由を出す。読むだけの項目はシートが無いこともあるので黙る
      if (isWaiting(item)) setDataError(e?.message || t('review.sheetMissing'))
    }
  }, [])

  // チャットの完了報告行など外部からの誘導（「このレビュータスク／注釈作成を開く」）を処理する
  useEffect(() => {
    if (!focusRequest || state.loading) return
    if (focusRequest.openNewAnnotation) {
      setNewTarget(focusRequest.target || '')
      setShowNew(true)
      onConsumedFocus?.()
      return
    }
    const found = state.items.find(
      (x) =>
        (focusRequest.taskId && x.id === focusRequest.taskId) ||
        (focusRequest.label && x.review?.label === focusRequest.label),
    )
    if (found) {
      setTab(isWaiting(found) ? 'waiting' : found.status === 'done' ? 'done' : 'active')
      openItem(found)
    } else {
      setTab('done')
    }
    onConsumedFocus?.()
  }, [focusRequest, state.loading, state.items, openItem, onConsumedFocus])

  function closeSheet() {
    setOpen(null)
    setData(null)
    setAnswer(null)
    setDataError(null)
  }

  /**
   * 作業フィードを読み、開いている間は既読にする（ナビの緑の点を消す）。
   * 新しい「完了」があればトーストで 1 回だけ知らせる（同じ行で二度は出さない）。
   */
  const loadFeed = useCallback(async () => {
    try {
      const r = await api('/api/review/feed?limit=6')
      const items = Array.isArray(r.items) ? r.items : []
      setFeed(items)
      const at = Date.now()
      try {
        localStorage.setItem('hm.reviewSeenAt', String(at))
      } catch {
        /* noop */
      }
      try {
        window.dispatchEvent(new CustomEvent('hm:review-seen', { detail: { at } }))
      } catch {
        /* noop */
      }
      const done = items.filter((n) => n.kind === 'done' || /^✅/.test(String(n.text || '')))
      const latest = done[done.length - 1]
      if (latest && latest.at > feedNotifiedRef.current) {
        // 初回読み込みでは出さない（過去の完了を今の通知として見せない）
        if (feedNotifiedRef.current) {
          notify?.(t('review.feedNotice', { text: String(latest.text).replace(/^✅\s*/, '') }))
        }
        feedNotifiedRef.current = latest.at
      }
    } catch {
      /* フィードは補助情報 */
    }
  }, [notify])

  useEffect(() => {
    loadFeed()
    const id = setInterval(() => document.visibilityState === 'visible' && loadFeed(), 15000)
    return () => clearInterval(id)
  }, [loadFeed])

  /**
   * 送信後（レビュー回答 Q2-B）: 閉じずに次の判断待ちを開く。
   * 残りが無いときだけ閉じる。送れた実感はトーストで補う。
   */
  async function handleSubmitted(answeredId, result) {
    const items = await load()
    const head = result?.duplicate ? t('review.duplicate') : t('review.answerSent')
    const next = nextWaiting(items, answeredId)
    if (next) {
      await openItem(next)
      notify?.(t('review.nextOpened', { head }))
      return
    }
    setTab('waiting')
    closeSheet()
    notify?.(t('review.noneLeft', { head }))
  }

  const hasItems = state.items.length > 0
  // >=820px は 2 ペイン（詳細をシートではなく右ペインに出す。SPEC §7.2）
  const split = useSplitLayout()
  const isAnnoOpen = Boolean(open && open.review?.mode === 'annotation' && isWaiting(open))
  const openTitle = open ? (open.review?.title || open.title) + '' : ''

  // 選択中シートの中身（Sheet と右ペインで同一。2 ペインでも挙動を変えない）
  const sheetInner = open ? (
    <>
        {open.review?.mode !== 'annotation' ? <SheetLink item={open} /> : null}
        {isWaiting(open) ? (
          <>
            {dataError ? <div className="ak-error">{t('review.openSheetDirectly', { error: dataError })}</div> : null}
            {data?.questions?.length ? (
              <StandardForm item={open} data={data} onSubmitted={(r) => handleSubmitted(open.id, r)} />
            ) : (
              <IframeForm item={open} onSubmitted={(r) => handleSubmitted(open.id, r)} />
            )}
          </>
        ) : (
          <ReadOnlyDetail
            item={open}
            data={data}
            answer={answer}
            notify={notify}
            onStartAnnotation={(t) => {
              closeSheet()
              setNewTarget(t || '')
              setShowNew(true)
            }}
            onReopened={async () => {
              await load()
              closeSheet()
            }}
            onOpenChat={(chatId) => {
              closeSheet()
              window.dispatchEvent(new CustomEvent('hm:open-session', { detail: { id: chatId } }))
            }}
          />
        )}
        {isWaiting(open) ? (
          <div className="ak-form">
            <div className="row-sub">{t('review.closeReasonLabel')}</div>
            <textarea
              className="inp"
              rows={2}
              style={{ marginTop: 6 }}
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value.slice(0, 400))}
              placeholder={t('review.closeReasonPlaceholder')}
            />
            <CloseActions
              board={open.board || 'mobile'}
              taskId={open.id}
              note={closeNote}
              notify={notify}
              onClosed={() => {
                setCloseNote('')
                load()
                setTimeout(() => setOpen(null), 600)
              }}
            />
          </div>
        ) : null}
        <WorkerFeed taskId={open.id} open={['running', 'ready'].includes(open.status)} />
    </>
  ) : null

  return (
    <div className={split ? 'pane ak-page split-layout review' : 'pane ak-page'}>
      <div className={split ? 'split-master' : undefined}>
      <div className="ak-head">
        <div>
          <div className="ak-title">{t('review.title')}</div>
          <div className="ak-sub">
            {counts.waiting ? t('review.waitingSub', { n: counts.waiting }) : t('review.noneWaiting')}
          </div>
        </div>
        <span className="ak-head-actions">
          <button
            className="btn ak-new-btn"
            type="button"
            onClick={() => {
              haptic('tap')
              setNewTarget('')
              setShowNew(true)
            }}
          >
            {t('review.newAnnotation')}
          </button>
          <RefreshButton onRefresh={refreshReview} />
        </span>
      </div>

      {/* 作業フィード: 完了・停止を「開いた瞬間」に読めるようにする（Discord と同じ 1 行） */}
      {feed.length ? (
        <div className="ak-feed" aria-live="polite">
          {feed.slice(-3).map((n, i) => (
            <div className="ak-feed-row" key={`${n.at}-${i}`}>
              <span className="ak-feed-at">
                {fmtTime(n.at)}
              </span>
              <span className="ak-feed-text">{n.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="chips ak-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`chip${tab === item.id ? ' on' : ''}`}
            onClick={() => {
              if (tab !== item.id) haptic('tap')
              setTab(item.id)
            }}
          >
            {t(item.key)}
            {item.id !== 'done' && counts[item.id] ? ` ${counts[item.id]}` : null}
          </button>
        ))}
      </div>

      {state.error ? <div className="ak-error">{state.error}</div> : null}
      {state.loading ? <Loader label={t('common.loading')} /> : null}

      {!state.loading && !hasItems ? (
        <div className="empty">
          {t('review.emptyNoSheets')}
          <br />
          {t('review.emptyNoSheetsHint')}
        </div>
      ) : null}

      {!state.loading && hasItems && tab === 'waiting' ? (
        groups.waiting.length ? (
          <section className="ak-group">
            {groups.waiting.map((it) => (
              <ItemRow key={it.id} item={it} onOpen={openItem} />
            ))}
          </section>
        ) : (
          <div className="ak-empty-card">
            <div className="ak-empty-title">{t('review.noneWaiting')}</div>
            <p className="ak-empty-body">{t('review.emptyBody')}</p>
            <button className="ak-empty-btn" type="button" onClick={() => setShowNew(true)}>
              {t('review.emptyNewAnnotation')}
            </button>
            <p className="ak-empty-note">{t('review.emptyNote')}</p>
            <div className="ak-empty-meta">
              {t('review.emptyMeta', { active: counts.active, done: groups.doneTotal })}
            </div>
          </div>
        )
      ) : null}

      {!state.loading && hasItems && tab === 'active' ? (
        groups.active.length ? (
          <section className="ak-group">
            {groups.active.map((it) => (
              <ItemRow key={it.id} item={it} onOpen={openItem} />
            ))}
          </section>
        ) : (
          <div className="empty">{t('review.noActive')}</div>
        )
      ) : null}

      {!state.loading && hasItems && tab === 'done' ? (
        <>
          <div className="ak-group-title">
            {showAllDone ? t('review.allDone', { n: groups.doneTotal }) : doneHint(groups.doneTotal)}
          </div>
          {groups.done.length ? (
            <section className="ak-group">
              {groups.done.map((it) => (
                <ItemRow key={it.id} item={it} onOpen={openItem} />
              ))}
            </section>
          ) : null}
          {groups.doneTotal > groups.done.length ? (
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAllDone(true)}>
              {t('review.showAllDone', { n: groups.doneTotal - groups.done.length })}
            </button>
          ) : showAllDone && groups.doneTotal > DONE_LIMIT ? (
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAllDone(false)}>
              {t('review.showRecentOnly', { n: DONE_LIMIT })}
            </button>
          ) : null}
        </>
      ) : null}

      </div>

      {showNew ? (
        <NewAnnotationSheet
          notify={notify}
          initialTarget={newTarget}
          onClose={() => setShowNew(false)}
          onCreated={async (r) => {
            setShowNew(false)
            await load()
            setOpen({ id: r.taskId, title: r.label, status: 'blocked', review: { mode: 'annotation', label: r.label } })
          }}
        />
      ) : null}

      {/* 1 ペイン（< 820px）は従来どおり全画面被せ。2 ペインなら右ペインに常設する */}
      {!split && isAnnoOpen ? (
        <AnnotationEditor
          item={open}
          notify={notify}
          onClose={() => setOpen(null)}
          onSubmitted={(r) => handleSubmitted(open.id, r)}
        />
      ) : null}

      {!split && open && !isAnnoOpen ? (
        <Sheet title={openTitle} onClose={closeSheet}>
          {sheetInner}
        </Sheet>
      ) : null}

      {/* >=820px: 右ペインに選択中のシート／注釈エディタを常設（左の一覧から選ぶだけ） */}
      {split ? (
        <div className="split-detail">
          {open ? (
            isAnnoOpen ? (
              <AnnotationEditor
                item={open}
                notify={notify}
                onClose={() => setOpen(null)}
                onSubmitted={(r) => handleSubmitted(open.id, r)}
              />
            ) : (
              <>
                <div className="split-detail-head">
                  <span className="split-detail-title">{openTitle}</span>
                  <button className="icon-btn" onClick={closeSheet} aria-label={t('common.close')}>
                    <Icon name="close" size={18} />
                  </button>
                </div>
                <div className="split-detail-body">{sheetInner}</div>
              </>
            )
          ) : (
            <div className="split-placeholder">
              <b>{t('review.selectPlaceholder')}</b>
              <span>{t('review.selectHint')}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
