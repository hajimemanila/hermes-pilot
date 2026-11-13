/**
 * 端末の振動（ハプティック）フィードバック。
 *
 * - Android Chrome / WebAPK で有効。非対応ブラウザ（iOS Safari 等）では安全に無視する。
 * - 設定画面から ON/OFF 可能（localStorage `hm.haptic`、既定は ON）。
 */

export const HAPTIC_KEY = 'hm.haptic'

export const HAPTIC_PATTERNS = {
  tap: 6,
  action: 10,
  heavy: 20,
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
