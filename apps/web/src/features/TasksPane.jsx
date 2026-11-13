import React, { useRef, useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Loader, RefreshButton, Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { pendingCount } from '../lib/reviewView.js'
import { fmtCost } from '../lib/format.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'

/** タスク状態 → 辞書キー（未知は生の値）。 */
const STATUS_KEY = {
  running: 'tasks.status.running',
  ready: 'tasks.status.ready',
  done: 'tasks.status.done',
  blocked: 'tasks.status.blocked',
  failed: 'tasks.status.failed',
  archived: 'tasks.status.archived',
  todo: 'tasks.status.todo',
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
  const { t } = useI18n()
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
  // Spec Launchpad（SPEC §5.4 / D15④）: ボードのリポジトリの SPEC とバッチ
  const [specsInfo, setSpecsInfo] = useState(null)
  const [specSheetOpen, setSpecSheetOpen] = useState(false)
  const [specPath, setSpecPath] = useState(null)
  const [specSel, setSpecSel] = useState([])
  const [specBusy, setSpecBusy] = useState(false)
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
        .then((d) => {
          if (!alive) return
          const turns = Number(d?.counts?.turns ?? 0)
          setLiveTurns(turns)
          try {
            window.dispatchEvent(
              new CustomEvent('hm:live-turns', {
                detail: { turns, items: Array.isArray(d?.turns) ? d.turns : [] },
              }),
            )
          } catch {
            /* noop */
          }
        })
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

  /*
   * Spec Launchpad 用の SPEC 検出（SPEC §5.4）。ボードを変えるたびに 1 回だけ問い合わせる
   * （ファイル走査はサーバ側で安いが、タスク一覧のように 5 秒ごとに叩く必要は無い）。
   * バッチが 1 つも無い SPEC（TOC だけ・別形式）はバーに出さない。
   */
  useEffect(() => {
    let alive = true
    if (!board) {
      setSpecsInfo(null)
      return () => {
        alive = false
      }
    }
    api(`/api/specs?board=${encodeURIComponent(board)}`)
      .then((d) => {
        if (!alive) return
        const list = (Array.isArray(d?.specs) ? d.specs : []).filter((s) => (s.batches ?? []).length > 0)
        setSpecsInfo(list.length ? { repo: d.repo ?? null, path: d.path ?? null, specs: list } : null)
        setSpecPath((cur) => (cur && list.some((s) => s.path === cur) ? cur : list[0]?.path ?? null))
      })
      .catch(() => {
        if (alive) setSpecsInfo(null)
      })
    return () => {
      alive = false
    }
  }, [board])

  useEffect(() => {
    if (!board) return
    loadTasks(board)
    const id = setInterval(() => document.visibilityState === 'visible' && loadTasks(board), 5000)
    return () => clearInterval(id)
  }, [board, loadTasks])

  const openTask = async (task) => {
    setDetail({ loading: true, ...task })
    setDiff(null)
    setPatch(null)
    try {
      const d = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(task.id)}`)
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

  const abortTask = async (task) => {
    setBusy(true)
    try {
      const r = await api(`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(task.id)}/abort`, {
        method: 'POST',
        body: { reason: t('tasks.abortReason') },
      })
      notify(t('tasks.aborted', { reclaim: r.reclaimed, block: r.blocked }))
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
      notify(t('tasks.actionRan', { action }))
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
      notify(t('tasks.pausedDone'))
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
      notify(t('tasks.resumed'))
      refresh?.()
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }

  const bridge = overview?.bridge
  const mem = overview?.system?.memory
  const disk = overview?.system?.disk
  const running = tasks.filter((task) => task.status === 'running').length
  const paused = overview?.paused ?? { engaged: false }
  // >=820px は 2 ペイン（詳細をシートではなく右ペインに出す。SPEC §7.2）
  const split = useSplitLayout()

  /*
   * Spec Launchpad（SPEC §5.4）。ボード上に同じ `[<ID>]` のタスクがあるバッチは
   * 「起票済み」として先に見せる（サーバ側の冪等チェックと同じ規則）。
   * 既定で選ぶのは**まだ一度も起票していない**バッチだけ — 完了済みのバッチを
   * うっかり再起票しないため（選び直せば起票できる）。
   */
  const specList = specsInfo?.specs ?? []
  const currentSpec = specList.find((s) => s.path === specPath) ?? specList[0] ?? null
  const batchIdOf = (title) => /^\[([^\]]+)\]/.exec(String(title ?? ''))?.[1] ?? null
  const filedBatchIds = new Set(tasks.map((x) => batchIdOf(x.title)).filter(Boolean))
  const openBatchIds = new Set(
    tasks.filter((x) => x.status !== 'done' && x.status !== 'archived').map((x) => batchIdOf(x.title)).filter(Boolean),
  )
  const defaultSelection = () =>
    (currentSpec?.batches ?? []).filter((b) => !filedBatchIds.has(b.id)).map((b) => b.id)

  /** バッチ選択シートを開く（未起票のバッチを既定で選択）。 */
  const openSpecSheet = () => {
    if (!currentSpec) return
    haptic('tap')
    setSpecSel(defaultSelection())
    setSpecSheetOpen(true)
  }

  /** 選んだバッチを 1 タップで一括起票し、そのまま自走に乗せる。 */
  const launchBatches = async () => {
    if (!currentSpec || !specSel.length || !board) return
    setSpecBusy(true)
    try {
      const r = await api('/api/specs/launch', {
        method: 'POST',
        body: { board, specRelPath: currentSpec.path, batchIds: specSel, assignee: 'mobile' },
      })
      haptic('success')
      notify(t('tasks.specLaunched', { created: (r.created ?? []).length, skipped: (r.skipped ?? []).length }))
      setSpecSheetOpen(false)
      setSpecSel([])
      loadTasks(board)
    } catch (e) {
      notify(e.message)
    } finally {
      setSpecBusy(false)
    }
  }

  // 詳細（右ペインと Sheet で同じ中身を使う。2 ペインのときは右ペインに常設する）
  const detailBody = detail
    ? detail.loading
      ? <Loader label={t('tasks.detailLoading')} />
      : (
          <>
            <div className="kv">
              <span>{t('tasks.status')}</span>
              <b>
                {STATUS_KEY[detail.status] ? t(STATUS_KEY[detail.status]) : detail.status}
                {detail.workerPid ? ` ・ pid ${detail.workerPid}` : ''}
              </b>
            </div>
            <div className="kv">
              <span>{t('tasks.started')}</span>
              <b>{detail.startedAt ? relTime(detail.startedAt) : '—'}</b>
            </div>
            {detail.branch ? (
              <div className="kv">
                <span>{t('tasks.branch')}</span>
                <b className="mono">{detail.branch}</b>
              </div>
            ) : null}
            {detail.body ? <div className="body-text">{detail.body}</div> : null}
            {detail.result ? <div className="body-text result">{detail.result}</div> : null}

            {detail.git?.head ? (
              <>
                <div className="kv">
                  <span>{t('tasks.commit')}</span>
                  <b className="mono">
                    {detail.git.head}
                    {detail.git.branch ? ` (${detail.git.branch})` : ''}
                  </b>
                </div>
                <div className="kv">
                  <span>{t('tasks.message')}</span>
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
                    {t('tasks.changedFiles')}
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
                      <span>{t('common.loading')}</span>
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
                                <span>{t('common.loading')}</span>
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
                      {!(diff.files ?? []).length ? <div className="empty">{t('tasks.noDiff')}</div> : null}
                      {diff.truncated ? <div className="row-sub">{t('tasks.diffLimit')}</div> : null}
                      {diff.dirty ? <div className="row-sub">{t('tasks.dirtyNote')}</div> : null}
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
                  {t('tasks.openThread')}
                </button>
              ) : null}

              {detail.status === 'running' || detail.workerPid ? (
                <div style={{ marginTop: 12 }}>
                  <HoldButton
                    label={t('tasks.abortTask')}
                    sub={t('tasks.abortSub')}
                    tone="danger"
                    disabled={busy}
                    onFire={() => abortTask(detail)}
                  />
                </div>
              ) : null}

              <div className="list-head" style={{ marginTop: 16 }}>
                <span>{t('tasks.events')}</span>
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
                {!(detail.events ?? []).length ? <div className="empty">{t('tasks.noEvents')}</div> : null}
              </div>
          </>
        )
    : null

  const closeDetail = () => {
    setDetail(null)
    setConfirmText('')
  }

  return (
    <div className={split ? 'pane split-layout tasks' : 'pane'}>
      <div className={split ? 'split-master' : undefined}>
      {paused.engaged ? (
        <div className="banner paused">
          {t('tasks.pausedBanner', { reason: paused.reason ? ` ・ ${paused.reason}` : '' })}
          <button onClick={resumeAction} disabled={busy}>
            {t('tasks.resume')}
          </button>
        </div>
      ) : null}

      {inboxCount ? (
        <button className="inbox-bar" onClick={() => openInbox(null)}>
          <span>{t('tasks.inboxBar', { n: inboxCount })}</span>
          <span className="inbox-bar-go">{t('tasks.inboxBarGo')}</span>
        </button>
      ) : null}

      {/* Spec Launchpad（SPEC §5.4）: ボードのリポジトリに SPEC があれば常設のバー */}
      {currentSpec ? (
        <button className="spec-bar" onClick={openSpecSheet} aria-label={t('tasks.specBarAria', { name: currentSpec.title })}>
          <span className="spec-bar-main">
            <span className="spec-bar-title">
              🚀 {t('tasks.specLaunchpad')}
            </span>
            <span className="spec-bar-name">{currentSpec.title}</span>
          </span>
          <span className="spec-bar-n">
            {t('tasks.specBatchCount', { n: currentSpec.batches.length })}
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : null}

      <div className="strip">
        <div className={`stat ${bridge?.ok === false ? 'bad' : bridge ? 'good' : ''}`}>
          <span className="stat-k">{t('tasks.bridge')}</span>
          <span className="stat-v">{bridge ? (bridge.ok ? t('tasks.ok') : t('tasks.disconnected')) : '—'}</span>
        </div>
        <button className="stat" onClick={() => setUsageOpen(true)} aria-label={t('tasks.usageAria')}>
          <span className="stat-k">24h</span>
          <span className="stat-v">{usageData?.ok ? fmtCost(usageData.totals.cost) : '—'}</span>
        </button>
        <div className="stat">
          <span className="stat-k">{t('tasks.memory')}</span>
          <span className="stat-v">{mem ? `${mem.percent}%` : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-k">{t('tasks.disk')}</span>
          <span className="stat-v">{disk ? `${disk.percent}%` : '—'}</span>
        </div>
        <button
          className={`stat ${running ? 'warn' : ''}`}
          onClick={() => setLiveOpen(true)}
          aria-label={t('tasks.liveAria')}
        >
          <span className="stat-k">
            {t('tasks.runningLabel')}
            {liveTurns ? <i className="live-dot" title={t('tasks.turnTitle', { n: liveTurns })} /> : null}
          </span>
          <span className="stat-v">{running + liveTurns}</span>
        </button>
      </div>

      <div className="chip-row">
        <button
          className="chip-more"
          onClick={() => setBoardSheetOpen(true)}
          aria-label={t('tasks.boardOpenAria')}
          title={t('tasks.boardList')}
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
        <Sheet title={t('tasks.board')} onClose={() => setBoardSheetOpen(false)}>
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
                    b.counts?.running ? t('tasks.boardRunning', { n: b.counts.running }) : null,
                    b.counts?.blocked ? t('tasks.boardBlocked', { n: b.counts.blocked }) : null,
                    b.archived ? t('tasks.boardArchived') : null,
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

      {specSheetOpen && currentSpec ? (
        <Sheet title={t('tasks.specSheetTitle')} onClose={() => !specBusy && setSpecSheetOpen(false)}>
          {specList.length > 1 ? (
            <div className="chips" style={{ marginBottom: 8 }}>
              {specList.map((s) => (
                <button
                  key={s.path}
                  className={`chip${s.path === currentSpec.path ? ' on' : ''}`}
                  onClick={() => {
                    setSpecPath(s.path)
                    setSpecSel(s.batches.filter((b) => !filedBatchIds.has(b.id)).map((b) => b.id))
                  }}
                >
                  {s.title}
                </button>
              ))}
            </div>
          ) : null}
          <div className="row-sub mono" style={{ padding: '0 2px 8px' }}>
            {currentSpec.path}
          </div>
          <div className="list">
            {currentSpec.batches.map((b) => {
              const filed = filedBatchIds.has(b.id)
              const taken = openBatchIds.has(b.id)
              const sel = specSel.includes(b.id)
              return (
                <button
                  key={b.id}
                  className={`list-item${sel ? ' on' : ''}`}
                  onClick={() => {
                    haptic('tap')
                    setSpecSel((cur) => (cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id]))
                  }}
                >
                  <span className="spec-check" aria-hidden="true">
                    {sel ? '☑' : '☐'}
                  </span>
                  <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <span className="row-title">
                      [{b.id}] {b.title}
                    </span>
                    {b.objective ? <span className="row-sub">{b.objective.slice(0, 140)}</span> : null}
                  </span>
                  {filed ? (
                    <span className="spec-taken">{t(taken ? 'tasks.specAlready' : 'tasks.specFiledDone')}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <button
            className="btn primary"
            style={{ marginTop: 12, width: '100%' }}
            disabled={specBusy || !specSel.length}
            onClick={launchBatches}
          >
            {specBusy ? t('tasks.specLaunching') : t('tasks.specLaunchBtn', { n: specSel.length })}
          </button>
          <div className="row-sub" style={{ padding: '8px 4px', lineHeight: 1.6 }}>
            {t('tasks.specNote')}
          </div>
        </Sheet>
      ) : null}

      <div className="list-head">
        <span>{t('tasks.tasks')}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            className="link"
            onClick={() => {
              haptic('tap')
              setCaptureOpen(true)
            }}
          >
            {t('tasks.newTask')}
          </button>
          <RefreshButton variant="link" onRefresh={refreshAll} />
        </span>
      </div>

      {loading ? <Loader label={t('common.loading')} /> : null}
      {!loading && !tasks.length ? <div className="empty">{t('tasks.empty')}</div> : null}

      <div className="list">
        {tasks.map((task) => (
          <button
            key={task.id}
            className="row"
            onClick={() => {
              haptic('tap')
              openTask(task)
            }}
          >
            <span className={`dot ${task.status}`} />
            <span className="row-main">
              <span className="row-title">{task.title}</span>
              <span className="row-sub">
                {STATUS_KEY[task.status] ? t(STATUS_KEY[task.status]) : task.status}
                {task.status === 'running' && task.elapsedSec != null
                  ? ` ・ ${t('tasks.elapsedMin', { n: Math.floor(task.elapsedSec / 60) })}`
                  : ''}
                {task.failures ? ` ・ ${t('tasks.failures', { n: task.failures })}` : ''}
                {task.completedAt ? ` ・ ${relTime(task.completedAt)}` : ''}
              </span>
              {task.git?.head ? (
                <span className="git-badge">
                  <span className="git-sha">{task.git.head}</span>
                  <span className="git-subject">{task.git.subject || t('tasks.noMessage')}</span>
                  {task.git.dirty ? <span className="git-dirty">{t('tasks.uncommitted')}</span> : null}
                  {task.discord ? (
                    <span
                      className="git-dc"
                      role="link"
                      tabIndex={0}
                      title={t('tasks.openInDiscord')}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.open(task.discord.url, '_blank', 'noopener')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation()
                          window.open(task.discord.url, '_blank', 'noopener')
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
        {t('tasks.emergency')}
      </button>

      {killOpen ? (
        <Sheet title={t('tasks.emergencyTitle')} onClose={() => !busy && setKillOpen(false)}>
          <div className="warn-card">{t('tasks.emergencyNote', { n: running })}</div>
          <div className="warn-card" style={{ marginTop: 8 }}>
            {paused.engaged
              ? t('tasks.pausedNow', { at: paused.engagedAt ?? t('tasks.unknownTime') })
              : t('tasks.pauseHelp')}
          </div>
          {paused.engaged ? (
            <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={resumeAction} disabled={busy}>
              {t('tasks.resumeEstop')}
            </button>
          ) : (
            <div className="hold-grid" style={{ marginTop: 10 }}>
              <HoldButton
                label={t('tasks.pauseLabel')}
                sub={t('tasks.pauseSub')}
                tone="safe"
                disabled={busy}
                onFire={pauseAction}
              />
            </div>
          )}
          <div className="hold-grid">
            <HoldButton
              label={t('tasks.drainLabel')}
              sub={t('tasks.drainSub')}
              tone="safe"
              disabled={busy}
              onFire={() => gatewayAction('drain')}
            />
            <HoldButton
              label={t('tasks.restartLabel')}
              sub={t('tasks.restartSub')}
              tone="danger"
              disabled={busy}
              onFire={() => gatewayAction('restart')}
            />
            <HoldButton
              label={t('tasks.stopLabel')}
              sub={t('tasks.stopSub')}
              tone="danger"
              disabled={busy}
              onFire={() => gatewayAction('stop')}
            />
            <HoldButton
              label={t('tasks.startLabel')}
              sub={t('tasks.startSub')}
              tone="safe"
              disabled={busy}
              onFire={() => gatewayAction('start')}
            />
          </div>
          <div className="row-sub" style={{ padding: '10px 4px' }}>
            {t('tasks.auditNote')}
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

      </div>

      {detail && !split ? (
        <Sheet title={detail.title ?? detail.id} onClose={closeDetail}>
          {detailBody}
        </Sheet>
      ) : null}

      {/* >=820px: 右ペインに詳細を常設（左の一覧から選ぶだけで切り替わる） */}
      {split ? (
        <div className="split-detail">
          {detail ? (
            <>
              <div className="split-detail-head">
                <span className="split-detail-title">{detail.title ?? detail.id}</span>
                <button className="icon-btn" onClick={closeDetail} aria-label={t('common.close')}>
                  <Icon name="close" size={18} />
                </button>
              </div>
              <div className="split-detail-body">{detailBody}</div>
            </>
          ) : (
            <div className="split-placeholder">
              <b>{t('tasks.selectPlaceholder')}</b>
              <span>{t('tasks.selectHint')}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
