/**
 * メモ一覧の表示モード（1 列 / 2 列 / リスト）と端末保存（SPEC-ver-0-2-1 §2.2）。
 *
 * `storage` は引数で受ける純関数にしてある — テストから `localStorage` の代わりに
 * 素のオブジェクトを渡せるようにするため。既定は二列（Q2=A）。
 */

import { HM_STORAGE } from '../contracts/storage.js'

export const MEMOS_VIEW_KEY = HM_STORAGE.MEMOS_VIEW

/** 表示モードの正本。未知の値・欠損は `DEFAULT_MEMOS_VIEW` に落とす。 */
export const VIEWS = ['one', 'two', 'list']

export const DEFAULT_MEMOS_VIEW = 'two'

/**
 * 端末に保存された生値を 3 モードのいずれかへ寄せる。
 * @param {unknown} raw `localStorage.getItem` の戻り値
 * @returns {'one'|'two'|'list'}
 */
export function parseMemosView(raw) {
  const v = typeof raw === 'string' ? raw.trim() : ''
  return VIEWS.includes(v) ? v : DEFAULT_MEMOS_VIEW
}

/**
 * 表示モードを端末へ保存する。storage が無い／壊れている環境では黙って false。
 * @param {{setItem?: Function}|null|undefined} storage
 * @param {string} view
 * @returns {boolean} 保存できたら true
 */
export function rememberMemosView(storage, view) {
  if (!storage || typeof storage.setItem !== 'function') return false
  if (!VIEWS.includes(view)) return false
  try {
    storage.setItem(MEMOS_VIEW_KEY, view)
    return true
  } catch {
    return false
  }
}

/** 二列で見せるチェックリストの件数（Q4=A: 先頭 3 件＋「+N」）。 */
export const TWO_COL_CHECK_LIMIT = 3

/**
 * カードに出すチェックリストを表示モードで切る。
 *
 * 二列はカードの高さを 220px に固定するので、先頭 `limit` 件だけ出し、残りは
 * `hidden` 件として `+N` 行に畳む。一列・リストは従来どおり全件（カード全体の
 * タップで編集シートが開くので、隠れた項目もそこで読める）。
 *
 * @param {Array<{id?: string, text?: string, done?: boolean}>} [items]
 * @param {string} view `'one' | 'two' | 'list'`
 * @param {number} [limit]
 * @returns {{visible: Array<object>, hidden: number}}
 */
export function checklistPreview(items = [], view, limit = TWO_COL_CHECK_LIMIT) {
  const list = Array.isArray(items) ? items : []
  if (view !== 'two' || list.length <= limit) return { visible: list, hidden: 0 }
  return { visible: list.slice(0, limit), hidden: list.length - limit }
}

/**
 * 端末から表示モードを読む（未保存・読めない環境は既定の二列）。
 * @param {{getItem?: Function}|null|undefined} storage
 * @returns {'one'|'two'|'list'}
 */
export function readMemosView(storage) {
  if (!storage || typeof storage.getItem !== 'function') return DEFAULT_MEMOS_VIEW
  try {
    return parseMemosView(storage.getItem(MEMOS_VIEW_KEY))
  } catch {
    return DEFAULT_MEMOS_VIEW
  }
}
