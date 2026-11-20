import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { useI18n } from '../i18n/index.js'
import { sep } from '../lib/format.js'

/**
 * 全セッション横断検索。
 * ブリッジの `/api/search`（state.db の FTS5 trigram）を叩き、抜粋だけを出す。
 * 行をタップすると、そのセッションをチャットタブで開く。
 */
export function SearchSheet({ onClose, onOpenSession, notify }) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 120)
    return () => clearTimeout(focusTimer)
  }, [])

  const run = useCallback(
    async (text) => {
      const query = text.trim()
      if (!query) {
        setRes(null)
        return
      }
      const seq = ++seqRef.current
      setBusy(true)
      try {
        const d = await api(`/api/search?q=${encodeURIComponent(query)}&limit=30`)
        if (seq === seqRef.current) setRes(d)
      } catch (e) {
        if (seq === seqRef.current) {
          setRes({ ok: false, reason: e.message, hits: [] })
          notify?.(e.message)
        }
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    },
    [notify],
  )

  // 入力のたびに 280ms 待ってから投げる
  useEffect(() => {
    const debounceTimer = setTimeout(() => run(q), 280)
    return () => clearTimeout(debounceTimer)
  }, [q, run])

  const hits = res?.hits ?? []

  return (
    <Sheet title={t('search.title')} onClose={onClose}>
      <input
        ref={inputRef}
        className="inp"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('search.placeholder')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="search"
        enterKeyHint="search"
      />

      <div className="row-sub" style={{ padding: '8px 4px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
        {busy ? (
          <>
            <Spinner size={12} />
            <span>{t('search.searching')}</span>
          </>
        ) : res?.ok ? (
          t('search.resultCount', { count: hits.length, ms: Math.round(res.tookMs) })
        ) : (
          (res?.reason ?? t('search.hint'))
        )}
      </div>

      <div className="list">
        {hits.map((h) => (
          <button
            key={`${h.profile ?? 'default'}:${h.messageId}`}
            className="list-item"
            onClick={() => {
              haptic('tap')
              onOpenSession?.(h)
              onClose?.()
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="row-title" style={{ fontSize: 12.5 }}>
                {h.snippet || t('search.emptySnippet')}
              </span>
              <span className="row-sub">
                {h.role === 'user' ? t('search.you') : h.role === 'assistant' ? 'Hermes' : h.role}
                {` ${sep()} ${relTime(h.at)}`}
                {h.sessionTitle ? ` ${sep()} ${String(h.sessionTitle).slice(0, 28)}` : ''}
                {h.profile && h.profile !== 'default' ? ` ${sep()} ${h.profile}` : ''}
                {h.source ? ` ${sep()} ${h.source}` : ''}
              </span>
            </span>
          </button>
        ))}
        {!busy && res?.ok && !hits.length ? <div className="empty">{t('search.none')}</div> : null}
      </div>

      <div className="row-sub" style={{ padding: '12px 4px 18px', lineHeight: 1.7 }}>
        {t('search.note')}
      </div>
    </Sheet>
  )
}
