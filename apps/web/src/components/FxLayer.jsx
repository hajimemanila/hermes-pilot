import React, { useEffect, useRef, useState } from 'react'
import { COMBO_WINDOW_MS, FX_EVENT, REDUCED_MOTION_QUERY, getActiveVibe, onVibeChange } from '../lib/vibe.js'
import { haptic } from '../lib/haptic.js'
import { useI18n } from '../i18n/index.js'

/**
 * Dopamine の演出レイヤ（SPEC-PILOT-V5 §3.1 / D24 + sakuga-vfx 拡張）。
 *
 * - `hm:fx-burst` を購読し、DOM パーティクル + Canvas 作画 VFX（衝撃線・煙パフ・結晶片・擬音文字）を描く
 * - `position: fixed; pointer-events: none; z-index: 9999` の 1 枚だけを敷く。レイアウト再計算も
 *   タップの横取りもしない（`aria-hidden` で読み上げにも出さない）
 * - コンボ >= 2 のときは `🔥 {n}x COMBO` のピルを 1.8 秒、`allClear` / `receipt` は
 *   `🎉 All Clear!` のフラッシュカードを 2.4 秒出す
 * - **Serotonin では何も出さない**（イベントを無視し、切替時に残骸も消す）
 */

/** パーティクルの数（種類で変える）。 */
const PARTICLE_COUNT = { allClear: 18, receipt: 18, vibeWarp: 18, launch: 16, fastTrack: 16, approve: 12, stamp: 12, combo: 10, send: 5, spark: 4 }

/** 粒の寿命（ms）。SPEC の 450〜750ms に収める。 */
const BURST_MS = 720
/** コンボピルの表示時間（ms）。 */
const COMBO_MS = 1800
/** オールクリアのフラッシュ時間（ms）。 */
const FLASH_MS = 2400
/** Canvas 同時再生バースト上限。 */
const MAX_CANVAS_BURSTS = 6
/** Tier 1〜4 すべてのタップ対象（同期ハプティック保証用）。 */
const HAPTIC_TARGET_SELECTOR =
  '.btn, .chip, .hm-switch, .seed-seg-btn, .seed-toggle, .seed-submit, .report-card-btn, .composer .plus, .composer .send, .chat-report-btn, .pill-btn, .ak-btn, .ak-empty-btn, .ak-thumb-btn, .ak-anno-preview-btn, .receipt-btn, .spec-banner-btn, .job-bar-btn, .job-bar-x, .icon-btn, .prof-chip, .snippet-chip, .settings-nav-chip, .pick-item, .list-item, .row:not(.static), .stat, .spec-bar, .inbox-bar, details > summary, .link, .code-copy, button.t-pill, .nav-item, .ap-act-btn, .ap-recipe-card, .ap-launcher-submit, .ap-deliverable-btn'

/** Tier 1〜3: バネ変形＋作画 VFX 対象。 */
const SAKUGA_SPRING_SELECTOR =
  '.btn, .chip, .hm-switch, .seed-seg-btn, .seed-toggle, .seed-submit, .report-card-btn, .composer .plus, .composer .send, .chat-report-btn, .pill-btn, .ak-btn, .ak-empty-btn, .ak-thumb-btn, .ak-anno-preview-btn, .receipt-btn, .spec-banner-btn, .job-bar-btn, .icon-btn, .prof-chip, .snippet-chip, .settings-nav-chip, details > summary, button.t-pill, .nav-item, .ap-act-btn, .ap-recipe-card, .ap-launcher-submit, .ap-deliverable-btn'

/** Tier 2: 状態切替・セグメント・トグル。 */
const TIER2_SWITCH_SELECTOR = '.hm-switch, .seed-toggle'
const TIER2_SEGMENT_SELECTOR = '.seed-seg-btn, .chip, .prof-chip, .snippet-chip.trigger, .settings-nav-chip'

const SFX_KEY_BY_KIND = {
  fastTrack: 'fx.sfx.fastTrack',
  approve: 'fx.sfx.approve',
  stamp: 'fx.sfx.stamp',
  launch: 'fx.sfx.launch',
  vibeWarp: 'fx.sfx.vibeWarp',
  send: 'fx.sfx.send',
  allClear: 'fx.sfx.allClear',
  receipt: 'fx.sfx.allClear',
  toggle: 'fx.sfx.toggle',
}

function isReducedMotion() {
  try {
    return Boolean(globalThis.window?.matchMedia?.(REDUCED_MOTION_QUERY)?.matches)
  } catch {
    return false
  }
}

function comboPalette(combo = 0) {
  if (combo >= 3) {
    return {
      hues: ['gold', 'gold', 'amber', 'gold-dim'],
      primary: '#fbbf24',
      secondary: '#fde68a',
    }
  }
  if (combo === 2) {
    return {
      hues: ['cyan', 'gold', 'teal', 'gold'],
      primary: '#22d3ee',
      secondary: '#fbbf24',
    }
  }
  return {
    hues: ['teal', 'mint', 'cyan', 'gold-dim'],
    primary: '#2dd4bf',
    secondary: '#5eead4',
  }
}

/**
 * 1 回ぶんの粒を作る（乱数はここだけで使う）。
 * @param {string} kind 演出の種類
 * @param {number} [combo] コンボ数（熱量に応じて配色を変える）
 * @returns {{id: number, dx: number, dy: number, rot: number, delay: number, hue: string}[]}
 */
function makeParticles(kind, combo = 0) {
  const count = PARTICLE_COUNT[kind] ?? 12
  const { hues } = comboPalette(combo)
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5
    const dist = (kind === 'spark' || kind === 'send' ? 24 : 54) + Math.random() * (kind === 'spark' || kind === 'send' ? 32 : 96)
    return {
      id: i,
      dx: Math.round(Math.cos(angle) * dist),
      dy: Math.round(Math.sin(angle) * dist - (kind === 'allClear' ? 26 : kind === 'send' ? 34 : 0)),
      rot: Math.round(Math.random() * 300 - 150),
      delay: Math.round(Math.random() * 90),
      hue: hues[i % hues.length],
    }
  })
}

/**
 * Canvas 作画バースト 1 件分の初期データを生成する。
 */
function createSakugaBurst({ kind, x, y, width, height, sfxText, combo = 0 }) {
  const vw = globalThis.window?.innerWidth || 390
  const vh = globalThis.window?.innerHeight || 844
  const cx = Number.isFinite(x) ? x : vw * 0.5
  const cy = Number.isFinite(y) ? y : vh * 0.38
  const w = Number.isFinite(width) && width > 0 ? width : 84
  const h = Number.isFinite(height) && height > 0 ? height : 36
  const pal = comboPalette(combo)

  const hasImpact =
    kind === 'approve' ||
    kind === 'fastTrack' ||
    kind === 'launch' ||
    kind === 'vibeWarp' ||
    kind === 'allClear' ||
    kind === 'receipt' ||
    kind === 'tapImpact'
  const isTap = kind === 'tap' || kind === 'toggle'
  const rayCount = hasImpact ? 10 : isTap ? 6 : kind === 'spark' || kind === 'send' ? 4 : 6
  const rays = Array.from({ length: rayCount }, (_, i) => {
    const a = (Math.PI * 2 * i) / rayCount + (Math.random() - 0.5) * 0.25
    return {
      angle: a,
      inner: (isTap ? 10 : 12) + Math.random() * 8,
      outer: (hasImpact ? 54 : isTap ? 36 : 30) + Math.random() * 24,
      color: i % 2 === 0 ? pal.primary : pal.secondary,
    }
  })

  const smokeCount = kind === 'spark' || kind === 'send' ? 0 : hasImpact ? 5 : 3
  const smokes = Array.from({ length: smokeCount }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1
    return {
      ox: cx + side * (w * 0.34 + Math.random() * 12),
      oy: cy + h * 0.25 + (Math.random() - 0.5) * 8,
      vx: side * (26 + Math.random() * 32),
      vy: 8 + Math.random() * 16,
      r0: 4.5 + Math.random() * 3.5,
      r1: (hasImpact ? 16 : 12) + Math.random() * 8,
    }
  })

  const chipCount = kind === 'spark' ? 3 : kind === 'send' ? 4 : hasImpact ? 8 : 5
  const chips = Array.from({ length: chipCount }, (_, i) => {
    const a = (Math.PI * 2 * i) / chipCount + Math.random() * 0.4
    const speed = (kind === 'spark' ? 40 : isTap ? 72 : 85) + Math.random() * 65
    return {
      x: cx,
      y: cy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 35,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 10,
      size: (isTap ? 3 : 3.5) + Math.random() * 3,
      color: i % 2 === 0 ? pal.primary : pal.secondary,
    }
  })

  return {
    start: performance.now(),
    duration: kind === 'vibeWarp' ? 440 : hasImpact ? 520 : 380,
    cx,
    cy,
    h,
    hasImpact: hasImpact || isTap,
    irisRing:
      kind === 'vibeWarp'
        ? { maxR: Math.ceil(Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy))) }
        : null,
    trail: kind === 'send' ? { x: cx, y: cy, dy: -165 } : null,
    rays,
    smokes,
    chips,
    sfxText: sfxText || null,
    sfxTilt: (Math.random() - 0.5) * 0.22,
    vw,
    vh,
  }
}

export function FxLayer() {
  const { t } = useI18n()
  const [vibe, setVibeState] = useState(() => getActiveVibe())
  const [bursts, setBursts] = useState([])
  const [combo, setCombo] = useState(null)
  const [flash, setFlash] = useState(null)
  const [scanSweep, setScanSweep] = useState(null)
  const seqRef = useRef(0)
  const timersRef = useRef([])
  const canvasRef = useRef(null)
  const canvasEffectsRef = useRef([])
  const rafRef = useRef(0)
  const comboTimerRef = useRef(0)
  const tRef = useRef(t)
  tRef.current = t

  /** 予約したタイマーをすべて片付ける（アンマウント・モード切替で使う）。 */
  const clearAll = () => {
    for (const id of timersRef.current) clearTimeout(id)
    timersRef.current = []
  }

  const later = (fn, ms) => {
    const id = setTimeout(fn, ms)
    timersRef.current.push(id)
    return id
  }

  const stopCanvasLoop = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    canvasEffectsRef.current = []
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }

  const startCanvasLoop = () => {
    if (rafRef.current || isReducedMotion()) return
    const draw = (now) => {
      if (getActiveVibe() !== 'dopamine' || document.visibilityState === 'hidden') {
        stopCanvasLoop()
        return
      }
      const canvas = canvasRef.current
      if (!canvas) {
        rafRef.current = 0
        return
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        rafRef.current = 0
        return
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const vw = window.innerWidth
      const vh = window.innerHeight
      const targetW = Math.round(vw * dpr)
      const targetH = Math.round(vh * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, vw, vh)

      const alive = []
      for (const fx of canvasEffectsRef.current) {
        const elapsed = now - fx.start
        const p = elapsed / fx.duration
        if (p >= 1) continue
        alive.push(fx)

        const easeOut = 1 - Math.pow(1 - p, 3)

        // 1. Impact ring & radial rays
        if (fx.irisRing) {
          const ir = Math.max(8, fx.irisRing.maxR * easeOut)
          ctx.save()
          ctx.globalAlpha = Math.max(0, (1 - p) * 0.92)
          ctx.strokeStyle = '#22d3ee'
          ctx.lineWidth = Math.max(1.5, 5 * (1 - p))
          ctx.beginPath()
          ctx.arc(fx.cx, fx.cy, ir, 0, Math.PI * 2)
          ctx.stroke()
          ctx.strokeStyle = '#fde68a'
          ctx.lineWidth = Math.max(1, 2 * (1 - p))
          ctx.beginPath()
          ctx.arc(fx.cx, fx.cy, Math.max(4, ir - 4), 0, Math.PI * 2)
          ctx.stroke()
          ctx.restore()
        }
        if (fx.hasImpact && p < 0.7) {
          const rp = p / 0.7
          const rEase = 1 - Math.pow(1 - rp, 2)
          ctx.save()
          ctx.globalAlpha = Math.max(0, 1 - rp) * 0.75
          ctx.strokeStyle = '#fbbf24'
          ctx.lineWidth = 2 * (1 - rp) + 0.5
          ctx.beginPath()
          ctx.arc(fx.cx, fx.cy, 12 + rEase * 46, 0, Math.PI * 2)
          ctx.stroke()

          for (const ray of fx.rays) {
            const r0 = ray.inner + rEase * 14
            const r1 = ray.inner + (ray.outer - ray.inner) * rEase
            ctx.strokeStyle = ray.color
            ctx.lineWidth = 2.2 * (1 - rp)
            ctx.beginPath()
            ctx.moveTo(fx.cx + Math.cos(ray.angle) * r0, fx.cy + Math.sin(ray.angle) * r0)
            ctx.lineTo(fx.cx + Math.cos(ray.angle) * r1, fx.cy + Math.sin(ray.angle) * r1)
            ctx.stroke()
          }
          ctx.restore()
        }

        // 1b. Launch trail (chat prompt submit)
        if (fx.trail) {
          const headY = fx.trail.y + fx.trail.dy * easeOut
          const tailY = fx.trail.y + fx.trail.dy * Math.max(0, easeOut - 0.35)
          const grad = ctx.createLinearGradient(fx.trail.x, tailY, fx.trail.x, headY)
          grad.addColorStop(0, 'rgba(34, 211, 238, 0)')
          grad.addColorStop(0.6, 'rgba(45, 212, 191, 0.85)')
          grad.addColorStop(1, 'rgba(251, 191, 36, 0.95)')
          ctx.save()
          ctx.globalAlpha = Math.max(0, 1 - p)
          ctx.strokeStyle = grad
          ctx.lineWidth = 2.5
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(fx.trail.x, tailY)
          ctx.lineTo(fx.trail.x, headY)
          ctx.stroke()
          ctx.restore()
        }

        // 2. Smoke puffs
        if (fx.smokes.length) {
          ctx.save()
          for (const s of fx.smokes) {
            const sx = s.ox + s.vx * easeOut
            const sy = s.oy + s.vy * easeOut
            const sr = s.r0 + (s.r1 - s.r0) * easeOut
            ctx.globalAlpha = Math.max(0, (1 - p) * 0.36)
            ctx.fillStyle = '#d1fae5'
            ctx.beginPath()
            ctx.arc(sx, sy, sr, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.restore()
        }

        // 3. Crystal chips
        if (fx.chips.length) {
          const sec = elapsed / 1000
          ctx.save()
          for (const c of fx.chips) {
            const px = c.x + c.vx * sec
            const py = c.y + c.vy * sec + 140 * sec * sec
            ctx.save()
            ctx.translate(px, py)
            ctx.rotate(c.rot + c.vrot * sec)
            ctx.globalAlpha = Math.max(0, 1 - p)
            ctx.fillStyle = c.color
            ctx.beginPath()
            ctx.moveTo(0, -c.size)
            ctx.lineTo(c.size * 0.7, 0)
            ctx.lineTo(0, c.size)
            ctx.lineTo(-c.size * 0.7, 0)
            ctx.closePath()
            ctx.fill()
            ctx.restore()
          }
          ctx.restore()
        }

        // 4. Manga SFX lettering (EN/JA localized, clamped inside 390px+ viewport)
        if (fx.sfxText) {
          const sp = Math.min(1, p * 1.15)
          const popScale = sp < 0.25 ? 0.6 + (sp / 0.25) * 0.5 : 1.1 - Math.min(1, (sp - 0.25) / 0.25) * 0.1
          const alpha = sp > 0.65 ? Math.max(0, 1 - (sp - 0.65) / 0.35) : 1
          const sx = Math.max(44, Math.min(vw - 44, fx.cx))
          const sy = Math.max(30, Math.min(vh - 28, fx.cy - fx.h * 0.55 - 14 - easeOut * 14))
          ctx.save()
          ctx.translate(sx, sy)
          ctx.rotate(fx.sfxTilt)
          ctx.scale(popScale, popScale)
          ctx.globalAlpha = alpha
          ctx.font = '900 15px system-ui, -apple-system, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.lineJoin = 'round'
          ctx.lineWidth = 4
          ctx.strokeStyle = 'rgba(11, 18, 22, 0.92)'
          ctx.strokeText(fx.sfxText, 0, 0)
          ctx.fillStyle = '#fde68a'
          ctx.fillText(fx.sfxText, 0, 0)
          ctx.restore()
        }
      }

      canvasEffectsRef.current = alive
      if (alive.length > 0) {
        rafRef.current = requestAnimationFrame(draw)
      } else {
        rafRef.current = 0
        ctx.clearRect(0, 0, vw, vh)
      }
    }
    rafRef.current = requestAnimationFrame(draw)
  }

  useEffect(() => onVibeChange(setVibeState), [])

  useEffect(() => {
    const onBurst = (e) => {
      // Serotonin では演出しない（過剰な装飾だけを止め、ハプティックは呼び出し側が残す）
      if (getActiveVibe() !== 'dopamine') return
      const detail = e?.detail ?? {}
      const kind = String(detail.kind ?? 'combo')
      const id = (seqRef.current += 1)
      const n = Number(detail.combo) || 0

      setBursts((prev) => {
        const next = [...prev, { id, kind, x: detail.x, y: detail.y, particles: makeParticles(kind, n) }]
        // 連打でも DOM を増やしすぎない（直近 4 発まで）
        return next.slice(-4)
      })
      later(() => setBursts((prev) => prev.filter((b) => b.id !== id)), BURST_MS)

      if (!isReducedMotion() && document.visibilityState !== 'hidden') {
        const sfxKey = SFX_KEY_BY_KIND[kind]
        const sfxText = detail.sfx || (sfxKey ? tRef.current(sfxKey) : null)
        const now = performance.now()
        // 直前に click で出した tapImpact の擬音が残っていれば、celebrate の強い擬音へ譲る
        if (sfxText) {
          for (const fx of canvasEffectsRef.current) {
            if (fx.fromClick && now - fx.start < 120) fx.sfxText = null
          }
        }
        const burst = createSakugaBurst({
          kind,
          x: detail.x,
          y: detail.y,
          width: detail.width,
          height: detail.height,
          sfxText,
          combo: n,
        })
        canvasEffectsRef.current = [...canvasEffectsRef.current, burst].slice(-MAX_CANVAS_BURSTS)
        startCanvasLoop()
        if (kind === 'launch' || kind === 'vibeWarp') {
          setScanSweep({ id })
          later(() => setScanSweep((prev) => (prev?.id === id ? null : prev)), 440)
        }
      }

      if (n >= 2) {
        setCombo({ n, id })
        later(() => setCombo((prev) => (prev?.id === id ? null : prev)), COMBO_MS)
      }
      if (n >= 1) {
        document.documentElement.dataset.combo = n >= 3 ? '3' : String(n)
        clearTimeout(comboTimerRef.current)
        comboTimerRef.current = setTimeout(() => {
          delete document.documentElement.dataset.combo
        }, COMBO_WINDOW_MS)
      }
      if (kind === 'allClear' || kind === 'receipt') {
        setFlash({ kind, id })
        later(() => setFlash((prev) => (prev?.id === id ? null : prev)), FLASH_MS)
      }
    }
    window.addEventListener(FX_EVENT, onBurst)
    return () => window.removeEventListener(FX_EVENT, onBurst)
  }, [])

  // 全ボタン・トグル・リスト行でのハプティック同期発火（Serotonin でも基本ハプティックは維持）
  useEffect(() => {
    const onTapHaptic = (e) => {
      const el = e.target?.closest?.(HAPTIC_TARGET_SELECTOR)
      if (!el || el.disabled) return
      haptic('tap')
    }
    document.addEventListener('click', onTapHaptic, { passive: true, capture: true })
    return () => document.removeEventListener('click', onTapHaptic, { capture: true })
  }, [])

  // Dopamine 時のみ、Tier 1〜3 はバネ戻り＋作画フィードバック、Tier 4 は控えめな沈み込みを出す
  useEffect(() => {
    if (vibe !== 'dopamine' || isReducedMotion()) return undefined
    const onClick = (e) => {
      if (getActiveVibe() !== 'dopamine') return
      const el = e.target?.closest?.(HAPTIC_TARGET_SELECTOR)
      if (!el || el.disabled) return

      const isSpringTarget = el.matches(SAKUGA_SPRING_SELECTOR)
      if (!isSpringTarget) {
        // Tier 4（リスト行・サマリ等）は控えめな沈み込みのみ（Canvas 爆発は出さない）
        el.classList.remove('fx-sakuga-lite')
        void el.offsetWidth
        el.classList.add('fx-sakuga-lite')
        later(() => el.classList.remove('fx-sakuga-lite'), 180)
        return
      }

      el.classList.remove('fx-sakuga-pop')
      // reflow 1 回だけで同じアニメーションを再トリガ
      void el.offsetWidth
      el.classList.add('fx-sakuga-pop')
      later(() => el.classList.remove('fx-sakuga-pop'), 340)

      if (document.visibilityState !== 'hidden') {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          const isSwitch = el.matches(TIER2_SWITCH_SELECTOR)
          const isSegment = !isSwitch && el.matches(TIER2_SEGMENT_SELECTOR)
          const isSend = el.classList.contains('send') && !el.classList.contains('stop')
          const isPrimary =
            el.classList.contains('primary') ||
            el.classList.contains('fast-track') ||
            el.classList.contains('seed-submit') ||
            el.classList.contains('ak-empty-btn') ||
            el.classList.contains('ak-new-btn') ||
            (el.classList.contains('spec-banner-btn') && !el.classList.contains('ghost')) ||
            isSend
          const kind = isSwitch || isSegment ? 'toggle' : isPrimary ? 'tapImpact' : 'tap'
          const sfxText = isSwitch
            ? tRef.current('fx.sfx.toggle')
            : isSegment
              ? tRef.current('fx.sfx.tick')
              : isSend
                ? tRef.current('fx.sfx.send')
                : isPrimary
                  ? tRef.current('fx.sfx.tapImpact')
                  : null
          const burst = createSakugaBurst({
            kind,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            sfxText,
          })
          burst.fromClick = true
          canvasEffectsRef.current = [...canvasEffectsRef.current, burst].slice(-MAX_CANVAS_BURSTS)
          startCanvasLoop()
        }
      }
    }
    document.addEventListener('click', onClick, { passive: true, capture: true })
    return () => document.removeEventListener('click', onClick, { capture: true })
  }, [vibe])

  // タブがバックグラウンドに回ったら Canvas ループを止める
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') stopCanvasLoop()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // モードが Serotonin に変わったら残骸を消す（演出は dopamine だけのもの）
  useEffect(() => {
    if (vibe === 'dopamine') return
    clearAll()
    clearTimeout(comboTimerRef.current)
    delete document.documentElement.dataset.combo
    stopCanvasLoop()
    setBursts([])
    setCombo(null)
    setFlash(null)
    setScanSweep(null)
  }, [vibe])

  useEffect(
    () => () => {
      clearAll()
      clearTimeout(comboTimerRef.current)
      delete document.documentElement.dataset.combo
      stopCanvasLoop()
    },
    [],
  )

  const visible = vibe === 'dopamine'

  return (
    <div className={`fx-layer${visible ? '' : ' off'}`} aria-hidden="true">
      <canvas ref={canvasRef} className="fx-canvas" aria-hidden="true" />
      {visible
        ? bursts.map((b) => (
            <div
              key={b.id}
              className={`fx-burst fx-${b.kind}`}
              style={{
                left: b.x == null ? '50%' : `${b.x}px`,
                top: b.y == null ? '38%' : `${b.y}px`,
              }}
            >
              {b.particles.map((p) => (
                <i
                  key={p.id}
                  className={`fx-particle ${p.hue}`}
                  style={{
                    '--fx-dx': `${p.dx}px`,
                    '--fx-dy': `${p.dy}px`,
                    '--fx-rot': `${p.rot}deg`,
                    animationDelay: `${p.delay}ms`,
                  }}
                />
              ))}
            </div>
          ))
        : null}

      {visible && combo ? (
        <div className="fx-combo-pill" key={`c${combo.id}`}>
          {t('fx.combo', { n: combo.n })}
        </div>
      ) : null}

      {visible && flash ? (
        <div className="fx-allclear-card" key={`f${flash.id}`}>
          <span className="fx-allclear-emoji" aria-hidden="true">
            🎉
          </span>
          <span>{t('fx.allClear')}</span>
        </div>
      ) : null}
      {visible && scanSweep ? <div className="fx-scan-sweep" key={`s${scanSweep.id}`} /> : null}
    </div>
  )
}
