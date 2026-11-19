/**
 * レイアウト境界の唯一の定義（SPEC-i18n-resp §2 B3）。
 *
 * これまで「2 ペインに切り替える幅」は CSS（`styles.css` の `@media (min-width: 820px)`）と
 * JS（`lib/useSplitLayout.js` の `SPLIT_QUERY`）に 820 が 2 つ手書きされていて、
 * 片方だけ直すと「右ペインは出るが中身はシート」等の半端な状態になった。
 * **数値はここだけに置く**。CSS 側は同じ値の `@media` を持つが、ずれたら
 * `web/test/layoutBreakpoints.test.js` が落ちる（3 つ目の境界を作らせない）。
 *
 * - `SPLIT_MIN`（680）: 一覧＋詳細の**狭い 2 ペイン**に入る幅（左 280px）。
 * - `SPLIT_WIDE_MIN`（820）: 現行の 2 ペイン（左 review 380 / tasks 360）。
 */

/** 狭い 2 ペイン（左ペイン 280px）に入る最小幅。 */
export const SPLIT_MIN = 680
/** 現行の 2 ペイン（左ペイン 380 / 360）に入る最小幅。 */
export const SPLIT_WIDE_MIN = 820

/** 左ペイン（一覧）の幅。`styles.css` の `--split-master-w` と同じ値。 */
export const MASTER_W = { narrow: 280, wide: { review: 380, tasks: 360, chat: 380 } }

/**
 * `@media` 用のクエリ文字列。
 * @param {number} min 最小幅（px）
 * @returns {string} `(min-width: <min>px)`
 */
export function query(min) {
  return '(min-width: ' + min + 'px)'
}

/** 狭い 2 ペイン以上のクエリ（680px〜）。 */
export const SPLIT_QUERY = query(SPLIT_MIN)
/** 現行の 2 ペイン以上のクエリ（820px〜）。 */
export const WIDE_QUERY = query(SPLIT_WIDE_MIN)
