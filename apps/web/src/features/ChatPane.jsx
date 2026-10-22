import React, { useCallback, useEffect, useRef, useState } from 'react'
import { openSocket } from '../api.js'
import { Icon, Sheet, relTime } from '../components/Ui.jsx'

/**
 * チャットタブ。ブリッジの /ws/chat 経由で Hermes の JSON-RPC（/api/ws）をそのまま話す。
 * 実測したプロトコル:
 *   session.list / session.create {title} / session.history {session_id}
 *   prompt.submit {session_id, text} / session.interrupt {session_id}
 *   通知: gateway.ready / message.start / message.delta {text} / thinking.delta {text}
 *         message.complete {text, usage} / session.title / session.info / sessions.changed
 */
export function ChatPane({ notify }) {
  const [conn, setConn] = useState('connecting')
  const [sessions, setSessions] = useState([])
  const [sid, setSid] = useState(null)
  const [title, setTitle] = useState('')
  const [blocks, setBlocks] = useState([])
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [usage, setUsage] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [thinking, setThinking] = useState('')

  const wsRef = useRef(null)
  const idRef = useRef(1)
  const pending = useRef(new Map())
  const sidRef = useRef(null)
  const listRef = useRef(null)
  const taRef = useRef(null)
  const stickRef = useRef(true)

  sidRef.current = sid

  /** JSON-RPC を送って応答を待つ。 */
  const rpc = useCallback((method, params = {}, timeoutMs = 20000) => {
    const ws = wsRef.current
    const id = idRef.current++
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ error: { message: '未接続' } })
        return
      }
      const t = setTimeout(() => {
        pending.current.delete(id)
        resolve({ error: { message: 'timeout' } })
      }, timeoutMs)
      pending.current.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }, [])

  const loadSessions = useCallback(async () => {
    const r = await rpc('session.list', {})
    const list = r?.result?.sessions ?? []
    setSessions(list)
    return list
  }, [rpc])

  const openSession = useCallback(
    async (storedId) => {
      const s = sessions.find((x) => x.id === storedId)
      setTitle(s?.title ?? '')
      setBlocks([])
      setUsage(null)
      setThinking('')
      // 履歴は session.resume が返す（session.history は resume 前は 4001 になる）
      const r = await rpc('session.resume', { session_id: storedId })
      const res = r?.result
      if (res?.session_id) {
        setSid(res.session_id)
        const msgs = Array.isArray(res.messages) ? res.messages : []
        setBlocks(
          msgs
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text ?? '' })),
        )
      } else {
        setSid(storedId)
        notify(r?.error?.message ?? 'セッションを復元できませんでした')
      }
    },
    [rpc, sessions, notify],
  )

  // 接続
  useEffect(() => {
    const ws = openSocket('/ws/chat')
    wsRef.current = ws
    ws.onopen = () => setConn('open')
    ws.onclose = () => {
      setConn('closed')
      setStreaming(false)
    }
    ws.onerror = () => setConn('error')
    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id && pending.current.has(msg.id)) {
        pending.current.get(msg.id)(msg)
        pending.current.delete(msg.id)
        return
      }
      const type = msg?.params?.type
      const p = msg?.params?.payload ?? {}
      const sidMsg = msg?.params?.session_id
      if (sidMsg && sidRef.current && sidMsg !== sidRef.current) return

      if (type === 'gateway.ready') {
        setConn('ready')
        return
      }
      if (type === 'message.start') {
        setStreaming(true)
        setThinking('')
        // 送信時に置いた空のバブルがあれば再利用する（二重に作らない）
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
        loadSessions()
        return
      }
      if (type === 'session.title') {
        if (p.title) setTitle(p.title)
        return
      }
      if (type === 'sessions.changed') {
        loadSessions()
      }
    }
    return () => ws.close()
  }, [loadSessions])

  // 初回: 一覧だけ読む（セッションは最初の送信時に作る。無駄な空セッションを作らない）
  useEffect(() => {
    if (conn !== 'ready') return
    loadSessions()
  }, [conn, loadSessions])

  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks, streaming])

  const ensureSession = useCallback(
    async (title) => {
      if (sid) return sid
      const r = await rpc('session.create', { title: title ?? 'mobile' })
      const created = r?.result?.session_id
      if (created) {
        setSid(created)
        setTitle(title ?? '新しい会話')
        return created
      }
      return null
    },
    [sid, rpc],
  )

  const send = useCallback(async () => {
    const body = text.trim()
    if (!body || streaming) return
    setText('')
    setStreaming(true)
    setBlocks((prev) => [...prev, { role: 'user', text: body }, { role: 'assistant', text: '', open: true }])

    let target = await ensureSession(body.slice(0, 24))
    if (!target) {
      setStreaming(false)
      notify('セッションを作成できませんでした')
      return
    }
    let r = await rpc('prompt.submit', { session_id: target, text: body })
    // ソケット再接続などで sid が無効になった場合は 1 度だけ作り直す
    if (r?.error && /session not found/i.test(r.error.message ?? '')) {
      const recreated = await rpc('session.create', { title: body.slice(0, 24) })
      const newSid = recreated?.result?.session_id
      if (newSid) {
        setSid(newSid)
        target = newSid
        r = await rpc('prompt.submit', { session_id: target, text: body })
      }
    }
    if (r?.error) {
      setStreaming(false)
      notify(`送信に失敗: ${r.error.message}`)
      setBlocks((prev) => [...prev, { role: 'notice', text: `送信に失敗: ${r.error.message}` }])
    }
    navigator.vibrate?.(8)
  }, [text, streaming, ensureSession, rpc, notify])

  const interrupt = useCallback(async () => {
    if (!sid) return
    await rpc('session.interrupt', { session_id: sid })
    setStreaming(false)
    setThinking('')
    notify('中断しました')
  }, [sid, rpc, notify])

  const newSession = useCallback(async () => {
    const r = await rpc('session.create', { title: 'mobile' })
    const created = r?.result?.session_id
    if (created) {
      setSid(created)
      setTitle('新しい会話')
      setBlocks([])
      setUsage(null)
      setDrawer(false)
    }
  }, [rpc])

  return (
    <div className="pane chat">
      <div className="chat-head">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="会話一覧">
          <Icon name="grid" size={18} />
        </button>
        <span className="chat-title">{title || 'チャット'}</span>
        <button className="icon-btn" onClick={newSession} aria-label="新しい会話">
          <Icon name="plus" size={18} />
        </button>
      </div>

      {conn !== 'ready' ? (
        <div className="banner">{conn === 'connecting' ? '接続中…' : `未接続（${conn}）`}</div>
      ) : null}

      <div className="chat-scroll" ref={listRef} onScroll={() => {
        const el = listRef.current
        if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}>
        {!blocks.length ? <div className="empty">メッセージを送って開始</div> : null}
        {blocks.map((b, i) =>
          b.role === 'user' ? (
            <div key={i} className="msg user">
              <div className="bubble">{b.text}</div>
            </div>
          ) : b.role === 'assistant' ? (
            <div key={i} className="msg bot">
              <div className="bubble">
                {b.text || (b.open ? <span className="dots">…</span> : '')}
              </div>
            </div>
          ) : (
            <div key={i} className="msg notice">{b.text}</div>
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
            <button
              key={s.id}
              className={`row${s.id === sid ? ' on' : ''}`}
              onClick={() => {
                openSession(s.id)
                setDrawer(false)
              }}
            >
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
