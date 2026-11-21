import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Sheet } from '../components/Ui.jsx'
import {
  STAMPS,
  applyStampToStrokes,
  composeNote,
  lastStampId,
  stampById,
  stampPills,
  strokesToMarks,
} from '../lib/annotationStamps.js'
import { readActiveChatId } from '../lib/chatReports.js'
import { haptic } from '../lib/haptic.js'
import { readSnippetBars, subscribeSnippetBars } from '../lib/snippetBars.js'
import { useI18n } from '../i18n/index.js'

/**
 * 注釈エディタ（Gemini アプリのペン入れ相当・最小セット）。
 *
 * 設計上の約束:
 * - **DPR 補正**: `canvas.width/height` を `devicePixelRatio` 倍し、CSS は 1 倍。
 *   描画前に `ctx.scale(dpr, dpr)` を適用する（高精細ディスプレイでぼやけない）
 * - **イベントは PointerEvent のみ**（pointerdown / pointermove / pointerup）。
 *   mouse と touch を書き分けない（`touch-action: none` でスクロールも止める）
 * - ツールは ペン / 矢印 / 矩形 / Undo の 4 つだけ。色・太さ・テキストは持たない
 * - **1 タップ指示スタンプ（SPEC-PILOT-V5 §3.3 ②）**: 6 種のチップで、最後のストロークに
 *   `stamp` を紐づける（未描画なら中央に自動ボックス）。送信 `note` には指示一覧を
 *   自動合成するので、キーボードを開かずに赤入れを送れる
 */

const TOOLS = [
  { id: 'pen', key: 'annot.tool.pen', icon: '✏️' },
  { id: 'arrow', key: 'annot.tool.arrow', icon: '↗' },
  { id: 'rect', key: 'annot.tool.rect', icon: '▭' },
]

const RED = '#e11d48'
/** スタンプの小ピル（画像の上でも読めるアンバー）。 */
const AMBER = '#f59e0b'
const AMBER_INK = '#231603'
/** これ以上の幅なら「画像｜操作列」の横並びにする（タブレット横・2 ペインの詳細）。 */
const WIDE_MIN = 560

export function AnnotationEditor({ item, onClose, onSubmitted, notify }) {
  const { t } = useI18n()
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
  // 最後のストロークに付いているスタンプ（チップの on 表示用）
  const [activeStamp, setActiveStamp] = useState(null)
  // Before ↔ After（SPEC §5.2.2）。比較相手が無いタスクではトグルを出さない
  const [compare, setCompare] = useState(false)
  const [approving, setApproving] = useState(false)
  // スタンプは 1 行の横スクロール＋「＋」ドロワー（チャットの定型チップと同じ作法）
  const [stampSheet, setStampSheet] = useState(false)
  // 帯の表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）。隠してもツール列のスタンプボタンから開ける
  const [bars, setBars] = useState(() => readSnippetBars())
  useEffect(() => subscribeSnippetBars(setBars), [])
  // 幅が広いとき（タブレット横・2 ペインの詳細）は操作列を右へ寄せ、画像に高さを全部渡す
  const [wide, setWide] = useState(false)
  const [closing, setClosing] = useState(false)
  const rootRef = useRef(null)
  const baseSrc = `/api/review/${item.id}/image`
  const imgSrc = compare ? `${baseSrc}?compare=1` : baseSrc

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
    drawStampPills(ctx, strokesRef.current, box.w, box.h)
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
    setReady(false)
    img.onload = () => {
      setReady(true)
      requestAnimationFrame(() => scheduleRedraw())
    }
    img.onerror = () => {
      setReady(false)
      setError(t('annot.loadFailed'))
    }
    img.src = imgSrc
    const onResize = () => scheduleRedraw()
    window.addEventListener('resize', onResize)
    const wrap = canvasRef.current?.parentElement
    const ro = wrap && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleRedraw()) : null
    if (ro && wrap) ro.observe(wrap)
    return () => {
      window.removeEventListener('resize', onResize)
      if (ro) ro.disconnect()
    }
  }, [imgSrc, scheduleRedraw])

  // 幅の判定（560px 以上で「画像｜操作列」の 2 ペイン）。CSS 側の @media ではなく
  // 実測にするのは、2 ペイン（.split-detail）では画面幅と編集器の幅が違うため。
  useEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    const sync = () => setWide(el.clientWidth >= WIDE_MIN)
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
    setActiveStamp(lastStampId(strokesRef.current))
    redraw()
  }

  function undo() {
    strokesRef.current.pop()
    setCount(strokesRef.current.length)
    setActiveStamp(lastStampId(strokesRef.current))
    redraw()
  }

  /**
   * 1 タップ指示スタンプを押す（SPEC-PILOT-V5 §3.3 ②）。
   *
   * 最後のストロークに紐づけ、1 本も無ければ中央に自動ボックスを作る
   * （＝赤を引かずにスタンプだけで送信できる）。判定は純関数側に置いてある。
   */
  function applyStamp(id) {
    if (!ready || busy) return
    haptic('tap')
    const box = layout()
    const res = applyStampToStrokes(strokesRef.current, id, box ? { w: box.w, h: box.h } : null)
    if (!res.stamp) return
    strokesRef.current = res.strokes
    setCount(res.strokes.length)
    setActiveStamp(res.stamp.id)
    setError(null)
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
      setError(t('annot.needMarks'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const canvas = canvasRef.current
      const dpr = window.devicePixelRatio || 1
      const marks = strokesToMarks(strokesRef.current, {
        width: canvas.width / dpr,
        height: canvas.height / dpr,
      })
      const r = await api(`/api/review/${item.id}/annotation`, {
        method: 'POST',
        body: {
          annotated_image: exportDataUrl(),
          note: composeNote(note, strokesRef.current),
          marks,
          by: 'mobile',
          chat: readActiveChatId(),
        },
      })
      notify?.(r?.duplicate ? t('annot.duplicate') : t('annot.sent'))
      onSubmitted?.(r)
    } catch (e) {
      setError(e?.message || t('annot.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 赤入れせずに 1 タップ検収（SPEC §5.2.3）。
   *
   * 描いたストロークは送らない（合格の意思表示だけ）。bridge が
   * `Visual check passed` をコメントし、作業済みなら done・未作業なら unblock する。
   */
  async function approve() {
    if (approving) return
    setApproving(true)
    setError(null)
    try {
      haptic('success')
      const r = await api(`/api/review/${item.id}/approve`, {
        method: 'POST',
        body: { by: 'mobile', note, chat: readActiveChatId() },
      })
      notify?.(r?.moved === 'done' ? t('annot.approved') : t('annot.approvedResume'))
      onSubmitted?.(r)
    } catch (e) {
      setError(e?.message || t('annot.approveFailed'))
    } finally {
      setApproving(false)
    }
  }

  /**
   * 一覧から外す（アーカイブ）。`hermes kanban archive` に対応する。
   * 検収 OK と並べるために CloseActions の 2 段階 UI は使わず、同じ endpoint を
   * 直接叩いて長押し確定だけ残している（誤タップで消えない）。
   */
  async function archive() {
    if (closing) return
    setClosing(true)
    setError(null)
    try {
      const board = item.board || 'mobile'
      const r = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(item.id)}/close`, {
        method: 'POST',
        body: { action: 'cancel', note: String(note ?? '').slice(0, 400) },
      })
      notify?.(r?.noop ? t('close.alreadyCancelled') : t('close.cancelled'))
      onSubmitted?.({ closed: true })
    } catch (e) {
      setError(e?.message || t('annot.approveFailed'))
    } finally {
      setClosing(false)
    }
  }

  return (
    <div ref={rootRef} className={`ak-anno${wide ? ' wide' : ''}`}>
      <header className="ak-anno-head">
        <button
          className="ak-anno-close"
          type="button"
          onClick={() => {
            haptic('tap')
            onClose()
          }}
          aria-label={t('common.close')}
        >
          ✕
        </button>
        <div className="ak-anno-title">
          {item.review?.title || item.title}
          <span>{t('annot.instruction')}</span>
        </div>
        <button
          className="ak-anno-send"
          type="button"
          disabled={busy}
          onClick={() => {
            haptic('action')
            submit()
          }}
        >
          {busy ? t('annot.sending') : t('annot.submit')}
        </button>
      </header>

      <div className="ak-anno-body">
        <div className="ak-anno-canvas-wrap">
          {item.review?.hasCompare ? (
            <button
              className={`ak-compare-pill${compare ? ' on' : ''}`}
              type="button"
              aria-pressed={compare}
              title={t('annot.compareAria')}
              onClick={() => {
                haptic('tap')
                setCompare((v) => !v)
              }}
            >
              {compare ? t('annot.compareBefore') : t('annot.compareAfter')}
            </button>
          ) : null}
          <div className="ak-anno-stage">
            <canvas
              ref={canvasRef}
              className="ak-anno-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
        </div>

        <div className="ak-anno-side">
          {/* 1 タップ指示スタンプ: チャットの定型チップと同じ「1 行 + ＋ ドロワー」。
              設定タブで非表示にしたときはツール列のスタンプボタンから開く（§3.4） */}
          {bars.annotation ? (
          <div className="ak-anno-bar">
            <span className="ak-anno-bar-title">{t('annot.stampsTitle')}</span>
            <div className="ak-anno-stamps-scroll" role="group" aria-label={t('annot.stampsAria')}>
              {STAMPS.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  className={`ak-anno-stamp${activeStamp === def.id ? ' on' : ''}`}
                  aria-pressed={activeStamp === def.id}
                  aria-label={t(def.key)}
                  title={`${t(def.key)} — ${def.instruction}`}
                  disabled={!ready || busy}
                  onClick={() => applyStamp(def.id)}
                >
                  <span aria-hidden="true">{def.emoji}</span>
                  {t(def.key)}
                </button>
              ))}
            </div>
            <button
              className="ak-anno-more"
              type="button"
              onClick={() => {
                haptic('tap')
                setStampSheet(true)
              }}
              aria-label={t('annot.stampsMore')}
            >
              +
            </button>
          </div>
          ) : null}

          {error ? <div className="ak-error ak-anno-error">{error}</div> : null}

          <div className="ak-anno-tools">
            {TOOLS.map((toolDef) => (
              <button
                key={toolDef.id}
                type="button"
                className={`ak-anno-tool${tool === toolDef.id ? ' on' : ''}`}
                onClick={() => {
                  haptic('tap')
                  setTool(toolDef.id)
                }}
                aria-pressed={tool === toolDef.id}
                aria-label={t(toolDef.key)}
                title={t(toolDef.key)}
              >
                <span aria-hidden="true">{toolDef.icon}</span>
              </button>
            ))}
            <button
              type="button"
              className="ak-anno-tool"
              onClick={() => {
                haptic('tap')
                undo()
              }}
              disabled={!count}
              aria-label={t('annot.undo')}
              title={t('annot.undo')}
            >
              <span aria-hidden="true">↩</span>
            </button>
            {/* スタンプ帯を隠したときの入口（SPEC-PILOT-V7 §3.4）。帯があるときは出さない */}
            {!bars.annotation ? (
              <button
                type="button"
                className="ak-anno-tool"
                onClick={() => {
                  haptic('tap')
                  setStampSheet(true)
                }}
                disabled={!ready || busy}
                aria-label={t('annot.stampTool')}
                title={t('annot.stampTool')}
              >
                <span aria-hidden="true">🏷️</span>
              </button>
            ) : null}
            <input
              className="ak-anno-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('annot.notePlaceholder')}
              maxLength={200}
            />
          </div>

          {/* 最下部の判断バー: ✅ 完了（検収 OK）/ 📂 アーカイブ の 2 つだけ */}
          {item.status === 'blocked' ? (
            <div className="ak-anno-actions">
              <button
                className="ak-anno-done"
                type="button"
                disabled={approving || busy || closing}
                aria-busy={approving}
                onClick={approve}
              >
                {approving ? t('annot.sending') : t('annot.doneShort')}
              </button>
              <HoldButton
                tone="danger"
                ms={800}
                label={t('annot.archiveShort')}
                hint={t('annot.holdHint')}
                disabled={busy || closing}
                onFire={archive}
              />
            </div>
          ) : null}
        </div>
      </div>

      {stampSheet ? (
        <Sheet title={t('annot.stampSheetTitle')} onClose={() => setStampSheet(false)}>
          <div className="list">
            {STAMPS.map((def) => (
              <button
                key={def.id}
                className="list-item"
                onClick={() => {
                  applyStamp(def.id)
                  setStampSheet(false)
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-title" style={{ display: 'block' }}>
                    {def.emoji} {t(def.key)}
                  </span>
                  <span className="row-sub" style={{ display: 'block' }}>
                    {def.instruction}
                  </span>
                </span>
                <span aria-hidden="true" className="ak-anno-more-chev">
                  ›
                </span>
              </button>
            ))}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            {t('annot.stampsHint')}
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}

/**
 * スタンプ付きストロークのそばに `#1 💥` のアンバーピルを描く（SPEC §3.3 ②）。
 *
 * ピルはストロークの終点に置き、キャンバス外へはみ出さないよう内側へ寄せる。
 * アンバー＋濃色文字なので、赤入れやスクショ上でも読める。
 */
function drawStampPills(ctx, strokes, w, h) {
  const pills = stampPills(strokes)
  if (!pills.length) return
  ctx.save()
  ctx.font = '700 11px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'
  for (const p of pills) {
    const pts = p.stroke?.points || []
    const [ax, ay] = pts[pts.length - 1] || [0, 0]
    const text = `#${p.index} ${p.emoji}`
    const padX = 6
    const pw = ctx.measureText(text).width + padX * 2
    const ph = 18
    const r = ph / 2
    const x = Math.max(1, Math.min(ax - pw / 2, w - pw - 1))
    const y = Math.max(1, Math.min(ay + 8, h - ph - 1))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + pw, y, x + pw, y + ph, r)
    ctx.arcTo(x + pw, y + ph, x, y + ph, r)
    ctx.arcTo(x, y + ph, x, y, r)
    ctx.arcTo(x, y, x + pw, y, r)
    ctx.closePath()
    ctx.fillStyle = AMBER
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 0, 0, .35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = AMBER_INK
    ctx.fillText(text, x + padX, y + ph / 2 + 0.5)
  }
  ctx.restore()
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
