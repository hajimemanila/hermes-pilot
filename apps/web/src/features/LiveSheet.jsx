import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Sheet, relTime } from '../components/Ui.jsx'

/** 秒を「12m34s」形式に。 */
function fmtElapsed(sec) {
  if (sec == null) return '—'
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * ライブ進捗シート。「いま何が動いているか」を5秒ごとに更新する。
 * 実行中ターン（Discord 等のセッション）と実行中タスクを並べ、タスクはその場で中断できる。
 */
export function LiveSheet({ onClose, notify, onAbortTask }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api('/api/live')
      setData(d)
    } catch (e) {
      setData({ ok: false, reason: e.message, turns: [], tasks: [] })
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    return () => clearInterval(id)
  }, [load])

  const abort = async (t) => {
    setBusy(true)
    try {
      await api(`/api/boards/${encodeURIComponent(t.board)}/tasks/${encodeURIComponent(t.id)}/abort`, {
        method: 'POST',
        body: { reason: 'モバイルから中断' },
      })
      notify?.(`中断しました: ${t.id}`)
      await load()
      onAbortTask?.()
    } catch (e) {
      notify?.(e.message)
    } finally {
      setBusy(false)
    }
  }

  const turns = data?.turns ?? []
  const tasks = data?.tasks ?? []

  return (
    <Sheet title="ライブ（5秒更新）" onClose={onClose}>
      {data && !data.ok ? <div className="empty">{data.reason}</div> : null}

      <div className="strip" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className={`stat ${turns.length ? 'warn' : ''}`}>
          <span className="stat-k">実行中ターン</span>
          <span className="stat-v">{turns.length}</span>
        </div>
        <div className={`stat ${tasks.length ? 'warn' : ''}`}>
          <span className="stat-k">実行中タスク</span>
          <span className="stat-v">{tasks.length}</span>
        </div>
      </div>

      <div className="list-head">
        <span>ターン</span>
      </div>
      <div className="list">
        {turns.map((t) => (
          <div key={t.sessionId} className="row static">
            <span className="dot running" />
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">{t.title}</span>
              <span className="row-sub">
                {t.platform || t.source || '—'} ・ {fmtElapsed(t.elapsedSec)}
                {t.lastTool ? ` ・ tool: ${t.lastTool.name}` : t.lastActivity ? ` ・ ${t.lastActivity}` : ''}
              </span>
              {t.lastTool?.at ? (
                <span className="row-sub" style={{ opacity: 0.75 }}>
                  最終ツール {relTime(t.lastTool.at)}
                  {t.expiresInSec != null ? ` ・ リース残 ${fmtElapsed(t.expiresInSec)}` : ''}
                </span>
              ) : null}
            </span>
            {t.discordUrl ? (
              <button
                className="link"
                onClick={() => window.open(t.discordUrl, '_blank', 'noopener')}
                aria-label="Discord で開く"
              >
                #
              </button>
            ) : null}
          </div>
        ))}
        {!turns.length ? <div className="empty">動いているターンはありません</div> : null}
      </div>

      <div className="list-head">
        <span>タスク</span>
      </div>
      <div className="list">
        {tasks.map((t) => (
          <div key={`${t.board}:${t.id}`} className="row static">
            <span className="dot running" />
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">{t.title}</span>
              <span className="row-sub">
                {t.boardName || t.board} ・ {fmtElapsed(t.elapsedSec)}
                {t.workerPid ? ` ・ pid ${t.workerPid}` : ''}
              </span>
            </span>
          </div>
        ))}
        {!tasks.length ? <div className="empty">実行中のタスクはありません</div> : null}
      </div>

      {tasks.length ? (
        <div style={{ marginTop: 12 }}>
          <HoldButton
            label={`実行中タスク ${tasks.length} 件を中断`}
            sub="長押し ・ reclaim → block"
            tone="danger"
            disabled={busy}
            onFire={async () => {
              for (const t of tasks) await abort(t)
            }}
          />
        </div>
      ) : null}

      <div className="row-sub" style={{ padding: '12px 2px 18px', lineHeight: 1.7 }}>
        state.db のターンリースとカンバンの running を合成しています（読み取り専用）。
        ターンの中断はチャットの停止ボタン、タスクは上の長押しで中断します。
      </div>
    </Sheet>
  )
}
