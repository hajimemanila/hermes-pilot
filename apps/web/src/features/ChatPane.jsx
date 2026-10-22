import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useChatSocket } from '../lib/useChatSocket.js'
import { Icon, Sheet, relTime } from '../components/Ui.jsx'

/**
 * チャットタブ。ブリッジの /ws/chat 経由で Hermes の JSON-RPC（/api/ws）をそのまま話す。
 * 実測したプロトコル:
 *   session.list / session.create {title} / session.resume {session_id}
 *   prompt.submit {session_id, text} / session.interrupt {session_id}
 *   通知: gateway.ready / message.start / message.delta {text} / thinking.delta {text}
 *         message.complete {text, usage} / session.title / session.info / sessions.changed
 *
 * 再接続（画面OFF→復帰・回線断）は useChatSocket が担当し、
 * 戻ってきたら保存済みの stored_session_id に `session.resume` で繋ぎ直す。
 */
export function ChatPane({ notify }) {
  const [sessions, setSessions] = useState([])
  const [sid, setSid] = useState(null)
  const [storedSid, setStoredSid] = useState(null)
  const [title, setTitle] = useState('')
  const [blocks, setBlocks] = useState([])
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [usage, setUsage] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [thinking, setThinking] = useState('')

  const sidRef = useRef(null)
  const storedRef = useRef(null)
  const sessionsRef = useRef([])
  const listRef = useRef(null)
  const taRef = useRef(null)
  const stickRef = useRef(true)
  const notifiedOffline = useRef(false)

  sidRef.current = sid
  storedRef.current = storedSid

  /** セッション一覧を取り直す。 */
  const loadSessions = useCallback(async (rpc) => {
    const r = await rpc('session.list', {})
    const list = r?.result?.sessions ?? []
    sessionsRef.current = list
    setSessions(list)
    return list
  }, [])

  /**
   * サーバのセッションを UI に繋ぎ直す（履歴も置き換える）。
   * @param {Function} rpc JSON-RPC
   * @param {string} target stored session id
   * @returns {Promise<boolean>} 成否
   */
  const resumeInto = useCallback(
    async (rpc, target) => {
      const r = await rpc('session.resume', { session_id: target })
      const res = r?.result
      if (!res?.session_id) return { ok: false, sid: null }
      setSid(res.session_id)
      setStoredSid(res.resumed ?? target)
      const msgs = Array.isArray(res.messages) ? res.messages : []
      setBlocks(
        msgs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text ?? '') }))
          // 空（ツール呼び出しだけのターン）は吹き出しを作らない
          .filter((m) => m.text.trim().length > 0),
      )
      return { ok: true, sid: res.session_id }
    },
    [],
  )

  /** 通知の処理（セッションは ref で判定するので再購読しない）。 */
  const onEvent = useCallback(
    (msg) => {
      const type = msg?.params?.type
      const p = msg?.params?.payload ?? {}
      const sidMsg = msg?.params?.session_id
      if (sidMsg && sidRef.current && sidMsg !== sidRef.current) return

      if (type === 'message.start') {
        setStreaming(true)
        setThinking('')
        setBlocks((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && last.open && !last.text) return prev
          return [...prev, { role: 'assistant', text: '', open: true }]
        })
        return
      }
      if (type === 'thinking.delta') {
        setThinking((t) => (t + (p.text ?? '')).slice(-400))
        return
      }
      if (type === 'message.delta') {
        const chunk = p.text ?? ''
        if (!chunk) return
        setBlocks((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.role === 'assistant' && last.open) next[next.length - 1] = { ...last, text: last.text + chunk }
          else next.push({ role: 'assistant', text: chunk, open: true })
          return next
        })
        return
      }
      if (type === 'message.complete') {
        setStreaming(false)
        setThinking('')
        setUsage(p.usage ?? null)
        setBlocks((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: p.text ?? last.text, open: false }
          return next
        })
        return
      }
      if (type === 'session.title') {
        if (p.title) setTitle(p.title)
      }
    },
    [],
  )

  const sockRef = useRef(null)

  /** 接続が ready になったとき（初回・再接続の両方）。 */
  const onReady = useCallback(async () => {
    const rpc = sockRef.current?.rpc
    if (!rpc) return
    if (notifiedOffline.current) {
      notifiedOffline.current = false
      notify('再接続しました')
    }
    await loadSessions(rpc)
    // 進行中の会話があれば繋ぎ直す（会話が切れない）
    const target = storedRef.current
    if (target) {
      const resumed = await resumeInto(rpc, target)
      if (!resumed.ok) {
        // セッションが消えていたら作り直し（次の送信で作る）
        setSid(null)
        setStoredSid(null)
      } else {
        // タイトルは一覧から拾う（resume の戻り値には含まれない）
        const found = sessionsRef.current.find((x) => x.id === target)
        if (found?.title) setTitle(found.title)
      }
    }
  }, [loadSessions, notify, resumeInto])

  const onState = useCallback((s) => {
    if (s === 'closed' || s === 'error') {
      setStreaming(false)
      notifiedOffline.current = true
    }
  }, [])

  const sock = useChatSocket({ onEvent, onReady, onState })
  sockRef.current = sock
  const { rpc, showBanner, state: connState } = sock

  // 直近の会話を端末に覚えておく（アプリを閉じても続きから話せる）
  useEffect(() => {
    const saved = localStorage.getItem('hm.storedSid')
    if (saved && !storedRef.current) {
      setStoredSid(saved)
      setSid(null) // resume は onReady で行う
    }
  }, [])
  useEffect(() => {
    try {
      if (storedSid) localStorage.setItem('hm.storedSid', storedSid)
      else localStorage.removeItem('hm.storedSid')
    } catch {
      /* noop */
    }
  }, [storedSid])

  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks, streaming])

  /** 送信。セッションは最初の送信時に作る。 */
  const send = useCallback(async () => {
    const body = text.trim()
    if (!body || streaming) return
    setText('')
    setStreaming(true)
    setBlocks((prev) => [...prev, { role: 'user', text: body }, { role: 'assistant', text: '', open: true }])

    let target = sid
    if (!target) {
      const r = await rpc('session.create', { title: body.slice(0, 24) })
      target = r?.result?.session_id
      setStoredSid(r?.result?.stored_session_id ?? null)
      if (!target) {
        setStreaming(false)
        notify('セッションを作成できませんでした')
        return
      }
      setSid(target)
      setTitle(body.slice(0, 24))
    }
    let r = await rpc('prompt.submit', { session_id: target, text: body })
    // 再接続で sid が無効になった場合は stored から復元して 1 度だけやり直す
    if (r?.error && /session not found/i.test(r.error.message ?? '')) {
      const stored = storedRef.current
      if (stored) {
        const resumed = await resumeInto(rpc, stored)
        if (resumed.ok && resumed.sid) r = await rpc('prompt.submit', { session_id: resumed.sid, text: body })
      }
    }
    if (r?.error) {
      setStreaming(false)
      notify(`送信に失敗: ${r.error.message}`)
      setBlocks((prev) => [...prev, { role: 'notice', text: `送信に失敗: ${r.error.message}` }])
    }
    navigator.vibrate?.(8)
  }, [text, streaming, sid, rpc, notify, resumeInto])

  const interrupt = useCallback(async () => {
    if (!sid) return
    await rpc('session.interrupt', { session_id: sid })
    setStreaming(false)
    setThinking('')
    notify('中断しました')
  }, [sid, rpc, notify])

  const newSession = useCallback(() => {
    setSid(null)
    setStoredSid(null)
    setTitle('')
    setBlocks([])
    setUsage(null)
    setDrawer(false)
  }, [])

  const openSession = useCallback(
    async (storedTarget) => {
      setDrawer(false)
      setBlocks([])
      setUsage(null)
      setTitle(sessions.find((s) => s.id === storedTarget)?.title ?? '')
      const resumed = await resumeInto(rpc, storedTarget)
      if (!resumed.ok) {
        setSid(null)
        setStoredSid(null)
        notify('セッションを復元できませんでした')
      }
    },
    [rpc, resumeInto, sessions, notify],
  )

  return (
    <div className="pane chat" data-conn={connState}>
      <div className="chat-head">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="会話一覧">
          <Icon name="grid" size={18} />
        </button>
        <span className="chat-title">{title || 'チャット'}</span>
        <button className="icon-btn" onClick={newSession} aria-label="新しい会話">
          <Icon name="plus" size={18} />
        </button>
      </div>

      {/* 切断直後（2秒未満）は出さない。タブ切替の一瞬のフラッシュ対策 */}
      {showBanner ? <div className="banner">接続を回復しています…</div> : null}

      <div
        className="chat-scroll"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {!blocks.length ? <div className="empty">メッセージを送って開始</div> : null}
        {blocks.map((b, i) =>
          b.role === 'user' ? (
            <div key={i} className="msg user">
              <div className="bubble">{b.text}</div>
            </div>
          ) : b.role === 'assistant' ? (
            <div key={i} className="msg bot">
              <div className="bubble">{b.text || (b.open ? <span className="dots">…</span> : '')}</div>
            </div>
          ) : (
            <div key={i} className="msg notice">
              {b.text}
            </div>
          ),
        )}
        {streaming && thinking ? <div className="thinking">{thinking}</div> : null}
        {usage ? (
          <div className="usage">
            in {usage.input ?? 0} / out {usage.output ?? 0}
            {usage.cache_read ? ` / cache ${usage.cache_read}` : ''}
          </div>
        ) : null}
      </div>

      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder="Hermes に送る…"
          onChange={(e) => {
            setText(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(120, el.scrollHeight)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        {streaming ? (
          <button className="send stop" onClick={interrupt} aria-label="中断">
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button className="send" onClick={send} disabled={!text.trim()} aria-label="送信">
            <Icon name="send" size={18} />
          </button>
        )}
      </div>

      {drawer ? (
        <Sheet title="会話" onClose={() => setDrawer(false)}>
          <button className="row" onClick={newSession}>
            <span className="row-main">
              <span className="row-title">新しい会話</span>
              <span className="row-sub">空のセッションを作る</span>
            </span>
            <Icon name="plus" size={16} />
          </button>
          {sessions.map((s) => (
            <button key={s.id} className={`row${s.id === storedSid ? ' on' : ''}`} onClick={() => openSession(s.id)}>
              <span className="row-main">
                <span className="row-title">{s.title || s.id}</span>
                <span className="row-sub">
                  {s.source ?? 'cli'} ・ {s.message_count ?? 0} msg ・ {relTime((s.started_at ?? 0) * 1000)}
                  {s.is_active ? ' ・ 稼働中' : ''}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
        </Sheet>
      ) : null}
    </div>
  )
}
