import React, { useEffect, useRef, useState } from 'react'
import { FX_EVENT, VIBE_EVENT, getActiveVibe, onVibeChange } from '../lib/vibe.js'
import { useI18n } from '../i18n/index.js'

/**
 * Dopamine の演出レイヤ（SPEC-PILOT-V5 §3.1 / D24）。
 *
 * - `hm:fx-burst` を購読し、1 回につき最大 18 粒の CSS パーティクルを 450〜750ms 描いて即破棄する
 * - `position: fixed; pointer-events: none; z-index: 9999` の 1 枚だけを敷く。レイアウト再計算も
 *   タップの横取りもしない（`aria-hidden` で読み上げにも出さない）
 * - コンボ >= 2 のときは `🔥 {n}x COMBO` のピルを 1.8 秒、`allClear` / `receipt` は
 *   `🎉 All Clear!` のフラッシュカードを 2.4 秒出す
 * - **Serotonin では何も出さない**（イベントを無視し、切替時に残骸も消す）
 */

/** パーティクルの数（種類で変える）。 */
const PARTICLE_COUNT = { allClear: 18, receipt: 18, launch: 16, fastTrack: 16, approve: 12, stamp: 12, combo: 10 }

/** 粒の寿命（ms）。SPEC の 450〜750ms に収める。 */
const BURST_MS = 720
/** コンボピルの表示時間（ms）。 */
const COMBO_MS = 1800
/** オールクリアのフラッシュ時間（ms）。 */
const FLASH_MS = 2400

/**
 * 1 回ぶんの粒を作る（乱数はここだけで使う）。
 * @param {string} kind 演出の種類
 * @returns {{id: number, dx: number, dy: number, rot: number, delay: number, hue: string}[]}
 */
function makeParticles(kind) {
  const count = PARTICLE_COUNT[kind] ?? 12
  const hues = ['gold', 'teal', 'gold-dim', 'mint']
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5
    const dist = 54 + Math.random() * 96
    return {
      id: i,
      dx: Math.round(Math.cos(angle) * dist),
      dy: Math.round(Math.sin(angle) * dist - (kind === 'allClear' ? 26 : 0)),
      rot: Math.round(Math.random() * 300 - 150),
      delay: Math.round(Math.random() * 90),
      hue: hues[i % hues.length],
    }
  })
}

export function FxLayer() {
  const { t } = useI18n()
  const [vibe, setVibeState] = useState(() => getActiveVibe())
  const [bursts, setBursts] = useState([])
  const [combo, setCombo] = useState(null)
  const [flash, setFlash] = useState(null)
  const seqRef = useRef(0)
  const timersRef = useRef([])

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
        const next = [...prev, { id, kind, x: detail.x, y: detail.y, particles: makeParticles(kind) }]
        // 連打でも DOM を増やしすぎない（直近 4 発まで）
        return next.slice(-4)
      })
      later(() => setBursts((prev) => prev.filter((b) => b.id !== id)), BURST_MS)

      if (n >= 2) {
        setCombo({ n, id })
        later(() => setCombo((prev) => (prev?.id === id ? null : prev)), COMBO_MS)
      }
      if (kind === 'allClear' || kind === 'receipt') {
        setFlash({ kind, id })
        later(() => setFlash((prev) => (prev?.id === id ? null : prev)), FLASH_MS)
      }
    }
    window.addEventListener(FX_EVENT, onBurst)
    return () => window.removeEventListener(FX_EVENT, onBurst)
  }, [])

  // モードが Serotonin に変わったら残骸を消す（演出は dopamine だけのもの）
  useEffect(() => {
    if (vibe === 'dopamine') return
    clearAll()
    setBursts([])
    setCombo(null)
    setFlash(null)
  }, [vibe])

  useEffect(() => () => clearAll(), [])

  const visible = vibe === 'dopamine'

  return (
    <div className={`fx-layer${visible ? '' : ' off'}`} aria-hidden="true">
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
    </div>
  )
}
