import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { CloseActions } from '../components/CloseActions.jsx'
import { Sheet, relTime } from '../components/Ui.jsx'

const KIND_LABEL = {
  needs_input: '回答待ち',
  dependency: '依存待ち',
  failure: '失敗',
  untyped: '停止',
}

/**
 * 自分が回答済みか。`lastComment` は `{author, body, at}` を返すので、
 * 最新コメントが mobile かつ blocked 以降なら「回答済み（再開待ち）」。
 * ウィジェット側のカウントと同じ判定にして、両サーフェスの数字を揃える。
 */
function isAnswered(item) {
  const c = item?.lastComment
  return Boolean(c && c.author === 'mobile' && (c.at ?? 0) >= (item?.blockedAt ?? 0))
}

/**
 * 承認待ちインボックス。
 *
 * blocked（needs_input など）のタスクをボード横断で並べ、**エージェントの質問を読んで
 * コメントで答える**だけ。ステータスは変えない（再開は Discord / ダッシュボード）。
 * 回答済みは既定で折りたたみ、未回答を先に出す（件数も未回答基準）。
 */
export function InboxSheet({ onClose, notify, onChanged, focusTaskId = null }) {
  const [data, setData] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [showAnswered, setShowAnswered] = useState(false)

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
  const answeredAll = allItems.filter(isAnswered)
  const pendingAll = allItems.filter((it) => !isAnswered(it))

  // ディープリンクで指定されたタスクを、そのグループ内の先頭に寄せる
  const order = (list) =>
    focusTaskId ? [...list].sort((a, b) => (a.id === focusTaskId ? -1 : b.id === focusTaskId ? 1 : 0)) : list
  const pending = order(pendingAll)
  const answered = order(answeredAll)
  const focused = Boolean(focusTaskId) && allItems.some((it) => it.id === focusTaskId)
  // 指定タスクが回答済みなら、そのグループは開いた状態で見せる
  const answeredVisible = showAnswered || (focused && answered.some((it) => it.id === focusTaskId))

  const title = `承認待ち（未回答 ${pending.length}${
    answeredAll.length ? `／回答済み ${answeredAll.length}` : ''
  }）`

  const card = (it, done) => (
    <div
      className="card"
      key={`${it.board}:${it.id}`}
      style={{ marginBottom: 10, opacity: done ? 0.75 : 1 }}
    >
      <div className="row-title" style={{ fontSize: 13 }}>
        {it.title}
      </div>
      <div className="row-sub" style={{ marginTop: 4 }}>
        {it.boardName} ・ {KIND_LABEL[it.blockKind ?? 'untyped'] ?? it.blockKind}
        {it.recurrences ? ` ・ 再発${it.recurrences}` : ''}
        {it.blockedAt ? ` ・ ${relTime(it.blockedAt)}` : ''}
        {done ? ' ・ 回答済み（再開待ち）' : ''}
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
        placeholder={done ? '追加の指示があれば書く（コメントとして記録）' : '回答・指示を書く（コメントとして記録）'}
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

      <CloseActions
        board={it.board}
        taskId={it.id}
        note={drafts[it.id] ?? ''}
        notify={notify}
        onClosed={async () => {
          setDrafts((d) => ({ ...d, [it.id]: '' }))
          await load()
          onChanged?.()
        }}
      />
    </div>
  )

  return (
    <Sheet title={title} onClose={onClose}>
      {data && !data.ok ? <div className="empty">{data.reason ?? '取得できませんでした'}</div> : null}
      {!allItems.length && data?.ok ? <div className="empty">承認待ちはありません</div> : null}
      {focused ? (
        <div className="row-sub" style={{ marginBottom: 8 }}>
          ウィジェットから開いたタスクを先頭に表示しています
        </div>
      ) : null}

      {pending.map((it) => card(it, false))}

      {!pending.length && answeredAll.length && data?.ok ? (
        <div className="empty">未回答はありません（回答済み {answeredAll.length} 件）</div>
      ) : null}

      {answeredAll.length ? (
        <button
          className="btn"
          style={{ width: '100%', marginBottom: 10 }}
          onClick={() => setShowAnswered((v) => !v)}
        >
          {answeredVisible ? '回答済みを隠す' : `回答済み ${answeredAll.length} 件を表示`}
        </button>
      ) : null}
      {answeredVisible ? answered.map((it) => card(it, true)) : null}

      <div className="row-sub" style={{ padding: '6px 2px 18px', lineHeight: 1.7 }}>
        コメントは hermes kanban comment で記録します。不要になった項目は「片付ける」から完了・取消で一覧から外せます
        （どちらも履歴はボードに残ります）。15秒ごとに更新します。
      </div>
    </Sheet>
  )
}
