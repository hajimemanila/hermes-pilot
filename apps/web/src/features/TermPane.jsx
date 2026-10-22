import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, openSocket } from '../api.js'
import { Icon, Sheet } from '../components/Ui.jsx'

/**
 * ターミナルタブ。ブリッジが持つ実 PTY（node-pty）に WebSocket で繋ぐ。
 * メッセージ: サーバ→{t:'out',d} / 端末→{t:'in',d}・{t:'resize',c,r}
 *
 * 定型コマンド（`GET /api/snippets/term`）:
 *   タップ = 入力欄に挿入（Enter は送らない）
 *   長押し = 挿入して実行（`run: true` のものだけ）
 */
export function TermPane({ notify }) {
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  const [state, setState] = useState('connecting')
  const [snippets, setSnippets] = useState([])
  const [sheet, setSheet] = useState(false)
  const pressRef = useRef({})

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
    fitRef.current = fit
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

  // スニペットを読む（失敗してもターミナルは使える）
  useEffect(() => {
    api('/api/snippets/term')
      .then((d) => setSnippets(d.snippets ?? []))
      .catch(() => {})
  }, [])

  /** バーが増減したら PTY の桁数を合わせ直す。 */
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* noop */
      }
      const term = termRef.current
      const ws = wsRef.current
      if (term && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }))
      }
    }, 80)
    return () => clearTimeout(t)
  }, [snippets.length])

  /** 端末へ送る（exec=true で「現在の行を消して Enter まで」）。 */
  const sendToPty = useCallback(
    (text, exec) => {
      const ws = wsRef.current
      if (ws?.readyState !== WebSocket.OPEN) {
        notify('ターミナルが未接続です。タブを切り替えて再接続してください')
        return false
      }
      // 実行は「入力中の行を捨ててから流す」（前のコマンドに連結される事故を防ぐ）
      ws.send(JSON.stringify({ t: 'in', d: exec ? `\x15${text}\r` : text }))
      termRef.current?.focus()
      navigator.vibrate?.(exec ? 12 : 6)
      return true
    },
    [notify],
  )

  const useSnippet = useCallback(
    (s, exec = false) => {
      setSheet(false)
      if (exec && !s.run) {
        notify('このコマンドは挿入のみです')
        return
      }
      if (sendToPty(s.text, exec)) notify(exec ? `実行: ${s.label}` : `挿入: ${s.label}`)
    },
    [sendToPty, notify],
  )

  const hot = snippets.filter((s) => s.hot)

  return (
    <div className="pane term">
      <div className="chat-head">
        <span className="chat-title">
          ターミナル <span className={`term-state ${state}`}>{state}</span>
        </span>
        <button className="link" onClick={() => setSheet(true)}>
          定型
        </button>
      </div>

      {hot.length ? (
        <div className="action-bar">
          <div className="chips-scroll">
            {hot.map((s) => (
              <button
                key={s.id}
                className={`snippet-chip${s.run ? '' : ' ro'}`}
                title={`${s.note}\n${s.text}`}
                onPointerDown={() => {
                  clearTimeout(pressRef.current?.timer)
                  pressRef.current = { fired: false }
                  if (!s.run) return
                  pressRef.current.timer = setTimeout(() => {
                    pressRef.current.fired = true
                    useSnippet(s, true)
                  }, 550)
                }}
                onPointerUp={() => clearTimeout(pressRef.current?.timer)}
                onPointerLeave={() => clearTimeout(pressRef.current?.timer)}
                onPointerCancel={() => clearTimeout(pressRef.current?.timer)}
                onClick={() => {
                  if (pressRef.current?.fired) {
                    pressRef.current.fired = false
                    return
                  }
                  useSnippet(s, false)
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="term-host" ref={hostRef} />
      <div className="term-hint">タップで挿入 / 長押しで実行。ログインシェル（フルシェル）、操作は監査ログに残ります。</div>

      {sheet ? (
        <Sheet title="ターミナルの定型コマンド" onClose={() => setSheet(false)}>
          <div className="list">
            {snippets.map((s) => (
              <div
                key={s.id}
                className="list-item"
                role="button"
                tabIndex={0}
                onClick={() => useSnippet(s, false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') useSnippet(s, false)
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-title" style={{ display: 'block' }}>
                    {s.label}
                    {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>バー</span> : null}
                  </span>
                  <span
                    className="row-sub mono"
                    style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {s.text}
                  </span>
                  {s.note ? (
                    <span className="row-sub" style={{ display: 'block', opacity: 0.75 }}>
                      {s.note}
                    </span>
                  ) : null}
                </span>
                {s.run ? (
                  <button
                    className="link"
                    onClick={(e) => {
                      e.stopPropagation()
                      useSnippet(s, true)
                    }}
                  >
                    実行
                  </button>
                ) : (
                  <Icon name="chevron" />
                )}
              </div>
            ))}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            タップで入力欄に挿入（Enter は送らない）。長押し、または右の「実行」で Enter まで送ります。
            再起動系はターミナル（ai.hermes.hermes-mobile）と別プロセスなので、この画面は切れません。
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
