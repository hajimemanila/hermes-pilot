/**
 * リスト表示の `⋯` メニュー（SPEC-ver-0-2-1 §2.2）。
 *
 * 一列・二列は従来どおり「ピン留め＋ブレスト＋仕様策定（＋元チャット）」のボタン列を残し、
 * リスト表示だけ 1 行に収めるため 1 個の `⋯` に畳む。どちらを出すかは `view` だけで決まる
 * — JSX とテストで規則を二重管理しないよう、判定はこの純関数が正本。
 */

/** メニュー行の並び（仕様で固定・この順で出す）。 */
export const MEMO_MENU_ACTIONS = ['pin', 'brainstorm', 'seed', 'chat']

/**
 * リスト表示のとき `⋯` を出すか。
 * @param {string} view `'one' | 'two' | 'list'`
 */
export function showsListMenu(view) {
  return view === 'list'
}

/**
 * カード内の従来ボタン列（ピン留めを含む）を出すか。リスト表示では `⋯` に畳むので出さない。
 * @param {string} view
 */
export function showsCardButtons(view) {
  return !showsListMenu(view)
}

/**
 * `⋯` シートに並べる行を組み立てる。
 *
 * 「ピン留め/解除」は現在の `pinned` で文言が変わる。「元チャット」は `chatId` を持つメモだけ
 * （チャットを開く導線が無い呼び出しでは `canOpenChat: false` で落とす）。
 * @param {{pinned?: boolean, source?: {chatId?: string}}} memo
 * @param {{canOpenChat?: boolean}} [opts]
 * @returns {Array<{action: string, labelKey: string}>}
 */
export function memoMenuRows(memo, opts = {}) {
  const canOpenChat = opts.canOpenChat !== false
  const rows = [
    { action: 'pin', labelKey: memo?.pinned ? 'notes.unpin' : 'notes.pin' },
    { action: 'brainstorm', labelKey: 'notes.brainstorm' },
    { action: 'seed', labelKey: 'notes.toSeed' },
  ]
  if (canOpenChat && memo?.source?.chatId) {
    rows.push({ action: 'chat', labelKey: 'notes.openChat' })
  }
  return rows
}
