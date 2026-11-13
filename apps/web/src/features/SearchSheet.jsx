import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'

/**
 * 全セッション横断検索。
 * ブリッジの `/api/search`（state.db の FTS5 trigram）を叩き、抜粋だけを出す。
 * 行をタップすると、そのセッションをチャットタブで開く。
 */
export function SearchSheet({ onClose, onOpenSession, notify }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 120)
    return () => clearTimeout(t)
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
    const t = setTimeout(() => run(q), 280)
    return () => clearTimeout(t)
  }, [q, run])

  const hits = res?.hits ?? []

  return (
    <Sheet title="検索（全セッション）" onClose={onClose}>
      <input
        ref={inputRef}
        className="inp"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="例: ドレイン / PWA / カンバン"
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
            <span>検索中…</span>
          </>
        ) : res?.ok ? (
          `${hits.length} 件 ・ ${Math.round(res.tookMs)}ms`
        ) : (
          res?.reason ?? '2文字以上で絞り込まれます'
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
                {h.snippet || '(空)'}
              </span>
              <span className="row-sub">
                {h.role === 'user' ? 'あなた' : h.role === 'assistant' ? 'Hermes' : h.role}
                {` ・ ${relTime(h.at)}`}
                {h.sessionTitle ? ` ・ ${String(h.sessionTitle).slice(0, 28)}` : ''}
                {h.profile && h.profile !== 'default' ? ` ・ ${h.profile}` : ''}
                {h.source ? ` ・ ${h.source}` : ''}
              </span>
            </span>
          </button>
        ))}
        {!busy && res?.ok && !hits.length ? <div className="empty">該当なし</div> : null}
      </div>

      <div className="row-sub" style={{ padding: '12px 4px 18px', lineHeight: 1.7 }}>
        Discord・CLI・カンバンすべての発言が対象（~/.hermes/state.db を読み取り専用で参照）。
        行をタップするとその会話を開きます。
      </div>
    </Sheet>
  )
}
