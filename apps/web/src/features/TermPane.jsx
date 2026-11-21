import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, openSocket } from '../api.js'
import { Icon, Sheet } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { readSnippetBars, subscribeSnippetBars } from '../lib/snippetBars.js'
import { termKeyBytes } from '../lib/termKey.js'
import { useI18n } from '../i18n/index.js'

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
 */
export function TermPane({ notify, active = true }) {
  const { lang, t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  const [state, setState] = useState('connecting')
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

    const ws = openSocket('/ws/term')
    wsRef.current = ws
    ws.onopen = () => {
      setState('open')
      term.write(`\r\n\x1b[2m${tRef.current('term.connected')}\x1b[0m\r\n`)
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
    const focusTimer = setTimeout(() => {
      term.focus()
      onResize()
    }, 120)

    return () => {
      clearTimeout(focusTimer)
      window.removeEventListener('resize', onResize)
      sub.dispose()
      ws.close()
      term.dispose()
    }
  }, [])

  // スニペットを読む（失敗してもターミナルは使える）。言語は URL に明示する（SPEC §3.1）
  const langRef = useRef(lang)
  langRef.current = lang
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
    window.addEventListener('hm:term-snippets', load)
    window.addEventListener('hm:lang', load)
    return () => {
      cancelled = true
      window.removeEventListener('hm:term-snippets', load)
      window.removeEventListener('hm:lang', load)
    }
  }, [lang])

  /** バー増減・タブ復帰時に PTY の桁数を合わせ直す。 */
  useEffect(() => {
    if (!active) return undefined
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

  /** PTY へ生バイトを書く（未接続なら理由を出す）。Enter の明示送信と定型コマンドが使う。 */
  const writeToPty = useCallback(
    (data) => {
      const ws = wsRef.current
      if (ws?.readyState !== WebSocket.OPEN) {
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
