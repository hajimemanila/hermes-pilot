/**
 * TasksPane のデータ層（取得・反映・ポーリング・memo）と、API への操作（Gateway / 緊急停止）。
 *
 * SPEC-COHERENCE-SWEEP-3 CSW3-6 で `features/TasksPane.jsx` から移動した（挙動は変えない）。
 * 定期取得は表（`lib/syncSources.js`）の購読だけで、ここは受け取った値を反映する。
 * ポーリング間隔は表が持つので、この hook には秒数を書かない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api.js'
import { haptic } from '../../lib/haptic.js'
import { celebrate } from '../../lib/vibe.js'
import { countRunningArchitect, pickActiveArchitectJob, pickSpecBanner } from '../../lib/specSeed.js'
import { pendingCount } from '../../lib/reviewView.js'
import { followUpPromptFor, readActiveChatId, reportBodyFor, toEpochMs } from '../../lib/chatReports.js'
import { renderMarkdown } from '../../lib/markdown.js'
import { localizeError } from '../../i18n/lang.js'
import { useI18n } from '../../i18n/index.js'
import { HM_STORAGE } from '../../contracts/storage.js'
import { HM_EVENTS, emitHmEvent, onHmEvent } from '../../contracts/events.js'
import { isOfflineError, shouldNotifyError } from '../../lib/netRecovery.js'
import { useWakeSync } from '../../lib/useWakeSync.js'
import { refreshSync, setSyncParams, setSyncState, subscribeSync, tickSync } from '../../lib/syncSources.js'
import { coherenceBannerView, coherenceDismissRecord, splitSpecsByArchive } from '../../lib/tasksView.js'

const BOARD_KEY = HM_STORAGE.BOARD

/** 直前に選んでいたボードの slug。 */
function readStoredBoard() {
  try {
    return localStorage.getItem(BOARD_KEY)
  } catch {
    return null
  }
}

export function useTasksData({
  notify,
  refresh,
  active = true,
  initialInbox = null,
  pendingInboxOpen = null,
  onConsumedPendingInboxOpen,
}) {
  const { t, lang } = useI18n()
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [tasks, setTasks] = useState([])
  // 直近のパイプライン完走サマリ（SPEC-PILOT-V4 §3.3 ③ / D20③）。無ければバナーを出さない。
  const [latestReport, setLatestReport] = useState(null)
  const [loading, setLoading] = useState(true)
  // 使用量（24h）
  const [usageData, setUsageData] = useState(null)
  const [liveTurns, setLiveTurns] = useState(0)
  const [inboxCount, setInboxCount] = useState(0)
  const [inboxOpen, setInboxOpen] = useState(false)
  // ウィジェットからのディープリンク（?open=inbox&task=…）を1回だけ反映
  const [inboxFocus, setInboxFocus] = useState(null)
  const [architectJobs, setArchitectJobs] = useState(null)
  const [architectFiling, setArchitectFiling] = useState(false)
  const [architectDismissed, setArchitectDismissed] = useState([])
  // 進行バーで × を押したジョブ（`failed` の再表示を止める。SPEC V6 §3.3 ②）
  const [architectJobClosed, setArchitectJobClosed] = useState([])
  const [killOpen, setKillOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  // `archivedCount` はサーバの値をそのまま持つ（一覧の LIMIT で落ちた分も数えている）
  const [archivedTaskTotal, setArchivedTaskTotal] = useState(null)
  // Spec Launchpad（SPEC §5.4 / D15④）: ボードのリポジトリの SPEC とバッチ
  const [specsInfo, setSpecsInfo] = useState(null)
  const [specPath, setSpecPath] = useState(null)
  // Coherence 提案バナー（SPEC-COHERENCE §3.6 / D83）。`null` の間は何も出さない。
  const [coherenceReport, setCoherenceReport] = useState(null)
  // 閉じた記録は localStorage（`HM_STORAGE.COHERENCE_DISMISSED`）に置く。初期値は 1 回だけ読む。
  const [coherenceDismissedRaw, setCoherenceDismissedRaw] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(HM_STORAGE.COHERENCE_DISMISSED) ?? null
    } catch {
      return null
    }
  })
  const workActiveRef = useRef(false)
  const prevWorkActiveRef = useRef(false)
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

  return {
    // 取得した値
    boards, board, setBoard, tasks, loading, latestReport, usageData, liveTurns, inboxCount,
    specsInfo, specPath, setSpecPath, architectJobs, architectFiling, architectDismissed,
    setArchitectDismissed, architectJobClosed, setArchitectJobClosed, archivedTaskTotal,
    // 承認待ち（Inbox）シート
    inboxOpen, inboxFocus, openInbox, closeInbox, loadInbox,
    // 取得関数（シートや他ペインからも呼ぶ）
    loadBoards, loadTasks, loadSpecs, loadArchitectJobs, refreshAll,
    // memo（描画に渡すだけ）
    activeJob, architectRunning, specBanner, idle, reportRecent, coherenceView,
    latestReportBody,
    // 操作
    fileSpecBatches, dismissCoherence, discussLatestReport,
    // Gateway / 緊急停止
    busy, killOpen, setKillOpen, setConfirmText, gatewayAction, stopAllAction, pauseAction, resumeAction,
  }
}
