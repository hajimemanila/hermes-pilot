import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, openSocket } from '../api.js'
import { Icon, Sheet } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { readSnippetBars, subscribeSnippetBars } from '../lib/snippetBars.js'
import { termKeyBytes } from '../lib/termKey.js'
import { reconnectDelay } from '../lib/termReconnect.js'
import { transport } from '../lib/transport.js'
import { useI18n } from '../i18n/index.js'
import { HM_EVENTS, onHmEvent } from '../contracts/events.js'
import { WS_HANDSHAKE_TIMEOUT_MS, WS_PROBE_TIMEOUT_MS } from '../lib/netRecovery.js'

/**
 * ターミナルタブ。ブリッジが持つ実 PTY（node-pty）に WebSocket で繋ぐ。
 * メッセージ: サーバ→{t:'out',d} / 端末→{t:'in',d}・{t:'resize',c,r}
 *
 * 定型コマンド（`GET /api/snippets/term`）:
 *   タップ = 入力欄に挿入（Enter は送らない）
 *   長押し = 挿入して実行（`run: true` のものだけ）
 *
 * Enter（SPEC-enter-enter-discuss-next-ste Q1/Q2 = A）:
 *   `.term-host` のキャプチャ段で Enter を拾い、`\r` を自分で PTY へ書く。xterm の keydown は
 *   同じ textarea のキャプチャ段なので、ここで `stopPropagation` すれば書き手は 1 つに保たれる
 *   （xterm が同時に `\r` を送って二重実行になることはない）。IME 変換中でも実行する。
 *   タブに戻ってきたときは xterm へフォーカスを戻す（隠し textarea にキーボードを繋ぎ直す）。
 *
 * 再接続:
 *   ブリッジの再起動（`launchctl kickstart -k …`）は端末ソケットも切る。ペインはタブ切替で
 *   破棄されない（`visibility:hidden + inert` で生かしたまま）ので、mount 時の 1 回きりの接続だと
 *   **「未接続」のまま二度と戻らない**（実測）。close で 1s→2s→4s…最大 15s のバックオフ再接続、
 *   タブ復帰・`visibilitychange`・`online`・送信時の失敗でも即座に繋ぎ直す。
 *
 * 状態表示（`term.state.*`）は接続状態の正本（`lib/transport.js` / D96）から写像する。
 * このペインは `setState('open' | 'reconnecting' | …)` をせず、ソケットの出来事を
 * ハブへ報告するだけ（表示文言は増やさない）。
 */

/** term 系統の状態（接続状態の正本から読む）。 */
const termSnapshot = () => transport.sourceState('term')

/** 集約語彙 → 端末ヘッダの表示語（`term.state.*` のキー）。 */
const TERM_STATE_VIEW = Object.freeze({
  ready: 'open',
  connecting: 'connecting',
  recovering: 'reconnecting',
  offline: 'closed',
  auth: 'error',
  error: 'error',
})

export function TermPane({ notify, active = true }) {
  const { lang, t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  /** 再接続を起こす関数（mount effect が入れ、送信失敗やタブ復帰から呼ぶ）。 */
  const connectRef = useRef(null)
  const retryRef = useRef(0)
  const reconnectTimer = useRef(null)
  /** 切断の行を書いたか（再試行のたびに積まない）。 */
  const droppedRef = useRef(false)
  /** 端末ソケットの状態は接続状態の正本から写像する（`term.state.*` の語は変えない）。 */
  const termState = useSyncExternalStore(transport.subscribe, termSnapshot)
  const state = TERM_STATE_VIEW[termState] ?? 'connecting'
  const [snippets, setSnippets] = useState([])
  const [sheet, setSheet] = useState(false)
  const pressRef = useRef({})
  // 帯の表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）。隠してもヘッダの定型ボタン（term.snippets）で開ける
  const [bars, setBars] = useState(() => readSnippetBars())
  useEffect(() => subscribeSnippetBars(setBars), [])

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

    let disposed = false
    let handshakeTimer = null
    let probeTimer = null

    /**
     * PTY ソケットを張る。切れたら自前でバックオフ再接続する
     * （`onclose` は「置き換え済みの古いソケット」の close でも来るので、ws 参照で無視する）。
     */
    const connect = (force = false) => {
      if (disposed) return
      const cur = wsRef.current
      if (force && cur && cur.readyState !== WebSocket.CLOSED) {
        wsRef.current = null
        try {
          cur.close()
        } catch {
          /* noop */
        }
      } else if (!force && cur && cur.readyState <= WebSocket.OPEN) {
        return
      }
      clearTimeout(handshakeTimer)
      clearTimeout(probeTimer)
      probeTimer = null
      // 再試行中は「接続中」に戻さない（切断→接続中の点滅を避ける）。猶予の判定はハブが持つ
      transport.report('term', 'connecting')
      const ws = openSocket('/ws/term')
      wsRef.current = ws
      handshakeTimer = setTimeout(() => {
        if (!disposed && wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close()
          } catch {
            /* noop */
          }
        }
      }, WS_HANDSHAKE_TIMEOUT_MS)
      ws.onopen = () => {
        if (wsRef.current !== ws) return
        clearTimeout(handshakeTimer)
        retryRef.current = 0
        droppedRef.current = false
        transport.report('term', 'open')
        term.write(`\r\n\x1b[2m${tRef.current('term.connected')}\x1b[0m\r\n`)
        try {
          fit.fit()
        } catch {
          /* noop */
        }
        ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }))
      }
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return
        clearTimeout(probeTimer)
        probeTimer = null
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          term.write(ev.data)
          return
        }
        if (msg.t === 'pong') return
        if (msg.t === 'out') term.write(msg.d)
      }
      ws.onerror = () => {
        if (wsRef.current !== ws) return
        transport.report('term', 'error')
      }
      ws.onclose = () => {
        if (wsRef.current !== ws) return
        clearTimeout(handshakeTimer)
        clearTimeout(probeTimer)
        probeTimer = null
        wsRef.current = null
        if (disposed) return
        transport.report('term', 'closed')
        if (!droppedRef.current) {
          droppedRef.current = true
          term.write(`\r\n\x1b[2m${tRef.current('term.reconnectLine')}\x1b[0m\r\n`)
        }
        retryRef.current += 1
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = setTimeout(connect, reconnectDelay(retryRef.current))
      }
    }
    connectRef.current = () => connect(true)
    connect()

    const sub = term.onData((d) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }))
    })
    const onResize = () => {
      try {
        fit.fit()
      } catch {
        /* noop */
      }
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }))
    }
    /** 復帰・回線復旧時は未接続を即張り直し、OPEN のまま半開きなら ping で生存確認する。 */
    const reconnectNow = () => {
      if (disposed) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        retryRef.current = 0
        clearTimeout(reconnectTimer.current)
        connect(true)
        return
      }
      if (probeTimer) return
      try {
        ws.send(JSON.stringify({ t: 'ping' }))
        probeTimer = setTimeout(() => {
          probeTimer = null
          if (!disposed) {
            retryRef.current = 0
            connect(true)
          }
        }, WS_PROBE_TIMEOUT_MS)
      } catch {
        retryRef.current = 0
        connect(true)
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow()
    }
    const offWake = onHmEvent(HM_EVENTS.WAKE_SYNC, reconnectNow)
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('online', reconnectNow)
    const focusTimer = setTimeout(() => {
      term.focus()
      onResize()
    }, 120)

    return () => {
      disposed = true
      connectRef.current = null
      offWake()
      clearTimeout(focusTimer)
      clearTimeout(reconnectTimer.current)
      clearTimeout(handshakeTimer)
      clearTimeout(probeTimer)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('online', reconnectNow)
      sub.dispose()
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.close()
      } catch {
        /* noop */
      }
      term.dispose()
    }
  }, [])

  // スニペットを読む（失敗してもターミナルは使える）。言語は URL に明示する（SPEC §3.1）
  const langRef = useRef(lang)
  langRef.current = lang
  const snippetsRef = useRef(snippets)
  snippetsRef.current = snippets
  useEffect(() => {
    let cancelled = false
    const load = () => {
      api(`/api/snippets/term?lang=${encodeURIComponent(lang)}`)
        .then((d) => {
          if (!cancelled && langRef.current === lang) setSnippets(d.snippets ?? [])
        })
        .catch(() => {})
    }
    load()
    const offWake = onHmEvent(HM_EVENTS.WAKE_SYNC, () => {
      if (!snippetsRef.current.length) load()
    })
    window.addEventListener(HM_EVENTS.TERM_SNIPPETS, load)
    window.addEventListener(HM_EVENTS.LANG, load)
    return () => {
      cancelled = true
      offWake()
      window.removeEventListener(HM_EVENTS.TERM_SNIPPETS, load)
      window.removeEventListener(HM_EVENTS.LANG, load)
    }
  }, [lang])

  /** バー増減・タブ復帰時に PTY の桁数を合わせ直す。切れていれば繋ぎ直す。 */
  useEffect(() => {
    if (!active) return undefined
    // タブに戻ってきたら待たずに繋ぎ直す（バックオフ中でも試す）
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      retryRef.current = 0
      clearTimeout(reconnectTimer.current)
      connectRef.current?.()
    }
    const fitTimer = setTimeout(() => {
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
    return () => clearTimeout(fitTimer)
  }, [snippets.length, bars.term, active])

  /**
   * タブに戻ってきたら xterm へフォーカスを戻す（SPEC-enter-enter-discuss-next-ste Q1）。
   * タブは `display:none` ではなく `visibility:hidden + inert` で生かしたまま隠れるので
   * （`App.jsx` の `TabHost`）、隠し textarea はフォーカスを失ったままになり、
   * 戻ってもキーボードが端末に繋がらない。表示に戻った直後に繋ぎ直す。
   */
  useEffect(() => {
    if (!active) return undefined
    const focusTimer = setTimeout(() => {
      try {
        termRef.current?.focus()
      } catch {
        /* 端末がまだ無い */
      }
    }, 60)
    return () => clearTimeout(focusTimer)
  }, [active])

  /** PTY へ生バイトを書く（未接続なら即再接続を試みて理由を出す）。Enter の明示送信と定型コマンドが使う。 */
  const writeToPty = useCallback(
    (data) => {
      const ws = wsRef.current
      if (ws?.readyState !== WebSocket.OPEN) {
        // 待たずに 1 回だけ繋ぎ直し、それでも駄目なら理由を出す（キーボードの裏に隠れない位置に出る）
        retryRef.current = 0
        clearTimeout(reconnectTimer.current)
        connectRef.current?.()
        notify(t('term.notConnected'))
        return false
      }
      ws.send(JSON.stringify({ t: 'in', d: data }))
      return true
    },
    [notify, t],
  )

  /**
   * Enter はホストのキャプチャ段で拾い、`\r` を自分で書く（Q1=A・Q2=A: IME 変換中でも実行）。
   * xterm の keydown は同じ textarea のキャプチャ段に登録されているので、ここで
   * `stopPropagation` すれば xterm は動かず、`\r` の書き手は 1 つに保たれる（二重実行しない）。
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const onKeyDown = (e) => {
      const bytes = termKeyBytes(e)
      if (bytes == null) return
      e.preventDefault()
      e.stopPropagation()
      writeToPty(bytes)
    }
    host.addEventListener('keydown', onKeyDown, true)
    return () => host.removeEventListener('keydown', onKeyDown, true)
  }, [writeToPty])

  /** 端末へ送る（exec=true で「現在の行を消して Enter まで」）。 */
  const sendToPty = useCallback(
    (text, exec) => {
      if (!writeToPty(exec ? `\x15${text}\r` : text)) return false
      termRef.current?.focus()
      haptic(exec ? 'action' : 'tap')
      return true
    },
    [writeToPty],
  )

  const useSnippet = useCallback(
    (s, exec = false) => {
      setSheet(false)
      if (exec && !s.run) {
        notify(t('term.insertOnly'))
        return
      }
      if (sendToPty(s.text, exec)) notify(exec ? t('term.ran', { label: s.label }) : t('term.inserted', { label: s.label }))
    },
    [sendToPty, notify, t],
  )

  const hot = snippets.filter((s) => s.hot)

  return (
    <div className="pane term">
      <div className="chat-head">
        <span className="chat-title">
          {t('term.title')} <span className={`term-state ${state}`}>{t(`term.state.${state}`)}</span>
        </span>
        <button className="link" onClick={() => setSheet(true)}>
          {t('term.snippets')}
        </button>
      </div>

      {bars.term && hot.length ? (
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
      <div className="term-hint">{t('term.hint')}</div>

      {sheet ? (
        <Sheet title={t('term.snippetsTitle')} onClose={() => setSheet(false)}>
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
                    {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>{t('term.bar')}</span> : null}
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
                    {t('term.run')}
                  </button>
                ) : (
                  <Icon name="chevron" />
                )}
              </div>
            ))}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            {t('term.sheetNote')}
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
