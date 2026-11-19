/**
 * チャットタブの 2 カラム（SPEC-ver-0-2-1 §2.3 / 決定 Q1=A）の面の割り当て。
 *
 * 820px 以上のチャットは「左 = セッション一覧＋下端スタック / 右 = タイムラインだけ」に
 * 分ける。左へ移す 4 グループの名前と順番をここだけに置き、JSX
 * （`features/ChatPane.jsx`）とテスト（`web/test/chatSplit.test.js`）で二重管理しない。
 *
 * 右カラムに置いてよいのは最小ヘッダとタイムラインだけで、ここに挙げた 4 グループは
 * 1 つも置かない（＝右の縦を全部本文に使う・Q1=A）。
 *
 * 境界（820）は `lib/layout.js` の `SPLIT_WIDE_MIN` が唯一の定義。ここでは再定義しない
 * （`web/test/layoutBreakpoints.test.js` が `@media` の集合一致を見ている）。
 */

/** 左カラム下端の固定スタック（上から順）。 */
export const CHAT_SPLIT_STACK = ['banners', 'chips', 'snippets', 'composer']

/** 右カラムに置く部品（最小ヘッダ＋タイムラインだけ）。 */
export const CHAT_SPLIT_DETAIL = ['head', 'timeline']

/**
 * そのグループに属する DOM の印（クラス名）。右カラムに 1 つも出ないことを
 * `web/test/chatSplit.test.js` が機械で見る。
 * @param {string} group グループ名
 * @returns {string[]} クラス名の配列（未知のグループは空）
 */
export function chatGroupMarks(group) {
  switch (group) {
    case 'banners':
      // オフライン .banner / 完了レポート .chat-report-banner / Architect 進行バー / 仕様書バナー
      return ['banner', 'chat-report-banner', 'job-bar', 'spec-banner']
    case 'chips':
      // プロファイル札とリポジトリ札（1 ペインでは .chat-head の中にある）
      return ['prof-chip', 'repo-chip']
    case 'snippets':
      return ['action-bar']
    case 'composer':
      // 添付レール・定型チップ帯の下に付く入力欄（読み取り専用の .composer-ro も同じ枠）
      return ['composer', 'composer-ro', 'attach-rail']
    default:
      return []
  }
}

/**
 * 左カラム下端の固定スタックのグループ名（この順で上から積む）。
 * JSX はこの配列をそのまま map するので、順番の正本はここ。
 * @returns {string[]} `['banners', 'chips', 'snippets', 'composer']` のコピー
 */
export function chatSplitChrome() {
  return CHAT_SPLIT_STACK.slice()
}
