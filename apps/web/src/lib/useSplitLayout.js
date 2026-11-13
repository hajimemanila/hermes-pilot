/**
 * タブレット（`>= 820px`）の Master-Detail 2 ペイン分割の判定（SPEC §7.2）。
 *
 * CSS 側は `@media (min-width: 820px)` でレイアウトを切り替えるが、
 * 「右ペインに出す詳細をシート（全画面被せ）で描くか、常設ペインに描くか」は
 * JS 側で決める必要があるため、同じ閾値をここに置いて両者を一致させる。
 */

import { useEffect, useState } from 'react'

/** CSS の `@media (min-width: 820px)` と同じ文字列。 */
export const SPLIT_QUERY = '(min-width: 820px)'
/** 左ペインの幅（CSS 側の `.split-master` と揃える）。 */
export const SPLIT_MASTER_WIDTH = 360

/**
 * いま 2 ペインで描くべきか（React 外から読む）。
 * `matchMedia` が無い環境（テスト・SSR 相当）は false（1 ペイン）。
 * @returns {boolean} 2 ペインなら true
 */
export function isSplitLayout() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return Boolean(window.matchMedia(SPLIT_QUERY).matches)
  } catch {
    return false
  }
}

/**
 * 画面幅の変化に追従する 2 ペイン判定。
 * @returns {boolean} 2 ペインなら true
 */
export function useSplitLayout() {
  const [split, setSplit] = useState(isSplitLayout)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let mql
    try {
      mql = window.matchMedia(SPLIT_QUERY)
    } catch {
      return undefined
    }
    const onChange = (e) => setSplit(Boolean(e.matches))
    setSplit(Boolean(mql.matches))
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
    else if (typeof mql.addListener === 'function') mql.addListener(onChange)
    return () => {
      try {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange)
        else if (typeof mql.removeListener === 'function') mql.removeListener(onChange)
      } catch {
        /* 解除失敗は無視 */
      }
    }
  }, [])
  return split
}
