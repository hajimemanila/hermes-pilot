import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { HoldButton, Icon, Loader, RefreshButton, Sheet, Spinner, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { celebrate } from '../lib/vibe.js'
import { CaptureSheet } from './CaptureSheet.jsx'
import { UsageSheet } from './UsageSheet.jsx'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'
import { SpecSeedSheet } from './SpecSeedSheet.jsx'
import { BrainstormSheet, RefactorSheet } from './TaskToolSheets.jsx'
import { SpecReadyBanner } from '../components/SpecReadyBanner.jsx'
import { SpecMarkdownSheet } from '../components/SpecMarkdownSheet.jsx'
import { ArchitectJobBar } from '../components/ArchitectJobBar.jsx'
import { countRunningArchitect, jobPollMs, pickActiveArchitectJob, pickSpecBanner } from '../lib/specSeed.js'
import { LiveSheet } from './LiveSheet.jsx'
import { InboxSheet } from './InboxSheet.jsx'
import { CloseActions } from '../components/CloseActions.jsx'
import { pendingCount } from '../lib/reviewView.js'
import { fmtCost, sep } from '../lib/format.js'
import { followUpPromptFor, readActiveChatId, reportBodyFor, reportSummaryLine, toEpochMs } from '../lib/chatReports.js'
import { renderMarkdown } from '../lib/markdown.js'
import { batchIdOf, specProgress } from '../lib/specProgress.js'
import { localizeError } from '../i18n/lang.js'
import { useI18n } from '../i18n/index.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import {
  coherenceBannerView,
  coherenceDismissRecord,
  collapseTaskEvents,
  specPickerList,
  splitSpecsByArchive,
} from '../lib/tasksView.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { WorkerFeed } from './ReviewPane.jsx'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'

/** 実行中タスクの詳細を追いかける間隔（heartbeat と worker の進捗が増えるため）。 */
const DETAIL_POLL_MS = 5000

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
 * Execution Mode → バッチ横のモードピル辞書キー（SPEC V5 §3.2）。
 * `mode` が無い過去 SPEC のバッチではピルを出さない。
 */
const MODE_KEY = {
  'zero-stop': 'tasks.modeZeroStop',
  'fast-track-review': 'tasks.modeFastTrack',
  'visual-gate': 'tasks.modeVisualGate',
}

/**
 * バッチのモードピル（未宣言なら null）。
 * @param {{mode?: string|null}} batch バッチ
 * @param {(key: string) => string} t 翻訳
 * @returns {React.ReactElement|null} ピル
 */
function ModePill({ batch, t }) {
  const key = MODE_KEY[batch?.mode]
  if (!key) return null
  return <span className={`spec-mode is-${batch.mode}`}>{t(key)}</span>
}

/**
 * 上部の SPEC セレクタ（SPEC-PILOT-V6 §3.5 ① / D29）。
 *
 * 既定は**選択中の 1 件だけ**を `.pick-item.spec-now` の 1 行で出す。タップすると
 * 下に `.pick-list.spec-accordion` が開き、別の SPEC を選ぶと自動で閉じる
 * （SPEC が増えても一覧が本題のバッチを画面下へ押し流さない）。
 *
 * 表示は増えうる一覧なので横スクロールにせず縦積み（UI 統一の規約）。
 *
 * @param {{specList: Array<object>, currentSpec: object|null, open: boolean,
 *          onToggle: Function, onPick: Function, t: Function}} props
 * @returns {any} セレクタ（1 行 ＋ 任意でアコーディオン）
 */
function SpecPicker({
  specList,
  currentSpec,
  open,
  onToggle,
  onPick,
  t,
  archivedCount = 0,
  showArchived = false,
  onToggleArchived = null,
}) {
  if (!currentSpec) return null
  const others = (specList ?? []).filter((s) => s.path !== currentSpec.path)
  // 展開する中身があるか（他の SPEC、または「Show archived」トグル）。
  // アクティブが 1 件でもアーカイブがあれば開ける（完了済みを見に行く導線を残す）。
  const canExpand = others.length > 0 || Boolean(archivedCount > 0 && onToggleArchived)
  const sub = (s) =>
    [
      t('tasks.specBatchCount', { n: (s.batches ?? []).length }),
      s.mtime ? t('tasks.specUpdated', { when: relTime(s.mtime) }) : null,
    ]
      .filter(Boolean)
      .join(' · ')
  return (
    <>
      <button
        type="button"
        className="pick-item spec-now"
        aria-expanded={canExpand ? open : undefined}
        aria-label={t('tasks.specNowAria', { name: currentSpec.title })}
        onClick={() => {
          haptic('tap')
          onToggle()
        }}
      >
        <span className="pick-main">
          <span className="pick-title">
            <span aria-hidden="true">📄</span> {currentSpec.title}
          </span>
          <span className="pick-sub">{`${sub(currentSpec)} · ${currentSpec.path}`}</span>
        </span>
        <span className="pick-meta">
          {canExpand ? t('tasks.specCountOf', { n: specList.length }) : null}
          {canExpand ? <span aria-hidden="true">{open ? '▴' : '▾'}</span> : null}
        </span>
      </button>
      {open && canExpand ? (
        <div className="pick-list spec-accordion">
          {others.map((s) => (
            <button
              key={s.path}
              type="button"
              className={`pick-item${s.archived ? ' is-archived' : ''}`}
              onClick={() => {
                haptic('tap')
                onPick(s)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">
                  {s.archived ? <span className="spec-archived-pill">{t('tasks.specArchivedPill')}</span> : null}
                  {s.title}
                </span>
                <span className="pick-sub">{sub(s)}</span>
              </span>
              <span className="pick-meta" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
          {/* 完了済み SPEC は既定で隠す（Launchpad が過去で埋まらないようにする。D84）。
              アーカイブが 1 件でもあるときだけ「Show archived (N)」を出す。 */}
          {archivedCount > 0 && onToggleArchived ? (
            <button
              type="button"
              className={`pick-item spec-archived-toggle${showArchived ? ' on' : ''}`}
              aria-pressed={showArchived}
              onClick={() => {
                haptic('tap')
                onToggleArchived(!showArchived)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">
                  {showArchived
                    ? t('tasks.specHideArchived')
                    : t('tasks.specShowArchived', { n: archivedCount })}
                </span>
              </span>
              <span className="pick-meta" aria-hidden="true">
                {showArchived ? '−' : '+'}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

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

  /*
   * A2B クイック起票カードの材料（GET /api/architect/jobs・SPEC V5 §3.2 D23）。
   * Seed していなくても「未起票の新しい SPEC」があればカードを出す（pending）。
   * 20 秒ごと。旧ブリッジ（404）ではカードを出さないだけ。
   */
  const loadArchitectJobs = useCallback(async () => {
    if (!board) {
      setArchitectJobs(null)
      return
    }
    try {
      const d = await api(`/api/architect/jobs?board=${encodeURIComponent(board)}`)
      if (d?.ok) setArchitectJobs(d)
    } catch {
      setArchitectJobs(null)
    }
  }, [board])

  const openTaskCountRef = useRef({ board: null, count: null })
  const loadTasks = useCallback(
    async (slug) => {
      if (!slug) return false
      try {
        const d = await api(`/api/boards/${encodeURIComponent(slug)}/tasks?limit=60`)
        const list = d.tasks ?? []
        setTasks(list)
        // 未完了タスクが減った（完了へ抜けた）瞬間に完了報告と Architect 進行バーを即時更新する
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
      } catch (e) {
        setTasks([])
        notify(e.message)
        return false
      }
    },
    [notify, loadArchitectJobs],
  )

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  // 使用量は60秒ごと（サーバ側も30秒キャッシュ）
  useEffect(() => {
    if (!active) return undefined
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
  }, [active])

  // 実行中ターン数（タイルの点。10秒ごと）
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    const load = () =>
      api('/api/live')
        .then((d) => {
          if (!alive) return
          const turns = Number(d?.counts?.turns ?? 0)
          setLiveTurns(turns)
          try {
            window.dispatchEvent(
              new CustomEvent(HM_EVENTS.LIVE_TURNS, {
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
  }, [active])

  // 承認待ちの件数（15秒ごと）
  const loadInbox = useCallback(async () => {
    try {
      const d = await api('/api/inbox')
      const items = d?.items ?? []
      setInboxCount(pendingCount(items))
      // 下部ナビのタスクタブの丸バッジ（注釈 1377.jpg の赤）を、この一覧と同じデータで同期する
      try {
        emitHmEvent(HM_EVENTS.INBOX_ITEMS, { items })
      } catch {
        /* noop */
      }
    } catch {
      /* 表示だけなので握る */
    }
  }, [])

  useEffect(() => {
    if (!active) return undefined
    loadInbox()
    const id = setInterval(() => document.visibilityState === 'visible' && loadInbox(), 15_000)
    return () => clearInterval(id)
  }, [loadInbox, active])

  /*
   * Spec Launchpad 用の SPEC 検出（SPEC §5.4）。ボードを変えるたびに 1 回だけ問い合わせる
   * （ファイル走査はサーバ側で安いが、タスク一覧のように 5 秒ごとに叩く必要は無い）。
   * バッチが 1 つも無い SPEC（TOC だけ・別形式）はバーに出さない。
   *
   * **切り出してある理由（SPEC V6 §3.3 ③ / D31）**: Seed で新しい SPEC が書かれても、
   * タブをリロードするまで `🚀 仕様ランチャー` に出ない不整合を無くすため、
   * ①ボード変更 ②更新ボタン（`refreshAll`）③一括起票の直後 ④`architectJobs` の変化
   * の 4 か所から同じ関数を呼ぶ。
   */
  const loadSpecs = useCallback(async (slug) => {
    if (!slug) {
      setSpecsInfo(null)
      return
    }
    try {
      const d = await api(`/api/specs?board=${encodeURIComponent(slug)}`)
      // 既定はアクティブ SPEC だけ（サーバが `archivedSpecs` を返す）。
      // 旧ブリッジ（`archivedSpecs` 無し）でも `archived` フラグで分けられるようにしておく。
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
        // アクティブが無いリポジトリでは、アーカイブを 1 件だけ出してトグルへ辿れるようにする
        return split.active[0]?.path ?? split.archived[0]?.path ?? null
      })
    } catch {
      setSpecsInfo(null)
    }
  }, [])

  useEffect(() => {
    loadSpecs(board)
  }, [board, loadSpecs])

  /*
   * 完走予兆の提案バナー（SPEC-COHERENCE §3.6 / D83）。
   *
   * 情報源は 2 系統ある。「生の診断（`GET /api/coherence/report`）」があればそれを優先し、
   * 無い（＝ 旧ブリッジで 404）ときは直近の完走レポートの `coherence_alert` を見る。
   * どちらも無ければ**何も出さない**（診断は飾りにしない・画面を壊さない）。
   * 読み取り専用で、ここから勝手にカンバンへ起票しない（D55）。
   */
  const loadCoherence = useCallback(async (slug, { fresh = false } = {}) => {
    if (!slug) {
      setCoherenceReport(null)
      return
    }
    try {
      const d = await api(`/api/coherence/report?board=${encodeURIComponent(slug)}${fresh ? '&fresh=1' : ''}`)
      setCoherenceReport(d && typeof d === 'object' ? d : null)
    } catch {
      // ルート未実装・オフラインでは黙って諦める（完走レポート側の材料で代替する）
      setCoherenceReport(null)
    }
  }, [])

  useEffect(() => {
    if (!board || !active) return undefined
    loadCoherence(board)
    // リポジトリ全体の走査なので、タスク一覧（5 秒）ほど頻繁に叩かない。
    const id = setInterval(() => document.visibilityState === 'visible' && loadCoherence(board), 120_000)
    return () => clearInterval(id)
  }, [board, active, loadCoherence])

  const refreshAll = useCallback(async () => {
    const results = await Promise.all([
      board ? loadTasks(board) : Promise.resolve(true),
      loadInbox(),
      loadSpecs(board),
      board ? loadCoherence(board, { fresh: true }) : Promise.resolve(),
      refresh ? refresh() : Promise.resolve(true),
    ])
    return results[0] !== false
  }, [board, loadTasks, loadInbox, loadSpecs, loadCoherence, refresh])

  useEffect(() => {
    if (!board || !active) return undefined
    loadTasks(board)
    const id = setInterval(() => document.visibilityState === 'visible' && loadTasks(board), 5000)
    return () => clearInterval(id)
  }, [board, loadTasks, active])

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

  // 状態が変わった瞬間に間隔を切り替える（効果の再生成は status/id だけで足りる）
  const pollMs = jobPollMs(activeJob)

  /*
   * 稼働中の Architect ジョブ件数（D43 後半）。`/api/live` の `counts.architect` と同じ規則
   * （`running` / `awaiting_spec`）。カンバンタスクを持たない Agy Opt-in も数に入れる。
   */
  const architectRunning = useMemo(
    () => countRunningArchitect(architectJobs?.jobs ?? []),
    [architectJobs],
  )

  useEffect(() => {
    if (!active) return undefined
    loadArchitectJobs()
    // 進行中（running / awaiting_spec）だけ 4 秒。人待ち・停止・ジョブ無しは 20 秒（SPEC V6 §3.3 ③）
    const id = setInterval(
      () => document.visibilityState === 'visible' && loadArchitectJobs(),
      pollMs,
    )
    return () => clearInterval(id)
  }, [loadArchitectJobs, pollMs, active])

  // スリープ復帰・Review 回答・パイプライン完走通知の直後にタスク一覧・進行バー・Coherence 診断を即時再同期する
  useEffect(() => {
    const onWake = () => {
      loadArchitectJobs()
      if (board) {
        loadTasks(board)
        loadCoherence(board, { fresh: true })
      }
    }
    const onRefreshReports = () => {
      if (board) loadCoherence(board, { fresh: true })
    }
    window.addEventListener(HM_EVENTS.WAKE_SYNC, onWake)
    window.addEventListener(HM_EVENTS.REFRESH_REPORTS, onRefreshReports)
    return () => {
      window.removeEventListener(HM_EVENTS.WAKE_SYNC, onWake)
      window.removeEventListener(HM_EVENTS.REFRESH_REPORTS, onRefreshReports)
    }
  }, [board, loadArchitectJobs, loadTasks, loadCoherence])

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
    if (!board || !active) return undefined
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
  }, [board, idle, active])

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
    () => coherenceBannerView(coherenceReport ?? latestReport ?? null, coherenceDismissedRaw),
    [coherenceReport, latestReport, coherenceDismissedRaw],
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

  /*
   * ChatPane の「📋 ボードを見る」で Tasks タブへ来たとき、そのボードを選ぶ。
   * `taskId` 付き（`ArchitectJobBar` / `LiveSheet` の「進捗詳細・タスク」・D43）なら、
   * ボード一覧が揃った時点でそのタスク詳細も開く。
   */
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

  /**
   * タスク詳細を開く。
   *
   * @param {{id: string, title?: string}} task タスク（最低限 id）
   * @param {string} [boardSlug] そのタスクのボード（別ボードのジョブから開くとき・D43）。
   *        省略時は表示中のボード。取得先 URL と、詳細の再同期先をこのボードに固定する。
   */
  const openTask = async (task, boardSlug = board) => {
    const targetBoard = String(boardSlug ?? board ?? '').trim()
    setDetail({ loading: true, board: targetBoard, ...task })
    setDiff(null)
    setPatch(null)
    try {
      const d = await api(
        `/api/boards/${encodeURIComponent(targetBoard)}/tasks/${encodeURIComponent(task.id)}`,
      )
      setDetail({ ...d, board: targetBoard })
    } catch (e) {
      notify(e.message)
      setDetail(null)
    }
  }

  /** 実行中／待機中のあいだ詳細を再同期する（heartbeat・イベント・worker の進捗が増えるため）。 */
  useEffect(() => {
    const id = detail?.id
    const status = detail?.status
    if (!id) return
    if (!(status === 'running' || status === 'ready')) return
    // 別ボードのタスクを開いている場合がある（D43 の導線）ので、詳細自身のボードを優先する
    const detailBoard = String(detail?.board ?? board ?? '')
    let alive = true
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const d = await api(`/api/boards/${encodeURIComponent(detailBoard)}/tasks/${encodeURIComponent(id)}`)
        if (!alive) return
        // 別のタスクを開いた／閉じたときに古い応答で上書きしない
        setDetail((prev) => (prev && prev.id === id ? { ...prev, ...d, board: detailBoard, loading: false } : prev))
      } catch {
        /* 一時的な失敗は次の tick で取り直す */
      }
    }, DETAIL_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [detail?.id, detail?.status, detail?.board, board])

  /** 詳細が対象にしているボード（別ボードのタスクを開いたときの取り違えを防ぐ・D43）。 */
  const detailBoard = String(detail?.board ?? board ?? '')

  /*
   * Architect ジョブの「🔍 進捗詳細」（SPEC-PILOT-V9 §3.3 ② / D43 後半）。
   *
   * - `taskId` あり（Hermes Native）… そのタスクの詳細を開く（実行中なら WorkerFeed も出る）
   * - `taskId` なし（Agy Opt-in。カンバンタスクを作らない）… 全体の `LiveSheet` を開く
   *
   * 別ボードのジョブでも、取得先はジョブの `board` をそのまま使う（表示中ボードに無いタスクでも
   * 詳細 API は開ける）。ボード一覧に居る場合だけ選択も切り替える。
   */
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

  /** 差分サマリ（アコーディオンを開いたときだけ取りに行く）。 */
  const loadDiff = async (id) => {
    if (diff?.files) return
    setDiff({ loading: true })
    try {
      const d = await api(`/api/boards/${encodeURIComponent(detailBoard)}/tasks/${encodeURIComponent(id)}/diff`)
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
        `/api/boards/${encodeURIComponent(detailBoard)}/tasks/${encodeURIComponent(id)}/diff?file=${encodeURIComponent(file)}`,
      )
      setPatch({ ...d, path: file })
    } catch (e) {
      setPatch({ path: file, ok: false, reason: e.message })
    }
  }

  const abortTask = async (task) => {
    setBusy(true)
    try {
      const targetBoard = String(task?.board ?? detailBoard).trim()
      const r = await api(
        `/api/boards/${encodeURIComponent(targetBoard)}/tasks/${encodeURIComponent(task.id)}/abort`,
        {
          method: 'POST',
          body: { reason: t('tasks.abortReason') },
        },
      )
      if (r?.ok === false) {
        notify(r?.error || r?.output || t('live.abortFailed', { id: task.id }))
        return
      }
      notify(t('tasks.aborted', { reclaim: r.reclaimed, block: r.blocked }))
      emitHmEvent(HM_EVENTS.WAKE_SYNC)
      setDetail(null)
      loadTasks(targetBoard)
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

  /**
   * 全タスク緊急停止（ESTOP ＋ 実行中一括中断）。
   *
   * 本番は失敗を HTTP 502 で返すので `api()` が例外にするが、デモは `{ok:false}` を返す。
   * どちらでも「成功トーストを出さない」ために両方を見る（D90 のエラー可視化）。
   */
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
  const paused = overview?.paused ?? { engaged: false }
  // >=680px は 2 ペイン（詳細をシートではなく右ペインに出す。SPEC-i18n-resp §2 B3）
  // 境界は lib/layout.js の 1 箇所だけ（CSS の @media と一致させる）
  const { split } = useSplitLayout()

  /*
   * Spec Launchpad（SPEC §5.4）。ボード上に同じ `[<ID>]` のタスクがあるバッチは
   * 「起票済み」として先に見せる（サーバ側の冪等チェックと同じ規則）。
   * 既定で選ぶのは**まだ一度も起票していない**バッチだけ — 完了済みのバッチを
   * うっかり再起票しないため（選び直せば起票できる）。
   */
  const specParts = { active: specsInfo?.active ?? [], archived: specsInfo?.archived ?? [] }
  const specArchivedCount = specParts.archived.length
  // `Show archived` の状態で並びを切り替える（既定はアクティブのみ・純関数でテスト済み）
  const specList = specPickerList(specParts, specShowArchived)
  const currentSpec = specList.find((s) => s.path === specPath) ?? specList[0] ?? null
  /*
   * 起票・完了の判定は lib/specProgress.js に集約（単体テストで固定）。
   * allDone のときだけカードを「✅ 全バッチ完了」にし、タップ先を履歴へ切り替える（Q3=A）。
   */
  // `pipeline-runs.json` の taskIds と SPEC の mtime を照合の補助に渡す（D91/D92。
  // 無印レガシータスク・別 SPEC の同名 ID を誤って拾わない）。
  const specOpts = { specMtime: currentSpec?.mtime ?? null, runTaskIds: currentSpec?.runTaskIds ?? null }
  const specProg = specProgress(currentSpec?.batches ?? [], tasks, currentSpec?.path, specOpts)
  const filedBatchIds = new Set(specProg.byId.keys())
  const openBatchIds = new Set(
    [...specProg.byId.entries()]
      .filter(([, task]) => task.status !== 'done' && task.status !== 'archived')
      .map(([id]) => id),
  )
  const specAllDone = specProg.allDone
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

  /** 全バッチ完了後の履歴シートを開く（Q3=A）。 */
  const openSpecHistory = () => {
    if (!currentSpec) return
    haptic('tap')
    setSpecPickerOpen(false)
    setSpecHistoryOpen(true)
  }

  /**
   * 上部セレクタで SPEC を切り替える（SPEC-PILOT-V6 §3.5 ①）。
   *
   * Launchpad（`forLaunch`）では、**選んだ SPEC のバッチ**で未起票の選択を作り直す。
   * 旧実装は切替前の `currentSpec` から作った `filedBatchIds` を見ていたため、
   * 別 SPEC に切り替えても未起票の既定選択が古いままだった（実測バグ）。
   * ここで `specProgress(next.batches, tasks)` を計算し直してから選ぶ。
   */
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
                {detail.workerPid ? ` ${sep()} pid ${detail.workerPid}` : ''}
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
                                {localizeError(patch)}
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
                      {localizeError(diff)}
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
              ) : detail.status && detail.status !== 'done' && detail.status !== 'archived' ? (
                <div style={{ marginTop: 12 }}>
                  <CloseActions
                    board={detailBoard}
                    taskId={detail.id}
                    notify={notify}
                    onClosed={() => {
                      emitHmEvent(HM_EVENTS.WAKE_SYNC)
                      setDetail(null)
                      if (detailBoard) loadTasks(detailBoard)
                      refresh?.()
                    }}
                  />
                </div>
              ) : null}

              {detail.sessionId ? (
                <div style={{ marginTop: 12 }}>
                  <WorkerFeed
                    taskId={detail.id}
                    open={detail.status === 'running' || detail.status === 'ready'}
                    endpoint={`/api/boards/${encodeURIComponent(detailBoard)}/tasks/${encodeURIComponent(detail.id)}/worker?limit=30`}
                  />
                </div>
              ) : null}

              <div className="list-head" style={{ marginTop: 16 }}>
                <span>{t('tasks.events')}</span>
              </div>
              <div className="timeline">
                {collapseTaskEvents(detail.events ?? []).map((e, i) => {
                  const merged = e.kind === 'heartbeat' && e.count > 1
                  return (
                    <div key={i} className="tl">
                      <span className="tl-dot" />
                      <span className="tl-main">
                        <span className="row-title">
                          {merged ? t('tasks.heartbeatCount', { n: e.count }) : e.kind}
                        </span>
                        <span className="row-sub">
                          {merged
                            ? t('tasks.heartbeatRange', { first: relTime(e.firstAt), last: relTime(e.at) })
                            : relTime(e.at)}
                        </span>
                      </span>
                    </div>
                  )
                })}
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
      />

      {/*
        完走予兆の提案バナー（SPEC-COHERENCE §3.6 / D83）。
        読み取り専用の診断結果から、閾値超過のときだけ出す。1 タップで推奨スイープを選んだ
        `RefactorSheet` を開き、✕ は署名つきで保存する（件数が変われば出し直す）。
      */}
      {coherenceView.show ? (
        <section className={`coh-banner${coherenceOpen ? ' is-open' : ''}`} aria-label={t('coherence.bannerAria')}>
          <div className="coh-banner-row">
            <button
              type="button"
              className="coh-banner-head"
              aria-expanded={coherenceOpen}
              onClick={() => {
                haptic('tap')
                setCoherenceOpen((v) => !v)
              }}
            >
              <span className="coh-banner-icon" aria-hidden="true">
                🩺
              </span>
              <span className="coh-banner-main">
                <span className="coh-banner-title">{t('coherence.bannerTitle')}</span>
                <span className="coh-banner-sub">
                  {t('coherence.bannerSummary', {
                    hard: coherenceView.summary.hardFailCount,
                    soft: coherenceView.summary.softSignalCount,
                    hotspots: coherenceView.summary.hotspotCount,
                  })}
                </span>
              </span>
              <span className="coh-banner-chev" aria-hidden="true">
                {coherenceOpen ? '▴' : '▾'}
              </span>
            </button>
            <button
              type="button"
              className="coh-banner-close"
              aria-label={t('coherence.bannerDismiss')}
              onClick={dismissCoherence}
            >
              ✕
            </button>
          </div>
          {coherenceOpen ? (
            <div className="coh-banner-body">
              {coherenceView.highlights.length ? (
                <ul className="coh-banner-list">
                  {coherenceView.highlights.map((h, i) => (
                    <li key={`${i}-${h}`}>{h}</li>
                  ))}
                </ul>
              ) : null}
              <div className="coh-banner-actions">
                <button type="button" className="btn primary" onClick={openCoherenceSweep}>
                  {t('coherence.bannerOpen')}
                </button>
                <button type="button" className="btn" onClick={dismissCoherence}>
                  {t('coherence.bannerHide')}
                </button>
              </div>
            </div>
          ) : (
            <div className="coh-banner-actions is-inline">
              <button type="button" className="btn primary" onClick={openCoherenceSweep}>
                {t('coherence.bannerOpen')}
              </button>
            </div>
          )}
        </section>
      ) : null}

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
                      <span className="spec-taken">{t(taken ? 'tasks.specAlready' : 'tasks.specFiledDone')}</span>
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
      {specHistoryOpen && currentSpec ? (
        <Sheet title={t('tasks.specHistoryTitle')} onClose={() => setSpecHistoryOpen(false)}>
          {/* 上部は親スコープ枠（SPEC 選択 ＋ プレビュー操作）として子のバッチ履歴と階層を分ける */}
          <div className={`spec-context-box${specPickerOpen ? ' is-open' : ''}`}>
            <SpecPicker
              specList={specList}
              currentSpec={currentSpec}
              open={specPickerOpen}
              onToggle={() => setSpecPickerOpen((v) => !v)}
              onPick={(s) => pickSpec(s, false)}
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
            {/* 1 行 1 バッチ。タップで展開して目的・結果・Git・抜粋まで読む（§3.5 ② / D29） */}
            <div className="pick-list">
            {currentSpec.batches.map((b) => {
              const task = specProg.byId.get(b.id) ?? null
              const done = task && (task.status === 'done' || task.status === 'archived')
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
          {/* 全バッチ完了後は起票するものが無いので導線を出さない（意味の無いボタンを残さない） */}
          {specAllDone ? null : (
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
          )}
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
        ))}
      </div>

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
