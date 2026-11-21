/**
 * ソフトキーボードの高さを CSS 変数（`--kb-inset`）にする。
 *
 * `position: fixed` の下端要素（トースト・バナー等）は**レイアウトビューポート**基準で配置される。
 * Android Chrome / iOS Safari のソフトキーボードは既定で「ビジュアルビューポートだけ」を縮めるので、
 * fixed の下端要素はキーボードの裏に隠れたまま動かない（実測: 端末タブの
 * 「ターミナルが未接続です」トーストがキーボードの下で見えず、押しても何も起きないように見えた）。
 *
 * そこで `VisualViewport` の縮み分を `--kb-inset`（px）へ書き、`html[data-kb='1']` の間だけ
 * CSS 側がその値を使う。キーボードが無いときは `0px` に戻すので、既存の
 * `bottom: calc(var(--nav-h) + …)` はそのまま効く。
 */

/** これ未満の縮みは URL バー／ツールバーの伸縮とみなす（ソフトキーボードは 250px 以上）。 */
export const KB_MIN_INSET = 140

/**
 * キーボードが覆っている高さ（px）。ソフトキーボードが無ければ 0。
 * @param {Window} [win] 差し替え（テスト用）
 * @returns {number} px（0 = キーボード無し）
 */
export function keyboardInset(win = globalThis.window) {
  const vv = win?.visualViewport
  if (!vv || typeof win.innerHeight !== 'number') return 0
  const hidden = win.innerHeight - (Number(vv.height) || 0) - (Number(vv.offsetTop) || 0)
  if (!Number.isFinite(hidden)) return 0
  const px = Math.round(hidden)
  return px >= KB_MIN_INSET ? px : 0
}

/**
 * いまの値で CSS 変数とフラグを更新する。
 * @param {Window} [win] 差し替え（テスト用）
 * @returns {number} 入れた値（0 = キーボード無し）
 */
export function applyViewportVars(win = globalThis.window) {
  const root = win?.document?.documentElement
  if (!root) return 0
  const inset = keyboardInset(win)
  root.style.setProperty('--kb-inset', `${inset}px`)
  root.dataset.kb = inset > 0 ? '1' : '0'
  return inset
}

/**
 * 追従を開始する（初回も 1 回呼ぶ）。戻り値は後始末。
 * @param {Window} [win] 差し替え（テスト用）
 * @returns {Function} 解除
 */
export function installViewportVars(win = globalThis.window) {
  const vv = win?.visualViewport
  if (!vv || typeof vv.addEventListener !== 'function') return () => {}
  const update = () => applyViewportVars(win)
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  win.addEventListener('orientationchange', update)
  update()
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    win.removeEventListener('orientationchange', update)
  }
}
