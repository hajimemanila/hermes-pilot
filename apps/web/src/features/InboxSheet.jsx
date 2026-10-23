import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Sheet, relTime } from '../components/Ui.jsx'

const KIND_LABEL = {
  needs_input: '回答待ち',
  dependency: '依存待ち',
  failure: '失敗',
  untyped: '停止',
}

/**
 * 承認待ちインボックス。
 *
 * blocked（needs_input など）のタスクをボード横断で並べ、**エージェントの質問を読んで
 * コメントで答える**だけ。ステータスは変えない（再開は Discord / ダッシュボード）。
 */
export function InboxSheet({ onClose, notify, onChanged, focusTaskId = null }) {
  const [data, setData] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await api('/api/inbox'))
    } catch (e) {
      setData({ ok: false, items: [], reason: e.message })
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 15_000)
    return () => clearInterval(id)
  }, [load])

  const send = async (it) => {
    const body = (drafts[it.id] ?? '').trim()
    if (!body) {
      notify?.('コメントを入力してください')
      return
    }
    setBusyId(it.id)
    try {
      await api(`/api/boards/${encodeURIComponent(it.board)}/tasks/${encodeURIComponent(it.id)}/comment`, {
        method: 'POST',
        body: { body },
      })
      setDrafts((d) => ({ ...d, [it.id]: '' }))
      notify?.('コメントしました')
      await load()
      onChanged?.()
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusyId(null)
    }
  }

  const allItems = data?.items ?? []
  // ディープリンクで指定されたタスクを先頭に寄せる（並び以外は変えない）
  const items = focusTaskId
    ? [...allItems].sort((a, b) => (a.id === focusTaskId ? -1 : b.id === focusTaskId ? 1 : 0))
    : allItems
  const focused = focusTaskId && allItems.some((it) => it.id === focusTaskId)

  return (
    <Sheet title={`承認待ち${items.length ? `（${items.length}）` : ''}`} onClose={onClose}>
      {data && !data.ok ? <div className="empty">{data.reason ?? '取得できませんでした'}</div> : null}
      {!items.length && data?.ok ? <div className="empty">承認待ちはありません</div> : null}
      {focused ? <div className="row-sub" style={{ marginBottom: 8 }}>ウィジェットから開いたタスクを先頭に表示しています</div> : null}

      {items.map((it) => (
        <div className="card" key={`${it.board}:${it.id}`} style={{ marginBottom: 10 }}>
          <div className="row-title" style={{ fontSize: 13 }}>
            {it.title}
          </div>
          <div className="row-sub" style={{ marginTop: 4 }}>
            {it.boardName} ・ {KIND_LABEL[it.blockKind ?? 'untyped'] ?? it.blockKind}
            {it.recurrences ? ` ・ 再発${it.recurrences}` : ''}
            {it.blockedAt ? ` ・ ${relTime(it.blockedAt)}` : ''}
          </div>

          {it.reason ? <div className="body-text" style={{ marginTop: 8 }}>{it.reason}</div> : null}

          {it.lastComment ? (
            <div className="row-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
              直前のコメント（{it.lastComment.author || '—'} ・ {relTime(it.lastComment.at)}）
              <br />
              {it.lastComment.body}
            </div>
          ) : null}

          <textarea
            className="inp"
            rows={2}
            style={{ marginTop: 10, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="回答・指示を書く（コメントとして記録）"
            value={drafts[it.id] ?? ''}
            onChange={(e) => setDrafts((d) => ({ ...d, [it.id]: e.target.value.slice(0, 2000) }))}
          />
          <button
            className="btn"
            style={{ marginTop: 8, width: '100%' }}
            disabled={busyId === it.id || !(drafts[it.id] ?? '').trim()}
            onClick={() => send(it)}
          >
            {busyId === it.id ? '送信中…' : 'コメントして送る'}
          </button>
        </div>
      ))}

      <div className="row-sub" style={{ padding: '6px 2px 18px', lineHeight: 1.7 }}>
        hermes kanban comment で記録します。ステータスは変えません（再開・アサインは Discord かダッシュボードから）。
        15秒ごとに更新します。
      </div>
    </Sheet>
  )
}
