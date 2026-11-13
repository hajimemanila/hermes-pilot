import React, { useRef, useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Loader, RefreshButton, Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { pendingCount } from '../lib/akapenView.js'
import { fmtCost } from '../lib/format.js'

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
const BOARD_KEY = 'hm.board'

/** 直前に選んでいたボードの slug。 */
function readStoredBoard() {
  try {
    return localStorage.getItem(BOARD_KEY)
  } catch {
    return null
  }
}

export function TasksPane({ overview, refresh, notify, initialInbox = null }) {
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [tasks, setTasks] = useState([])
  const [detail, setDetail] = useState(null)
  const [killOpen, setKillOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  // Diff プレビュー（開いたときだけ取得）
  const [diff, setDiff] = useState(null)
  const [patch, setPatch] = useState(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [boardSheetOpen, setBoardSheetOpen] = useState(false)
  // 使用量（24h）
  const [usageData, setUsageData] = useState(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const [liveTurns, setLiveTurns] = useState(0)
  const [inboxCount, setInboxCount] = useState(0)
  const [inboxOpen, setInboxOpen] = useState(false)
  // ウィジェットからのディープリンク（?open=inbox&task=…）を1回だけ反映
  const [inboxFocus, setInboxFocus] = useState(null)

  // シートは履歴に載せる（Android の戻るで閉じる／ディープリンクと実装を一本化）
  const INBOX_HASH = '#inbox'
  // 自分で履歴を積んだかどうか。WebAPK は URL に #inbox:task を付けて開くことがあり、
  // その場合は push しない → ✕ の history.back() が効かない。積んだ時だけ back() する。
  const pushedInbox = useRef(false)
  const openInbox = useCallback((taskId = null) => {
    setInboxFocus(taskId ?? null)
    setInboxOpen(true)
    if (!window.location.hash.startsWith(INBOX_HASH)) {
      window.history.pushState({ hmSheet: 'inbox' }, '', taskId ? `${INBOX_HASH}:${taskId}` : INBOX_HASH)
      pushedInbox.current = true
    }
  }, [])
  const closeInbox = useCallback(() => {
    setInboxOpen(false)
    if (pushedInbox.current && window.location.hash.startsWith(INBOX_HASH)) {
      pushedInbox.current = false
      window.history.back()
      return
    }
    // 自分で積んでいない（URL に最初からハッシュがある）場合は、ハッシュだけ消す
    if (window.location.hash.startsWith(INBOX_HASH)) {
      window.history.replaceState({}, '', window.location.pathname + window.location.search)
    }
  }, [])
  useEffect(() => {
    const onPop = () => {
      if (!window.location.hash.startsWith(INBOX_HASH)) {
        pushedInbox.current = false
        setInboxOpen(false)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const initialInboxApplied = useRef(false)

  // App からのディープリンク要求（マウント後に届くので確実）
  useEffect(() => {
    const onOpen = (e) => openInbox(e?.detail?.task ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    window.addEventListener('hm:open-inbox', onOpen)
    return () => window.removeEventListener('hm:open-inbox', onOpen)
  }, [])

  // ウィジェットの行タップ（?open=inbox&task=…）でシートを開く。1回だけ。
  useEffect(() => {
    if (!initialInbox || initialInboxApplied.current) return
    initialInboxApplied.current = true
    openInbox(initialInbox.task ?? null)
  }, [initialInbox, openInbox])

  const loadBoards = useCallback(async () => {
    try {
      const d = await api('/api/boards')
      const list = d.boards ?? []
      setBoards(list)
      setBoard((cur) => {
        if (cur) return cur
        // 直前に見ていたボードを優先（タブ往復・再読み込みで選択が飛ばないように）
        const saved = readStoredBoard()
        if (saved && list.some((b) => b.slug === saved)) return saved
        return list.find((b) => b.current)?.slug ?? list.find((b) => !b.archived)?.slug ?? list[0]?.slug ?? null
      })
    } catch (e) {
      notify(e.message)
    } finally {
      setLoading(false)
    }
  }, [notify])

  // 選択したボードを覚える（TasksPane はタブ切替でアンマウントされるため）
  useEffect(() => {
    try {
      if (board) localStorage.setItem(BOARD_KEY, board)
    } catch {
      /* 保存できなくても動作に影響なし */
    }
  }, [board])

  const loadTasks = useCallback(
    async (slug) => {
      if (!slug) return false
      try {
        const d = await api(`/api/boards/${encodeURIComponent(slug)}/tasks?limit=60`)
        setTasks(d.tasks ?? [])
        return true
      } catch (e) {
        setTasks([])
        notify(e.message)
        return false
      }
    },
    [notify],
  )

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  // 使用量は60秒ごと（サーバ側も30秒キャッシュ）
  useEffect(() => {
    let alive = true
    const load = () =>
      api('/api/usage?hours=24')
        .then((d) => alive && setUsageData(d))
        .catch(() => {})
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // 実行中ターン数（タイルの点。10秒ごと）
  useEffect(() => {
    let alive = true
    const load = () =>
      api('/api/live')
        .then((d) => alive && setLiveTurns(Number(d?.counts?.turns ?? 0)))
        .catch(() => {})
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 10_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // 承認待ちの件数（15秒ごと）
  const loadInbox = useCallback(async () => {
    try {
      const d = await api('/api/inbox')
      const items = d?.items ?? []
      setInboxCount(pendingCount(items))
      // 下部ナビのタスクタブの丸バッジ（注釈 1377.jpg の赤）を、この一覧と同じデータで同期する
      try {
        window.dispatchEvent(new CustomEvent('hm:inbox-items', { detail: { items } }))
      } catch {
        /* noop */
      }
    } catch {
      /* 表示だけなので握る */
    }
  }, [])

  useEffect(() => {
    loadInbox()
    const id = setInterval(() => document.visibilityState === 'visible' && loadInbox(), 15_000)
    return () => clearInterval(id)
  }, [loadInbox])

  const refreshAll = useCallback(async () => {
    const results = await Promise.all([
      board ? loadTasks(board) : Promise.resolve(true),
      loadInbox(),
      refresh ? refresh() : Promise.resolve(true),
    ])
    return results[0] !== false
  }, [board, loadTasks, loadInbox, refresh])

  useEffect(() => {
    if (!board) return
    loadTasks(board)
    const id = setInterval(() => document.visibilityState === 'visible' && loadTasks(board), 5000)
    return () => clearInterval(id)
  }, [board, loadTasks])

  const openTask = async (t) => {
    setDetail({ loading: true, ...t })
    setDiff(null)
    setPatch(null)
    try {
      const d = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(t.id)}`)
      setDetail(d)
    } catch (e) {
      notify(e.message)
      setDetail(null)
    }
  }

  /** 差分サマリ（アコーディオンを開いたときだけ取りに行く）。 */
  const loadDiff = async (id) => {
    if (diff?.files) return
    setDiff({ loading: true })
    try {
      const d = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(id)}/diff`)
      setDiff(d)
    } catch (e) {
      setDiff({ ok: false, reason: e.message })
    }
  }

  /** 1ファイルのパッチ。 */
  const loadPatch = async (id, file) => {
    if (patch?.path === file) {
      setPatch(null)
      return
    }
    setPatch({ path: file, loading: true })
    try {
      const d = await api(
        `/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(id)}/diff?file=${encodeURIComponent(file)}`,
      )
      setPatch({ ...d, path: file })
    } catch (e) {
      setPatch({ path: file, ok: false, reason: e.message })
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

  /** 緊急停止（新規作業のみ停止）。実行中は完走する。 */
  const pauseAction = async () => {
    setBusy(true)
    try {
      await api('/api/gateway/pause', { method: 'POST', body: { confirm: 'PAUSE', reason: 'mobile' } })
      notify('一時停止しました（新規のみ）')
      refresh?.()
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }

  /** 緊急停止の解除（安全方向なので1タップ）。 */
  const resumeAction = async () => {
    setBusy(true)
    try {
      await api('/api/gateway/resume', { method: 'POST', body: { confirm: 'RESUME' } })
      notify('再開しました')
      refresh?.()
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
  const paused = overview?.paused ?? { engaged: false }

  return (
    <div className="pane">
      {paused.engaged ? (
        <div className="banner paused">
          一時停止中（新規の受付を止めています{paused.reason ? ` ・ ${paused.reason}` : ''}）
          <button onClick={resumeAction} disabled={busy}>
            再開
          </button>
        </div>
      ) : null}

      {inboxCount ? (
        <button className="inbox-bar" onClick={() => openInbox(null)}>
          <span>承認待ち {inboxCount} 件</span>
          <span className="inbox-bar-go">回答する ›</span>
        </button>
      ) : null}

      <div className="strip">
        <div className={`stat ${ops?.ok === false ? 'bad' : ops ? 'good' : ''}`}>
          <span className="stat-k">SystemOps</span>
          <span className="stat-v">{ops ? (ops.ok ? 'Clean' : 'Blocked') : '—'}</span>
        </div>
        <button className="stat" onClick={() => setUsageOpen(true)} aria-label="使用量の内訳">
          <span className="stat-k">24h</span>
          <span className="stat-v">{usageData?.ok ? fmtCost(usageData.totals.cost) : '—'}</span>
        </button>
        <div className="stat">
          <span className="stat-k">メモリ</span>
          <span className="stat-v">{mem ? `${mem.percent}%` : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-k">ディスク</span>
          <span className="stat-v">{disk ? `${disk.percent}%` : '—'}</span>
        </div>
        <button
          className={`stat ${running ? 'warn' : ''}`}
          onClick={() => setLiveOpen(true)}
          aria-label="いま動いているもの"
        >
          <span className="stat-k">
            稼働{liveTurns ? <i className="live-dot" title={`ターン ${liveTurns} 件`} /> : null}
          </span>
          <span className="stat-v">{running + liveTurns}</span>
        </button>
      </div>

      <div className="chip-row">
        <button
          className="chip-more"
          onClick={() => setBoardSheetOpen(true)}
          aria-label="ボード一覧を開く"
          title="ボード一覧"
        >
          <Icon name="chevron" size={16} />
        </button>
        <div className="chips">
          {boards.map((b) => (
            <button
              key={b.slug}
              className={`chip${board === b.slug ? ' on' : ''}`}
              onClick={() => setBoard(b.slug)}
            >
              <span>{b.icon}</span>
              {b.name}
            </button>
          ))}
        </div>
      </div>

      {boardSheetOpen && (
        <Sheet title="ボード" onClose={() => setBoardSheetOpen(false)}>
          <div className="list">
            {boards.map((b) => (
              <button
                key={b.slug}
                className={`list-item${board === b.slug ? ' on' : ''}`}
                onClick={() => {
                  setBoard(b.slug)
                  setBoardSheetOpen(false)
                }}
              >
                <span style={{ flex: '0 0 auto' }}>{b.icon}</span>
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {b.name}
                </span>
                <span style={{ flex: '0 0 auto', color: 'var(--muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                  {[
                    b.counts?.running ? `実行中 ${b.counts.running}` : null,
                    b.counts?.blocked ? `停止 ${b.counts.blocked}` : null,
                    b.archived ? '保管' : null,
                    b.lastActivityAt ? relTime(b.lastActivityAt * 1000) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {board === b.slug ? <span style={{ color: 'var(--accent)', flex: '0 0 auto' }}>✓</span> : null}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      <div className="list-head">
        <span>タスク</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            className="link"
            onClick={() => {
              haptic('tap')
              setCaptureOpen(true)
            }}
          >
            ＋ 起票
          </button>
          <RefreshButton variant="link" onRefresh={refreshAll} />
        </span>
      </div>

      {loading ? <Loader label="読み込み中…" /> : null}
      {!loading && !tasks.length ? <div className="empty">タスクがありません</div> : null}

      <div className="list">
        {tasks.map((t) => (
          <button
            key={t.id}
            className="row"
            onClick={() => {
              haptic('tap')
              openTask(t)
            }}
          >
            <span className={`dot ${t.status}`} />
            <span className="row-main">
              <span className="row-title">{t.title}</span>
              <span className="row-sub">
                {STATUS_LABEL[t.status] ?? t.status}
                {t.status === 'running' && t.elapsedSec != null ? ` ・ ${Math.floor(t.elapsedSec / 60)}分` : ''}
                {t.failures ? ` ・ 失敗${t.failures}` : ''}
                {t.completedAt ? ` ・ ${relTime(t.completedAt)}` : ''}
              </span>
              {t.git?.head ? (
                <span className="git-badge">
                  <span className="git-sha">{t.git.head}</span>
                  <span className="git-subject">{t.git.subject || '(メッセージなし)'}</span>
                  {t.git.dirty ? <span className="git-dirty">未コミット</span> : null}
                  {t.discord ? (
                    <span
                      className="git-dc"
                      role="link"
                      tabIndex={0}
                      title="Discord で開く"
                      onClick={(e) => {
                        e.stopPropagation()
                        window.open(t.discord.url, '_blank', 'noopener')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation()
                          window.open(t.discord.url, '_blank', 'noopener')
                        }
                      }}
                    >
                      Discord
                    </span>
                  ) : null}
                </span>
              ) : null}
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
          <div className="warn-card" style={{ marginTop: 8 }}>
            {paused.engaged
              ? `一時停止中です（${paused.engagedAt ?? '時刻不明'}）。実行中のターンは完走しています。`
              : '「一時停止」は新しい仕事だけを止めます。実行中のターンは完走し、再開は1タップです。'}
          </div>
          {paused.engaged ? (
            <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={resumeAction} disabled={busy}>
              再開する（ESTOP 解除）
            </button>
          ) : (
            <div className="hold-grid" style={{ marginTop: 10 }}>
              <HoldButton
                label="一時停止（新規のみ）"
                sub="長押し ・ hermes pause"
                tone="safe"
                disabled={busy}
                onFire={pauseAction}
              />
            </div>
          )}
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

      {captureOpen ? (
        <CaptureSheet
          board={board}
          boards={boards}
          notify={notify}
          onClose={() => setCaptureOpen(false)}
          onCreated={(task) => {
            if (board && task?.board === board) loadTasks(board)
            else if (task?.board) setBoard(task.board)
          }}
        />
      ) : null}

      {usageOpen ? <UsageSheet data={usageData} hours={24} onClose={() => setUsageOpen(false)} /> : null}

      {inboxOpen ? (
        <InboxSheet
          notify={notify}
          onClose={closeInbox}
          onChanged={loadInbox}
          focusTaskId={inboxFocus}
        />
      ) : null}

      {liveOpen ? (
        <LiveSheet
          notify={notify}
          onClose={() => setLiveOpen(false)}
          onAbortTask={() => board && loadTasks(board)}
        />
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
            <Loader label="詳細を読み込み中…" />
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

              {detail.git?.head ? (
                <>
                  <div className="kv">
                    <span>コミット</span>
                    <b className="mono">
                      {detail.git.head}
                      {detail.git.branch ? ` (${detail.git.branch})` : ''}
                    </b>
                  </div>
                  <div className="kv">
                    <span>メッセージ</span>
                    <b className="git-msg">{detail.git.subject || '—'}</b>
                  </div>
                  <button
                    className="accordion"
                    onClick={() => {
                      if (diff?.loading) return
                      if (diff) setDiff(null)
                      else loadDiff(detail.id)
                    }}
                  >
                    <span className="acc-title">
                      変更ファイル
                      {diff?.ok ? (
                        <span className="diff-sum">
                          <span className="add">+{diff.total.add}</span> <span className="del">−{diff.total.del}</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="acc-caret">{diff ? '▾' : '▸'}</span>
                  </button>
                  {diff ? (
                    diff.loading ? (
                      <div className="row-sub hm-btn-inner" style={{ padding: '6px 4px' }}>
                        <Spinner size={12} />
                        <span>読み込み中…</span>
                      </div>
                    ) : diff.ok ? (
                      <div className="diff-list">
                        {(diff.files ?? []).map((f) => (
                          <div key={f.path}>
                            <button
                              className={`diff-row${patch?.path === f.path ? ' on' : ''}`}
                              onClick={() => loadPatch(detail.id, f.path)}
                            >
                              <span className="diff-path mono">{f.path}</span>
                              <span className="diff-nums">
                                {f.binary ? (
                                  <span className="git-dirty">binary</span>
                                ) : (
                                  <>
                                    <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
                                  </>
                                )}
                              </span>
                            </button>
                            {patch?.path === f.path ? (
                              patch.loading ? (
                                <div className="row-sub hm-btn-inner" style={{ padding: '6px 10px' }}>
                                  <Spinner size={12} />
                                  <span>読み込み中…</span>
                                </div>
                              ) : patch.ok ? (
                                <pre className="patch">{patch.text}</pre>
                              ) : (
                                <div className="row-sub" style={{ padding: '6px 10px' }}>
                                  {patch.reason}
                                </div>
                              )
                            ) : null}
                          </div>
                        ))}
                        {!(diff.files ?? []).length ? <div className="empty">差分なし</div> : null}
                        {diff.truncated ? <div className="row-sub">（100ファイルまで表示）</div> : null}
                        {diff.dirty ? (
                          <div className="row-sub">未コミットの変更があります（表示はコミット分のみ）</div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="row-sub" style={{ padding: '6px 4px' }}>
                        {diff.reason}
                      </div>
                    )
                  ) : null}
                </>
              ) : null}

              {detail.discord?.url ? (
                <button
                  className="btn dc-btn"
                  onClick={() => window.open(detail.discord.url, '_blank', 'noopener')}
                >
                  Discord スレッドで開く
                </button>
              ) : null}

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
