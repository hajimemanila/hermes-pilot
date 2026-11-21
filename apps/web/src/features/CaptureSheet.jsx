import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Sheet, Spinner } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { useI18n } from '../i18n/index.js'
import { localizeError } from '../i18n/lang.js'

/**
 * クイック起票。1行でカンバンにタスクを作る。
 *
 * 音声は **OS キーボードの標準音声入力**を使う（自前の Web Speech API マイクは
 * 非 Secure Context・`continuous` 非互換で失敗するため削除。SPEC V7 §1.3 / D33）。
 * 二重送信は idempotencyKey（このシートを開いたときの乱数）でサーバ側が吸収する。
 */
export function CaptureSheet({ board, boards, defaultBoard, onClose, onCreated, notify }) {
  const { t } = useI18n()
  const [targetBoard, setTargetBoard] = useState(board ?? defaultBoard ?? null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [more, setMore] = useState(false)
  const [priority, setPriority] = useState(0)
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false)
  // 起票先ボードの一覧は縦リスト（Q1=B / Q2=A）。19 ボードあっても入力欄を押し出さないよう、
  // 既定は「いま選んでいるボード」1 行だけにし、タップで下に開く。
  const [pickOpen, setPickOpen] = useState(false)
  const keyRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  const titleRef = useRef(null)

  // 開いたらすぐ打てる（音声はキーボードのマイクを 1 タップ）。
  useEffect(() => {
    const focusTimer = setTimeout(() => titleRef.current?.focus(), 150)
    return () => clearTimeout(focusTimer)
  }, [])

  const submit = async () => {
    const clean = title.trim()
    if (!clean) {
      notify?.(t('capture.needTitle'))
      return
    }
    if (!targetBoard) {
      notify?.(t('capture.needBoard'))
      return
    }
    setBusy(true)
    try {
      const r = await api(`/api/boards/${encodeURIComponent(targetBoard)}/tasks`, {
        method: 'POST',
        body: {
          title: clean,
          body: body.trim(),
          priority,
          assignee: assignee.trim() || null,
          idempotencyKey: keyRef.current,
        },
      })
      if (!r?.ok) {
        // 文言はコード＋辞書で自言語化する（SPEC-i18n-resp B2）。空文字なら既定文へ落とす。
        notify?.(localizeError(r) || t('capture.failed'))
        return
      }
      notify?.(r.created ? t('capture.created', { id: r.task.id }) : t('capture.already', { id: r.task.id }))
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
    <Sheet title={t('capture.title')} onClose={onClose}>
      {/* 起票先ボードは増えうる一覧なので縦リスト（Q1=B / Q2=A）。
          既定は選択中の 1 行だけ表示し、タップで同じシート内に全件を縦に開く。 */}
      <button
        className="pick-item board-now"
        onClick={() => {
          haptic('tap')
          setPickOpen((v) => !v)
        }}
        aria-expanded={pickOpen}
        aria-label={t('capture.boardAria')}
      >
        <span aria-hidden="true">{(boards ?? []).find((b) => b.slug === targetBoard)?.icon ?? '🗂'}</span>
        <span className="pick-main">
          <span className="pick-title">
            {(boards ?? []).find((b) => b.slug === targetBoard)?.name ?? t('capture.board')}
          </span>
          <span className="pick-sub">{t('capture.boardPick')}</span>
        </span>
        <span className="pick-meta">{pickOpen ? '▴' : '▾'}</span>
      </button>

      {pickOpen ? (
        <div className="pick-list" style={{ marginBottom: 8 }}>
          {(boards ?? []).map((b) => (
            <button
              key={b.slug}
              className={`pick-item${targetBoard === b.slug ? ' on' : ''}`}
              onClick={() => {
                setTargetBoard(b.slug)
                setPickOpen(false)
              }}
            >
              <span aria-hidden="true">{b.icon}</span>
              <span className="pick-main">
                <span className="pick-title">{b.name}</span>
              </span>
              <span className="pick-meta">{targetBoard === b.slug ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}

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
          placeholder={t('capture.placeholder')}
          enterKeyHint="done"
          autoCapitalize="sentences"
        />
      </div>

      {/* 音声は OS キーボードのマイクに一本化（自前の Web Speech API は削除した） */}
      <p className="capture-hint">{t('capture.voiceHint')}</p>

      <button className="link" style={{ marginTop: 6 }} onClick={() => setMore((v) => !v)}>
        {more ? t('capture.moreClose') : t('capture.moreOpen')}
      </button>

      {more ? (
        <div style={{ marginTop: 6 }}>
          <textarea
            className="inp"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 4000))}
            placeholder={t('capture.bodyPlaceholder')}
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {[
              { v: 0, key: 'capture.priorityNone' },
              { v: 1, key: 'capture.priorityLow' },
              { v: 5, key: 'capture.priorityMid' },
              { v: 8, key: 'capture.priorityHigh' },
            ].map((p) => (
              <button
                key={p.v}
                className={`chip${priority === p.v ? ' on' : ''}`}
                onClick={() => setPriority(p.v)}
              >
                {t(p.key)}
              </button>
            ))}
          </div>
          <input
            className="inp"
            style={{ marginTop: 10 }}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value.slice(0, 64))}
            placeholder={t('capture.assigneePlaceholder')}
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
        <span>{busy ? t('capture.submitting') : t('capture.submit')}</span>
      </button>

      <div className="row-sub" style={{ padding: '12px 2px 18px', lineHeight: 1.7 }}>
        {t('capture.note')}
      </div>
    </Sheet>
  )
}
