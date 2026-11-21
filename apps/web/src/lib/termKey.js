/**
 * ターミナル（xterm）へ流すバイト列の決定 — SPEC-enter-enter-discuss-next-ste Q1/Q2 = A。
 *
 * 症状: ターミナルタブで Enter が効かない（実行されない）。共有キー判定
 * （`lib/composerKey.js` の `shouldSendOnEnter`）は**チャット入力欄の 1 消費者だけ**で、
 * ターミナルには元からキーハンドラが無い（＝横取りではない）。原因は 2 つ:
 *   1. フォーカス: タブは `visibility:hidden + inert` で生かしたまま隠れる（`App.jsx` の `TabHost`）
 *      ので、戻ってきても xterm の隠し textarea にフォーカスが無く、キーボードが端末に繋がらない。
 *   2. IME: 日本語入力のまま確定 Enter を押すと、その Enter は PTY へ `\r` として届かない。
 *
 * 契約（レビュー round 1 / すべて A）:
 *   - **Enter はターミナルのホスト（`.term-host`）で自分で拾い、`\r` を PTY へ書く。**
 *     xterm の keydown は同じ textarea の**キャプチャ段**で登録されているので、祖先の
 *     キャプチャ段で `stopPropagation` すれば xterm 側は動かない（書き手は常に 1 つ）。
 *   - **IME 変換中でも実行する**（ターミナルは文章ではなくコマンド。日本語入力のまま
 *     Enter が死ぬのが報告された症状そのもの）。
 *
 * ここは純関数だけを持つ（DOM を触らない）ので `node --test` で固定できる。
 */

/** Enter 1 回が PTY へ書くバイト（CR）。 */
export const TERM_ENTER_BYTES = '\r'

/**
 * Enter 系のキーか。`key` だけでなく `code` と旧 `keyCode` も見る
 * （Android の IME は `key` を省いたり `Process` にしたりする）。
 * @param {{key?: string, code?: string, keyCode?: number}} [event]
 * @returns {boolean}
 */
export function isEnterKey(event = {}) {
  if (!event) return false
  if (event.key === 'Enter') return true
  if (event.code === 'Enter' || event.code === 'NumpadEnter') return true
  return Number(event.keyCode) === 13
}

/**
 * ターミナルの keydown を PTY のバイト列へ変換する。担当外のキーは `null`（xterm に任せる）。
 *
 * `isComposing` は**わざと見ない**（Q2=A）。確定 Enter でも実行する。
 * @param {{key?: string, code?: string, keyCode?: number, isComposing?: boolean}} [event]
 * @returns {string|null}
 */
export function termKeyBytes(event = {}) {
  if (!isEnterKey(event)) return null
  return TERM_ENTER_BYTES
}
