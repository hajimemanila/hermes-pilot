import { playSound } from './soundFx.js'
import { getResolvedTheme } from './theme.js'
import { celebrate, getActiveVibe, prefersReducedMotion, setVibe } from './vibe.js'

let activeShellAnim = null

/**
 * イベントまたはフォーカス要素から画面座標を抽出する。
 * キーボード操作や座標欠落時は要素中心、それも無ければ画面中央を返す。
 *
 * @param {Event|{clientX?:number, clientY?:number, currentTarget?:Element}|null|undefined} event
 * @param {{innerWidth?:number, innerHeight?:number}} [win]
 * @returns {{x: number, y: number}}
 */
export function originFromEvent(event, win = globalThis.window) {
  const vw = Number(win?.innerWidth) || 390
  const vh = Number(win?.innerHeight) || 844
  const cx = Number(event?.clientX)
  const cy = Number(event?.clientY)
  if (Number.isFinite(cx) && Number.isFinite(cy) && (cx > 0 || cy > 0)) {
    return { x: Math.round(cx), y: Math.round(cy) }
  }
  try {
    const rect = event?.currentTarget?.getBoundingClientRect?.()
    if (rect && rect.width > 0 && rect.height > 0) {
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }
    }
  } catch {
    /* 要素矩形が取れない環境では画面中央にフォールバック */
  }
  return { x: Math.round(vw / 2), y: Math.round(vh / 2) }
}

/**
 * `.shell` に対して GPU 合成プロパティ（transform / opacity）のみの軽量トランジションを再生する。
 * 連打時は前のアニメーションを即キャンセルし、レイアウト再計算を起こさない。
 */
function animateShell(keyframes, options, doc = globalThis.document) {
  try {
    const el = doc?.querySelector?.('.shell') ?? doc?.body
    if (!el || typeof el.animate !== 'function') return null
    try {
      activeShellAnim?.cancel?.()
    } catch {
      /* ignore */
    }
    const anim = el.animate(keyframes, options)
    activeShellAnim = anim
    anim.onfinish = () => {
      if (activeShellAnim === anim) activeShellAnim = null
    }
    return anim
  } catch {
    return null
  }
}

/**
 * Dopamine ⇄ Serotonin をスムーズな世界転移演出付きで切り替える。
 * 画面全体の scale/shake はリペイント時のカクつき（不具合感）の原因になるため使わず、
 * Dark/Light と同じ View Transitions API（円形イリス展開）＋ Canvas 光粒・衝撃輪で表現する。
 *
 * @param {'dopamine'|'serotonin'} nextMode
 * @param {Event|null|undefined} [event]
 * @returns {'dopamine'|'serotonin'}
 */
export function switchVibeWithTransition(nextMode, event) {
  const prev = getActiveVibe()
  if (prev === nextMode || prefersReducedMotion() || typeof document === 'undefined') {
    return setVibe(nextMode)
  }

  const { x, y } = originFromEvent(event)
  const vw = Number(globalThis.window?.innerWidth) || 390
  const vh = Number(globalThis.window?.innerHeight) || 844
  const maxR = Math.ceil(Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y)))

  let applied = nextMode
  const applyAndFx = () => {
    applied = setVibe(nextMode)
    if (applied === 'dopamine') {
      celebrate('vibeWarp', { x, y, sound: false })
      playSound('approve')
    }
  }

  if (typeof document.startViewTransition === 'function') {
    try {
      const vt = document.startViewTransition(applyAndFx)
      vt.ready
        ?.then?.(() => {
          if (applied === 'dopamine') {
            document.documentElement?.animate?.(
              {
                clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`],
              },
              {
                duration: 420,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                pseudoElement: '::view-transition-new(root)',
              },
            )
          } else {
            document.documentElement?.animate?.(
              { opacity: [0, 1] },
              {
                duration: 240,
                easing: 'ease-out',
                pseudoElement: '::view-transition-new(root)',
              },
            )
          }
        })
        ?.catch?.(() => {})
      return applied
    } catch {
      /* startViewTransition 失敗時は下のフェードへフォールバック */
    }
  }

  applyAndFx()
  animateShell([{ opacity: 0.78 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
  return applied
}

/**
 * Dark / Light / System テーマをタップ起点の円形イリス展開（View Transitions API）で切り替える。
 * 非対応環境や reduced-motion 時は軽量フェードまたは即時適用へフォールバックする。
 *
 * @param {'dark'|'light'|'system'} pref
 * @param {(p: 'dark'|'light'|'system') => void} applyFn
 * @param {Event|null|undefined} [event]
 */
export function switchThemeWithTransition(pref, applyFn, event) {
  if (typeof applyFn !== 'function') return
  const prevResolved = getResolvedTheme()
  if (prefersReducedMotion() || typeof document === 'undefined') {
    applyFn(pref)
    return
  }

  const { x, y } = originFromEvent(event)
  const vw = Number(globalThis.window?.innerWidth) || 390
  const vh = Number(globalThis.window?.innerHeight) || 844
  const maxR = Math.ceil(Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y)))

  if (typeof document.startViewTransition === 'function') {
    try {
      const vt = document.startViewTransition(() => {
        applyFn(pref)
      })
      vt.ready
        ?.then?.(() => {
          if (getResolvedTheme() === prevResolved) return
          document.documentElement?.animate?.(
            {
              clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`],
            },
            {
              duration: 340,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              pseudoElement: '::view-transition-new(root)',
            },
          )
        })
        ?.catch?.(() => {})
      return
    } catch {
      /* startViewTransition 失敗時は下のフェードへフォールバック */
    }
  }

  applyFn(pref)
  if (getResolvedTheme() !== prevResolved) {
    animateShell([{ opacity: 0.76 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
  }
}
