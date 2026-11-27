/**
 * 添付とスニペット一覧のシート（`ChatPane.jsx` から切り出し）。
 *
 * 中身は「隠した 3 つの file input（画像・カメラ・ファイル）」「＋ から開く添付シート」
 * 「定型文の一覧シート」の 3 つだけ。開閉は `useChatComposer.js` が持ち、ここは
 * props で受け取って描く（開いているかを ChatPane 側で二重に持たない）。
 *
 * 設計: `docs/SPEC-COHERENCE-SWEEP-3.md` §3.3 / Batch CSW3-2（移動のみ）。
 */

import React from 'react'
import { Icon, Sheet } from '../../components/Ui.jsx'
import { t } from '../../i18n/lang.js'

export function ChatAttachSheets({
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
}) {
  return (
    <>
      <input
        ref={imgInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={camInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {attachSheet ? (
        <Sheet title={t('chat.attachSheetTitle')} onClose={() => setAttachSheet(false)}>
          <div className="list">
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                imgInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">{t('chat.pickImage')}</span>
                <span className="row-sub" style={{ display: 'block' }}>{t('chat.pickImageSub')}</span>
              </span>
              <Icon name="chevron" />
            </button>
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                camInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">{t('chat.takePhoto')}</span>
                <span className="row-sub" style={{ display: 'block' }}>{t('chat.takePhotoSub')}</span>
              </span>
              <Icon name="chevron" />
            </button>
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                fileInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">{t('chat.pickFile')}</span>
                <span className="row-sub" style={{ display: 'block' }}>
                  {t('chat.pickFileSub')}
                </span>
              </span>
              <Icon name="chevron" />
            </button>
            <button className="list-item" onClick={pasteFromClipboard}>
              <span style={{ flex: 1 }}>
                <span className="row-title">{t('chat.fromClipboard')}</span>
                <span className="row-sub" style={{ display: 'block' }}>{t('chat.fromClipboardSub')}</span>
              </span>
              <Icon name="chevron" />
            </button>
            {/* 定型チップ帯を隠したときの入口（SPEC-PILOT-V7 §3.4）。帯があるときは出さない */}
            {!bars.chat ? (
              <button
                className="list-item"
                onClick={() => {
                  setAttachSheet(false)
                  setSnippetSheet(true)
                }}
              >
                <span style={{ flex: 1 }}>
                  <span className="row-title">{t('chat.snippetsFromPlus')}</span>
                  <span className="row-sub" style={{ display: 'block' }}>{t('chat.snippetsFromPlusSub')}</span>
                </span>
                <Icon name="chevron" />
              </button>
            ) : null}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            {t('chat.attachNote')}
          </div>
        </Sheet>
      ) : null}

      {snippetSheet ? (
        <Sheet title={t('chat.snippetsTitle')} onClose={() => setSnippetSheet(false)}>
          <div className="list">
            {snippets.map((s) => (
              <button key={s.id} className="list-item" onClick={() => insertSnippet(s)}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-title" style={{ display: 'block' }}>
                    {s.label}
                    {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>{t('chat.bar')}</span> : null}
                    {s.custom ? <span className="pill" style={{ marginLeft: 6 }}>{t('chat.mine')}</span> : null}
                  </span>
                  <span
                    className="row-sub"
                    style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {s.text.replace(/\n/g, ' ')}
                  </span>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            {t('chat.snippetNote')}
            {t('chat.snippetCustomNote')}
          </div>
        </Sheet>
      ) : null}
    </>
  )
}
