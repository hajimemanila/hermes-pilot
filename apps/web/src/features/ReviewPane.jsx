import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import { CloseActions } from '../components/CloseActions.jsx'
import { Loader, RefreshButton, Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { readActiveChatId } from '../lib/chatReports.js'
import { AnnotationEditor } from './AnnotationEditor.jsx'
import { answerRows, capturedLabel, DONE_LIMIT, doneHint, groupItems, isWaiting, nextWaiting, repoLabel, thumbCaption } from '../lib/reviewView.js'

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

const STATUS_LABEL = {
  review: 'レビュー中',
  ready: '反映待ち',
  running: '生成中',
  blocked: '停止',
  done: '完了',
}

const TABS = [
  { id: 'waiting', label: '判断待ち' },
  { id: 'active', label: '進行中' },
  { id: 'done', label: '完了' },
]

/** 進行状況の1行（「動いているのか」を数字で示す）。 */
function progressText(item) {
  const pr = item.progress || {}
  const now = Date.now()
  const ago = (ts) => {
    if (!ts) return null
    const s = Math.max(0, Math.round((now - ts) / 1000))
    if (s < 90) return `${s}秒前`
    if (s < 3600) return `${Math.round(s / 60)}分前`
    return `${Math.round(s / 3600)}時間前`
  }
  if (item.status === 'running') {
    const beat = ago(pr.heartbeatAt)
    const since = ago(pr.startedAt)
    return `反映中${since ? `（開始 ${since}）` : ''}${beat ? ` ・ 心拍 ${beat}` : ''}`
  }
  if (item.status === 'ready') return '反映待ち（worker の起動待ち）'
  if (item.status === 'blocked' && item.review?.label) {
    const at = ago(pr.lastEventAt)
    return `レビュー待ち${at ? ` ・ 提示 ${at}` : ''}`
  }
  if (item.status === 'done') return `完了${pr.lastEventAt ? ` ・ ${ago(pr.lastEventAt)}` : ''}`
  return ''
}

function Chip({ tone, children }) {
  return <span className={`ak-chip ${tone || ''}`}>{children}</span>
}

function ItemRow({ item, onOpen }) {
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
          {ak.questions ? <span>{ak.questions}問</span> : null}
          {ak.mode && ak.mode !== 'standard' ? <span>{ak.mode}</span> : null}
          <span>{age}</span>
        </div>
        {progressText(item) ? <div className="ak-row-phase">{progressText(item)}</div> : null}
      </div>
      <div className="ak-row-side">
        <Chip tone={waiting ? 'warn' : item.status === 'done' ? 'good' : ''}>
          {waiting ? 'レビュー待ち' : STATUS_LABEL[item.status] || item.status}
        </Chip>
      </div>
    </button>
  )
}

/** 【レビュー回答】の貼り付けを最小限パースする（iframe モードのフォールバック）。 */
export function parsePastedReply(text) {
  const out = { answers: [], global: '' }
  const lines = String(text || '').split('\n')
  let inGlobal = false
  for (const line of lines) {
    const q = /^Q(\d+)\.\s*(.*?):\s*(.*)$/.exec(line)
    if (q) {
      const rest = q[3]
      const m = /^(.*?)(?:\s*\/\s*補足:\s*(.*))?$/.exec(rest)
      const choice = (m?.[1] || '').trim()
      out.answers.push({
        id: `q${q[1]}`,
        choice: choice.startsWith('(未選択') ? null : choice,
        note: (m?.[2] || '').trim(),
      })
      inGlobal = false
      continue
    }
    const g = /^全体へのレビュー:\s*(.*)$/.exec(line)
    if (g) {
      out.global = g[1] || ''
      inGlobal = true
      continue
    }
    if (line.trim() === '---') break
    if (inGlobal) out.global += `\n${line}`
  }
  out.global = out.global.trim()
  return out
}


/** worker（profile mobile）の進行。反映中でも「何をしているか」が見えるようにする。 */
function WorkerFeed({ taskId, open }) {
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
        if (alive) setError(e?.message || '取得できません')
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
        worker の進行
        {feed?.status ? `（${feed.status === 'running' ? '実行中' : feed.status}）` : ''}
        {msgs.length ? ` ・ ${msgs.length} ステップ` : ''}
      </summary>
      {error ? <div className="ak-error">{error}</div> : null}
      {!error && !msgs.length ? <div className="ak-worker-empty">まだ出力がありません</div> : null}
      <div className="ak-worker-log" ref={boxRef}>
        {msgs.map((m) => {
          const time = new Date(m.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
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
      setError(e?.message || '送信できませんでした')
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
                    {o.recommended ? <Chip tone="rec">推奨</Chip> : null}
                    <span className="ak-opt-check" aria-hidden="true">✓</span>
                  </span>
                  {o.detail ? <span className="ak-opt-detail">{o.detail}</span> : null}
                  {o.thumb ? (
                    <span
                      className="ak-thumb-btn"
                      role="button"
                      tabIndex={0}
                      aria-label={`${thumbCaption(`Q${i + 1}`, o).head} の挿絵を拡大`}
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
            placeholder="補足（任意）"
          />
        </section>
      ))}
      <section className="ak-q">
        <div className="ak-q-head">
          <span className="ak-q-no">全</span>
          <span className="ak-q-text">全体へのレビュー（任意）</span>
        </div>
        <textarea
          className="ak-global"
          value={global}
          onChange={(e) => setGlobal(e.target.value)}
          placeholder="方針・優先度・気になる点を自由に"
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
          <span>{busy ? '送信中…' : 'レビューを送る'}</span>
        </button>
      </div>
      <p className="ak-hint">未選択は推奨案で確定します。送信するとカンバンが ready に戻り、agent が反映します。</p>
      {zoom
        ? createPortal(
            <div
              className="ak-zoom"
              role="dialog"
              aria-modal="true"
              aria-label={`${zoom.head} の挿絵`}
              onClick={() => setZoom(null)}
            >
              <figure onClick={(e) => e.stopPropagation()}>
                <img src={zoom.src} alt={`${zoom.head} の挿絵`} />
                <figcaption>
                  <b>{zoom.head}</b>
                  {zoom.sub ? <span>{zoom.sub}</span> : null}
                </figcaption>
              </figure>
              <button className="ak-zoom-close" type="button" onClick={() => setZoom(null)}>
                閉じる
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function IframeForm({ item, onSubmitted, notify }) {
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
        notify?.(r?.duplicate ? '同じ回答が既に保存されています' : 'シートから回答を受け取りました')
        onSubmitted?.(r)
      } catch (e) {
        setError(e?.message || '送信できませんでした')
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
      setError(e?.message || '送信できませんでした')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ak-form">
      <iframe
        className="ak-iframe"
        title="レビューシート"
        src={`/api/review/${item.id}/sheet`}
        sandbox="allow-scripts allow-forms"
      />
      <details className="ak-paste">
        <summary>回答テキストを貼り付けて送る</summary>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="【レビュー回答】… をそのまま貼り付け"
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
          <span>{busy ? '送信中…' : '貼り付けた回答を送る'}</span>
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
  return (
    <div className="ak-sheetlink">
      <a className="ak-link" href={`/api/review/${item.id}/sheet`} target="_blank" rel="noreferrer">
        シート全体を開く ↗
      </a>
    </div>
  )
}

/** レビュー待ち以外（進行中・完了）の読み取り専用ビュー。回答フォームは出さない。 */
function ReadOnlyDetail({ item, data, answer, notify, onStartAnnotation, onReopened, onOpenChat }) {
  const ak = item.review || {}
  const label = STATUS_LABEL[item.status] || item.status
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
        body: { reason: reopenReason.trim() || 'PWA から再確認を依頼' },
      })
      if (!r?.ok) throw new Error('再確認依頼に失敗しました')
      notify?.('再確認（review）へ戻しました')
      onReopened?.()
    } catch (e) {
      notify?.(e?.message || '再確認依頼に失敗しました')
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
        {ak.questions ? <span>{ak.questions}問</span> : null}
        {answered ? <span>回答 {answered}</span> : null}
        {item.completedAt ? <span>完了 {relTime(item.completedAt)}</span> : null}
      </div>
      <p className="ak-hint">
        レビューを送れるのは「レビュー待ち」のシートだけです（このシートは{label}）。
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
            <img src={imgSrc} alt={`${ak.title || item.title} の画像`} />
          </button>
          {anno ? (
            <div className="ak-anno-preview-meta">
              <span>注釈 {Array.isArray(anno.marks) ? anno.marks.length : 0} ストローク</span>
              {anno.note ? <span> ・ メモ: {anno.note}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {hasHistory ? (
        <details className="ak-answers">
          <summary>レビュー回答（履歴）</summary>
          <ol className="ak-answer-list">
            {history.rows.map((r, i) => (
              <li key={r.id || i}>
                <div className="ak-answer-q">{r.question || r.id}</div>
                <div className="ak-answer-a">
                  {r.choice ? `${r.choice}. ${r.label}` : 'お任せ（既定の案で反映）'}
                </div>
                {r.note ? <div className="ak-answer-note">{r.note}</div> : null}
              </li>
            ))}
          </ol>
          {history.global ? <div className="ak-answer-global">全体メモ: {history.global}</div> : null}
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
          🖊 スクショに赤入れして追加指示
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
            💬 起票元のチャットを開く
          </button>
        ) : null}
      </div>

      {item.status === 'done' ? (
        <details className="ak-reopen">
          <summary>↩ 反映が不十分なとき（再確認を依頼）</summary>
          <textarea
            className="inp"
            rows={2}
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value.slice(0, 400))}
            placeholder="再確認したい理由・修正点（任意）"
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
            <span>{reopenBusy ? '送信中…' : 'review へ差し戻す'}</span>
          </button>
        </details>
      ) : null}

      {zoomImg && imgSrc
        ? createPortal(
            <div
              className="ak-zoom"
              role="dialog"
              aria-modal="true"
              aria-label="注釈画像の拡大"
              onClick={() => setZoomImg(false)}
            >
              <figure onClick={(e) => e.stopPropagation()}>
                <img src={imgSrc} alt={`${ak.title || item.title} の拡大画像`} />
                <figcaption>
                  <b>{ak.title || item.title}</b>
                  {anno?.note ? <span>{anno.note}</span> : null}
                </figcaption>
              </figure>
              <button className="ak-zoom-close" type="button" onClick={() => setZoomImg(false)}>
                閉じる
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
      reject(new Error('画像を読み込めませんでした'))
    }
    img.src = url
  })
}

/** 「＋ 注釈」: 端末の画像 / library・直近スクショ から注釈タスクを作る。 */
function NewAnnotationSheet({ onCreated, onClose, notify, initialTarget = '' }) {
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
        setError(e?.message || '一覧を取得できません')
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
      if (!r?.ok) throw new Error(r?.message || '作成できませんでした')
      notify?.(`注釈タスクを作りました（${r.image}）`)
      onCreated?.(r)
    } catch (e) {
      setError(e?.message || '作成できませんでした')
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
      setError(e?.message || '取り込めませんでした')
      setBusy(false)
    }
  }

  const selectedTarget = targets.find((tg) => tg.path === target) || null
  const shownItems =
    repoOnly && selectedTarget && items
      ? items.filter((it) => it.repo?.id === selectedTarget.id)
      : items

  return (
    <Sheet title="注釈の下地を選ぶ" onClose={onClose}>
      <div className="ak-new">
        <button className="btn primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          端末の画像（ギャラリー / カメラ）
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        <label className="ak-new-target-row">
          <span>対象</span>
          <select className="ak-new-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((tg) => (
              <option key={tg.path} value={tg.path}>
                {tg.label}（{tg.id}）
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
              {selectedTarget.id} のみ
            </button>
            <button
              type="button"
              className={`chip${!repoOnly ? ' on' : ''}`}
              onClick={() => {
                haptic('tap')
                setRepoOnly(false)
              }}
            >
              すべて
            </button>
          </div>
        ) : null}
        {error ? <div className="ak-error">{error}</div> : null}
        <div className="ak-new-sub">library と直近のスクショ（{shownItems ? shownItems.length : '…'} 件）</div>
        {shownItems && !shownItems.length ? (
          <div className="ak-worker-empty">
            {repoOnly ? 'このリポジトリの画像はまだありません（「すべて」から選べます）' : 'まだ画像がありません'}
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
        <p className="ak-hint">
          端末の画像は長辺1600px / JPEG 0.85 に縮小して送ります。チャットに貼った画像は
          agent が <code>library/chat/</code> へ取り込んだものがここに出ます。
        </p>
      </div>
    </Sheet>
  )
}

export function ReviewPane({ notify, focusRequest = null, onConsumedFocus }) {
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
      setState({ loading: false, items: [], error: e?.message || '取得できません' })
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
      if (isWaiting(item)) setDataError(e?.message || 'sheet.json がありません')
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
      const done = items.filter((n) => /完了/.test(n.text || ''))
      const latest = done[done.length - 1]
      if (latest && latest.at > feedNotifiedRef.current) {
        // 初回読み込みでは出さない（過去の完了を今の通知として見せない）
        if (feedNotifiedRef.current) notify?.(`レビュー: ${String(latest.text).replace(/^✅\s*/, '')}`)
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
    const head = result?.duplicate ? '同じ回答が既に保存されています' : '回答を送信しました'
    const next = nextWaiting(items, answeredId)
    if (next) {
      await openItem(next)
      notify?.(`${head} — 次の判断待ちを開きました`)
      return
    }
    setTab('waiting')
    closeSheet()
    notify?.(`${head} — 判断待ちは残っていません`)
  }

  const hasItems = state.items.length > 0

  return (
    <div className="pane ak-page">
      <div className="ak-head">
        <div>
          <div className="ak-title">レビュー</div>
          <div className="ak-sub">
            {counts.waiting ? `${counts.waiting} 件の判断待ち` : '判断待ちはありません'}
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
            ＋ 注釈
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
                {new Date(n.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="ak-feed-text">{n.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="chips ak-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`chip${tab === t.id ? ' on' : ''}`}
            onClick={() => {
              if (tab !== t.id) haptic('tap')
              setTab(t.id)
            }}
          >
            {t.label}
            {t.id !== 'done' && counts[t.id] ? ` ${counts[t.id]}` : null}
          </button>
        ))}
      </div>

      {state.error ? <div className="ak-error">{state.error}</div> : null}
      {state.loading ? <Loader label="読み込み中…" /> : null}

      {!state.loading && !hasItems ? (
        <div className="empty">
          まだシートがありません。
          <br />
          カンバン board <b>mobile</b> にタスクを作ると、agent がシートを生成します。
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
            <div className="ak-empty-title">判断待ちはありません</div>
            <p className="ak-empty-body">次の仕様はチャットから投げてください。</p>
            <button className="ak-empty-btn" type="button" onClick={() => setShowNew(true)}>
              ＋ 注釈を作る
            </button>
            <p className="ak-empty-note">ライブラリの画像に赤を入れて送ることもできます</p>
            <div className="ak-empty-meta">
              進行中 {counts.active} 件 ・ 完了 {groups.doneTotal} 件
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
          <div className="empty">進行中はありません。</div>
        )
      ) : null}

      {!state.loading && hasItems && tab === 'done' ? (
        <>
          <div className="ak-group-title">
            {showAllDone ? `全 ${groups.doneTotal} 件` : doneHint(groups.doneTotal)}
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
              すべて表示（残り {groups.doneTotal - groups.done.length} 件）
            </button>
          ) : showAllDone && groups.doneTotal > DONE_LIMIT ? (
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAllDone(false)}>
              直近 {DONE_LIMIT} 件のみ表示
            </button>
          ) : null}
        </>
      ) : null}

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

      {open && open.review?.mode === 'annotation' && isWaiting(open) ? (
        <AnnotationEditor
          item={open}
          notify={notify}
          onClose={() => setOpen(null)}
          onSubmitted={(r) => handleSubmitted(open.id, r)}
        />
      ) : null}

      {open && !(open.review?.mode === 'annotation' && isWaiting(open)) ? (
        <Sheet title={(open.review?.title || open.title) + ''} onClose={closeSheet}>
          {open.review?.mode !== 'annotation' ? <SheetLink item={open} /> : null}
          {isWaiting(open) ? (
            <>
              {dataError ? <div className="ak-error">{dataError} — シートを直接開いてください</div> : null}
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
              <div className="row-sub">片付ける理由（任意・記録に残ります）</div>
              <textarea
                className="inp"
                rows={2}
                style={{ marginTop: 6 }}
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value.slice(0, 400))}
                placeholder="例: 不要になった / 別の Issue で扱う"
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
        </Sheet>
      ) : null}
    </div>
  )
}
