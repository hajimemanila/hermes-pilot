import React, { useState } from 'react'
import { api } from '../api.js'
import { HoldButton } from './Ui.jsx'

/**
 * 判断待ち・承認待ちを閉じる操作（完了 / 取消）。
 *
 * - 破壊的寄りの操作なので、開く → 長押しで確定 の 2 段階にする（誤タップ対策）
 * - 完了は `hermes kanban complete`、取消は `hermes kanban archive` に対応する
 * - 二重実行は bridge 側が noop で吸収する（連打しても状態は壊れない）
 *
 * @param {{board: string, taskId: string, note?: string, notify?: Function,
 *          onClosed?: Function, label?: string}} props 対象と通知
 */
export function CloseActions({ board, taskId, note = '', notify, onClosed, label = 'この判断待ちを片付ける' }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)

  const fire = async (action) => {
    setBusy(action)
    try {
      const res = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(taskId)}/close`, {
        method: 'POST',
        body: { action, note: String(note ?? '').slice(0, 400) },
      })
      const doneMsg = res?.noop ? 'すでに完了です' : '完了にしました'
      const cancelMsg = res?.noop ? 'すでに取消済みです' : '取消（アーカイブ）しました'
      notify?.(action === 'done' ? doneMsg : cancelMsg)
      setOpen(false)
      onClosed?.(res)
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="close-actions">
      <button className="btn" type="button" onClick={() => setOpen((v) => !v)}>
        {open ? '片付けメニューを閉じる' : label}
      </button>
      {open ? (
        <>
          <div className="row-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
            一覧から外します。上の欄に理由を書いておくと記録に残ります。押しっぱなしで確定します。
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <HoldButton
              tone="safe"
              label="完了にする"
              sub="done — 結果として記録して一覧から外す"
              disabled={Boolean(busy)}
              onFire={() => fire('done')}
            />
            <HoldButton
              tone="danger"
              label="取消（アーカイブ）"
              sub="一覧から消す — 履歴はボードに残る"
              disabled={Boolean(busy)}
              onFire={() => fire('cancel')}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
