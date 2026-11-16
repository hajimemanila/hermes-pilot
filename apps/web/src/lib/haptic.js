/**
 * 端末の振動（ハプティック）フィードバック。
 *
 * - Android Chrome / WebAPK で有効。非対応ブラウザ（iOS Safari 等）では安全に無視する。
 * - 設定画面から ON/OFF 可能（localStorage `hm.haptic`、既定は ON）。
 */

export const HAPTIC_KEY = 'hm.haptic'

export const HAPTIC_PATTERNS = {
  tap: 16,
  action: 22,
  heavy: 32,
  success: [8, 35, 10],
  error: [14, 35, 14],
}

/**
 * ハプティック振動が有効か。既定 ON（'0' が保存されているときだけ OFF）。
 * @param {{getItem: Function}} [storage]
 * @returns {boolean}
 */
export function isHapticEnabled(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(HAPTIC_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * ハプティック振動の有効/無効を保存する。
 * @param {boolean} enabled
 * @param {{setItem: Function}} [storage]
 * @returns {boolean} 保存後の状態
 */
export function setHapticEnabled(enabled, storage = globalThis.localStorage) {
  const on = Boolean(enabled)
  try {
    storage?.setItem(HAPTIC_KEY, on ? '1' : '0')
  } catch {
    /* noop */
  }
  return on
}

/**
 * 任意の振動パターン（`navigator.vibrate` の配列形式）を鳴らす。
 *
 * Vibe Mode の Dopamine 演出（多段バイブ）用。ON/OFF の判定は `haptic()` と同じで、
 * `hm.haptic` が OFF なら音も振動も出さない（SPEC-PILOT-V5 §3.1 / D24:
 * Serotonin でも基本ハプティックは維持する、という方針は `haptic()` 側が担う）。
 *
 * @param {number[]|number} pattern 振動パターン
 * @param {{vibrate?: Function}} [nav]
 * @param {{getItem: Function}} [storage]
 * @returns {boolean}
 */
export function hapticPattern(pattern, nav = globalThis.navigator, storage = globalThis.localStorage) {
  if (!Array.isArray(pattern) && typeof pattern !== 'number') return false
  if (!isHapticEnabled(storage)) return false
  if (typeof nav?.vibrate !== 'function') return false
  try {
    return Boolean(nav.vibrate(Array.isArray(pattern) ? pattern.slice() : pattern))
  } catch {
    return false
  }
}

/**
 * 短い振動を鳴らす。
 * @param {'tap'|'action'|'heavy'|'success'|'error'} [kind]
 * @param {{vibrate?: Function}} [nav]
 * @param {{getItem: Function}} [storage]
 * @returns {boolean}
 */
export function haptic(kind = 'tap', nav = globalThis.navigator, storage = globalThis.localStorage) {
  if (!isHapticEnabled(storage)) return false
  if (typeof nav?.vibrate !== 'function') return false
  const pat = HAPTIC_PATTERNS[kind] ?? HAPTIC_PATTERNS.tap
  try {
    return Boolean(nav.vibrate(pat))
  } catch {
    return false
  }
}
