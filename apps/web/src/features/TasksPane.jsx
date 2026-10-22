import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Sheet, relTime } from '../components/Ui.jsx'

const STATUS_LABEL = {
  running: '実行中',
  ready: '待機',
  done: '完了',
  blocked: '停止',
  failed: '失敗',
  archived: '保管',
  todo: 'TODO',
}

/**
 * タスクタブ（ホーム）。SystemOps の状態 + カンバン + キルスイッチ。
 */
export function TasksPane({ overview, refresh, notify }) {
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [tasks, setTasks] = useState([])
  const [detail, setDetail] = useState(null)
  const [killOpen, setKillOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadBoards = useCallback(async () => {
    try {
      const d = await api('/api/boards')
      setBoards(d.boards ?? [])
      setBoard((cur) => cur ?? d.boards?.find((b) => b.current)?.slug ?? d.boards?.find((b) => !b.archived)?.slug ?? d.boards?.[0]?.slug ?? null)
    } catch (e) {
      notify(e.message)
    } finally {
      setLoading(false)
    }
  }, [notify])

  const loadTasks = useCallback(
    async (slug) => {
      if (!slug) return
      try {
        const d = await api(`/api/boards/${encodeURIComponent(slug)}/tasks?limit=60`)
        setTasks(d.tasks ?? [])
      } catch (e) {
        setTasks([])
        notify(e.message)
      }
    },
    [notify],
  )

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  useEffect(() => {
    if (!board) return
    loadTasks(board)
    const id = setInterval(() => document.visibilityState === 'visible' && loadTasks(board), 5000)
    return () => clearInterval(id)
  }, [board, loadTasks])

  const openTask = async (t) => {
    setDetail({ loading: true, ...t })
    try {
      const d = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(t.id)}`)
      setDetail(d)
    } catch (e) {
      notify(e.message)
      setDetail(null)
    }
  }

  const abortTask = async (t) => {
    setBusy(true)
    try {
      const r = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(t.id)}/abort`, {
        method: 'POST',
        body: { reason: 'モバイルから中断' },
      })
      notify(`中断しました（reclaim=${r.reclaimed} / block=${r.blocked}）`)
      setDetail(null)
      loadTasks(board)
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }

  const gatewayAction = async (action) => {
    setBusy(true)
    try {
      const r = await api(`/api/gateway/${action}`, { method: 'POST', body: { confirm: action.toUpperCase() } })
      notify(`${action} を実行しました`)
      setKillOpen(false)
      setConfirmText('')
      refresh?.()
      return r
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }

  const ops = overview?.ops
  const mem = overview?.system?.memory
  const disk = overview?.system?.disk
  const running = tasks.filter((t) => t.status === 'running').length

  return (
    <div className="pane">
      <div className="strip">
        <div className={`stat ${ops?.ok === false ? 'bad' : ops ? 'good' : ''}`}>
          <span className="stat-k">SystemOps</span>
          <span className="stat-v">{ops ? (ops.ok ? 'Clean' : 'Blocked') : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-k">メモリ</span>
          <span className="stat-v">{mem ? `${mem.percent}%` : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-k">ディスク</span>
          <span className="stat-v">{disk ? `${disk.percent}%` : '—'}</span>
        </div>
        <div className={`stat ${running ? 'warn' : ''}`}>
          <span className="stat-k">実行中</span>
          <span className="stat-v">{running}</span>
        </div>
      </div>

      <div className="chips">
        {boards.map((b) => (
          <button key={b.slug} className={`chip${board === b.slug ? ' on' : ''}`} onClick={() => setBoard(b.slug)}>
            <span>{b.icon}</span>
            {b.name}
          </button>
        ))}
      </div>

      <div className="list-head">
        <span>タスク</span>
        <button className="link" onClick={() => board && loadTasks(board)}>
          更新
        </button>
      </div>

      {loading ? <div className="empty">読み込み中…</div> : null}
      {!loading && !tasks.length ? <div className="empty">タスクがありません</div> : null}

      <div className="list">
        {tasks.map((t) => (
          <button key={t.id} className="row" onClick={() => openTask(t)}>
            <span className={`dot ${t.status}`} />
            <span className="row-main">
              <span className="row-title">{t.title}</span>
              <span className="row-sub">
                {STATUS_LABEL[t.status] ?? t.status}
                {t.status === 'running' && t.elapsedSec != null ? ` ・ ${Math.floor(t.elapsedSec / 60)}分` : ''}
                {t.failures ? ` ・ 失敗${t.failures}` : ''}
                {t.completedAt ? ` ・ ${relTime(t.completedAt)}` : ''}
              </span>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        ))}
      </div>

      <button className="kill-open" onClick={() => setKillOpen(true)}>
        <Icon name="bolt" size={18} />
        緊急操作
      </button>

      {killOpen ? (
        <Sheet title="緊急操作（長押しで実行）" onClose={() => !busy && setKillOpen(false)}>
          <div className="warn-card">
            実行中 {running} 件。restart は実行中ターンの完了を待ってから再起動します（最大30分）。
          </div>
          <div className="hold-grid">
            <HoldButton label="新規受付を停止" sub="drain（実行中は完走）" tone="safe" disabled={busy} onFire={() => gatewayAction('drain')} />
            <HoldButton label="ゲートウェイ再起動" sub="restart（Bot が数秒落ちる）" tone="danger" disabled={busy} onFire={() => gatewayAction('restart')} />
            <HoldButton label="強制停止" sub="stop（実行中も切る）" tone="danger" disabled={busy} onFire={() => gatewayAction('stop')} />
            <HoldButton label="受付を再開" sub="start" tone="safe" disabled={busy} onFire={() => gatewayAction('start')} />
          </div>
          <div className="row-sub" style={{ padding: '10px 4px' }}>
            実行結果は設定タブの監査ログに残ります。
          </div>
        </Sheet>
      ) : null}

      {detail ? (
        <Sheet
          title={detail.title ?? detail.id}
          onClose={() => {
            setDetail(null)
            setConfirmText('')
          }}
        >
          {detail.loading ? (
            <div className="empty">読み込み中…</div>
          ) : (
            <>
              <div className="kv">
                <span>状態</span>
                <b>
                  {STATUS_LABEL[detail.status] ?? detail.status}
                  {detail.workerPid ? ` ・ pid ${detail.workerPid}` : ''}
                </b>
              </div>
              <div className="kv">
                <span>開始</span>
                <b>{detail.startedAt ? relTime(detail.startedAt) : '—'}</b>
              </div>
              {detail.branch ? (
                <div className="kv">
                  <span>ブランチ</span>
                  <b className="mono">{detail.branch}</b>
                </div>
              ) : null}
              {detail.body ? <div className="body-text">{detail.body}</div> : null}
              {detail.result ? <div className="body-text result">{detail.result}</div> : null}

              {detail.status === 'running' || detail.workerPid ? (
                <div style={{ marginTop: 12 }}>
                  <HoldButton
                    label="このタスクを中断"
                    sub="reclaim → block（再実行を止める）"
                    tone="danger"
                    disabled={busy}
                    onFire={() => abortTask(detail)}
                  />
                </div>
              ) : null}

              <div className="list-head" style={{ marginTop: 16 }}>
                <span>イベント</span>
              </div>
              <div className="timeline">
                {(detail.events ?? []).map((e, i) => (
                  <div key={i} className="tl">
                    <span className="tl-dot" />
                    <span className="tl-main">
                      <span className="row-title">{e.kind}</span>
                      <span className="row-sub">{relTime(e.at)}</span>
                    </span>
                  </div>
                ))}
                {!(detail.events ?? []).length ? <div className="empty">イベントなし</div> : null}
              </div>
            </>
          )}
        </Sheet>
      ) : null}
    </div>
  )
}
