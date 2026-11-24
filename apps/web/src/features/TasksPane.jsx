import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Loader, RefreshButton, Sheet, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { celebrate } from '../lib/vibe.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'
import { SpecSeedSheet } from './SpecSeedSheet.jsx'
import { BrainstormSheet, RefactorSheet } from './TaskToolSheets.jsx'
import { SpecReadyBanner } from '../components/SpecReadyBanner.jsx'
import { SpecRunningBar } from '../components/SpecRunningBar.jsx'
import { CoherenceBanner } from '../components/CoherenceBanner.jsx'
import { SpecMarkdownSheet } from '../components/SpecMarkdownSheet.jsx'
import { ArchitectJobBar } from '../components/ArchitectJobBar.jsx'
import { countRunningArchitect, pickActiveArchitectJob, pickSpecBanner } from '../lib/specSeed.js'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { BoardPickerSheet } from './tasks/BoardPickerSheet.jsx'
import { CloseActions } from '../components/CloseActions.jsx'
import { pendingCount } from '../lib/reviewView.js'
import { fmtCost, sep } from '../lib/format.js'
import { followUpPromptFor, readActiveChatId, reportBodyFor, reportSummaryLine, toEpochMs } from '../lib/chatReports.js'
import { renderMarkdown } from '../lib/markdown.js'
import { activeSpecRunSummary, batchIdOf, specProgress } from '../lib/specProgress.js'
import { localizeError } from '../i18n/lang.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import {
  coherenceBannerView,
  coherenceDismissRecord,
  archivedTaskCount,
  archivableTasks,
  bulkArchivePayload,
  isArchivedTask,
  organizeRowView,
  selectableBrokenTasks,
  specPickerList,
  splitSpecsByArchive,
  visibleTasks,
} from '../lib/tasksView.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { HM_EVENTS, emitHmEvent, onHmEvent } from '../contracts/events.js'
import { isOfflineError, shouldNotifyError } from '../lib/netRecovery.js'
import { useWakeSync } from '../lib/useWakeSync.js'
import { refreshSync, setSyncParams, setSyncState, subscribeSync, tickSync } from '../lib/syncSources.js'
import { ModePill, SpecPicker } from './tasks/SpecPicker.jsx'
import { STATUS_KEY, TaskDetailSheet } from './tasks/TaskDetailSheet.jsx'


/**
 * タスクタブ（ホーム）。SystemOps の状態 + カンバン + キルスイッチ。
 */
const BOARD_KEY = HM_STORAGE.BOARD

/** 直前に選んでいたボードの slug。 */
function readStoredBoard() {
  try {
    return localStorage.getItem(BOARD_KEY)
  } catch {
    return null
  }
}

export function TasksPane({ overview, refresh, notify, initialInbox = null, pendingInboxOpen = null, onConsumedPendingInboxOpen, focusBoard = null, onConsumedFocusBoard, taskToolRequest = null, onConsumedTaskTool, active = true }) {
  const { t, lang } = useI18n()
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [tasks, setTasks] = useState([])
  // 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。無ければバナーを出さない。
  const [latestReport, setLatestReport] = useState(null)
  // 開いているタスク詳細（{ id, board, title, seq } | null）。取得・ポーリングは TaskDetailSheet 側が持つ
  const [detailTarget, setDetailTarget] = useState(null)
  const [killOpen, setKillOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [boardSheetOpen, setBoardSheetOpen] = useState(false)
  // 使用量（24h）
  const [usageData, setUsageData] = useState(null)
  const [usageOpen, setUsageOpen] = useState(false)
  // 完了レシート（SPEC-PILOT-V5 §3.3 ③ / D26③）。ボードと Spec を渡して 1 タップで開く。
  const [receiptCtx, setReceiptCtx] = useState(null)
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
  // 上部 SPEC セレクタのアコーディオン（SPEC-PILOT-V6 §3.5 ① / D29）。シートを開くたびに閉じる
  const [specPickerOpen, setSpecPickerOpen] = useState(false)
  // 仕様書（MD）プレビュー（§3.4 ② / D30）。`{path, title}` を渡して 1 枚のシートを開く
  const [specMd, setSpecMd] = useState(null)
  // Launchpad のバッチ 1 行ごとの「仕様・Verify ▾」展開（チェックボックス選択とは独立）
  const [specBatchOpen, setSpecBatchOpen] = useState([])
  // 📝 Spec Seed と A2B クイック起票カード（SPEC-PILOT-V5 §3.2・§3.3 ① / D23・D26①）
  const [seedOpen, setSeedOpen] = useState(false)
  const [seedInitial, setSeedInitial] = useState('')
  const [brainstormOpen, setBrainstormOpen] = useState(false)
  const [brainstormInitial, setBrainstormInitial] = useState('')
  const [refactorOpen, setRefactorOpen] = useState(false)
  // バナーから開くときのスイープ（`RefactorSheet` の `initialPreset`・SPEC-COHERENCE §3.6）
  const [refactorPreset, setRefactorPreset] = useState('')
  // Coherence 提案バナー（SPEC-COHERENCE §3.6 / D83）。`null` の間は何も出さない。
  const [coherenceReport, setCoherenceReport] = useState(null)
  const [coherenceOpen, setCoherenceOpen] = useState(false)
  const workActiveRef = useRef(false)
  const prevWorkActiveRef = useRef(false)
  // 閉じた記録は localStorage（`HM_STORAGE.COHERENCE_DISMISSED`）に置く。初期値は 1 回だけ読む。
  const [coherenceDismissedRaw, setCoherenceDismissedRaw] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(HM_STORAGE.COHERENCE_DISMISSED) ?? null
    } catch {
      return null
    }
  })
  // Launchpad の「Show archived (N)」トグル（既定 OFF＝アクティブ SPEC だけ。D84）
  const [specShowArchived, setSpecShowArchived] = useState(false)
  // バッチ履歴ドロワーは過去分もすぐ参照できるよう、既定でアーカイブ済みも表示する
  const [historyShowArchived, setHistoryShowArchived] = useState(true)
  const [historySpecPath, setHistorySpecPath] = useState(null)
  // タスク一覧の「アーカイブ済み (N)」トグルと整理モード（SPEC-RELIABILITY-GUARD RG-3 / D92）。
  // 既定はどちらも OFF（アーカイブは隠す・整理モードは通常の一覧）。
  const [showArchivedTasks, setShowArchivedTasks] = useState(false)
  const [organize, setOrganize] = useState(false)
  const [organizeSel, setOrganizeSel] = useState([])
  const [organizeBusy, setOrganizeBusy] = useState(false)
  // `archivedCount` はサーバの値をそのまま持つ（一覧の LIMIT で落ちた分も数えている）
  const [archivedTaskTotal, setArchivedTaskTotal] = useState(null)

  useEffect(() => {
    if (!taskToolRequest) return
    if (taskToolRequest.kind === 'brainstorm') {
      setBrainstormInitial(taskToolRequest.seed || '')
      setBrainstormOpen(true)
    } else if (taskToolRequest.kind === 'seed') {
      setSeedInitial(taskToolRequest.seed || '')
      setSeedOpen(true)
    }
    onConsumedTaskTool?.()
  }, [taskToolRequest, onConsumedTaskTool])
  const [architectJobs, setArchitectJobs] = useState(null)
  const [architectFiling, setArchitectFiling] = useState(false)
  const [architectDismissed, setArchitectDismissed] = useState([])
  // 進行バーで × を押したジョブ（`failed` の再表示を止める。SPEC V6 §3.3 ②）
  const [architectJobClosed, setArchitectJobClosed] = useState([])
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

  // App からのインボックス要求（ディープリンク・🔔 タップ・ハッシュ）は prop で受ける。
  // 以前は `setTimeout` で `hm:open-inbox` を投げていたが、マウント前だと取りこぼしていた。
  useEffect(() => {
    if (!pendingInboxOpen) return
    openInbox(pendingInboxOpen.task ?? null)
    onConsumedPendingInboxOpen?.()
  }, [pendingInboxOpen, openInbox, onConsumedPendingInboxOpen])

  // 旧経路の後方互換: 外部（デモ・将来の画面）が直接 dispatch した場合だけ受ける。
  useEffect(() => {
    const onOpen = (e) => openInbox(e?.detail?.task ?? null)
    window.addEventListener(HM_EVENTS.OPEN_INBOX, onOpen)
    return () => window.removeEventListener(HM_EVENTS.OPEN_INBOX, onOpen)
  }, [openInbox])

  // ウィジェットの行タップ（?open=inbox&task=…）でシートを開く。1回だけ。
  useEffect(() => {
    if (!initialInbox || initialInboxApplied.current) return
    initialInboxApplied.current = true
    openInbox(initialInbox.task ?? null)
  }, [initialInbox, openInbox])

  const boardRef = useRef(board)
  boardRef.current = board
  const boardsFailedRef = useRef(false)
  const tasksBoardRef = useRef(null)
  const tasksSeqRef = useRef(0)
  const specsBoardRef = useRef(null)
  const archBoardRef = useRef(null)
  const cohBoardRef = useRef(null)
  const reportBoardRef = useRef(null)
  const lastErrToastRef = useRef(0)

  /*
   * 取得先（表示中ボード）を取得関数へ渡す。他の購読より先に走らせるため、ref の直後に置く。
   */
  useEffect(() => {
    setSyncParams({ board: board || null, architectBoard: board || null })
  }, [board])

  const notifyNetErr = useCallback(
    (err, { silent = false } = {}) => {
      const now = Date.now()
      if (!shouldNotifyError({ silent, offline: isOfflineError(err), lastAt: lastErrToastRef.current, now })) return
      lastErrToastRef.current = now
      notify(err?.message ?? '')
    },
    [notify],
  )

  /** ボード一覧の応答を反映する（取得は表の `boards` = `lib/syncSources.js`）。 */
  const applyBoards = useCallback((d) => {
    const list = Array.isArray(d?.boards) ? d.boards : []
    boardsFailedRef.current = false
    setSyncState({ boardsFailed: false })
    setBoards(list)
    const cur = boardRef.current
    const saved = readStoredBoard()
    const next =
      cur && (!list.length || list.some((b) => b.slug === cur))
        ? cur
        : saved && list.some((b) => b.slug === saved)
          ? saved
          : list.find((b) => b.current)?.slug ?? list.find((b) => !b.archived)?.slug ?? list[0]?.slug ?? null
    setBoard(next)
    setLoading(false)
    return next
  }, [])

  const loadBoards = useCallback(
    async ({ silent = false } = {}) => {
      try {
        return applyBoards(await api('/api/boards'))
      } catch (e) {
        boardsFailedRef.current = true
        setSyncState({ boardsFailed: true })
        notifyNetErr(e, { silent })
        return null
      } finally {
        setLoading(false)
      }
    },
    [applyBoards, notifyNetErr],
  )

  // 選択したボードを覚える（TasksPane はタブ切替でアンマウントされるため）
  useEffect(() => {
    try {
      if (board) localStorage.setItem(BOARD_KEY, board)
    } catch {
      /* 保存できなくても動作に影響なし */
    }
  }, [board])

  /* A2B クイック起票カードの材料（SPEC V5 §3.2 D23）。取得は表の `architectJobs`。 */
  const applyArchitectJobs = useCallback((slug, d) => {
    if (!slug) {
      archBoardRef.current = null
      setArchitectJobs(null)
      return
    }
    if (d?.ok) {
      archBoardRef.current = slug
      setArchitectJobs(d)
    }
  }, [])

  const loadArchitectJobs = useCallback(async () => {
    if (!board) {
      applyArchitectJobs(null, null)
      return
    }
    try {
      applyArchitectJobs(board, await api(`/api/architect/jobs?board=${encodeURIComponent(board)}`))
    } catch {
      if (archBoardRef.current !== board) setArchitectJobs(null)
    }
  }, [board, applyArchitectJobs])

  const openTaskCountRef = useRef({ board: null, count: null })
  // 同じタスクを開き直したことを TaskDetailSheet に伝える世代番号
  const detailSeq = useRef(0)
  /** タスク一覧の応答を反映する（取得は表の `tasks`）。 */
  const applyTasks = useCallback(
    (slug, d) => {
      if (!slug || slug !== boardRef.current) return false
      tasksBoardRef.current = slug
      const list = Array.isArray(d?.tasks) ? d.tasks : []
      setTasks(list)
      setArchivedTaskTotal(Number.isFinite(Number(d?.archivedCount)) ? Number(d.archivedCount) : null)
      const openCount = list.filter((x) =>
        ['running', 'ready', 'todo', 'blocked'].includes(String(x?.status ?? '')),
      ).length
      const prev = openTaskCountRef.current
      openTaskCountRef.current = { board: slug, count: openCount }
      if (prev.board === slug && prev.count !== null && openCount < prev.count) {
        try {
          emitHmEvent(HM_EVENTS.REFRESH_REPORTS)
        } catch {
          /* noop */
        }
        loadArchitectJobs()
      }
      return true
    },
    [loadArchitectJobs],
  )

  const loadTasks = useCallback(
    async (slug, { silent = false } = {}) => {
      if (!slug) return false
      const seq = ++tasksSeqRef.current
      try {
        const d = await api(`/api/boards/${encodeURIComponent(slug)}/tasks?limit=60`)
        if (seq !== tasksSeqRef.current) return true
        return applyTasks(slug, d)
      } catch (e) {
        if (seq !== tasksSeqRef.current) return false
        // 同一ボードの一時的な瞬断・オフライン時は既存のタスク一覧を消さずに保持する
        if (tasksBoardRef.current !== slug) setTasks([])
        notifyNetErr(e, { silent })
        return false
      }
    },
    [notifyNetErr, applyTasks],
  )

  /** 整理モードの一括アーカイブ（SPEC-RELIABILITY-GUARD RG-3 / D92）。 */
  const bulkArchiveSelected = async () => {
    if (!board) return
    const ids = bulkArchivePayload(organizeSel, tasks)
    if (!ids.length) {
      notify(t('tasks.organizeNone'))
      return
    }
    setOrganizeBusy(true)
    try {
      const r = await api(`/api/boards/${encodeURIComponent(board)}/tasks/bulk-archive`, {
        method: 'POST',
        // 理由はカンバンのコメントに残るので UI 言語で書く（英語 UI に日本語を残さない）
        body: { taskIds: ids, reason: t('tasks.organizeReason'), by: 'mobile' },
      })
      const archived = Array.isArray(r?.archived) ? r.archived.length : 0
      const skippedRunning = Array.isArray(r?.skippedRunning) ? r.skippedRunning.length : 0
      notify(t('tasks.organizeArchived', { n: archived, running: skippedRunning }))
      setOrganizeSel([])
      emitHmEvent(HM_EVENTS.WAKE_SYNC)
      await loadTasks(board)
    } catch (e) {
      notify(e.message)
    } finally {
      setOrganizeBusy(false)
    }
  }

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  /*
   * 定期取得は表（`lib/syncScheduler.js`）の購読だけ。ここは受け取った値を反映する。
   */
  const applyUsage = useCallback((d) => {
    if (d) setUsageData(d)
  }, [])

  const applyLive = useCallback((d) => {
    const turns = Number(d?.counts?.turns ?? 0)
    setLiveTurns(turns)
    try {
      window.dispatchEvent(
        new CustomEvent(HM_EVENTS.LIVE_TURNS, {
          detail: { turns, items: Array.isArray(d?.turns) ? d.turns : [], architect: Number(d?.counts?.architect ?? 0) },
        }),
      )
    } catch {
      /* noop */
    }
  }, [])

  /* 承認待ちの件数と、下部ナビのタスクタブの丸バッジ（注釈 1377.jpg の赤）を同じデータで同期する。 */
  const applyInbox = useCallback((d) => {
    const items = Array.isArray(d?.items) ? d.items : []
    setInboxCount(pendingCount(items))
    try {
      emitHmEvent(HM_EVENTS.INBOX_ITEMS, { items })
    } catch {
      /* noop */
    }
  }, [])

  const loadInbox = useCallback(async () => {
    try {
      applyInbox(await api('/api/inbox'))
    } catch {
      /* 表示だけなので握る */
    }
  }, [applyInbox])

  /*
   * 使用量（60 秒）・ライブターン（5 秒）・承認待ち（15 秒）は表が持つ。
   * この 3 本はタブを離れていてもバッジに要るので、`active` に関係なく購読する。
   */
  useEffect(() => {
    const offs = [
      subscribeSync('usage', (d, meta) => !meta?.error && applyUsage(d)),
      subscribeSync('live', (d, meta) => !meta?.error && applyLive(d)),
      subscribeSync('inbox', (d, meta) => !meta?.error && applyInbox(d)),
    ]
    tickSync('usage')
    tickSync('live')
    tickSync('inbox')
    return () => {
      for (const off of offs) off()
    }
  }, [applyUsage, applyLive, applyInbox])

  /* Spec Launchpad 用 SPEC 検出（SPEC §5.4 / D31: ボード変更・refreshAll・一括起票・architectJobs で呼ぶ）。 */
  /** SPEC 一覧の応答を反映する（取得は表の `specs`）。 */
  const applySpecs = useCallback((slug, d) => {
    if (!slug || slug !== boardRef.current) return
    specsBoardRef.current = slug
    const keep = (s) => (s.batches ?? []).length > 0
    const raw = (Array.isArray(d?.specs) ? d.specs : []).filter(keep)
    const split = Array.isArray(d?.archivedSpecs)
      ? { active: raw, archived: d.archivedSpecs.filter(keep) }
      : splitSpecsByArchive(raw)
    setSpecsInfo(
      split.active.length + split.archived.length
        ? { repo: d.repo ?? null, path: d.path ?? null, active: split.active, archived: split.archived }
        : null,
    )
    setSpecPath((cur) => {
      const all = [...split.active, ...split.archived]
      if (cur && all.some((s) => s.path === cur)) return cur
      return split.active[0]?.path ?? split.archived[0]?.path ?? null
    })
  }, [])

  const loadSpecs = useCallback(
    async (slug) => {
      if (!slug) {
        specsBoardRef.current = null
        setSpecsInfo(null)
        return
      }
      try {
        applySpecs(slug, await api(`/api/specs?board=${encodeURIComponent(slug)}`))
      } catch {
        if (specsBoardRef.current !== slug) setSpecsInfo(null)
      }
    },
    [applySpecs],
  )

  /* SPEC 一覧は表の `specs`（60 秒）。ボードが変わったら取得先を渡してすぐ 1 回取り直す。 */
  useEffect(() => {
    if (!board || !active) return undefined
    const off = subscribeSync('specs', (d, meta) => !meta?.error && applySpecs(board, d))
    tickSync('specs')
    return off
  }, [board, active, applySpecs])

  /* 完走予兆の提案バナー（SPEC-COHERENCE §3.6 / D83・読み取り専用・D55）。 */
  const applyCoherence = useCallback((slug, d) => {
    if (!slug || slug !== boardRef.current) return
    cohBoardRef.current = slug
    setCoherenceReport(d && typeof d === 'object' ? d : null)
  }, [])

  const loadCoherence = useCallback(
    async (slug, { fresh = false } = {}) => {
      if (!slug) {
        cohBoardRef.current = null
        setCoherenceReport(null)
        return
      }
      try {
        const d = await api(`/api/coherence/report?board=${encodeURIComponent(slug)}${fresh ? '&fresh=1' : ''}`)
        applyCoherence(slug, d)
      } catch {
        if (cohBoardRef.current !== slug) setCoherenceReport(null)
      }
    },
    [applyCoherence],
  )

  /*
   * リポジトリ全体の走査なので、タスク一覧（5 秒）ほど頻繁に叩かない（表の `coherence` = 120 秒）。
   * 作業中（ワーカー・Architect 稼働）は表の `enabledWhen` が止める。
   */
  useEffect(() => {
    if (!board || !active) return undefined
    const off = subscribeSync('coherence', (d, meta) => !meta?.error && applyCoherence(board, d))
    return off
  }, [board, active, applyCoherence])

  const refreshAll = useCallback(async () => {
    const activeBoard = board || (await loadBoards())
    const results = await Promise.all([
      activeBoard ? loadTasks(activeBoard) : Promise.resolve(false),
      board ? loadBoards({ silent: true }) : Promise.resolve(activeBoard),
      loadInbox(),
      loadSpecs(activeBoard),
      activeBoard ? loadCoherence(activeBoard, { fresh: true }) : Promise.resolve(),
      refresh ? refresh() : Promise.resolve(true),
    ])
    return Boolean(activeBoard) && results[0] !== false
  }, [board, loadBoards, loadTasks, loadInbox, loadSpecs, loadCoherence, refresh])

  /* タスク一覧（5 秒）と、取得に失敗したときだけ走るボード再試行（表の `boards`）。 */
  useEffect(() => {
    if (!active) return undefined
    const offs = [
      subscribeSync('tasks', (d, meta) => {
        if (meta?.error) {
          // 同じボードの 2 回目以降は黙って握る（初回だけ知らせる）
          notifyNetErr(meta.error, { silent: tasksBoardRef.current === board })
          return
        }
        applyTasks(board, d)
      }),
      subscribeSync('boards', (d, meta) => {
        if (!meta?.error) applyBoards(d)
      }),
    ]
    if (board) tickSync('tasks')
    tickSync('boards')
    return () => {
      for (const off of offs) off()
    }
  }, [active, board, applyTasks, applyBoards, notifyNetErr])

  /**
   * 進行バーに出すジョブ（`running` / `awaiting_review` / `awaiting_spec` / `failed` の 1 件）。
   * `spec_ready` / `launched` は `SpecReadyBanner` が引き継ぐ。
   *
   * 第 3 引数に表示中のボードを渡す（D43 後半）。ブリッジはアクティブジョブをボード横断で
   * 返すので、選択中ボードのジョブを優先しつつ、別ボードのものもフォールバックで出す。
   */
  const activeJob = useMemo(
    () => pickActiveArchitectJob(architectJobs?.jobs ?? [], architectJobClosed, board ?? ''),
    [architectJobs, architectJobClosed, board],
  )

  /*
   * 稼働中の Architect ジョブ件数（D43 後半）。`/api/live` の `counts.architect` と同じ規則
   * （`running` / `awaiting_spec`）。カンバンタスクを持たない Agy Opt-in も数に入れる。
   */
  const architectRunning = useMemo(
    () => countRunningArchitect(architectJobs?.jobs ?? []),
    [architectJobs],
  )

  /*
   * Architect ジョブ（進行中 4 秒 / 人待ち 20 秒 = 表の `architectJobs` の `everyMsOf`）。
   * `architectBusy` はアプリ全体の状況なので、表へ渡して間隔を切り替えてもらう。
   */
  useEffect(() => {
    setSyncState({
      architectBusy: Boolean(
        activeJob && (activeJob.status === 'running' || activeJob.status === 'awaiting_spec'),
      ),
    })
  }, [activeJob])

  useEffect(() => {
    if (!active) return undefined
    const off = subscribeSync('architectJobs', (d, meta) => !meta?.error && applyArchitectJobs(board, d))
    tickSync('architectJobs')
    return off
  }, [active, board, applyArchitectJobs])

  // スリープ復帰・回線回復・Review 回答の直後に未取得ボード／タスク一覧・進行バー・Coherence を再同期する
  useWakeSync(() => {
    refreshSync('inbox')
    refreshSync('live')
    refreshSync('architectJobs')
    if (!board) {
      refreshSync('boards')
      return
    }
    refreshSync('boards')
    refreshSync('tasks')
    refreshSync('specs')
    refreshSync('coherence')
  })
  useEffect(
    () =>
      onHmEvent(HM_EVENTS.REFRESH_REPORTS, () => {
        if (board) loadCoherence(board, { fresh: true })
      }),
    [board, loadCoherence],
  )

  /*
   * 新 SPEC の即時同期（SPEC V6 §3.3 ③ / D31）。
   * ブリッジが新しい SPEC を検知したら（`specReady` / `pending` の顔ぶれが変わったら）
   * SPEC 一覧を取り直す。リロード無しで `🚀 仕様ランチャー` が出る。
   */
  const specSyncKey = useMemo(() => {
    const ready = architectJobs?.specReady ?? []
    const pending = architectJobs?.pending ?? []
    return [
      ...ready.map((r) => `r:${r?.spec}:${r?.batchCount}:${r?.launched ? 1 : 0}`),
      ...pending.map((p) => `p:${p?.path}:${p?.pendingCount}`),
    ].join('|')
  }, [architectJobs])

  useEffect(() => {
    if (!specSyncKey) return
    loadSpecs(board)
  }, [specSyncKey, board, loadSpecs])

  /** 出すカードは 1 枚だけ（完成 SPEC 優先・× で閉じたものは再表示しない）。 */
  const specBanner = useMemo(() => {
    const picked = pickSpecBanner({
      specReady: architectJobs?.specReady ?? [],
      pending: architectJobs?.pending ?? [],
    })
    if (!picked || architectDismissed.includes(picked.path)) return null
    return picked
  }, [architectJobs, architectDismissed])

  /** バナーから未起票バッチを一括起票する（既起票はブリッジ側でスキップ＝冪等）。 */
  const fileSpecBatches = useCallback(
    async (banner) => {
      if (!banner || architectFiling || !board) return
      setArchitectFiling(true)
      try {
        const activeChat = readActiveChatId(globalThis.localStorage)
        const r = await api('/api/specs/launch', {
          method: 'POST',
          body: {
            board,
            specRelPath: banner.path,
            batchIds: banner.ids,
            ...(activeChat ? { chat: activeChat } : {}),
          },
        })
        notify(t('seed.bannerFiled', { n: (r?.created ?? []).length }))
        try {
          celebrate('launch')
        } catch {
          /* 演出は本質ではない */
        }
        await Promise.all([loadArchitectJobs(), loadTasks(board), loadSpecs(board)])
      } catch (e) {
        notify(e?.message ?? t('seed.failed'))
      } finally {
        setArchitectFiling(false)
      }
    },
    [architectFiling, board, notify, t, loadArchitectJobs, loadTasks, loadSpecs],
  )

  /* 稼働中（running / ready / todo）が 0 か。0 に変わった瞬間に完走レポートを取り直す。 */
  const idle = !tasks.some((x) => x.status === 'running' || x.status === 'ready' || x.status === 'todo')
  /* 作業中（ワーカー稼働・Architect 稼働）は Coherence 推奨を出し控えて完了直後に fresh 再取得する（問題④）。 */
  const workActive =
    !idle ||
    architectRunning > 0 ||
    Boolean(activeJob && (activeJob.status === 'running' || activeJob.status === 'awaiting_spec'))
  workActiveRef.current = workActive
  useEffect(() => {
    const wasActive = prevWorkActiveRef.current
    prevWorkActiveRef.current = workActive
    // Coherence の 120 秒は作業中に止める（表の `enabledWhen`）
    setSyncState({ workActive })
    if (wasActive && !workActive && board && active) loadCoherence(board, { fresh: true })
  }, [workActive, board, active, loadCoherence])

  /* 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③・30 秒 = 表の `specReports`）。 */
  const applySpecReports = useCallback((slug, d) => {
    if (!slug || slug !== boardRef.current) return
    reportBoardRef.current = slug
    const list = Array.isArray(d?.reports) ? d.reports : Array.isArray(d?.items) ? d.items : []
    setLatestReport(list[0] ?? null)
  }, [])

  useEffect(() => {
    if (!board) {
      reportBoardRef.current = null
      setLatestReport(null)
      return undefined
    }
    if (!active) return undefined
    const off = subscribeSync('specReports', (d, meta) => !meta?.error && applySpecReports(board, d))
    tickSync('specReports')
    return off
  }, [board, active, applySpecReports])

  // 新しいパイプライン完走レポートを観測したら、生の Coherence 診断も即時 fresh 取得する
  const lastCoherenceReportAtRef = useRef(null)
  useEffect(() => {
    const at = latestReport?.at ?? null
    if (!board || !active || !at) return
    if (lastCoherenceReportAtRef.current === at) return
    lastCoherenceReportAtRef.current = at
    loadCoherence(board, { fresh: true })
  }, [board, active, latestReport?.at, loadCoherence])

  /* 直近 24 時間のレポートだけをバナーに出す（古い完走を常設しない）。 */
  const reportRecent = useMemo(() => {
    const at = toEpochMs(latestReport?.at)
    return Boolean(at) && Date.now() - at < 24 * 60 * 60 * 1000
  }, [latestReport])

  /*
   * バナーの表示判定は純関数（`lib/tasksView.js`）に集約。ここは材料を渡すだけ。
   * 生の診断が無いときは直近の完走レポートの `coherence_alert` を使う（2 系統）。
   */
  const coherenceView = useMemo(
    () => coherenceBannerView(coherenceReport ?? latestReport ?? null, coherenceDismissedRaw, { busy: workActive }),
    [coherenceReport, latestReport, coherenceDismissedRaw, workActive],
  )

  /** バナーの 1 タップ起動: 推奨スイープを選択済みにして `RefactorSheet` を開く。 */
  const openCoherenceSweep = useCallback(() => {
    haptic('tap')
    setRefactorPreset(coherenceView.recommendedSweep || '')
    setRefactorOpen(true)
  }, [coherenceView.recommendedSweep])

  /** バナーを閉じる（署名を保存。件数が変われば再表示される）。 */
  const dismissCoherence = useCallback(() => {
    haptic('tap')
    const record = coherenceDismissRecord(coherenceView.signature)
    let raw = null
    try {
      raw = JSON.stringify(record)
      globalThis.localStorage?.setItem(HM_STORAGE.COHERENCE_DISMISSED, raw)
    } catch {
      // 保存できない環境でも、この画面では閉じる（押したのに消えない方が困る）
    }
    setCoherenceDismissedRaw(raw)
  }, [coherenceView.signature])

  /* バナーの本文（統合 Markdown サマリ）は Markdown として読ませる。 */
  const latestReportBody = useMemo(
    () => (latestReport?.markdown ? renderMarkdown(reportBodyFor(latestReport)) : null),
    // lang を依存に入れる（言語を切り替えたら本文も選び直す）
    [latestReport, lang],
  )

  /** バナーの「💬 チャットで次の一手を相談」: App 経由でチャットタブへ渡す（§3.3 ③）。 */
  const discussLatestReport = useCallback(() => {
    if (!latestReport) return
    haptic('tap')
    try {
      window.dispatchEvent(
        new CustomEvent(HM_EVENTS.DISCUSS_PIPELINE, {
          detail: {
            sessionId: latestReport.sessionId ?? null,
            repoPath: latestReport.repoPath ?? null,
            board: latestReport.board ?? board,
            prompt: followUpPromptFor(latestReport, t('chat.discussFallback'), { t, lang }),
            title: latestReport.label ?? null,
          },
        }),
      )
    } catch {
      /* noop */
    }
  }, [latestReport, board])

  /* ChatPane からの「📋 ボードを見る」および `taskId` 付き詳細オープン（D43）。 */
  useEffect(() => {
    if (!focusBoard?.board) return
    // ボード一覧の取得前に消費すると選択が空振りする（実測: チップが既定のまま残った）
    if (!boards.length) return
    if (boards.some((b) => b.slug === focusBoard.board)) setBoard(focusBoard.board)
    const taskId = String(focusBoard.taskId ?? '').trim()
    if (taskId) openTask({ id: taskId, title: '' }, focusBoard.board)
    onConsumedFocusBoard?.()
    // openTask は毎レンダー作り直される素の関数。focusBoard が変わった時だけ開けば足りる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBoard, boards, onConsumedFocusBoard])

  /** タスク詳細を開く（`boardSlug` は別ボードのジョブから開くときの固定用・D43）。 */
  const openTask = (task, boardSlug = board) => {
    detailSeq.current += 1
    setDetailTarget({
      id: String(task.id),
      board: String(boardSlug ?? board ?? '').trim(),
      title: task.title ?? '',
      // 同じ id をタップし直したときだけ取得し直すための世代番号
      seq: detailSeq.current,
    })
  }

  /* Architect ジョブの「🔍 進捗詳細」（SPEC-PILOT-V9 §3.3 ② / D43 後半）。 */
  const inspectArchitectJob = (job) => {
    const taskId = String(job?.taskId ?? '').trim()
    const targetBoard = String(job?.board ?? board ?? '').trim()
    if (!taskId || !targetBoard) {
      setLiveOpen(true)
      return
    }
    haptic('tap')
    if (targetBoard !== board && boards.some((b) => b.slug === targetBoard)) setBoard(targetBoard)
    const title = String(job?.seed ?? '').trim()
    openTask({ id: taskId, title: title ? title.slice(0, 40) : taskId }, targetBoard)
  }

  const gatewayAction = async (action) => {
    setBusy(true)
    try {
      const r = await api(`/api/gateway/${action}`, { method: 'POST', body: { confirm: action.toUpperCase() } })
      if (r?.ok === false) {
        notify(localizeError(r) || t('tasks.actionFailed'))
        return
      }
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

  /** 全タスク緊急停止（ESTOP ＋ 一括中断）。本番 502 / デモ `{ok:false}` の両方を捕捉（D90）。 */
  const stopAllAction = async () => {
    setBusy(true)
    try {
      const r = await api('/api/emergency/stop-all', {
        method: 'POST',
        body: { confirm: 'STOP_ALL', reason: t('tasks.stopAllReason') },
      })
      if (r?.ok === false) {
        notify(localizeError(r) || t('tasks.stopAllFailed'))
        return
      }
      notify(
        t('tasks.stopAllDone', {
          estop: r?.paused?.engaged ? t('tasks.estopOn') : t('tasks.estopOff'),
          aborted: Number(r?.aborted ?? 0),
          failed: Number(r?.failed?.length ?? 0),
        }),
      )
      if (Number(r?.remainingRunning ?? 0) > 0) notify(t('tasks.stopAllLeft', { n: Number(r.remainingRunning) }))
      emitHmEvent(HM_EVENTS.WAKE_SYNC)
      setKillOpen(false)
      setConfirmText('')
      refresh?.()
      if (board) loadTasks(board)
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
      const r = await api('/api/gateway/pause', { method: 'POST', body: { confirm: 'PAUSE', reason: 'mobile' } })
      if (r?.ok === false) {
        notify(localizeError(r) || t('tasks.actionFailed'))
        return
      }
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
      const r = await api('/api/gateway/resume', { method: 'POST', body: { confirm: 'RESUME' } })
      if (r?.ok === false) {
        notify(localizeError(r) || t('tasks.actionFailed'))
        return
      }
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
  // タスク一覧の表示（D92）: 既定はアーカイブを隠し、N はサーバの件数を優先する。
  const archivedShown = archivedTaskCount(tasks, archivedTaskTotal)
  const shownTasks = visibleTasks(tasks, showArchivedTasks)
  const organizeTargets = archivableTasks(tasks)
  const brokenSelection = selectableBrokenTasks(tasks)
  const paused = overview?.paused ?? { engaged: false }
  // >=680px は 2 ペイン（詳細をシートではなく右ペインに出す。SPEC-i18n-resp §2 B3）
  // 境界は lib/layout.js の 1 箇所だけ（CSS の @media と一致させる）
  const { split } = useSplitLayout()

  /* Spec Launchpad（SPEC §5.4）: 既定選択は未起票バッチのみ。 */
  const specParts = { active: specsInfo?.active ?? [], archived: specsInfo?.archived ?? [] }
  const activeSpecRun = useMemo(() => activeSpecRunSummary(specParts.active, tasks), [specParts.active, tasks])
  const specArchivedCount = specParts.archived.length
  // `Show archived` の状態で並びを切り替える（既定はアクティブのみ・純関数でテスト済み）
  const specList = specPickerList(specParts, specShowArchived)
  const currentSpec = specList.find((s) => s.path === specPath) ?? specList[0] ?? null
  /* 起票・完了判定は lib/specProgress.js（allDone 時は履歴を開く・Q3=A / D91・D92）。 */
  const specOpts = { specMtime: currentSpec?.mtime ?? null, runTaskIds: currentSpec?.runTaskIds ?? null }
  const specProg = specProgress(currentSpec?.batches ?? [], tasks, currentSpec?.path, specOpts)
  const filedBatchIds = new Set(specProg.byId.keys())
  const openBatchIds = new Set(
    [...specProg.byId.entries()]
      .filter(([, task]) => task.status !== 'done' && task.status !== 'archived')
      .map(([id]) => id),
  )
  const specAllDone = specProg.allDone
  const historySpecList = specPickerList(specParts, historyShowArchived)
  const historySpec =
    historySpecList.find((s) => s.path === historySpecPath) ?? currentSpec ?? historySpecList[0] ?? null
  const historyProg = specProgress(historySpec?.batches ?? [], tasks, historySpec?.path, {
    specMtime: historySpec?.mtime ?? null,
    runTaskIds: historySpec?.runTaskIds ?? null,
  })
  /**
   * 起票シートで既定選択する（＝まだ起票していない）バッチ ID。
   *
   * `archived`（破棄済み）は完了ではないので**未起票として選び直せる**（D92 の再起票導線）。
   */
  const unfiledBatchIds = (prog, batches) =>
    (Array.isArray(batches) ? batches : [])
      .filter((b) => {
        const t = prog?.byId?.get(b?.id)
        return !t || t.status === 'archived'
      })
      .map((b) => b.id)
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
  const defaultSelection = () => unfiledBatchIds(specProg, currentSpec?.batches ?? [])

  /** バッチ選択シートを開く（未起票のバッチを既定で選択）。 */
  const openSpecSheet = () => {
    if (!currentSpec) return
    haptic('tap')
    setSpecSel(defaultSelection())
    setSpecPickerOpen(false)
    setSpecBatchOpen([])
    setSpecSheetOpen(true)
  }

  /** 全バッチ完了後の履歴シートを開く（Q3=A）。過去 SPEC もすぐ参照できるようアーカイブも開く。 */
  const openSpecHistory = () => {
    if (!currentSpec && !historySpecList.length) return
    haptic('tap')
    setHistorySpecPath(currentSpec?.path ?? null)
    setHistoryShowArchived(true)
    setSpecPickerOpen(false)
    setSpecHistoryOpen(true)
  }

  /** 上部セレクタで SPEC を切り替え、Launchpad では切替先 SPEC の未起票を選び直す（SPEC V6 §3.5 ①）。 */
  const pickSpec = (next, forLaunch = false) => {
    if (!next) return
    setSpecPath(next.path)
    setSpecPickerOpen(false)
    setSpecBatchOpen([])
    if (forLaunch) {
      const prog = specProgress(next.batches ?? [], tasks, next?.path, {
        specMtime: next?.mtime ?? null,
        runTaskIds: next?.runTaskIds ?? null,
      })
      setSpecSel(unfiledBatchIds(prog, next.batches ?? []))
    }
  }

  /**
   * SPEC をアーカイブへ退避する（`POST /api/specs/archive`・D92）。
   *
   * ファイルは消さない。ヘッダに `- **Status**: archived` が 1 行足されるだけで、
   * Launchpad の「アーカイブ済み」側へ移る（既にアーカイブ済みなら `noop`）。
   */
  const archiveCurrentSpec = async (spec = null) => {
    const target = spec ?? currentSpec
    if (!target?.path || !board) return
    try {
      const r = await api('/api/specs/archive', {
        method: 'POST',
        body: { board, repo: specsInfo?.repo ?? null, path: target.path },
      })
      notify(r?.noop ? t('tasks.specArchiveNoop') : t('tasks.specArchiveDone'))
      await Promise.all([loadSpecs(board), loadArchitectJobs()])
    } catch (e) {
      notify(e?.message || t('tasks.specArchiveFailed'))
    }
  }

  /** A2B 通知カード（SpecReadyBanner）から未起票 SPEC を直接アーカイブ退避する。 */
  const archiveBannerSpec = async (banner) => {
    if (!banner?.path || (!banner?.board && !board)) return
    try {
      const r = await api('/api/specs/archive', {
        method: 'POST',
        body: { board: banner?.board ?? board, repo: specsInfo?.repo ?? null, path: banner.path },
      })
      notify(r?.noop ? t('tasks.specArchiveNoop') : t('tasks.specArchiveDone'))
      await Promise.all([loadSpecs(board), loadArchitectJobs()])
    } catch (e) {
      notify(e?.message || t('tasks.specArchiveFailed'))
    }
  }

  /** 仕様書（MD）プレビューを開く（§3.4 ② / D30。3 箇所の入口から同じシート）。 */
  const openSpecMd = (spec) => {
    const p = typeof spec === 'string' ? spec : spec?.path
    if (!p) return
    haptic('tap')
    setSpecMd({
      path: p,
      title: typeof spec === 'string' ? null : (spec?.title ?? null),
      // バナー由来はジョブのボード（別ボードの仕様書でも正しいリポジトリで読む）
      board: typeof spec === 'string' ? null : (spec?.board ?? null),
    })
  }

  /**
   * 完了レシート（🏆）を開く。既定は「いま見ているボード ＋ 表示中の Spec」。
   * 完走レポートがあればそちらの board / spec を優先する（別ボードの完走でも正しい対象になる）。
   */
  const openReceipt = (report = null) => {
    haptic('tap')
    setReceiptCtx({
      board: report?.board ?? board ?? null,
      spec: report?.spec ?? currentSpec?.path ?? null,
    })
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
          // 直近に操作していた会話へ紐づける（完走レポートの宛先・§3.2 ② / §3.3 ③）
          chat: readActiveChatId(globalThis.localStorage) || undefined,
        },
      })
      // 一括起票の祝祭（SPEC-PILOT-V5 §3.1 / D24: Dopamine は演出＋音、Serotonin は触覚だけ）
      celebrate('launch')
      notify(t('tasks.specLaunched', { created: (r.created ?? []).length, skipped: (r.skipped ?? []).length }))
      setSpecSheetOpen(false)
      setSpecSel([])
      await Promise.all([loadTasks(board), loadArchitectJobs(), loadSpecs(board)])
    } catch (e) {
      notify(e.message)
    } finally {
      setSpecBusy(false)
    }
  }

  const closeDetail = () => {
    setDetailTarget(null)
    setConfirmText('')
  }

  return (
    <div className={split ? 'pane split-layout tasks' : 'pane'}>
      <div className={split ? 'split-master' : undefined}>
      {paused.engaged ? (
        <div className="banner paused">
          {t('tasks.pausedBanner', { reason: paused.reason ? ` ${sep()} ${paused.reason}` : '' })}
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

      {/* Architect の進行バー（SPEC V6 §3.3 ②）: Seed のあと「今どこか」を画面上部に残す */}
      <ArchitectJobBar
        job={activeJob}
        board={board ?? ''}
        repo={specsInfo?.repo ?? null}
        chat={readActiveChatId(globalThis.localStorage) || null}
        onInspect={inspectArchitectJob}
        onRetried={async () => {
          await Promise.all([loadArchitectJobs(), loadSpecs(board)])
        }}
        onDismiss={(jobId) => setArchitectJobClosed((prev) => [...prev, jobId])}
        notify={notify}
      />

      {/* A2B クイック起票カード（SPEC V5 §3.2 D23）: 仕様書ができた瞬間に 1 タップ起票 */}
      <SpecReadyBanner
        banner={specBanner}
        busy={architectFiling}
        onFile={fileSpecBatches}
        onDismiss={(b) => setArchitectDismissed((prev) => [...prev, b.path])}
        onPreview={(b) => openSpecMd({ path: b.path, title: b.title })}
        onArchive={archiveBannerSpec}
      />

      {/* バッチ一括起票後の自走実行サマリ（問題③）: 稼働中の SPEC 進捗と詳細への導線 */}
      <SpecRunningBar
        summary={activeSpecRun}
        onInspect={(task) => openTask(task, board)}
        onOpenBatches={(spec) => {
          pickSpec(spec, true)
          setSpecSheetOpen(true)
        }}
      />

      {/*
        完走予兆の提案バナー（SPEC-COHERENCE §3.6 / D83 / 問題④）。
        作業中は表示と 120s 診断を控え、作業完了後に残る問題だけ 1 タップスイープで示す。
      */}
      <CoherenceBanner
        view={coherenceView}
        open={coherenceOpen}
        onToggle={() => setCoherenceOpen((v) => !v)}
        onOpenSweep={openCoherenceSweep}
        onDismiss={dismissCoherence}
      />

      {/* 📝 Spec Seed ＋ 🧠 ブレスト ＋ 🛠 リファクタリング（同列エントリ） */}
      <div className="seed-entry">
        <button
          type="button"
          className="snippet-chip trigger"
          onClick={() => {
            haptic('tap')
            setSeedInitial('')
            setSeedOpen(true)
          }}
          aria-label={t('seed.openAria')}
        >
          📝 {t('seed.title')}
        </button>
        <button
          type="button"
          className="snippet-chip trigger"
          onClick={() => {
            haptic('tap')
            setBrainstormInitial('')
            setBrainstormOpen(true)
          }}
        >
          🧠 {t('brainstorm.title')}
        </button>
        <button
          type="button"
          className="snippet-chip trigger"
          onClick={() => {
            haptic('tap')
            setRefactorPreset('')
            setRefactorOpen(true)
          }}
        >
          🛠 {t('refactor.title')}
        </button>
      </div>

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

      {/* 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。 */}
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
              <button type="button" className="report-card-btn" onClick={() => openReceipt(latestReport)}>
                {t('receipt.open')}
              </button>
              {/* ここは「折りたたむ」。カードごと消すとタスクタブから報告が消える（実機） */}
              <button
                type="button"
                className="report-card-btn"
                onClick={(e) => {
                  const d = e.currentTarget.closest('details')
                  if (d) d.open = false
                }}
              >
                {t('tasks.pipelineCollapse')}
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
          className={`stat ${running || architectRunning ? 'warn' : ''}`}
          onClick={() => setLiveOpen(true)}
          aria-label={t('tasks.liveAria')}
        >
          <span className="stat-k">
            {t('tasks.runningLabel')}
            {liveTurns || architectRunning ? (
              <i
                className="live-dot"
                title={t('tasks.turnTitle', { n: liveTurns + architectRunning })}
              />
            ) : null}
          </span>
          {/* Architect（仕様策定）の稼働分も「実行中」に数える（D43 後半）。 */}
          <span className="stat-v">{running + liveTurns + architectRunning}</span>
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
        <BoardPickerSheet
          boards={boards}
          board={board}
          boardMeta={boardMeta}
          onSelect={setBoard}
          onRefreshBoards={() => loadBoards({ silent: true })}
          onClose={() => setBoardSheetOpen(false)}
          notify={notify}
        />
      )}

      {seedOpen ? (
        <SpecSeedSheet
          board={board ?? ''}
          repo={specsInfo?.repo ?? null}
          chat={readActiveChatId(globalThis.localStorage) || null}
          initialText={seedInitial}
          notify={notify}
          onClose={() => {
            setSeedOpen(false)
            setSeedInitial('')
          }}
          onSeeded={() => loadArchitectJobs()}
        />
      ) : null}

      {brainstormOpen ? (
        <BrainstormSheet
          initialSeed={brainstormInitial}
          board={board ?? ''}
          repo={specsInfo?.repo ?? null}
          notify={notify}
          onClose={() => {
            setBrainstormOpen(false)
            setBrainstormInitial('')
          }}
        />
      ) : null}

      {refactorOpen ? (
        <RefactorSheet
          board={board ?? ''}
          repo={specsInfo?.repo ?? null}
          initialPreset={refactorPreset}
          notify={notify}
          onClose={() => {
            setRefactorOpen(false)
            setRefactorPreset('')
          }}
        />
      ) : null}

      {specSheetOpen && currentSpec ? (
        <Sheet title={t('tasks.specSheetTitle')} onClose={() => !specBusy && setSpecSheetOpen(false)}>
          {/* 上部は親スコープ枠（選択中 SPEC ＋ プレビュー操作）として子のバッチ一覧と階層を分ける */}
          <div className={`spec-context-box${specPickerOpen ? ' is-open' : ''}`}>
            <SpecPicker
              specList={specList}
              currentSpec={currentSpec}
              open={specPickerOpen}
              onToggle={() => setSpecPickerOpen((v) => !v)}
              onPick={(s) => pickSpec(s, true)}
              archivedCount={specArchivedCount}
              showArchived={specShowArchived}
              onToggleArchived={setSpecShowArchived}
              t={t}
            />
            <div className="spec-md-row">
              <button type="button" className="btn spec-md-open" onClick={() => openSpecMd(currentSpec)}>
                {`📄 ${t('tasks.specMdPreview')}`}
              </button>
            </div>
          </div>
          <div className="spec-children-section">
            <div className="list-head spec-children-head">
              {t('tasks.specBatchesHead', { n: currentSpec.batches.length })}
            </div>
            <div className="list">
            {currentSpec.batches.map((b) => {
              const filed = filedBatchIds.has(b.id)
              const taken = openBatchIds.has(b.id)
              const bt = specProg.byId.get(b.id)
              const badgeKey = taken
                ? 'tasks.specAlready'
                : bt?.status === 'archived'
                  ? 'tasks.status.archived'
                  : 'tasks.specFiledDone'
              const sel = specSel.includes(b.id)
              const open = specBatchOpen.includes(b.id)
              return (
                /* 行の本体＝チェックボックス選択（1 タップ）／下の「仕様・Verify ▾」は独立（D29） */
                <div className={`spec-batch${sel ? ' on' : ''}`} key={b.id}>
                  <button
                    type="button"
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
                      <ModePill batch={b} t={t} />
                      {b.objective ? <span className="row-sub">{b.objective.slice(0, 140)}</span> : null}
                    </span>
                    {filed ? (
                      <span className="spec-taken">
                        {t(badgeKey)}
                        {bt?.id ? ` · ${bt.id}` : ''}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="link spec-batch-toggle"
                    aria-expanded={open}
                    onClick={() => {
                      haptic('tap')
                      setSpecBatchOpen((cur) => (cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id]))
                    }}
                  >
                    {t('tasks.specDetailToggle')} {open ? '▴' : '▾'}
                  </button>
                  {open ? (
                    <div className="spec-batch-detail">{renderMarkdown(b.section || b.title || '')}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
          {/* 起票するものがあるときは起票、全部完了しているときは履歴へ（ボタンは行き先を名乗る） */}
          {specAllDone ? (
            <button
              className="btn"
              style={{ marginTop: 12, width: '100%' }}
              onClick={() => {
                setSpecSheetOpen(false)
                openSpecHistory()
              }}
            >
              {t('tasks.specHistoryTitle')}
            </button>
          ) : (
            <button
              className="btn primary"
              style={{ marginTop: 12, width: '100%' }}
              disabled={specBusy || !specSel.length}
              onClick={launchBatches}
            >
              {specBusy ? t('tasks.specLaunching') : t('tasks.specLaunchBtn', { n: specSel.length })}
            </button>
          )}
          <div className="row-sub" style={{ padding: '8px 4px', lineHeight: 1.6 }}>
            {t('tasks.specNote')}
          </div>
          </div>
        </Sheet>
      ) : null}

      {/* 全バッチ完了後の履歴（Q3=A）。行＝バッチ＋完了バッジ＋完了時刻。増えうる一覧なので縦リスト */}
      {specHistoryOpen && historySpec ? (
        <Sheet title={t('tasks.specHistoryTitle')} onClose={() => setSpecHistoryOpen(false)}>
          {/* 上部は親スコープ枠（SPEC 選択 ＋ プレビュー操作）として子のバッチ履歴と階層を分ける */}
          <div className={`spec-context-box${specPickerOpen ? ' is-open' : ''}`}>
            <SpecPicker
              specList={historySpecList}
              currentSpec={historySpec}
              open={specPickerOpen}
              onToggle={() => setSpecPickerOpen((v) => !v)}
              onPick={(s) => {
                setHistorySpecPath(s.path)
                setSpecPickerOpen(false)
              }}
              archivedCount={specArchivedCount}
              showArchived={historyShowArchived}
              onToggleArchived={setHistoryShowArchived}
              t={t}
            />
            <div className="spec-md-row">
              <button type="button" className="btn spec-md-open" onClick={() => openSpecMd(historySpec)}>
                {`📄 ${t('tasks.specMdPreview')}`}
              </button>
            </div>
          </div>
          <div className="spec-children-section">
            <div className="list-head spec-children-head">
              {t('tasks.specBatchesHead', { n: historySpec.batches.length })}
            </div>
            {/* 1 行 1 バッチ。タップで展開して目的・結果・Git・抜粋まで読む（§3.5 ② / D29） */}
            <div className="pick-list">
            {historySpec.batches.map((b) => {
              const task = historyProg.byId.get(b.id) ?? null
              const done = task?.status === 'done'
              const stateText = task
                ? STATUS_KEY[task.status]
                  ? t(STATUS_KEY[task.status])
                  : task.status
                : t('tasks.specNotFiled')
              const when = done
                ? task?.completedAt
                  ? relTime(task.completedAt)
                  : null
                : task?.startedAt
                  ? t('tasks.specStartedAt', { when: relTime(task.startedAt) })
                  : null
              return (
                <details key={b.id} className="pick-item history-row">
                  <summary className="history-summary">
                    <span className={`dot ${task?.status ?? 'todo'}`} />
                    <span className="history-title" title={`[${b.id}] ${b.title}`}>
                      [{b.id}] {b.title}
                    </span>
                    <span className="history-state">{done ? t('tasks.specDoneBadge') : stateText}</span>
                    <Icon name="chevron" size={14} />
                  </summary>
                  <div className="history-body">
                    <div className="history-head">
                      <ModePill batch={b} t={t} />
                      <span className="history-state-in">{stateText}</span>
                      {task ? <span className="history-task">{t('tasks.specTaskId', { id: task.id })}</span> : null}
                      {when ? <span className="history-when">{when}</span> : null}
                    </div>
                    {b.objective ? (
                      <>
                        <div className="history-label">{t('tasks.specObjective')}</div>
                        <div className="history-objective">{b.objective}</div>
                      </>
                    ) : null}
                    {task?.result ? (
                      <>
                        <div className="history-label">{t('tasks.specResult')}</div>
                        <div className="history-result">{task.result}</div>
                      </>
                    ) : null}
                    {task?.git?.head ? (
                      <div className="git-badge">
                        <span className="git-sha">{task.git.head}</span>
                        {task.git.subject ? <span className="git-subject">{task.git.subject}</span> : null}
                      </div>
                    ) : null}
                    {task ? (
                      <button
                        type="button"
                        className="btn history-open-task"
                        onClick={() => {
                          haptic('action')
                          setSpecHistoryOpen(false)
                          openTask(task)
                        }}
                      >
                        {`🔍 ${t('tasks.specOpenTask')}`}
                      </button>
                    ) : null}
                    <details className="history-sub-details">
                      <summary>{t('tasks.specSection')}</summary>
                      <div className="history-section">{renderMarkdown(b.section || b.title || '')}</div>
                    </details>
                  </div>
                </details>
              )
            })}
          </div>
          {/* 全バッチ完了後・アーカイブ済みは起票導線を出さない（意味の無いボタンを残さない） */}
          {historySpec.archived || historyProg.allDone ? null : (
            <button
              className="btn"
              style={{ marginTop: 12, width: '100%' }}
              onClick={() => {
                setSpecHistoryOpen(false)
                pickSpec(historySpec, true)
                setSpecPickerOpen(false)
                setSpecSheetOpen(true)
              }}
            >
              {t('tasks.specOpenLaunch')}
            </button>
          )}
          {/* 不要・テスト用 SPEC の退避（D92）。ファイルは消さず、ヘッダに 1 行足すだけ */}
          {historySpec && !historySpec.archived ? (
            <div className="spec-archive-row">
              <HoldButton
                label={t('tasks.specArchiveBtn')}
                sub={t('tasks.specArchiveSub')}
                tone="danger"
                onFire={() => archiveCurrentSpec(historySpec)}
              />
            </div>
          ) : null}
          <div className="row-sub" style={{ padding: '8px 4px', lineHeight: 1.6 }}>
            {t('tasks.specHistoryNote')}
          </div>
          </div>
        </Sheet>
      ) : null}

      {/* 仕様書(MD)プレビュー（§3.4 ② / D30）。Launchpad・履歴・バナーから同じ 1 枚を開く */}
      {specMd ? (
        <SpecMarkdownSheet
          board={specMd.board ?? board}
          repo={specsInfo?.repo ?? null}
          path={specMd.path}
          title={specMd.title}
          onClose={() => setSpecMd(null)}
          onArchived={async () => {
            await Promise.all([loadSpecs(board), loadArchitectJobs()])
          }}
        />
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
          {/* 整理モードの入り口（D92）。ON の間は行がチェックボックスになる */}
          <button
            className={`link organize-toggle${organize ? ' on' : ''}`}
            aria-pressed={organize}
            onClick={() => {
              haptic('tap')
              const next = !organize
              setOrganize(next)
              if (!next) setOrganizeSel([])
            }}
          >
            {organize ? t('tasks.organizeExit') : t('tasks.organize')}
          </button>
          <RefreshButton variant="link" onRefresh={refreshAll} />
        </span>
      </div>

      {loading ? <Loader label={t('common.loading')} /> : null}
      {!loading && !tasks.length ? <div className="empty">{t('tasks.empty')}</div> : null}

      {/* 整理モードの操作帯: 失敗・停止の全選択 → 長押しで一括アーカイブ */}
      {organize ? (
        <div className="organize-bar">
          <div className="organize-head">
            <span className="organize-count">{t('tasks.organizeSelected', { n: organizeSel.length })}</span>
            <button
              type="button"
              className="link"
              disabled={!brokenSelection.length}
              onClick={() => {
                haptic('tap')
                setOrganizeSel((cur) => [...new Set([...cur, ...brokenSelection])])
              }}
            >
              {t('tasks.organizeSelectBroken', { n: brokenSelection.length })}
            </button>
            <button
              type="button"
              className="link"
              disabled={!organizeSel.length}
              onClick={() => {
                haptic('tap')
                setOrganizeSel([])
              }}
            >
              {t('tasks.organizeClear')}
            </button>
          </div>
          <div className="hold-grid">
            <HoldButton
              label={t('tasks.organizeArchive', { n: organizeSel.length })}
              sub={t('tasks.organizeHint')}
              tone="danger"
              disabled={organizeBusy || !organizeSel.length || !organizeTargets.length}
              onFire={bulkArchiveSelected}
            />
          </div>
        </div>
      ) : null}

      <div className="list">
        {shownTasks.map((task) => {
          const row = organizeRowView(task, organizeSel)
          const archived = isArchivedTask(task)
          const cls = ['row', archived ? 'is-archived' : '', row.selected ? 'on' : '', organize && !row.archivable ? 'is-locked' : '']
            .filter(Boolean)
            .join(' ')
          return (
          <button
            key={task.id}
            className={cls}
            aria-pressed={organize ? row.selected : undefined}
            onClick={() => {
              haptic('tap')
              // 整理モードでは「選択」、通常は「詳細」。実行中・アーカイブ済みは選べない
              if (organize) {
                if (!row.archivable) return
                setOrganizeSel((cur) => (cur.includes(task.id) ? cur.filter((x) => x !== task.id) : [...cur, task.id]))
                return
              }
              openTask(task)
            }}
          >
            {organize ? (
              <span className="spec-check organize-check" aria-hidden="true">
                {row.selected ? '☑' : '☐'}
              </span>
            ) : null}
            <span className={`dot ${task.status}`} />
            <span className="row-main">
              <span className="row-title">{task.title}</span>
              <span className="row-sub">
                {STATUS_KEY[task.status] ? t(STATUS_KEY[task.status]) : task.status}
                {task.status === 'running' && task.elapsedSec != null
                  ? ` ${sep()} ${t('tasks.elapsedMin', { n: Math.floor(task.elapsedSec / 60) })}`
                  : ''}
                {task.failures ? ` ${sep()} ${t('tasks.failures', { n: task.failures })}` : ''}
                {task.completedAt ? ` ${sep()} ${relTime(task.completedAt)}` : ''}
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
          )
        })}
      </div>

      {/* 「アーカイブ済み (N)」トグル（既定 OFF・D92）。N はサーバの `archivedCount` */}
      {archivedShown > 0 ? (
        <button
          type="button"
          className={`archived-toggle${showArchivedTasks ? ' on' : ''}`}
          aria-pressed={showArchivedTasks}
          onClick={() => {
            haptic('tap')
            setShowArchivedTasks((v) => !v)
          }}
        >
          {t('tasks.archivedToggle', { n: archivedShown })}
          {showArchivedTasks ? ' ✓' : ''}
        </button>
      ) : null}
      {showArchivedTasks && archivedShown > 0 && !tasks.some(isArchivedTask) ? (
        <div className="empty">{t('tasks.archivedEmpty')}</div>
      ) : null}

      <button className="kill-open" onClick={() => setKillOpen(true)}>
        <Icon name="bolt" size={18} />
        {t('tasks.emergency')}
      </button>

      {killOpen ? (
        <Sheet title={t('tasks.emergencyTitle')} onClose={() => !busy && setKillOpen(false)}>
          {/* (1) カンバン・タスク緊急停止（Kanban Workers）— 最優先はこの 1 ボタン */}
          <div className="kill-section">
            <span className="kill-section-title">{t('tasks.emergencyKanbanHead')}</span>
            <span className="kill-section-sub">{t('tasks.emergencyKanbanSub')}</span>
          </div>
          <div className="warn-card">{t('tasks.emergencyNote', { n: running })}</div>
          <div className="hold-grid">
            <HoldButton
              label={t('tasks.stopAllLabel')}
              sub={t('tasks.stopAllSub')}
              tone="danger"
              disabled={busy}
              onFire={stopAllAction}
            />
          </div>
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
            <div className="hold-grid">
              <HoldButton
                label={t('tasks.pauseLabel')}
                sub={t('tasks.pauseSub')}
                tone="safe"
                disabled={busy}
                onFire={pauseAction}
              />
            </div>
          )}

          {/* (2) Hermes Gateway 操作（Bot / 通信）— カンバンのタスクは止まらない */}
          <div className="kill-section">
            <span className="kill-section-title">{t('tasks.emergencyGatewayHead')}</span>
            <span className="kill-section-sub">{t('tasks.emergencyGatewaySub')}</span>
          </div>
          <div className="row-sub" style={{ padding: '0 4px 8px' }}>{t('tasks.gatewayNote')}</div>
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

      {usageOpen ? (
        <UsageSheet
          data={usageData}
          hours={24}
          board={board}
          spec={currentSpec?.path ?? null}
          onClose={() => setUsageOpen(false)}
        />
      ) : null}
      {receiptCtx ? (
        <MissionReceiptSheet
          board={receiptCtx.board}
          spec={receiptCtx.spec}
          onClose={() => setReceiptCtx(null)}
          notify={notify}
        />
      ) : null}

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

      {/* タスク詳細（Sheet / >=820px の右ペイン）。取得・ポーリング・差分は TaskDetailSheet 側 */}
      <TaskDetailSheet
        target={detailTarget}
        fallbackBoard={board}
        mode={split ? 'split' : 'sheet'}
        notify={notify}
        onClose={closeDetail}
        onChanged={(targetBoard) => {
          if (targetBoard) loadTasks(targetBoard)
          refresh?.()
        }}
      />
    </div>
  )
}
