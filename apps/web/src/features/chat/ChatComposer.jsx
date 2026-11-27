/**
 * 入力欄まわりの見た目（`ChatPane.jsx` から切り出し）。
 *
 * `ChatAttachRail` = 入力欄のすぐ上に出る添付レール、`ChatComposer` = ＋・本文・送信/停止。
 * 状態とハンドラは `useChatComposer.js` が持ち、ここは props で受け取って描くだけ。
 *
 * 設計: `docs/SPEC-COHERENCE-SWEEP-3.md` §3.3 / Batch CSW3-2（移動のみ）。
 * 2 つに分けているのは、1 カラム表示でレールが進行バー・チップ帯の**上**に来る
 * 現在の並び（`{attachNode}{jobBarNode}{specBannerNode}{actionBarNode}{composerNode}`）を
 * そのまま保つため。1 つの部品にまとめるとレールが入力欄の直下へ動いて見た目が変わる。
 */

import React from 'react'
import { Icon } from '../../components/Ui.jsx'
import { t } from '../../i18n/lang.js'
import { shouldSendOnEnter } from '../../lib/composerKey.js'
import { fitComposer } from './ChatParts.jsx'

/** 添付レール（入力欄のすぐ上）。 */
export function ChatAttachRail({ attached, setAttached, objectUrlsRef }) {
  return (
    <>
      {attached.length ? (
        <div className="attach-rail">
          {attached.map((a) => (
            <div className={`attach-item${a.kind === 'image' ? ' img' : ''}`} key={a.id}>
              {a.kind === 'image' ? (
                <img src={a.preview} alt={a.name} />
              ) : (
                <span className="attach-file">
                  📎<span className="attach-file-name">{a.name}</span>
                </span>
              )}
              <button
                className="attach-x"
                aria-label={t('chat.removeAttachment')}
                onClick={() => {
                  if (a.preview) {
                    URL.revokeObjectURL(a.preview)
                    objectUrlsRef.current.delete(a.preview)
                  }
                  setAttached((prev) => prev.filter((x) => x.id !== a.id))
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

/** 入力欄（読み取り専用のときは .composer-ro）。 */
export function ChatComposer({
  readonly,
  streaming,
  text,
  setText,
  attached,
  attachBusy,
  taRef,
  addFiles,
  send,
  onStop,
  onOpenAttachSheet,
}) {
  return (
    <>
      {readonly ? <div className="composer-ro">{t('chat.readonlyComposer')}</div> : null}
      <div className="composer" style={readonly ? { display: 'none' } : undefined}>
        <button
          className="plus"
          aria-label={t('chat.attachAria')}
          onClick={onOpenAttachSheet}
          disabled={streaming}
        >
          <span aria-hidden="true">+</span>
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={t('chat.composerPlaceholder')}
          onChange={(e) => {
            setText(e.target.value)
            fitComposer(e.target)
          }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.items ?? [])]
              .filter((i) => i.kind === 'file' && (i.type || '').startsWith('image/'))
              .map((i) => i.getAsFile())
              .filter(Boolean)
            if (!files.length) return
            e.preventDefault()
            addFiles(files)
          }}
          onKeyDown={(e) => {
            // Enter は改行。送信は丸ボタンと、物理キーボードの Shift+Enter だけ（レビュー enter-key-01）
            if (!shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent?.isComposing })) return
            e.preventDefault()
            send()
          }}
        />
        {streaming ? (
          <button className="send stop" onClick={onStop} aria-label={t('chat.interrupt')}>
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button
            className="send"
            onClick={send}
            disabled={(!text.trim() && !attached.length) || attachBusy}
            aria-label={t('chat.sendAria')}
          >
            <Icon name="send" size={18} />
          </button>
        )}
      </div>
    </>
  )
}
