import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Loader, RefreshButton, Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { celebrate } from '../lib/vibe.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { pendingCount } from '../lib/reviewView.js'
import { fmtCost } from '../lib/format.js'
import { followUpPromptFor, readActiveChatId, reportSummaryLine, toEpochMs } from '../lib/chatReports.js'
import { renderMarkdown } from '../lib/markdown.js'
import { batchIdOf, specProgress } from '../lib/specProgress.js'
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

export function TasksPane({ overview, refresh, notify, initialInbox = null, focusBoard = null, onConsumedFocusBoard }) {
  const { t } = useI18n()
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [tasks, setTasks] = useState([])
  // 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。無ければバナーを出さない。
  const [latestReport, setLatestReport] = useState(null)
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
  // 全バッチ完了後に開く履歴（Q3=A）。起票シートとは別のシートにする
  const [specHistoryOpen, setSpecHistoryOpen] = useState(false)
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

  /* 稼働中（running / ready / todo）が 0 か。0 に変わった瞬間に完走レポートを取り直す。 */
  const idle = !tasks.some((x) => x.status === 'running' || x.status === 'ready' || x.status === 'todo')

  /*
   * 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。
   * ブリッジ（V4-2 の watcher）が `GET /api/specs/reports` を生やす前は 404 になるので、
   * 取れないことは異常ではない — バナーを出さないだけで画面は壊さない。
   */
  useEffect(() => {
    if (!board) {
      setLatestReport(null)
      return undefined
    }
    let alive = true
    const load = () =>
      api(`/api/specs/reports?board=${encodeURIComponent(board)}&limit=1`)
        .then((d) => {
          if (!alive) return
          const list = Array.isArray(d?.reports) ? d.reports : Array.isArray(d?.items) ? d.items : []
          setLatestReport(list[0] ?? null)
        })
        .catch(() => {
          if (alive) setLatestReport(null)
        })
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 30_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [board, idle])

  /* 直近 24 時間のレポートだけをバナーに出す（古い完走を常設しない）。 */
  const reportRecent = useMemo(() => {
    const at = toEpochMs(latestReport?.at)
    return Boolean(at) && Date.now() - at < 24 * 60 * 60 * 1000
  }, [latestReport])

  /* バナーの本文（統合 Markdown サマリ）は Markdown として読ませる。 */
  const latestReportBody = useMemo(
    () => (latestReport?.markdown ? renderMarkdown(latestReport.markdown) : null),
    [latestReport],
  )

  /** バナーの「💬 チャットで次の一手を相談」: App 経由でチャットタブへ渡す（§3.3 ③）。 */
  const discussLatestReport = useCallback(() => {
    if (!latestReport) return
    haptic('tap')
    try {
      window.dispatchEvent(
        new CustomEvent('hm:discuss-pipeline', {
          detail: {
            sessionId: latestReport.sessionId ?? null,
            repoPath: latestReport.repoPath ?? null,
            board: latestReport.board ?? board,
            prompt: followUpPromptFor(latestReport, ''),
            title: latestReport.label ?? null,
          },
        }),
      )
    } catch {
      /* noop */
    }
  }, [latestReport, board])

  /* ChatPane の「📋 ボードを見る」で Tasks タブへ来たとき、そのボードを選ぶ。 */
  useEffect(() => {
    if (!focusBoard?.board) return
    // ボード一覧の取得前に消費すると選択が空振りする（実測: チップが既定のまま残った）
    if (!boards.length) return
    if (boards.some((b) => b.slug === focusBoard.board)) setBoard(focusBoard.board)
    onConsumedFocusBoard?.()
  }, [focusBoard, boards, onConsumedFocusBoard])

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
  /*
   * 起票・完了の判定は lib/specProgress.js に集約（単体テストで固定）。
   * allDone のときだけカードを「✅ 全バッチ完了」にし、タップ先を履歴へ切り替える（Q3=A）。
   */
  const specProg = specProgress(currentSpec?.batches ?? [], tasks)
  const filedBatchIds = new Set(specProg.byId.keys())
  const openBatchIds = new Set(
    tasks.filter((x) => x.status !== 'done' && x.status !== 'archived').map((x) => batchIdOf(x.title)).filter(Boolean),
  )
  const specAllDone = specProg.allDone
  /** ボード 1 行の補足（実行中・停止・保管・最終更新）。 */
  const boardMeta = (b) =>
    [
      b?.counts?.running ? t('tasks.boardRunning', { n: b.counts.running }) : null,
      b?.counts?.blocked ? t('tasks.boardBlocked', { n: b.counts.blocked }) : null,
      b?.archived ? t('tasks.boardArchived') : null,
      b?.lastActivityAt ? relTime(b.lastActivityAt * 1000) : null,
    ]
      .filter(Boolean)
      .join(' · ')
  const currentBoard = boards.find((b) => b.slug === board) ?? null
  const defaultSelection = () =>
    (currentSpec?.batches ?? []).filter((b) => !filedBatchIds.has(b.id)).map((b) => b.id)

  /** バッチ選択シートを開く（未起票のバッチを既定で選択）。 */
  const openSpecSheet = () => {
    if (!currentSpec) return
    haptic('tap')
    setSpecSel(defaultSelection())
    setSpecSheetOpen(true)
  }

  /** 全バッチ完了後の履歴シートを開く（Q3=A）。 */
  const openSpecHistory = () => {
    if (!currentSpec) return
    haptic('tap')
    setSpecHistoryOpen(true)
  }

  /** 選んだバッチを 1 タップで一括起票し、そのまま自走に乗せる。 */
  const launchBatches = async () => {
    if (!currentSpec || !specSel.length || !board) return
    setSpecBusy(true)
    try {
      const r = await api('/api/specs/launch', {
        method: 'POST',
        body: {
          board,
          specRelPath: currentSpec.path,
          batchIds: specSel,
          assignee: 'mobile',
          // 直近に操作していた会話へ紐づける（完走レポートの宛先・§3.2 ② / §3.3 ③）
          chat: readActiveChatId(globalThis.localStorage) || undefined,
        },
      })
      // 一括起票の祝祭（SPEC-PILOT-V5 §3.1 / D24: Dopamine は演出＋音、Serotonin は触覚だけ）
      celebrate('launch')
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

      {/* Spec Launchpad（SPEC §5.4）: ボードのリポジトリに SPEC があれば常設のバー。
          全バッチ完了後は「✅ 全バッチ完了」カードになり、タップで履歴（縦リスト）を開く（Q3=A） */}
      {currentSpec ? (
        <button
          className={`spec-bar${specAllDone ? ' is-done' : ''}`}
          onClick={specAllDone ? openSpecHistory : openSpecSheet}
          aria-label={t(specAllDone ? 'tasks.specHistoryAria' : 'tasks.specBarAria', { name: currentSpec.title })}
        >
          <span className="spec-bar-main">
            <span className="spec-bar-title">
              {specAllDone ? `✅ ${t('tasks.specAllDone')}` : `🚀 ${t('tasks.specLaunchpad')}`}
            </span>
            <span className="spec-bar-name">{currentSpec.title}</span>
          </span>
          <span className="spec-bar-n">
            {t('tasks.specBatchCount', { n: currentSpec.batches.length })}
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : null}

      {/*
        直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。
        Spec Launchpad の直下に控えめに出し、展開すると統合 Markdown の全文が読める。
        稼働中タスクがあるときは「直近 24 時間の完走」だけを出す（進行中の邪魔をしない）。
      */}
      {latestReport && (idle || reportRecent) ? (
        <details className={`pipeline-summary-card${String(latestReport.status ?? '') === 'halted' ? ' is-halted' : ''}`}>
          <summary className="pipeline-summary-head">
            <span className="pipeline-summary-icon" aria-hidden="true">
              {String(latestReport.status ?? '') === 'halted' ? '⚠️' : '🎉'}
            </span>
            <span className="pipeline-summary-title">{latestReport.label || t('tasks.pipelineSummary')}</span>
            <span className="pipeline-summary-sub">{reportSummaryLine(latestReport, 48)}</span>
            <span className="pipeline-summary-when">{relTime(toEpochMs(latestReport.at) || 0)}</span>
          </summary>
          <div className="pipeline-summary-body">
            {latestReportBody}
            <div className="pipeline-summary-actions">
              <button type="button" className="report-card-btn primary" onClick={discussLatestReport}>
                {t('tasks.discussReport')}
              </button>
              <button type="button" className="report-card-btn" onClick={() => setLatestReport(null)}>
                {t('tasks.pipelineDismiss')}
              </button>
            </div>
          </div>
        </details>
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

      {/*
        ボード切替（Q1=B / Q2=A）: 増えうる一覧は縦リストに統一し、横スクロールは使わない。
        常設は「いま選んでいるボード」1 行（.pick-item.on）。全件はこの行をタップして
        縦リストのシートで選ぶ（▾ の意味は変えない）。
      */}
      <button
        className="pick-item board-now"
        onClick={() => setBoardSheetOpen(true)}
        aria-label={t('tasks.boardOpenAria')}
        title={t('tasks.boardList')}
      >
        <span className="pick-main">
          <span className="pick-title">
            <span aria-hidden="true">{currentBoard?.icon ?? '🗂'}</span> {currentBoard?.name ?? board ?? t('tasks.board')}
          </span>
          <span className="pick-sub">{boardMeta(currentBoard)}</span>
        </span>
        <span className="pick-meta">
          {t('tasks.boardCount', { n: boards.length })}
          <Icon name="chevron" size={14} />
        </span>
      </button>

      {boardSheetOpen && (
        <Sheet title={t('tasks.board')} onClose={() => setBoardSheetOpen(false)}>
          <div className="pick-list">
            {boards.map((b) => (
              <button
                key={b.slug}
                className={`pick-item${board === b.slug ? ' on' : ''}`}
                onClick={() => {
                  setBoard(b.slug)
                  setBoardSheetOpen(false)
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
          </div>
        </Sheet>
      )}

      {specSheetOpen && currentSpec ? (
        <Sheet title={t('tasks.specSheetTitle')} onClose={() => !specBusy && setSpecSheetOpen(false)}>
          {specList.length > 1 ? (
            /* 仕様の選択は増えうる一覧なので縦リスト（Q1=B / Q2=A）。行＝タイトル＋バッチ数＋更新日時 */
            <div className="pick-list" style={{ marginBottom: 8 }}>
              {specList.map((s) => {
                const sel = s.path === currentSpec.path
                return (
                  <button
                    key={s.path}
                    className={`pick-item${sel ? ' on' : ''}`}
                    onClick={() => {
                      haptic('tap')
                      setSpecPath(s.path)
                      setSpecSel(s.batches.filter((b) => !filedBatchIds.has(b.id)).map((b) => b.id))
                    }}
                  >
                    <span className="pick-main">
                      <span className="pick-title">{s.title}</span>
                      <span className="pick-sub">
                        {[
                          t('tasks.specBatchCount', { n: s.batches.length }),
                          s.mtime ? t('tasks.specUpdated', { when: relTime(s.mtime) }) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="pick-meta">{sel ? '✓' : ''}</span>
                  </button>
                )
              })}
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

      {/* 全バッチ完了後の履歴（Q3=A）。行＝バッチ＋完了バッジ＋完了時刻。増えうる一覧なので縦リスト */}
      {specHistoryOpen && currentSpec ? (
        <Sheet title={t('tasks.specHistoryTitle')} onClose={() => setSpecHistoryOpen(false)}>
          <div className="row-sub mono" style={{ padding: '0 2px 8px' }}>
            {currentSpec.path}
          </div>
          <div className="pick-list">
            {currentSpec.batches.map((b) => {
              const task = specProg.byId.get(b.id) ?? null
              const done = task && (task.status === 'done' || task.status === 'archived')
              return (
                <div key={b.id} className="pick-item">
                  <span className={`dot ${task?.status ?? 'todo'}`} />
                  <span className="pick-main">
                    <span className="pick-title">
                      [{b.id}] {b.title}
                    </span>
                    <span className="pick-sub">
                      {[
                        task
                          ? STATUS_KEY[task.status]
                            ? t(STATUS_KEY[task.status])
                            : task.status
                          : t('tasks.specNotFiled'),
                        task?.completedAt ? relTime(task.completedAt) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {done ? <span className="pick-badge">{t('tasks.specDoneBadge')}</span> : null}
                </div>
              )
            })}
          </div>
          <button
            className="btn"
            style={{ marginTop: 12, width: '100%' }}
            onClick={() => {
              setSpecHistoryOpen(false)
              openSpecSheet()
            }}
          >
            {t('tasks.specOpenLaunch')}
          </button>
          <div className="row-sub" style={{ padding: '8px 4px', lineHeight: 1.6 }}>
            {t('tasks.specHistoryNote')}
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
