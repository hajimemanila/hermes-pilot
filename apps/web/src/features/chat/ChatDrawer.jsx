/**
 * 会話ドロワー（≡ で開く 1 ペインの会話一覧・`ChatPane.jsx` から切り出し）。
 *
 * 中身は `features/chat/ChatParts.jsx` の `ChatSessionList` そのもの。ここが持つのは
 * 「`Sheet` で包む」ことだけで、一覧の材料（sessions / バッジ / 未読 / ハンドラ）は
 * `listProps` として親から 1 つの束で受け取る。開閉 state（`drawer`）も親の責務のまま。
 *
 * 2 カラム（820px 以上）はドロワーではなく左カラムへ同じ `listProps` を流すので、
 * 一覧の props をここで組み立て直さない（親が 1 回だけ組む・SPEC-ver-0-2-1 §2.3）。
 *
 * 設計: `review/sheets/chat-tasks-split-01.md` §3（境界③）。
 * `open` が false のときは何も描かない（従来の `{drawer ? <Sheet>…` と同じ。
 * `Sheet` は履歴を push するので、閉じているのに mount しない）。
 */

import React from 'react'
import { Sheet } from '../../components/Ui.jsx'
import { ChatSessionList } from './ChatParts.jsx'

/**
 * @param {object} props
 * @param {boolean} props.open 開いているか（親の `drawer` state）
 * @param {() => void} props.onClose 閉じる（親の `setDrawer(false)`）
 * @param {string} props.title シートの見出し（呼び出し側で `t('chat.drawerTitle')`）
 * @param {object} props.listProps `ChatSessionList` へそのまま渡す props の束
 */
export function ChatDrawer({ open, onClose, title, listProps }) {
  if (!open) return null
  return (
    <Sheet title={title} onClose={onClose}>
      <ChatSessionList {...listProps} />
    </Sheet>
  )
}
