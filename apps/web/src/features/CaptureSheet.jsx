import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Sheet, Spinner } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'

/**
 * クイック起票。1行（または音声）でカンバンにタスクを作る。
 *
 * 音声は Android Chrome の webkitSpeechRecognition。使えなければボタンを出さない。
 * 二重送信は idempotencyKey（このシートを開いたときの乱数）でサーバ側が吸収する。
 */
export function CaptureSheet({ board, boards, defaultBoard, onClose, onCreated, notify }) {
  const [targetBoard, setTargetBoard] = useState(board ?? defaultBoard ?? null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [more, setMore] = useState(false)
  const [priority, setPriority] = useState(0)
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const keyRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  const recRef = useRef(null)
  const titleRef = useRef(null)
  const baseRef = useRef('')

  const speechSupported =
    typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    const t = setTimeout(() => titleRef.current?.focus(), 150)
    return () => {
      clearTimeout(t)
      try {
        recRef.current?.abort?.()
      } catch {
        /* noop */
      }
    }
  }, [])

  const toggleMic = useCallback(() => {
    if (listening) {
      try {
        recRef.current?.stop?.()
      } catch {
        /* noop */
      }
      setListening(false)
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      notify?.('この端末は音声入力に対応していません')
      return
    }
    try {
      const rec = new SR()
      rec.lang = 'ja-JP'
      rec.interimResults = true
      rec.continuous = false
      baseRef.current = title.trim() ? `${title.trim()} ` : ''
      rec.onresult = (e) => {
        let text = ''
        for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript
        setTitle(`${baseRef.current}${text}`.slice(0, 200))
      }
      rec.onerror = (e) => {
        setListening(false)
        if (e?.error !== 'aborted' && e?.error !== 'no-speech') notify?.(`音声入力を止めました（${e?.error ?? 'error'}）`)
      }
      rec.onend = () => setListening(false)
      recRef.current = rec
      rec.start()
      setListening(true)
    } catch (e) {
      setListening(false)
      notify?.(e.message)
    }
  }, [listening, title, notify])

  const submit = async () => {
    const t = title.trim()
    if (!t) {
      notify?.('タイトルを入れてください')
      return
    }
    if (!targetBoard) {
      notify?.('ボードを選んでください')
      return
    }
    setBusy(true)
    try {
      const r = await api(`/api/boards/${encodeURIComponent(targetBoard)}/tasks`, {
        method: 'POST',
        body: {
          title: t,
          body: body.trim(),
          priority,
          assignee: assignee.trim() || null,
          idempotencyKey: keyRef.current,
        },
      })
      if (!r?.ok) {
        notify?.(r?.error ?? '起票できませんでした')
        return
      }
      notify?.(r.created ? `起票しました: ${r.task.id}` : `起票済みです: ${r.task.id}`)
      haptic('action')
      onCreated?.(r.task)
      onClose?.()
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title="起票" onClose={onClose}>
      <div className="chips" style={{ marginBottom: 8 }}>
        {(boards ?? []).map((b) => (
          <button
            key={b.slug}
            className={`chip${targetBoard === b.slug ? ' on' : ''}`}
            onClick={() => setTargetBoard(b.slug)}
          >
            <span>{b.icon}</span>
            {b.name}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input
          ref={titleRef}
          className="inp"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 200))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="何をやる？（1行）"
          enterKeyHint="done"
          autoCapitalize="sentences"
        />
        {speechSupported ? (
          <button
            className={`mic${listening ? ' on' : ''}`}
            onClick={toggleMic}
            aria-label={listening ? '音声入力を停止' : '音声で入力'}
            title={listening ? '停止' : '音声で入力'}
          >
            <span aria-hidden="true">{listening ? '■' : '🎤'}</span>
          </button>
        ) : null}
      </div>

      <button className="link" style={{ marginTop: 6 }} onClick={() => setMore((v) => !v)}>
        {more ? '詳細を閉じる' : '詳細（本文・優先度・担当）'}
      </button>

      {more ? (
        <div style={{ marginTop: 6 }}>
          <textarea
            className="inp"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 4000))}
            placeholder="本文（任意）"
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {[
              { v: 0, label: '優先度 なし' },
              { v: 1, label: '低' },
              { v: 5, label: '中' },
              { v: 8, label: '高' },
            ].map((p) => (
              <button
                key={p.v}
                className={`chip${priority === p.v ? ' on' : ''}`}
                onClick={() => setPriority(p.v)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            className="inp"
            style={{ marginTop: 10 }}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value.slice(0, 64))}
            placeholder="担当（任意・profile 名）"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      <button
        className="btn hm-btn-inner"
        onClick={submit}
        disabled={busy || !title.trim()}
        aria-busy={busy}
        style={{ marginTop: 14 }}
      >
        {busy ? <Spinner size={14} /> : null}
        <span>{busy ? '起票中…' : '起票する'}</span>
      </button>

      <div className="row-sub" style={{ padding: '12px 2px 18px', lineHeight: 1.7 }}>
        `hermes kanban create` を実行します（DB 直接書き込みはしません）。
        同じ内容の連打は10分間まとめて1件になります。音声は端末の認識機能を使います。
      </div>
    </Sheet>
  )
}
