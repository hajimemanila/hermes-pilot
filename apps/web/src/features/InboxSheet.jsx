import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { CloseActions } from '../components/CloseActions.jsx'
import { Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { isAnswered } from '../lib/reviewView.js'
import { localizeError } from '../i18n/lang.js'
import { useI18n } from '../i18n/index.js'
import { sep } from '../lib/format.js'
import { refreshSync, subscribeSync, tickSync } from '../lib/syncSources.js'

/** `blockKind` → 辞書キー（未知は生の値）。 */
const KIND_KEY = {
  needs_input: 'inbox.kind.needsInput',
  dependency: 'inbox.kind.dependency',
  failure: 'inbox.kind.failure',
  untyped: 'inbox.kind.untyped',
}

/**
 * 承認待ちインボックス。
 *
 * blocked（needs_input など）のタスクをボード横断で並べ、**エージェントの質問を読んで
 * コメントで答える**だけ。ステータスは変えない（再開は Discord / ダッシュボード）。
 * 回答済みは既定で折りたたみ、未回答を先に出す（件数も未回答基準）。
 */
export function InboxSheet({ onClose, notify, onChanged, focusTaskId = null }) {
  const { t } = useI18n()
  const [data, setData] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [showAnswered, setShowAnswered] = useState(false)

  /**
   * 一覧を反映する（取得は表の `inbox` = TasksPane と同じ 1 回を共有する）。
   * 送信後の取り直しは `load()` が 1 回だけ取得する。
   */
  const applyInbox = useCallback((d, meta) => {
    if (meta?.error) {
      setData({ ok: false, items: [], reason: meta.error?.message })
      return
    }
    if (d) setData(d)
  }, [])

  const load = useCallback(async () => {
    const r = await refreshSync('inbox')
    applyInbox(r.value, { error: r.error })
  }, [applyInbox])

  useEffect(() => {
    const off = subscribeSync('inbox', applyInbox)
    tickSync('inbox')
    return off
  }, [applyInbox])

  const send = async (it) => {
    const body = (drafts[it.id] ?? '').trim()
    if (!body) {
      notify?.(t('inbox.needComment'))
      return
    }
    setBusyId(it.id)
    try {
      await api(`/api/boards/${encodeURIComponent(it.board)}/tasks/${encodeURIComponent(it.id)}/comment`, {
        method: 'POST',
        body: { body },
      })
      setDrafts((d) => ({ ...d, [it.id]: '' }))
      notify?.(t('inbox.commented'))
      await load()
      onChanged?.()
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusyId(null)
    }
  }

  const unblock = async (it) => {
    const note = (drafts[it.id] ?? '').trim()
    setBusyId(it.id)
    try {
      await api(`/api/boards/${encodeURIComponent(it.board)}/tasks/${encodeURIComponent(it.id)}/unblock`, {
        method: 'POST',
        body: { note },
      })
      setDrafts((d) => ({ ...d, [it.id]: '' }))
      notify?.(t('inbox.reopened', { id: it.id }))
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

  const title = answeredAll.length
    ? t('inbox.titleWithAnswered', { pending: pending.length, answered: answeredAll.length })
    : t('inbox.title', { pending: pending.length })

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
        {it.boardName} ${sep()} {KIND_KEY[it.blockKind ?? 'untyped'] ? t(KIND_KEY[it.blockKind ?? 'untyped']) : it.blockKind}
        {it.recurrences ? ` ${sep()} ${t('inbox.recurrences', { n: it.recurrences })}` : ''}
        {it.blockedAt ? ` ${sep()} ${relTime(it.blockedAt)}` : ''}
        {done ? ` ${sep()} ${t('inbox.answeredWaiting')}` : ''}
      </div>

      {it.reason ? <div className="body-text" style={{ marginTop: 8 }}>{it.reason}</div> : null}

      {it.lastComment ? (
        <div className="row-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
          {t('inbox.lastComment', { author: it.lastComment.author || '—', at: relTime(it.lastComment.at) })}
          <br />
          {it.lastComment.body}
        </div>
      ) : null}

      <textarea
        className="inp"
        rows={2}
        style={{ marginTop: 10, resize: 'vertical', fontFamily: 'inherit' }}
        placeholder={done ? t('inbox.placeholderAnswered') : t('inbox.placeholder')}
        value={drafts[it.id] ?? ''}
        onChange={(e) => setDrafts((d) => ({ ...d, [it.id]: e.target.value.slice(0, 2000) }))}
      />
      <button
        className="btn hm-btn-inner"
        style={{ marginTop: 8, width: '100%' }}
        disabled={busyId === it.id || !(drafts[it.id] ?? '').trim()}
        aria-busy={busyId === it.id}
        onClick={() => {
          haptic('action')
          send(it)
        }}
      >
        {busyId === it.id ? <Spinner size={14} /> : null}
        <span>{busyId === it.id ? t('inbox.sending') : t('inbox.sendComment')}</span>
      </button>

      <button
        className="btn primary hm-btn-inner"
        style={{ marginTop: 6, width: '100%' }}
        disabled={busyId === it.id}
        aria-busy={busyId === it.id}
        onClick={() => {
          haptic('action')
          unblock(it)
        }}
      >
        {busyId === it.id ? <Spinner size={14} /> : null}
        <span>{(drafts[it.id] ?? '').trim() ? t('inbox.answerResume') : t('inbox.resume')}</span>
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
      {data && !data.ok ? <div className="empty">{localizeError(data) || t('inbox.failed')}</div> : null}
      {!allItems.length && data?.ok ? <div className="empty">{t('inbox.empty')}</div> : null}
      {focused ? (
        <div className="row-sub" style={{ marginBottom: 8 }}>
          {t('inbox.focused')}
        </div>
      ) : null}

      {pending.map((it) => card(it, false))}

      {!pending.length && answeredAll.length && data?.ok ? (
        <div className="empty">{t('inbox.allAnswered', { n: answeredAll.length })}</div>
      ) : null}

      {answeredAll.length ? (
        <button
          className="btn"
          style={{ width: '100%', marginBottom: 10 }}
          onClick={() => setShowAnswered((v) => !v)}
        >
          {answeredVisible ? t('inbox.hideAnswered') : t('inbox.showAnswered', { n: answeredAll.length })}
        </button>
      ) : null}
      {answeredVisible ? answered.map((it) => card(it, true)) : null}

      <div className="row-sub" style={{ padding: '6px 2px 18px', lineHeight: 1.7 }}>
        {t('inbox.note')}
      </div>
    </Sheet>
  )
}
