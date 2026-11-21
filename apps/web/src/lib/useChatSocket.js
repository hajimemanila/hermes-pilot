import { useCallback, useEffect, useRef, useState } from 'react'
import { openSocket } from '../api.js'
import { HM_EVENTS, onHmEvent } from '../contracts/events.js'
import { WS_HANDSHAKE_TIMEOUT_MS, WS_PROBE_TIMEOUT_MS } from './netRecovery.js'
import { t } from '../i18n/lang.js'

/**
 * Hermes の JSON-RPC（/ws/chat 経由）クライアント。
 *
 * 画面OFF→復帰でソケットが死ぬ前提で作る:
 * - close / error で指数バックオフ再接続（1s → 2s → 4s … 最大15s）
 * - visibilitychange（復帰）/ online で即再接続
 * - 再接続できたら `session.resume` で元のセッションに繋ぎ直す（会話が切れない）
 * - 切断直後は赤帯を出さない（2秒の猶予。タブ切替の一瞬のフラッシュ対策）
 *
 * @param {{onEvent: Function, onReady: Function, onState: Function}} opts コールバック
 * @returns {{rpc: Function, state: string, reconnectNow: Function, showBanner: boolean}} クライアント
 */
export function useChatSocket({ onEvent, onReady, onState }) {
  const [state, setState] = useState('connecting') // connecting | ready | closed | error
  const [showBanner, setShowBanner] = useState(false)
  const wsRef = useRef(null)
  const pending = useRef(new Map())
  const idRef = useRef(1)
  const retryRef = useRef(0)
  const timerRef = useRef(null)
  const handshakeTimerRef = useRef(null)
  const probingRef = useRef(false)
  const closedByUs = useRef(false)
  /** 切断が始まった時刻（null = つながっている）。 */
  const offlineSince = useRef(Date.now())

  const eventRef = useRef(onEvent)
  const readyRef = useRef(onReady)
  const stateRef = useRef(onState)
  eventRef.current = onEvent
  readyRef.current = onReady
  stateRef.current = onState

  /*
   * 赤帯は「2秒以上つながらない」ときだけ出す。
   * 再接続のたびにタイマーを張り直すと、バックオフ中に一度も発火しないので
   * 「切断開始時刻」から経過時間で判定する（実測でハマった点）。
   */
  useEffect(() => {
    const id = setInterval(() => {
      const since = offlineSince.current
      setShowBanner(Boolean(since) && Date.now() - since > 2000)
    }, 400)
    return () => clearInterval(id)
  }, [])

  /** 未解決の RPC を解放する（呼び出し側を 20 秒待たせない）。 */
  const failPending = useCallback((message) => {
    for (const [id, resolve] of pending.current) {
      resolve({ id, error: { message } })
    }
    pending.current.clear()
  }, [])

  const rpc = useCallback((method, params = {}, timeoutMs = 20000) => {
    const ws = wsRef.current
    const id = idRef.current++
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ id, error: { message: t('socket.notConnected') } })
        return
      }
      const timeoutId = setTimeout(() => {
        pending.current.delete(id)
        resolve({ id, error: { message: 'timeout' } })
      }, timeoutMs)
      pending.current.set(id, (m) => {
        clearTimeout(timeoutId)
        resolve(m)
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return
    setState('connecting')
    stateRef.current?.('connecting')
    if (!offlineSince.current) offlineSince.current = Date.now()

    const ws = openSocket('/ws/chat')
    wsRef.current = ws
    clearTimeout(handshakeTimerRef.current)
    handshakeTimerRef.current = setTimeout(() => {
      if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close()
        } catch {
          /* noop */
        }
      }
    }, WS_HANDSHAKE_TIMEOUT_MS)

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      clearTimeout(handshakeTimerRef.current)
      retryRef.current = 0
    }
    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return
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
      if (type === 'gateway.ready') {
        offlineSince.current = null
        setShowBanner(false)
        setState('ready')
        stateRef.current?.('ready')
        readyRef.current?.()
      }
      eventRef.current?.(msg)
    }
    ws.onerror = () => {
      if (wsRef.current !== ws) return
      setState('error')
      stateRef.current?.('error')
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      clearTimeout(handshakeTimerRef.current)
      wsRef.current = null
      if (!offlineSince.current) offlineSince.current = Date.now()
      setState('closed')
      stateRef.current?.('closed')
      failPending(t('socket.disconnected'))
      if (closedByUs.current) return
      const delay = Math.min(15000, 1000 * 2 ** retryRef.current)
      retryRef.current += 1
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => connect(), delay)
    }
  }, [failPending])

  /** いますぐ繋ぎ直す（復帰時・`CONNECTING` ハングも破棄して張り直す）。 */
  const reconnectNow = useCallback(() => {
    retryRef.current = 0
    clearTimeout(timerRef.current)
    clearTimeout(handshakeTimerRef.current)
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      const old = wsRef.current
      wsRef.current = null
      if (old) {
        failPending(t('socket.disconnected'))
        try {
          old.close()
        } catch {
          /* noop */
        }
      }
      connect()
    }
  }, [connect, failPending])

  /** 復帰・通信回復時に半開きソケットを ping 確認し、応答が無ければ張り直す。 */
  const probeOrReconnect = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reconnectNow()
      return
    }
    if (probingRef.current) return
    probingRef.current = true
    try {
      const res = await rpc('bridge.ping', {}, WS_PROBE_TIMEOUT_MS)
      if (res?.error && wsRef.current === ws) {
        wsRef.current = null
        failPending(t('socket.disconnected'))
        try {
          ws.close()
        } catch {
          /* noop */
        }
        connect()
      }
    } finally {
      probingRef.current = false
    }
  }, [connect, failPending, reconnectNow, rpc])

  useEffect(() => {
    closedByUs.current = false
    connect()
    const onVisible = () => {
      if (document.visibilityState === 'visible') probeOrReconnect()
    }
    const onOnline = () => probeOrReconnect()
    const offWake = onHmEvent(HM_EVENTS.WAKE_SYNC, probeOrReconnect)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onVisible)
    return () => {
      closedByUs.current = true
      offWake()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onVisible)
      clearTimeout(timerRef.current)
      clearTimeout(handshakeTimerRef.current)
      try {
        wsRef.current?.close()
      } catch {
        /* noop */
      }
      wsRef.current = null
    }
  }, [connect, probeOrReconnect])

  return { rpc, state, reconnectNow, showBanner }
}
