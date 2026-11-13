import React, { useState } from 'react'
import { api } from '../api.js'
import { HoldButton } from './Ui.jsx'
import { useI18n } from '../i18n/index.js'

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
export function CloseActions({ board, taskId, note = '', notify, onClosed, label }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)

  const fire = async (action) => {
    setBusy(action)
    try {
      const res = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(taskId)}/close`, {
        method: 'POST',
        body: { action, note: String(note ?? '').slice(0, 400) },
      })
      const doneMsg = res?.noop ? t('close.alreadyDone') : t('close.done')
      const cancelMsg = res?.noop ? t('close.alreadyCancelled') : t('close.cancelled')
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
        {open ? t('close.menuClose') : (label ?? t('close.title'))}
      </button>
      {open ? (
        <>
          <div className="row-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
            {t('close.help')}
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <HoldButton
              tone="safe"
              label={t('close.doneLabel')}
              sub={t('close.doneSub')}
              disabled={Boolean(busy)}
              onFire={() => fire('done')}
            />
            <HoldButton
              tone="danger"
              label={t('close.cancelLabel')}
              sub={t('close.cancelSub')}
              disabled={Boolean(busy)}
              onFire={() => fire('cancel')}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
