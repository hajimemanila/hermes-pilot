import React, { useCallback, useEffect, useRef, useState } from 'react'

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
  }
  return <svg {...common}>{paths[name] ?? paths.grid}</svg>
}

/**
 * スライドアップのシート。
 */
export function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
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
      navigator.vibrate?.(20)
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
