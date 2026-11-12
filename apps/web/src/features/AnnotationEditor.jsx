import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

/**
 * 注釈エディタ（Gemini アプリのペン入れ相当・最小セット）。
 *
 * 設計上の約束:
 * - **DPR 補正**: `canvas.width/height` を `devicePixelRatio` 倍し、CSS は 1 倍。
 *   描画前に `ctx.scale(dpr, dpr)` を適用する（高精細ディスプレイでぼやけない）
 * - **イベントは PointerEvent のみ**（pointerdown / pointermove / pointerup）。
 *   mouse と touch を書き分けない（`touch-action: none` でスクロールも止める）
 * - ツールは ペン / 矢印 / 矩形 / Undo の 4 つだけ。色・太さ・テキストは持たない
 */

const TOOLS = [
  { id: 'pen', label: 'ペン', icon: '✏️' },
  { id: 'arrow', label: '矢印', icon: '↗' },
  { id: 'rect', label: '矩形', icon: '▭' },
]

const RED = '#e11d48'

export function AnnotationEditor({ item, onClose, onSubmitted, notify }) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const drawingRef = useRef(null)
  const strokesRef = useRef([])
  const [tool, setTool] = useState('pen')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState('')
  const [count, setCount] = useState(0)

  /** 画像を画面に収める（contain）大きさを CSS px で返す。 */
  const layout = useCallback(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas || !img.naturalWidth) return null
    const availW = canvas.parentElement.clientWidth
    const availH = canvas.parentElement.clientHeight
    const ratio = Math.min(availW / img.naturalWidth, availH / img.naturalHeight)
    return {
      w: Math.round(img.naturalWidth * ratio),
      h: Math.round(img.naturalHeight * ratio),
      ratio,
    }
  }, [])

  /** 下地＋ストロークを描き直す（DPR 補正込み）。 */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const box = layout()
    if (!canvas || !img || !box) return
    const dpr = window.devicePixelRatio || 1
    // 内部解像度 = CSS × dpr / CSS は 1 倍のまま
    canvas.style.width = `${box.w}px`
    canvas.style.height = `${box.h}px`
    canvas.width = Math.round(box.w * dpr)
    canvas.height = Math.round(box.h * dpr)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(dpr, dpr)
    ctx.drawImage(img, 0, 0, box.w, box.h)
    for (const s of strokesRef.current) drawStroke(ctx, s)
  }, [layout])

  // レイアウトが 0 の瞬間（初回マウント直後）に描かないよう、次フレームで再試行する
  const retryRef = useRef(0)
  const scheduleRedraw = useCallback((tries = 0) => {
    const canvas = canvasRef.current
    const wrap = canvas?.parentElement
    const box = layout()
    if (!box || !wrap || wrap.clientWidth === 0 || wrap.clientHeight === 0) {
      if (tries < 20) requestAnimationFrame(() => scheduleRedraw(tries + 1))
      return
    }
    redraw()
  }, [layout])

  useEffect(() => {
    const img = new Image()
    imgRef.current = img
    img.onload = () => {
      setReady(true)
      requestAnimationFrame(() => scheduleRedraw())
    }
    img.onerror = () => setError('下地画像を読み込めませんでした')
    img.src = `/api/akapen/${item.id}/image`
    const onResize = () => scheduleRedraw()
    window.addEventListener('resize', onResize)
    const wrap = canvasRef.current?.parentElement
    const ro = wrap && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleRedraw()) : null
    if (ro && wrap) ro.observe(wrap)
    return () => {
      window.removeEventListener('resize', onResize)
      if (ro) ro.disconnect()
    }
  }, [item.id, redraw, ready])

  /** ポインタ座標 → CSS px（キャンバス左上基準）。 */
  function point(ev) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return [ev.clientX - rect.left, ev.clientY - rect.top]
  }

  function onPointerDown(ev) {
    if (!ready || busy) return
    ev.preventDefault()
    // 合成イベントでは setPointerCapture が投げるので握りつぶす（実機では効く）
    try {
      canvasRef.current?.setPointerCapture?.(ev.pointerId)
    } catch {
      /* no active pointer (synthetic event) */
    }
    drawingRef.current = { tool, points: [point(ev)] }
    strokesRef.current.push(drawingRef.current)
    redraw()
  }

  function onPointerMove(ev) {
    const cur = drawingRef.current
    if (!cur) return
    ev.preventDefault()
    cur.points.push(point(ev))
    redraw()
  }

  function onPointerUp(ev) {
    const cur = drawingRef.current
    if (!cur) return
    ev.preventDefault()
    drawingRef.current = null
    if (cur.points.length < 2) {
      // 点だけ（タップ）は捨てる
      strokesRef.current.pop()
    } else {
      cur.points = cur.points.filter((_, i) => i % 2 === 0 || i === cur.points.length - 1)
      setCount(strokesRef.current.length)
    }
    redraw()
  }

  function undo() {
    strokesRef.current.pop()
    setCount(strokesRef.current.length)
    redraw()
  }

  /** 送信用に焼く: 長辺 1600px / JPEG 0.85（base64 を小さく保つ）。 */
  function exportDataUrl() {
    const canvas = canvasRef.current
    const long = Math.max(canvas.width, canvas.height)
    const scale = Math.min(1, 1600 / long)
    const out = document.createElement('canvas')
    out.width = Math.round(canvas.width * scale)
    out.height = Math.round(canvas.height * scale)
    const ctx = out.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, 0, 0, out.width, out.height)
    return out.toDataURL('image/jpeg', 0.85)
  }

  async function submit() {
    if (!strokesRef.current.length) {
      setError('まず赤を入れてください（ペン・矢印・矩形）')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const canvas = canvasRef.current
      const w = canvas.width
      const h = canvas.height
      const marks = strokesRef.current.map((s) => ({
        tool: s.tool,
        points: s.points.map(([x, y]) => [
          Math.round((x / (w / (window.devicePixelRatio || 1))) * 1000) / 1000,
          Math.round((y / (h / (window.devicePixelRatio || 1))) * 1000) / 1000,
        ]),
      }))
      const r = await api(`/api/akapen/${item.id}/annotation`, {
        method: 'POST',
        body: { annotated_image: exportDataUrl(), note, marks, by: 'mobile' },
      })
      notify?.(r?.duplicate ? '同じ注釈が既に保存されています' : '注釈を送信しました')
      onSubmitted?.(r)
    } catch (e) {
      setError(e?.message || '送信できませんでした（画像が大きい可能性があります）')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ak-anno">
      <header className="ak-anno-head">
        <button className="ak-anno-close" type="button" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
        <div className="ak-anno-title">
          {item.akapen?.title || item.title}
          <span>赤を入れて「送信」</span>
        </div>
        <button className="ak-anno-send" type="button" disabled={busy} onClick={submit}>
          {busy ? '送信中…' : '送信'}
        </button>
      </header>

      <div className="ak-anno-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="ak-anno-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      {error ? <div className="ak-error ak-anno-error">{error}</div> : null}

      <div className="ak-anno-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`ak-anno-tool${tool === t.id ? ' on' : ''}`}
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
          >
            <span aria-hidden="true">{t.icon}</span>
            {t.label}
          </button>
        ))}
        <button type="button" className="ak-anno-tool" onClick={undo} disabled={!count}>
          ↩ 戻す
        </button>
        <input
          className="ak-anno-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="ひとこと（任意）"
          maxLength={200}
        />
      </div>
    </div>
  )
}

/** 1 ストロークを描く（CSS px 座標系）。 */
function drawStroke(ctx, s) {
  const pts = s.points
  if (!pts || pts.length < 2) return
  ctx.save()
  ctx.strokeStyle = RED
  ctx.fillStyle = 'rgba(225, 29, 72, 0.18)'
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (s.tool === 'pen') {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.stroke()
  } else if (s.tool === 'rect') {
    const [x0, y0] = pts[0]
    const [x1, y1] = pts[pts.length - 1]
    const x = Math.min(x0, x1)
    const y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0)
    const h = Math.abs(y1 - y0)
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)
  } else if (s.tool === 'arrow') {
    const [x0, y0] = pts[0]
    const [x1, y1] = pts[pts.length - 1]
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    const ang = Math.atan2(y1 - y0, x1 - x0)
    const head = Math.max(12, Math.min(28, Math.hypot(x1 - x0, y1 - y0) * 0.28))
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 7), y1 - head * Math.sin(ang - Math.PI / 7))
    ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 7), y1 - head * Math.sin(ang + Math.PI / 7))
    ctx.closePath()
    ctx.fillStyle = RED
    ctx.fill()
  }
  ctx.restore()
}
