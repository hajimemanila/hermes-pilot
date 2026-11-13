import React, { useCallback, useEffect, useRef, useState } from 'react'
import { haptic } from '../lib/haptic.js'

/**
 * 最小限のアイコン（外部依存を増やさない）。
 * @param {{name: string, size?: number}} props 名前とサイズ
 */
export function Icon({ name, size = 20 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    chat: <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.6-4.6A8 8 0 1 1 21 12Z" />,
    term: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>,
    gear: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" /></>,
    send: <path d="M4 12 20 4l-6 16-3.2-6.8L4 12Z" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    plus: <path d="M12 5v14M5 12h14" />,
    bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
    check: <path d="m4 12 5 5L20 6" />,
    pen: <><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 6 4 4" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>,
  }
  return <svg {...common}>{paths[name] ?? paths.grid}</svg>
}

/**
 * 軽量な回転スピナー。ボタン内や読み込み表示で共用する。
 * @param {{size?: number, className?: string}} props
 */
export function Spinner({ size = 16, className = '' }) {
  return (
    <svg
      className={`hm-spin ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.24" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 待機中のシンプルなローダー表示（画面・シート・一覧の初期ロード向け）。
 * @param {{label?: string, size?: number}} props
 */
export function Loader({ label = '読み込み中…', size = 18 }) {
  return (
    <div className="hm-loader" role="status" aria-live="polite">
      <Spinner size={size} />
      {label ? <span>{label}</span> : null}
    </div>
  )
}

/**
 * 押下フィードバック・回転中・完了チェック（✓）を備えた共通更新ボタン。
 * @param {{
 *   onRefresh?: Function,
 *   variant?: 'btn'|'link'|'icon',
 *   label?: string,
 *   ariaLabel?: string,
 *   busy?: boolean,
 *   disabled?: boolean,
 *   className?: string,
 * }} props
 */
export function RefreshButton({
  onRefresh,
  variant = 'btn',
  label = '更新',
  ariaLabel = '更新',
  busy: externalBusy = false,
  disabled = false,
  className = '',
}) {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const timerRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(timerRef.current)
    }
  }, [])

  const busy = running || externalBusy

  const handleClick = async () => {
    if (busy || disabled || !onRefresh) return
    haptic('tap')
    clearTimeout(timerRef.current)
    setDone(false)
    setRunning(true)
    const started = Date.now()
    let ok = true
    try {
      const res = await onRefresh()
      if (res === false) ok = false
    } catch {
      ok = false
    }
    // 一瞬で終わった場合でも、更新が走ったことを視認できるよう最低 260ms 回す
    const wait = Math.max(0, 260 - (Date.now() - started))
    if (wait) await new Promise((r) => setTimeout(r, wait))
    if (!mountedRef.current) return
    setRunning(false)
    if (ok) {
      setDone(true)
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) setDone(false)
      }, 1100)
    } else {
      haptic('error')
    }
  }

  const baseClass = variant === 'icon' ? 'icon-btn' : variant === 'link' ? 'link' : 'btn'
  const iconSize = variant === 'icon' ? 18 : 14

  return (
    <button
      type="button"
      className={`${baseClass} hm-refresh-btn${done ? ' is-done' : ''} ${className}`.trim()}
      onClick={handleClick}
      disabled={busy || disabled}
      aria-busy={busy}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span className={`hm-refresh-ico${busy ? ' hm-spin' : ''}`} aria-hidden="true">
        <Icon name={done ? 'check' : 'refresh'} size={iconSize} />
      </span>
      {variant !== 'icon' && label ? <span>{busy ? '更新中' : done ? '更新済' : label}</span> : null}
    </button>
  )
}

let sheetSeq = 0
const activeSheets = []
let sheetHistoryActive = false
let pendingBackTimer = null
let ignoringNextPop = false
let popListenerBound = false

function onGlobalSheetPop() {
  if (ignoringNextPop) {
    ignoringNextPop = false
    return
  }
  if (!activeSheets.length) {
    sheetHistoryActive = false
    return
  }
  const top = activeSheets.pop()
  if (!activeSheets.length) sheetHistoryActive = false
  top?.close?.()
}

/**
 * スライドアップのシート。
 * マウント時にブラウザ履歴を 1 段積み、Android の「戻る」で閉じられるようにする
 * （`TasksPane` が `#inbox` で管理している場合は二重に積まない）。
 */
export function Sheet({ title, onClose, children }) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (typeof window === 'undefined' || !window.history?.pushState) return undefined
    // InboxSheet は TasksPane 側で #inbox ハッシュと履歴を管理しているため重複させない
    if (window.history.state?.hmSheet === 'inbox' || window.location.hash.startsWith('#inbox')) {
      return undefined
    }
    if (!popListenerBound) {
      window.addEventListener('popstate', onGlobalSheetPop)
      popListenerBound = true
    }
    if (pendingBackTimer !== null) {
      clearTimeout(pendingBackTimer)
      pendingBackTimer = null
    }
    const token = `s-${++sheetSeq}`
    const entry = { token, close: () => onCloseRef.current?.() }
    activeSheets.push(entry)
    if (!sheetHistoryActive) {
      try {
        window.history.pushState({ ...(window.history.state ?? {}), hmSheetId: token }, '', window.location.href)
        sheetHistoryActive = true
      } catch {
        const idx = activeSheets.indexOf(entry)
        if (idx !== -1) activeSheets.splice(idx, 1)
        return undefined
      }
    }
    return () => {
      const idx = activeSheets.indexOf(entry)
      if (idx !== -1) activeSheets.splice(idx, 1)
      if (activeSheets.length === 0 && sheetHistoryActive && pendingBackTimer === null) {
        pendingBackTimer = setTimeout(() => {
          pendingBackTimer = null
          if (activeSheets.length === 0 && sheetHistoryActive) {
            sheetHistoryActive = false
            ignoringNextPop = true
            try {
              window.history.back()
            } catch {
              ignoringNextPop = false
            }
          }
        }, 0)
      }
    }
  }, [])

  const handleClose = () => {
    haptic('tap')
    onClose?.()
  }

  return (
    <div className="sheet-wrap" onClick={handleClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={handleClose} aria-label="閉じる">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}

/**
 * 長押しで確定するボタン（破壊的操作の誤爆防止）。
 * @param {{onFire: Function, ms?: number, label: string, sub?: string, tone?: string, disabled?: boolean}} props
 */
export function HoldButton({ onFire, ms = 1500, label, sub, tone = 'danger', disabled }) {
  const [progress, setProgress] = useState(0)
  const timer = useRef(null)
  const raf = useRef(null)
  const startRef = useRef(0)

  const stop = useCallback(() => {
    clearTimeout(timer.current)
    cancelAnimationFrame(raf.current)
    setProgress(0)
  }, [])

  const start = useCallback(() => {
    if (disabled) return
    startRef.current = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - startRef.current) / ms)
      setProgress(p)
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    timer.current = setTimeout(() => {
      stop()
      haptic('heavy')
      onFire()
    }, ms)
  }, [disabled, ms, onFire, stop])

  useEffect(() => stop, [stop])

  return (
    <button
      className={`hold ${tone}`}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      <span className="hold-fill" style={{ transform: `scaleX(${progress})` }} />
      <span className="hold-label">{label}</span>
      {sub ? <span className="hold-sub">{sub}</span> : null}
    </button>
  )
}

/** バイト数を読みやすく。 */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`
  return `${(n / 1073741824).toFixed(1)}GB`
}

/** 相対時刻。 */
export function relTime(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}秒前`
  if (s < 3600) return `${Math.round(s / 60)}分前`
  if (s < 86400) return `${Math.round(s / 3600)}時間前`
  return `${Math.round(s / 86400)}日前`
}
