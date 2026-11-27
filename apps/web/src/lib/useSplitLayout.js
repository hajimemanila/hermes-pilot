/**
 * 2 ペイン分割の判定（SPEC §7.2 / SPEC-i18n-resp §2 B3）。
 *
 * 閾値は `lib/layout.js` にだけ置く（CSS と JS で二重管理しない）。
 * - `split`: 680px 以上 = 一覧＋詳細の狭い 2 ペイン
 * - `wide`:  820px 以上 = 現行の 2 ペイン（左 380/360）
 *
 * CSS 側（`styles.css` の `@media (min-width: 680px)` / `(min-width: 820px)`）と
 * ずれると「右ペインは出るが中身はシート」等の半端な状態になるため、
 * 定数一致は `web/test/layoutBreakpoints.test.js` が機械で確認する。
 */

import { useEffect, useState } from 'react'
import { SPLIT_QUERY, WIDE_QUERY } from './layout.js'

/** 互換のための再エクスポート（`SPLIT_QUERY` は 680px 以上のクエリ）。 */
export { SPLIT_QUERY, WIDE_QUERY }

/**
 * クエリが今一致するか。`matchMedia` が無い環境（テスト・SSR 相当）は false。
 * @param {string} q `@media` 用のクエリ文字列
 * @returns {boolean}
 */
function matches(q) {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return Boolean(window.matchMedia(q).matches)
  } catch {
    return false
  }
}

/**
 * いま狭い 2 ペイン以上で描くべきか（React 外から読む）。
 * @returns {boolean} 680px 以上なら true
 */
export function isSplitLayout() {
  return matches(SPLIT_QUERY)
}

/**
 * いま現行の 2 ペイン以上で描くべきか（React 外から読む）。
 * @returns {boolean} 820px 以上なら true
 */
function isWideLayout() {
  return matches(WIDE_QUERY)
}

/**
 * 画面幅の変化に追従する 2 ペイン判定。
 * @returns {{ split: boolean, wide: boolean }} split = 680px 以上、wide = 820px 以上
 */
export function useSplitLayout() {
  const [state, setState] = useState(() => ({ split: isSplitLayout(), wide: isWideLayout() }))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const lists = []
    for (const q of [SPLIT_QUERY, WIDE_QUERY]) {
      try {
        lists.push(window.matchMedia(q))
      } catch {
        /* 未対応のクエリは無視 */
      }
    }
    const sync = () =>
      setState((prev) => {
        const next = { split: matches(SPLIT_QUERY), wide: matches(WIDE_QUERY) }
        return prev.split === next.split && prev.wide === next.wide ? prev : next
      })
    const onChange = () => sync()
    sync()
    for (const mql of lists) {
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
      else if (typeof mql.addListener === 'function') mql.addListener(onChange)
    }
    return () => {
      for (const mql of lists) {
        try {
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange)
          else if (typeof mql.removeListener === 'function') mql.removeListener(onChange)
        } catch {
          /* 解除失敗は無視 */
        }
      }
    }
  }, [])
  return state
}
