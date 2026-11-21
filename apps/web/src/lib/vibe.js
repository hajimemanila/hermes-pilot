/**
 * Vibe Mode（`dopamine` ⇄ `serotonin`）の核（React 非依存）。SPEC-PILOT-V5 §3.1 / D24
 *
 * - 保存キーは `HM_STORAGE.VIBE`（`contracts/storage.js`）。既定は **`dopamine`**、ただし端末が
 *   `prefers-reduced-motion: reduce` のときは **`serotonin`** を自動選択する
 * - 適用は `<html data-vibe="dopamine|serotonin">` 1 箇所だけ。CSS 側はこの属性で
 *   装飾を出し分ける（Serotonin は現行 V4 の外観そのまま）
 * - **`Serotonin` でも基本ハプティック（`haptic.js` の `tap`/`action`/`success`）は維持する**。
 *   Vibe が止めるのは過剰な演出（パーティクル・コンボ・効果音）だけ
 * - 連続操作コンボは 20 秒窓。`Serotonin` 時は常に 0（`activeCombo`）
 *
 * このモジュールは Node のテストからそのまま import できる（DOM 依存は try/catch の内側だけ）。
 */

import { haptic, hapticPattern } from './haptic.js'
import { isSoundEnabled, playSound } from './soundFx.js'
import { HM_EVENTS } from '../contracts/events.js'
import { HM_STORAGE } from '../contracts/storage.js'

/** `localStorage` のキー。 */
export const VIBE_KEY = HM_STORAGE.VIBE
/** 選べるモード。 */
export const VIBES = ['dopamine', 'serotonin']
/** 既定（`prefers-reduced-motion: reduce` の端末だけ serotonin になる）。 */
export const DEFAULT_VIBE = 'dopamine'
/** 端末の「視差効果を減らす」設定。 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** コンボが継続する窓（ms）。 */
export const COMBO_WINDOW_MS = 20_000
/** コンボの上限（表示崩れ防止）。 */
export const COMBO_MAX = 99
/** モード変更の通知イベント名。 */
export const VIBE_EVENT = HM_EVENTS.VIBE
/** パーティクル発火イベント名（`FxLayer.jsx` が購読する）。 */
export const FX_EVENT = HM_EVENTS.FX_BURST

/** コンボを進める操作（承認・赤入れ・一括起票）。 */
export const COMBO_KINDS = ['approve', 'stamp', 'fastTrack', 'launch']

/**
 * Dopamine の振動計画。配列は多段バイブ、文字列は既存の `haptic()` の種類。
 * SPEC §3.1: `allClear` / `receipt` は `[10, 30, 16, 30, 40]`、それ以外は `success`。
 */
export const HAPTIC_PLAN = {
  allClear: [10, 30, 16, 30, 40],
  receipt: [10, 30, 16, 30, 40],
  approve: 'success',
  stamp: 'success',
  fastTrack: 'success',
  launch: 'success',
  combo: 'action',
  tap: 'tap',
}

/** Serotonin でも残す基本ハプティック（`haptic.js` の種類）。 */
export const SEROTONIN_HAPTIC = {
  allClear: 'success',
  receipt: 'success',
  approve: 'success',
  stamp: 'success',
  fastTrack: 'success',
  launch: 'success',
  combo: 'action',
  tap: 'tap',
}

/** `localStorage` が無い/壊れている環境でも落ちない取得。 */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** `document` が無い環境（Node テスト）でも落ちない取得。 */
function safeDoc(doc) {
  if (doc) return doc
  try {
    return globalThis.document ?? null
  } catch {
    return null
  }
}

/** `window` が無い環境でも落ちない取得。 */
function safeWin(win) {
  if (win) return win
  try {
    return globalThis.window ?? null
  } catch {
    return null
  }
}

/** 既定の matchMedia 参照（`window.matchMedia` は束縛しないと Illegal invocation になる）。 */
function defaultMatchMedia() {
  try {
    const win = globalThis.window
    if (typeof win?.matchMedia === 'function') return (q) => win.matchMedia(q)
  } catch {
    /* 無い環境 */
  }
  return null
}

/**
 * 保存値・引数を `dopamine` / `serotonin` に正規化する（未知は `null`）。
 * @param {unknown} value
 * @returns {'dopamine'|'serotonin'|null}
 */
export function normalizeVibe(value) {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  if (s === 'dopamine' || s === 'dopa') return 'dopamine'
  if (s === 'serotonin' || s === 'sero' || s === 'calm') return 'serotonin'
  return null
}

/**
 * 端末が「視差効果を減らす」設定か。
 * @param {(() => {matches?: boolean})|{matches?: boolean}|null} [matchMedia] 関数か MQL
 * @returns {boolean}
 */
export function prefersReducedMotion(matchMedia) {
  try {
    let mql = matchMedia ?? defaultMatchMedia()
    if (typeof mql === 'function') mql = mql(REDUCED_MOTION_QUERY)
    if (mql && typeof mql.matches === 'boolean') return mql.matches
  } catch {
    /* matchMedia が壊れている環境は既定扱い */
  }
  return false
}

/**
 * 起動時のモードを決める。保存値が最優先、無ければ端末設定で決める。
 * @param {{getItem: Function}} [storage]
 * @param {Function|{matches?: boolean}} [matchMedia] 端末設定の読み取り
 * @returns {'dopamine'|'serotonin'}
 */
export function getVibe(storage = safeStorage(), matchMedia) {
  let saved = null
  try {
    saved = normalizeVibe(storage?.getItem(VIBE_KEY))
  } catch {
    saved = null
  }
  if (saved) return saved
  return prefersReducedMotion(matchMedia) ? 'serotonin' : DEFAULT_VIBE
}

/**
 * `<html data-vibe>` を書き換える（DOM が無ければ何もしない）。
 * @param {'dopamine'|'serotonin'} mode
 * @param {object} [doc]
 * @returns {'dopamine'|'serotonin'} 反映したモード
 */
export function applyVibe(mode, doc) {
  const next = normalizeVibe(mode) ?? DEFAULT_VIBE
  const d = safeDoc(doc)
  try {
    const el = d?.documentElement
    if (el && el.dataset && el.dataset.vibe !== next) el.dataset.vibe = next
  } catch {
    /* DOM 失敗は致命的ではない */
  }
  return next
}

/** 現在のモード（モジュール状態）。 */
let active = null
/** 購読者。 */
const listeners = new Set()
/** `prefers-reduced-motion` の監視（保存値が無いときだけ追従する）。 */
let motionMql = null

function notify(mode) {
  for (const fn of [...listeners]) {
    try {
      fn(mode)
    } catch {
      /* 購読者の失敗でモード切替を止めない */
    }
  }
}

/**
 * モード変更を購読する。
 * @param {(mode: 'dopamine'|'serotonin') => void} fn
 * @returns {() => void} 解除関数
 */
export function onVibeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 現在のモード。まだ `initVibe()` していなければ保存値/端末設定から解決する。
 * @returns {'dopamine'|'serotonin'}
 */
export function getActiveVibe() {
  if (!active) active = getVibe()
  return active
}

/**
 * モードを保存・適用・通知する（設定タブのセグメント切替が呼ぶ）。
 * @param {unknown} mode `dopamine` / `serotonin`
 * @param {{setItem: Function}} [storage]
 * @param {object} [doc]
 * @param {object} [win] イベント発火先（テスト用）
 * @returns {'dopamine'|'serotonin'} 保存したモード
 */
export function setVibe(mode, storage = safeStorage(), doc, win) {
  const next = normalizeVibe(mode) ?? DEFAULT_VIBE
  applyVibe(next, doc)
  active = next
  try {
    storage?.setItem(VIBE_KEY, next)
  } catch {
    /* 保存できなくても表示は切り替える */
  }
  notify(next)
  const w = safeWin(win)
  try {
    if (typeof w?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
      w.dispatchEvent(new globalThis.CustomEvent(VIBE_EVENT, { detail: { vibe: next } }))
    }
  } catch {
    /* イベント失敗は無視 */
  }
  return next
}

/**
 * 起動時に 1 度だけ呼ぶ。保存値（無ければ端末設定）を適用し、未保存のあいだだけ
 * `prefers-reduced-motion` の変化に追従する。何度呼んでも安全。
 * @param {{storage?: object, doc?: object, win?: object}} [opts]
 * @returns {'dopamine'|'serotonin'} 適用したモード
 */
export function initVibe(opts = {}) {
  const storage = opts.storage ?? safeStorage()
  let saved = null
  try {
    saved = normalizeVibe(storage?.getItem(VIBE_KEY))
  } catch {
    saved = null
  }
  const mode = saved ?? (prefersReducedMotion(opts.matchMedia) ? 'serotonin' : DEFAULT_VIBE)
  applyVibe(mode, opts.doc)
  active = mode

  if (motionMql || saved) return mode
  const w = safeWin(opts.win)
  if (typeof w?.matchMedia !== 'function') return mode
  try {
    motionMql = w.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => {
      if (normalizeVibe(safeStorage()?.getItem(VIBE_KEY))) return
      const next = applyVibe(motionMql.matches ? 'serotonin' : DEFAULT_VIBE, opts.doc)
      active = next
      notify(next)
    }
    if (typeof motionMql.addEventListener === 'function') motionMql.addEventListener('change', onChange)
    else if (typeof motionMql.addListener === 'function') motionMql.addListener(onChange)
  } catch {
    motionMql = null
  }
  return mode
}

/**
 * 連続操作コンボの次状態を返す（純関数）。
 *
 * - `dopamine` で 20 秒以内の連続操作なら `1 -> 2 -> 3 ...`
 * - `serotonin` は常に `0`（演出を出さない）
 * - 窓を超えたら `1` からやり直す（「タイムアウトは 0 扱い」）
 *
 * @param {{combo: number, at: number}|null} prev 直前の状態
 * @param {{vibe?: string, now?: number, windowMs?: number}} opts
 * @returns {{combo: number, at: number}}
 */
export function nextComboState(prev, opts = {}) {
  const vibe = normalizeVibe(opts.vibe) ?? DEFAULT_VIBE
  const now = Number(opts.now) || 0
  const windowMs = Number(opts.windowMs) || COMBO_WINDOW_MS
  if (vibe !== 'dopamine') return { combo: 0, at: 0 }
  const prevCombo = Number(prev?.combo) || 0
  const prevAt = Number(prev?.at) || 0
  const continues = prevCombo > 0 && now >= prevAt && now - prevAt <= windowMs
  const combo = continues ? Math.min(prevCombo + 1, COMBO_MAX) : 1
  return { combo, at: now }
}

/**
 * 表示に使う「いま生きているコンボ数」を返す（純関数）。
 * @param {{combo: number, at: number}|null} state
 * @param {{vibe?: string, now?: number, windowMs?: number}} opts
 * @returns {number} `0` = コンボ無し
 */
export function activeCombo(state, opts = {}) {
  const vibe = normalizeVibe(opts.vibe) ?? DEFAULT_VIBE
  if (vibe !== 'dopamine') return 0
  const combo = Number(state?.combo) || 0
  const at = Number(state?.at) || 0
  if (combo <= 0) return 0
  const now = Number(opts.now) || 0
  const windowMs = Number(opts.windowMs) || COMBO_WINDOW_MS
  if (now < at) return combo
  return now - at <= windowMs ? combo : 0
}

/**
 * コンボ追跡（状態 + 時計）。`vibe` は文字列でも関数（現在モードを読む）でもよい。
 */
export class ComboTracker {
  /**
   * @param {{vibe?: string|Function, now?: () => number, windowMs?: number}} [opts]
   */
  constructor(opts = {}) {
    this.vibe = opts.vibe ?? DEFAULT_VIBE
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.windowMs = Number(opts.windowMs) || COMBO_WINDOW_MS
    this.state = { combo: 0, at: 0 }
    this.lastKind = null
  }

  /** @returns {'dopamine'|'serotonin'} 現在モード */
  get mode() {
    return normalizeVibe(typeof this.vibe === 'function' ? this.vibe() : this.vibe) ?? DEFAULT_VIBE
  }

  /** @returns {number} 生きているコンボ数 */
  get combo() {
    return activeCombo(this.state, { vibe: this.mode, now: this.now(), windowMs: this.windowMs })
  }

  /**
   * 操作 1 回を記録する。
   * @param {string} [kind]
   * @returns {number} 更新後のコンボ数
   */
  bump(kind = 'tap') {
    this.lastKind = kind
    this.state = nextComboState(this.state, {
      vibe: this.mode,
      now: this.now(),
      windowMs: this.windowMs,
    })
    return this.state.combo
  }

  /** @returns {number} 0（次の操作は 1 から） */
  reset() {
    this.state = { combo: 0, at: 0 }
    this.lastKind = null
    return 0
  }
}

/** アプリ共通のコンボ追跡（現在モードを毎回読む）。 */
export const comboTracker = new ComboTracker({ vibe: () => getActiveVibe() })

/**
 * パーティクル発火イベントを投げる（`FxLayer.jsx` が 1 つだけ購読する）。
 * @param {{kind: string, combo?: number, x?: number, y?: number, target?: object}} detail
 * @returns {boolean} 発火したか
 */
export function dispatchFx(detail) {
  const w = safeWin(detail?.target)
  try {
    if (typeof w?.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return false
    const fxDetail = {
      kind: detail.kind,
      combo: Number(detail.combo) || 0,
      x: Number.isFinite(detail.x) ? detail.x : null,
      y: Number.isFinite(detail.y) ? detail.y : null,
    }
    if (Number.isFinite(detail.width)) fxDetail.width = detail.width
    if (Number.isFinite(detail.height)) fxDetail.height = detail.height
    if (typeof detail.sfx === 'string' && detail.sfx) fxDetail.sfx = detail.sfx
    w.dispatchEvent(new globalThis.CustomEvent(FX_EVENT, { detail: fxDetail }))
    return true
  } catch {
    return false
  }
}

/**
 * 操作 1 回ぶんの「祝祭」を実行する（副作用は注入できる）。
 *
 * - `serotonin`: `hapticFn` だけ（パーティクル・効果音なし）。**基本ハプティックは必ず残す**
 * - `dopamine`: 多段ハプティック → `hm:fx-burst` → 効果音（`isSoundEnabled` が真のとき）
 *
 * @param {string} kind `approve` / `stamp` / `fastTrack` / `launch` / `allClear` / `receipt` / `combo`
 * @param {{vibe?: string, combo?: number, x?: number, y?: number,
 *          hapticFn?: Function, vibrateFn?: Function, soundFn?: Function, target?: object}} [opts]
 * @returns {{kind: string, vibe: string, combo: number, haptic: any, fx: boolean, sound: boolean}}
 */
export function celebrateAction(kind, opts = {}) {
  const vibe = normalizeVibe(opts.vibe) ?? DEFAULT_VIBE
  const combo = Number(opts.combo) || 0
  const result = { kind, vibe, combo, haptic: null, fx: false, sound: false }

  if (vibe === 'serotonin') {
    const basic = SEROTONIN_HAPTIC[kind] ?? 'tap'
    if (typeof opts.hapticFn === 'function') opts.hapticFn(basic)
    result.haptic = basic
    return result
  }

  const plan = HAPTIC_PLAN[kind] ?? 'success'
  if (Array.isArray(plan)) {
    if (typeof opts.vibrateFn === 'function') opts.vibrateFn(plan)
    else if (typeof opts.hapticFn === 'function') opts.hapticFn('success')
    result.haptic = plan
  } else {
    if (typeof opts.hapticFn === 'function') opts.hapticFn(plan)
    result.haptic = plan
  }

  result.fx = dispatchFx({
    kind,
    combo,
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    sfx: opts.sfx,
    target: opts.target,
  })

  if (typeof opts.soundFn === 'function') {
    result.sound = Boolean(opts.soundFn(kind, { combo }))
  }
  return result
}

/**
 * 実環境向けの薄い入口。現在モードを読み、コンボを進め、実際の触覚・音・演出を出す。
 *
 * 呼び出し側は `celebrate('fastTrack', { x, y })` の 1 行でよい。
 *
 * @param {string} kind 操作の種類
 * @param {{x?: number, y?: number, storage?: object, sound?: boolean}} [extras]
 * @returns {ReturnType<typeof celebrateAction>}
 */
export function celebrate(kind, extras = {}) {
  const vibe = getActiveVibe()
  const storage = extras.storage ?? safeStorage()
  const combo = COMBO_KINDS.includes(kind) ? comboTracker.bump(kind) : comboTracker.combo
  const withSound = combo > 1 && COMBO_KINDS.includes(kind) ? 'combo' : kind
  let { x, y, width, height } = extras
  if (!Number.isFinite(x) && !Number.isFinite(y)) {
    try {
      const rect = globalThis.document?.activeElement?.getBoundingClientRect?.()
      if (rect && rect.width > 0 && rect.height > 0) {
        x = Math.round(rect.left + rect.width / 2)
        y = Math.round(rect.top + rect.height / 2)
        width = Math.round(rect.width)
        height = Math.round(rect.height)
      }
    } catch {
      /* テスト環境等では座標なし */
    }
  }
  return celebrateAction(kind, {
    vibe,
    combo,
    x,
    y,
    width,
    height,
    sfx: extras.sfx,
    hapticFn: (k) => haptic(k, undefined, storage),
    vibrateFn: (p) => hapticPattern(p, undefined, storage),
    soundFn: (k, o) => {
      if (extras.sound === false) return false
      if (!isSoundEnabled(storage)) return false
      return playSound(withSound ?? k, { combo: o?.combo, storage })
    },
  })
}
