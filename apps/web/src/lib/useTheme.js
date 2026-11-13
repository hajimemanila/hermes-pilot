import { useCallback, useSyncExternalStore } from 'react'
import { getResolvedTheme, getThemePref, onThemeChange, setThemePref } from './theme.js'

/**
 * テーマ設定の購読フック。`pref` は設定値（dark/light/system）、`resolved` は実際の色。
 * `setPref` は保存と DOM 反映まで行う（呼び出し側で再描画は不要）。
 * @returns {{pref: 'dark'|'light'|'system', resolved: 'dark'|'light', setPref: (v: string) => void}} 状態
 */
export function useTheme() {
  const pref = useSyncExternalStore(onThemeChange, getThemePref, () => 'dark')
  const resolved = useSyncExternalStore(onThemeChange, getResolvedTheme, () => 'dark')
  const setPref = useCallback((value) => {
    setThemePref(value)
  }, [])
  return { pref, resolved, setPref }
}
