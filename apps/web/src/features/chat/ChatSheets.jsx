/**
 * シート類（添付・定型文・Spec Seed・仕様書 MD・新しい会話はヘッドの外・ドロワー・
 * 完了レシート・バブルメニュー）を `ChatPane.jsx` から切り出した
 * （`docs/SPEC-COHERENCE-SWEEP-3.md` §3.3 / Batch CSW3-5）。
 *
 * 移動のみ: 値・文字列・分岐・順序は変えていない。開閉の state は呼び出し側が持ち、
 * ここは「渡された開閉フラグで描く」だけ（開閉フラグを 2 か所に割らない）。
 * 添付・定型文の state は `useChatComposer` の戻り（`composer`）をそのまま受け取る。
 */

import React from 'react'
import { MissionReceiptSheet } from '../MissionReceiptSheet.jsx'
import { SpecSeedSheet } from '../SpecSeedSheet.jsx'
import { ChatAttachSheets } from './ChatAttachSheets.jsx'
import { ChatDrawer } from './ChatDrawer.jsx'
import { ChatBubbleMenu } from './ChatTimeline.jsx'

/**
 * @param {object} args
 * @param {object} args.composer `useChatComposer` の戻り（添付・定型文・入力欄）
 * @param {boolean} args.seedOpen 📝 Seed シートが開いているか
 * @param {string} args.seedBoard 起票先のボード
 * @param {string|null} args.repo いまのリポジトリ
 * @param {string|null} args.chat 起票元の会話
 * @param {(msg: string) => void} args.notify
 * @param {() => void} args.onCloseSeed
 * @param {() => void} args.onSeeded Seed から仕様策定を始めた後
 * @param {React.ReactNode} args.specMdSheet 仕様書(MD)プレビュー（`useChatChrome` が組む）
 * @param {boolean} args.drawerOpen
 * @param {() => void} args.onCloseDrawer
 * @param {string} args.drawerTitle
 * @param {object} args.listProps `ChatSessionList` へ渡す束
 * @param {object|null} args.receiptCtx 完了レシートの対象
 * @param {() => void} args.onCloseReceipt
 * @param {object|null} args.bubbleMenu 開いているバブルメニュー
 * @param {() => void} args.onCloseBubbleMenu
 * @param {string|null} args.sid
 * @param {string} args.title
 * @param {object|null} args.readonly 読み取り専用で開いている会話
 */
export function ChatSheets({
  composer,
  seedOpen,
  seedBoard,
  repo,
  chat,
  notify,
  onCloseSeed,
  onSeeded,
  specMdSheet,
  drawerOpen,
  onCloseDrawer,
  drawerTitle,
  listProps,
  receiptCtx,
  onCloseReceipt,
  bubbleMenu,
  onCloseBubbleMenu,
  sid,
  title,
  readonly,
}) {
  const {
    attachSheet,
    setAttachSheet,
    snippetSheet,
    setSnippetSheet,
    snippets,
    insertSnippet,
    pasteFromClipboard,
    addFiles,
    imgInputRef,
    camInputRef,
    fileInputRef,
    bars,
    sendText,
    setText,
    taRef,
  } = composer

  return (
    <>
      <ChatAttachSheets
        attachSheet={attachSheet}
        setAttachSheet={setAttachSheet}
        snippetSheet={snippetSheet}
        setSnippetSheet={setSnippetSheet}
        snippets={snippets}
        insertSnippet={insertSnippet}
        pasteFromClipboard={pasteFromClipboard}
        addFiles={addFiles}
        imgInputRef={imgInputRef}
        camInputRef={camInputRef}
        fileInputRef={fileInputRef}
        bars={bars}
      />

      {seedOpen ? (
        <SpecSeedSheet
          board={seedBoard}
          repo={repo?.id ?? null}
          chat={chat}
          notify={notify}
          onClose={onCloseSeed}
          onSeeded={onSeeded}
        />
      ) : null}

      {specMdSheet}

      <ChatDrawer open={drawerOpen} onClose={onCloseDrawer} title={drawerTitle} listProps={listProps} />

      {receiptCtx ? (
        <MissionReceiptSheet
          board={receiptCtx.board}
          spec={receiptCtx.spec}
          onClose={onCloseReceipt}
          notify={notify}
        />
      ) : null}

      {bubbleMenu ? (
        <ChatBubbleMenu
          menu={bubbleMenu}
          onClose={onCloseBubbleMenu}
          notify={notify}
          sid={sid}
          title={title}
          repo={repo}
          readonly={readonly}
          sendText={sendText}
          setText={setText}
          taRef={taRef}
        />
      ) : null}
    </>
  )
}
