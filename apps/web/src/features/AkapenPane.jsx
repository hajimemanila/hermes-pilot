import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Sheet, relTime } from '../components/Ui.jsx'

/**
 * 赤ペン（akapen）ビュー。
 *
 * 契約: `~/Projects/akapen/CONTRACT.md`。カンバン board `mobile` の状態が真実で、
 * 標準モードは sheet.json から**ネイティブフォーム**を描き（=モバイルで一番速い）、
 * 指摘/添削モードはシート自体を iframe で開く（注釈UIは再現しない）。
 *
 * 送信は `POST /api/akapen/:id/answer` のみ。サーバが回答ファイルを書き、
 * カンバンを comment → unblock するので、この画面は状態を推測しない。
 */

const STATUS_LABEL = {
  review: '赤ペン待ち',
  ready: '反映待ち',
  running: '生成中',
  blocked: '停止',
  done: '完了',
}

function Chip({ tone, children }) {
  return <span className={`ak-chip ${tone || ''}`}>{children}</span>
}

function ItemRow({ item, onOpen }) {
  const ak = item.akapen || {}
  const waiting = item.status === 'review' || (item.status === 'blocked' && Boolean(ak.label))
  const age = item.completedAt || item.createdAt ? relTime(item.completedAt || item.createdAt) : ''
  return (
    <button className="ak-row" onClick={() => onOpen(item)} type="button">
      <div className="ak-row-main">
        <div className="ak-row-title">{ak.title || item.title}</div>
        <div className="ak-row-sub">
          <span className="ak-label">{ak.label || item.id}</span>
          {ak.round ? <span>r{ak.round}</span> : null}
          {ak.questions ? <span>{ak.questions}問</span> : null}
          {ak.mode && ak.mode !== 'standard' ? <span>{ak.mode}</span> : null}
          <span>{age}</span>
        </div>
      </div>
      <div className="ak-row-side">
        <Chip tone={waiting ? 'warn' : item.status === 'done' ? 'good' : ''}>
          {waiting ? '赤ペン待ち' : STATUS_LABEL[item.status] || item.status}
        </Chip>
      </div>
    </button>
  )
}

/** 【赤ペン回答】の貼り付けを最小限パースする（iframe モードのフォールバック）。 */
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
    const g = /^全体への赤ペン:\s*(.*)$/.exec(line)
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

function StandardForm({ item, data, onSubmitted, notify }) {
  const questions = data.questions || []
  const [answers, setAnswers] = useState(() => {
    const init = {}
    for (const q of questions) init[q.id] = { choice: null, note: '' }
    return init
  })
  const [global, setGlobal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

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
      }
      const r = await api(`/api/akapen/${item.id}/answer`, { method: 'POST', body: payload })
      if (r?.duplicate) notify?.('同じ回答が既に保存されています')
      else notify?.(`回答を送信しました（${r?.moved || ''}）`)
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
                  </span>
                  {o.detail ? <span className="ak-opt-detail">{o.detail}</span> : null}
                  {o.thumb ? <img className="ak-opt-thumb" src={`/api/akapen/${item.id}/thumb/${o.thumb}`} alt="" /> : null}
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
          <span className="ak-q-text">全体への赤ペン（任意）</span>
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
        <button className="btn primary" type="button" disabled={busy} onClick={submit}>
          {busy ? '送信中…' : '赤ペンを送る'}
        </button>
        <a className="btn" href={`/api/akapen/${item.id}/sheet`} target="_blank" rel="noreferrer">
          シート全体
        </a>
      </div>
      <p className="ak-hint">未選択は推奨案で確定します。送信するとカンバンが ready に戻り、agent が反映します。</p>
    </div>
  )
}

function IframeForm({ item, notify, onSubmitted }) {
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submitPasted() {
    if (!pasted.trim()) return
    setBusy(true)
    setError(null)
    try {
      const parsed = parsePastedReply(pasted)
      const r = await api(`/api/akapen/${item.id}/answer`, { method: 'POST', body: { ...parsed, by: 'mobile' } })
      notify?.(r?.duplicate ? '同じ回答が既に保存されています' : '回答を送信しました')
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
        title="赤ペンシート"
        src={`/api/akapen/${item.id}/sheet`}
        sandbox="allow-scripts allow-forms"
      />
      <details className="ak-paste">
        <summary>回答テキストを貼り付けて送る</summary>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="【赤ペン回答】… をそのまま貼り付け"
          rows={6}
        />
        {error ? <div className="ak-error">{error}</div> : null}
        <button className="btn primary" type="button" disabled={busy || !pasted.trim()} onClick={submitPasted}>
          {busy ? '送信中…' : '貼り付けた回答を送る'}
        </button>
      </details>
    </div>
  )
}

export function AkapenPane({ notify }) {
  const [state, setState] = useState({ loading: true, items: [], error: null })
  const [open, setOpen] = useState(null)
  const [data, setData] = useState(null)
  const [dataError, setDataError] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api('/api/akapen')
      setState({ loading: false, items: r.items || [], error: null })
    } catch (e) {
      setState({ loading: false, items: [], error: e?.message || '取得できません' })
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 15000)
    return () => clearInterval(id)
  }, [load])

  const groups = useMemo(() => {
    const isWaiting = (i) => i.status === 'review' || (i.status === 'blocked' && Boolean(i.akapen?.label))
    const review = state.items.filter(isWaiting)
    const active = state.items.filter(
      (i) => (i.status === 'ready' || i.status === 'running' || i.status === 'blocked') && !isWaiting(i),
    )
    const done = state.items.filter((i) => i.status === 'done').slice(0, 8)
    return { review, active, done }
  }, [state.items])

  async function openItem(item) {
    setOpen(item)
    setData(null)
    setDataError(null)
    const ak = item.akapen || {}
    if (ak.mode && ak.mode !== 'standard') return
    try {
      const r = await api(`/api/akapen/${item.id}/data`)
      setData(r.data)
    } catch (e) {
      setDataError(e?.message || 'sheet.json がありません')
    }
  }

  return (
    <div className="pane ak-page">
      <div className="ak-head">
        <div>
          <div className="ak-title">赤ペン</div>
          <div className="ak-sub">
            {groups.review.length ? `${groups.review.length} 件の判断待ち` : '判断待ちはありません'}
          </div>
        </div>
        <button className="btn" type="button" onClick={load}>
          更新
        </button>
      </div>

      {state.error ? <div className="ak-error">{state.error}</div> : null}
      {state.loading ? <div className="empty">読み込み中…</div> : null}

      {!state.loading && !state.items.length ? (
        <div className="empty">
          まだシートがありません。
          <br />
          カンバン board <b>mobile</b> にタスクを作ると、agent がシートを生成します。
        </div>
      ) : null}

      {groups.review.length ? (
        <section className="ak-group">
          <div className="ak-group-title">判断待ち</div>
          {groups.review.map((it) => (
            <ItemRow key={it.id} item={it} onOpen={openItem} />
          ))}
        </section>
      ) : null}

      {groups.active.length ? (
        <section className="ak-group">
          <div className="ak-group-title">進行中</div>
          {groups.active.map((it) => (
            <ItemRow key={it.id} item={it} onOpen={openItem} />
          ))}
        </section>
      ) : null}

      {groups.done.length ? (
        <details className="ak-group">
          <summary className="ak-group-title">完了 ({groups.done.length})</summary>
          {groups.done.map((it) => (
            <ItemRow key={it.id} item={it} onOpen={openItem} />
          ))}
        </details>
      ) : null}

      {open ? (
        <Sheet
          title={(open.akapen?.title || open.title) + ''}
          onClose={() => {
            setOpen(null)
            setData(null)
          }}
        >
          {dataError ? <div className="ak-error">{dataError} — シートを直接開いてください</div> : null}
          {data?.questions?.length ? (
            <StandardForm
              item={open}
              data={data}
              notify={notify}
              onSubmitted={() => {
                load()
                setTimeout(() => {
                  setOpen(null)
                  setData(null)
                }, 600)
              }}
            />
          ) : (
            <IframeForm
              item={open}
              notify={notify}
              onSubmitted={() => {
                load()
                setTimeout(() => {
                  setOpen(null)
                  setData(null)
                }, 600)
              }}
            />
          )}
        </Sheet>
      ) : null}
    </div>
  )
}
