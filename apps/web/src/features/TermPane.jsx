import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { openSocket } from '../api.js'

/**
 * 端末タブ。ブリッジが持つ実 PTY（node-pty）に WebSocket で繋ぐ。
 * メッセージ: サーバ→{t:'out',d} / 端末→{t:'in',d}・{t:'resize',c,r}
 */
export function TermPane({ notify }) {
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const [state, setState] = useState('connecting')

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: {
        background: '#07171b',
        foreground: '#dff3ef',
        cursor: '#2dd4bf',
        selectionBackground: '#1e4a52',
      },
      convertEol: false,
      scrollback: 2000,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try {
      fit.fit()
    } catch {
      /* 幅 0 のときなど */
    }

    const ws = openSocket('/ws/term')
    wsRef.current = ws
    ws.onopen = () => {
      setState('open')
      term.write('\r\n\x1b[2m── 接続しました ──\x1b[0m\r\n')
      try {
        fit.fit()
      } catch {
        /* noop */
      }
      ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }))
    }
    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        term.write(ev.data)
        return
      }
      if (msg.t === 'out') term.write(msg.d)
    }
    ws.onclose = () => setState('closed')
    ws.onerror = () => setState('error')

    const sub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }))
    })
    const onResize = () => {
      try {
        fit.fit()
      } catch {
        /* noop */
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }))
    }
    window.addEventListener('resize', onResize)
    const t = setTimeout(() => {
      term.focus()
      onResize()
    }, 120)

    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
      sub.dispose()
      ws.close()
      term.dispose()
    }
  }, [])

  const reconnect = () => {
    notify('再接続するにはタブを切り替えてください')
  }

  return (
    <div className="pane term">
      <div className="chat-head">
        <span className="chat-title">
          端末 <span className={`term-state ${state}`}>{state}</span>
        </span>
        <button className="link" onClick={reconnect}>
          ヘルプ
        </button>
      </div>
      <div className="term-host" ref={hostRef} />
      <div className="term-hint">ログインシェル（フルシェル）。操作は監査ログに残ります。</div>
    </div>
  )
}
