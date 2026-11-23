import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api.js'
import { Sheet } from '../../components/Ui.jsx'
import { useI18n } from '../../i18n/index.js'
import { repoLabel } from '../../lib/repoPicker.js'

/**
 * ボード切替シート。
 *
 * 開くたびに `/api/repos?fresh=1` とボード一覧を再取得し、裏で `git init` した
 * ボード未作成リポジトリも一覧に出してワンタップでボード作成・切替できる。
 */
export function BoardPickerSheet({
  boards = [],
  board = null,
  boardMeta,
  onSelect,
  onRefreshBoards,
  onClose,
  notify,
}) {
  const { t } = useI18n()
  const [unboarded, setUnboarded] = useState([])
  const [creatingId, setCreatingId] = useState('')
  const refreshRef = useRef(onRefreshBoards)
  refreshRef.current = onRefreshBoards

  useEffect(() => {
    let alive = true
    refreshRef.current?.()
    api('/api/repos?fresh=1')
      .then((d) => {
        if (!alive) return
        const list = Array.isArray(d?.repos) ? d.repos : []
        setUnboarded(list.filter((r) => !(r.boards?.length)))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const createBoard = async (r) => {
    if (!r?.id || creatingId) return
    setCreatingId(r.id)
    try {
      const res = await api(`/api/repos/${encodeURIComponent(r.id)}/board`, { method: 'POST', body: {} })
      if (!res?.ok || !res.board) {
        notify?.(res?.error ?? t('chat.boardCreateFailed'))
        return
      }
      notify?.(t('chat.boardCreated', { slug: res.board.slug }))
      await onRefreshBoards?.()
      onSelect(res.board.slug)
      onClose()
    } catch (e) {
      notify?.(e?.message ?? t('chat.boardCreateFailed'))
    } finally {
      setCreatingId('')
    }
  }

  return (
    <Sheet title={t('tasks.board')} onClose={onClose}>
      <div className="pick-list">
        {boards.map((b) => (
          <button
            key={b.slug}
            className={`pick-item${board === b.slug ? ' on' : ''}`}
            onClick={() => {
              onSelect(b.slug)
              onClose()
            }}
          >
            <span aria-hidden="true">{b.icon}</span>
            <span className="pick-main">
              <span className="pick-title">{b.name}</span>
              <span className="pick-sub">{boardMeta(b)}</span>
            </span>
            <span className="pick-meta">{board === b.slug ? '✓' : ''}</span>
          </button>
        ))}

        {unboarded.length ? <div className="sec">{t('tasks.unboardedRepos')}</div> : null}
        {unboarded.map((r) => {
          const busy = creatingId === r.id
          return (
            <button
              key={r.id}
              className="pick-item"
              onClick={() => createBoard(r)}
              disabled={Boolean(creatingId)}
              aria-busy={busy}
            >
              <span aria-hidden="true">📁</span>
              <span className="pick-main">
                <span className="pick-title">{repoLabel(r)}</span>
                <span className="pick-sub">{r.path}</span>
              </span>
              <span className="pick-meta">{busy ? t('chat.creating') : t('tasks.createBoardAction')}</span>
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}
