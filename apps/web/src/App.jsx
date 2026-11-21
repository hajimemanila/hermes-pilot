import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { readDeepLink } from './lib/deeplink.js'

import { api } from './api.js'
import { appBadgeCount, navBadgeState, pendingCount, runningCount, unseenNotices, waitingCount } from './lib/reviewView.js'
import { cachePercent, gwState, latestToolName, reviewJumpTarget, runningTotal } from './lib/telemetry.js'
import {
  SEEN_MAP_KEY,
  SEEN_NAV_KEY,
  newerThan,
  otherUnreadReports,
  readActiveChatId,
  readSeenMap,
  unseenPipelineReports,
} from './lib/chatReports.js'
import { TasksPane } from './features/TasksPane.jsx'
import { ChatPane } from './features/ChatPane.jsx'
import { SettingsPane } from './features/SettingsPane.jsx'
import { ReviewPane } from './features/ReviewPane.jsx'
import { SearchSheet } from './features/SearchSheet.jsx'
import { UsageSheet } from './features/UsageSheet.jsx'
import { LiveSheet } from './features/LiveSheet.jsx'
import { MemosPane } from './features/MemosPane.jsx'
import { Icon, Loader } from './components/Ui.jsx'
import { FxLayer } from './components/FxLayer.jsx'
import { haptic } from './lib/haptic.js'
import { celebrate, getActiveVibe, initVibe } from './lib/vibe.js'
import { useI18n } from './i18n/index.js'
import { t as tGlobal } from './i18n/lang.js'
import { initTheme } from './lib/theme.js'
import { consumePairToken } from './lib/pairing.js'
import { isChunkLoadError, reloadForChunkError, retryImport } from './lib/lazyRetry.js'
import { HM_EVENTS, emitHmEvent } from './contracts/events.js'
import { HM_STORAGE } from './contracts/storage.js'

/*
 * ターミナルは初回にしか読み込まない（起動を速くするため）。ただしスリープ復帰や
 * 再デプロイの後は古いハッシュの `TermPane-<hash>.js` を取りに行って失敗するので、
 * `retryImport` で数回刺し直してから諦める（`lib/lazyRetry.js`）。
 */
const TermPane = lazy(() =>
  retryImport(() => import('./features/TermPane.jsx')).then((m) => ({ default: m.TermPane })),
)

const TABS = [
  { id: 'tasks', key: 'nav.tasks', icon: 'grid' },
  { id: 'review', key: 'nav.review', icon: 'pen' },
  { id: 'chat', key: 'nav.chat', icon: 'chat' },
  { id: 'notes', key: 'nav.notes', icon: 'memo' },
  { id: 'term', key: 'nav.term', icon: 'term' },
  { id: 'settings', key: 'nav.settings', icon: 'gear' },
]

/**
 * タブ共通のホスト（非アクティブ時は `display:none` ではなく `visibility:hidden + inert` で隠し、
 * スクロール位置・入力欄・端末セッションなどをそのまま保持する）。
 */
function TabHost({ active, children }) {
  const hostRef = useRef(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const hidden = !active
    if ('inert' in host) host.inert = hidden
    if (hidden) {
      const el = document.activeElement
      if (el && host.contains(el) && typeof el.blur === 'function') el.blur()
    }
  }, [active])

  return (
    <div ref={hostRef} className={`pane-host${active ? '' : ' is-hidden'}`} aria-hidden={active ? undefined : 'true'}>
      {children}
    </div>
  )
}

/** タブ内の描画エラー画面（フックを使うため関数コンポーネントに切り出す）。 */
function TabError({ error, onRetry }) {
  const { t } = useI18n()
  return (
    <div className="pane">
      <div className="card">
        <div className="row-title">{t('app.tabError')}</div>
        <div className="row-sub" style={{ marginTop: 6, lineHeight: 1.7 }}>
          {String(error?.message ?? error)}
        </div>
        <button className="btn" style={{ marginTop: 12 }} onClick={onRetry}>
          {t('common.retry')}
        </button>
        <div className="row-sub" style={{ marginTop: 8 }}>
          {t('app.tabErrorLog')}
        </div>
      </div>
    </div>
  )
}

/**
 * タブ内の描画エラーを1画面に閉じ込める（下部ナビは絶対に残す）。
 * 発生したら内容とスタックをブリッジに送って記録する。
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, retryKey: 0 }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    try {
      fetch('/api/client-error', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-client': 'mobile' },
        body: JSON.stringify({
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').slice(0, 4000),
          componentStack: String(info?.componentStack ?? '').slice(0, 4000),
          tab: this.props.tab,
          ua: navigator.userAgent,
          url: location.href,
        }),
      }).catch(() => {})
    } catch {
      /* noop */
    }
  }

  /**
   * 「再試行」の中身。チャンクが取れなかっただけの失敗は `React.lazy` が reject を
   * 握ったままなので、state を戻して描き直しても同じ失敗を即座に再生する。
   * その場合だけページを 1 回読み直す（30 秒クールダウン中なら読み直さず、
   * 下の再描画に任せる＝無限リロードにしない）。実装バグは `retryKey` を上げて
   * 子を作り直すだけにする。
   */
  retry() {
    if (isChunkLoadError(this.state.error) && reloadForChunkError()) return
    this.setState((prev) => ({ error: null, retryKey: prev.retryKey + 1 }))
  }

  render() {
    if (this.state.error) {
      return <TabError error={this.state.error} onRetry={() => this.retry()} />
    }
    // `retryKey` を key に載せ、再試行で子（reject 済み lazy を含む）を作り直す
    return <React.Fragment key={`${this.props.tab}:${this.state.retryKey}`}>{this.props.children}</React.Fragment>
  }
}

export function App() {
  const { t } = useI18n()
  const [deepLink] = useState(() => readDeepLink())

  /*
   * テーマ（Dark / Light / System）の初期化と `prefers-color-scheme` の監視（SPEC §7.1）。
   * 初回描画前に `main.jsx` が 1 度当てているので、ここは「購読を張り直す」役。
   * `initTheme` は冪等（監視は 1 本だけ）で、`<html data-theme>` と
   * `<meta name="theme-color">` の更新も内部で行う。
   */
  useEffect(() => initTheme(), [])

  /*
   * Vite の動的 import 失敗（再デプロイ・スリープ復帰で古いハッシュを掴んだ時）は
   * `vite:preloadError` として飛んでくる。`ErrorBoundary` まで落ちる前に、
   * 30 秒クールダウン付きの単発リロードで拾う（`lib/lazyRetry.js`）。
   * リロードしない（＝クールダウン中）ときは preventDefault せず、例外を
   * そのまま `ErrorBoundary` に渡してタブ内のエラー表示に落とす。
   */
  useEffect(() => {
    const onPreloadError = (event) => {
      if (reloadForChunkError()) event.preventDefault?.()
    }
    window.addEventListener('vite:preloadError', onPreloadError)
    return () => window.removeEventListener('vite:preloadError', onPreloadError)
  }, [])

  /*
   * Vibe Mode（Dopamine ⇄ Serotonin・SPEC-PILOT-V5 §3.1 / D24）。
   * 保存値 → 無ければ端末の `prefers-reduced-motion` で自動選択し、`<html data-vibe>` を当てる。
   * 冪等なので再マウントしても安全。Serotonin でもハプティック（`haptic.js`）は止めない。
   */
  useEffect(() => {
    initVibe()
  }, [])

  const [tab, setTab] = useState(
    deepLink?.open === 'inbox' || deepLink?.open === 'tasks' ? 'tasks' : deepLink?.open === 'chat' ? 'chat' : 'tasks',
  )
  const [overview, setOverview] = useState(null)
  const [conn, setConn] = useState('ok')
  const [authNeeded, setAuthNeeded] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [toast, setToast] = useState(null)
  const [booting, setBooting] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  /*
   * チャットはタブを移っても畳まない（レビュー chat-keepalive-01: q1=A 画面を残す / q2=A 裏でも受ける）。
   * 一度開いたら「隠すだけ」にして、スクロール位置・ツール使用ログ・書きかけ・WS の受信をそのまま残す。
   * 起動直後にチャットへ繋がないよう、初回にチャットタブを開くまでマウントしない。
   * 書きかけはメモリのみ（q3=B）なので localStorage には保存しない。
   */
  const [mountedTabs, setMountedTabs] = useState(() => ({ [tab]: true }))
  const chatMounted = Boolean(mountedTabs.chat)
  // 下部ナビのレビュータブに出す判断待ち件数（注釈 1377.jpg の赤 = 小さい丸に数字）。
  // タブ内の表示は ReviewPane の持ち物なので、ここでは数えるだけ。
  const [reviewWaiting, setReviewWaiting] = useState(0)
  // 下部ナビのタスクタブに出す承認待ち件数（同じ赤の指示。承認待ちは全ボード横断）。
  const [inboxPending, setInboxPending] = useState(0)
  // レビューの進行中件数と、作業フィード（完了・停止の 1 行ログ）の未読数。
  // 「押すまで分からない」を無くすため、判断待ちの数字とは別に 点 で出す。
  const [reviewRunning, setReviewRunning] = useState(0)
  const [reviewUnseen, setReviewUnseen] = useState(0)
  const lastSeenRef = useRef(0)
  /*
   * チャットの新着（レビューの完了報告が起票した会話に戻る 1 行。レビュー chat-badge-01）。
   * q1=A で「紐づけと新着バッジの両方」、q2=A で「チャットタブと会話一覧の行の両方」、
   * q3=B で「点だけ（数字を出さない）」。数字は判断待ち専用のままにする。
   */
  const [chatReportItems, setChatReportItems] = useState([])
  /**
   * 未見のパイプライン完了レポート数（ナビのタスクタブに出す）。
   *
   * 報告カードはタスクタブに出るのに、ナビには何も出ていなかった（実機フィードバック）。
   * 宛先セッションが会話一覧に無い報告でも「まだ見ていない成果」なので数える。
   */
  const [pipelineUnseen, setPipelineUnseen] = useState(0)
  const [chatUnread, setChatUnread] = useState(0)
  const [otherChatUnread, setOtherChatUnread] = useState(0)
  const [liveTurns, setLiveTurns] = useState(0)
  const [liveTurnsList, setLiveTurnsList] = useState([])
  // 稼働中の Architect（仕様策定）ジョブ数。カンバンタスクを持たない `agy` ジョブも
  // ⚡ 実行中 に数えるため `/api/live` の `counts.architect` を購読する（SPEC V9 §3.2 / D43）。
  const [liveArchitect, setLiveArchitect] = useState(0)
  const [reviewItems, setReviewItems] = useState([])
  const [chatStreaming, setChatStreaming] = useState(false)
  const [reviewFocus, setReviewFocus] = useState(null)
  const [pendingChatOpen, setPendingChatOpen] = useState(null)
  const [pendingTaskTool, setPendingTaskTool] = useState(null)
  // インボックスを開く要求。以前は `setTimeout` で `hm:open-inbox` を投げていたが、
  // タスクタブが未マウントだと 200ms では届かず、マウント済みなら不要という不安定な橋だった。
  // いまは prop で TasksPane に渡し、消費されたら null に戻す（`reviewFocus` と同じ形）。
  const [pendingInboxOpen, setPendingInboxOpen] = useState(null)
  const requestInboxOpen = useCallback((task = null) => {
    setPendingInboxOpen({ task: task ?? null, nonce: Date.now() })
  }, [])

  useEffect(() => {
    const onOpenBrainstorm = (e) => {
      setPendingTaskTool({ kind: 'brainstorm', ...(e?.detail || {}) })
      setTab('tasks')
    }
    const onOpenSeed = (e) => {
      setPendingTaskTool({ kind: 'seed', ...(e?.detail || {}) })
      setTab('tasks')
    }
    window.addEventListener(HM_EVENTS.OPEN_BRAINSTORM, onOpenBrainstorm)
    window.addEventListener(HM_EVENTS.OPEN_SEED, onOpenSeed)
    return () => {
      window.removeEventListener(HM_EVENTS.OPEN_BRAINSTORM, onOpenBrainstorm)
      window.removeEventListener(HM_EVENTS.OPEN_SEED, onOpenSeed)
    }
  }, [])
  /*
   * パイプライン完走サマリの導線（SPEC-PILOT-V4 §3.3 ③ / D20③）。
   *  - pendingDiscuss: Tasks タブのバナー「💬 チャットで次の一手を相談」→ ChatPane が会話を開いて相談文を置く
   *  - focusBoard: ChatPane の「📋 ボードを見る」→ Tasks タブがそのボードへ切り替える
   * どちらも nonce 付きで持つ（同じ内容の連打でも 1 回ずつ効かせる）。
   */
  const [pendingDiscuss, setPendingDiscuss] = useState(null)
  const [focusBoard, setFocusBoard] = useState(null)
  // 計器盤（SPEC §5.5）: 使用量（60 秒キャッシュ）と、そこから開くシート
  const [usageData, setUsageData] = useState(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const chatMountedRef = useRef(chatMounted)
  chatMountedRef.current = chatMounted
  const chatSeenRef = useRef(0)
  // 直近に知らせた報告の時刻（同じ行で二度トーストを出さない）。
  // 初回の取得では 0 のまま入れ直すだけにして、過去の報告を「今来た」として出さない。
  const chatReportedAtRef = useRef(null)
  const tabRef = useRef(tab)
  tabRef.current = tab
  useEffect(() => {
    try {
      chatSeenRef.current = Number(localStorage.getItem(SEEN_NAV_KEY)) || 0
    } catch {
      chatSeenRef.current = 0
    }
  }, [])

  /**
   * タスクタブを開いたら、その上部に出ている完了報告カードを「見た」ことにする。
   * 既読は `SEEN_MAP_KEY`（会話ごとの既読時刻）に報告の `at` で書き、ナビのバッジを消す。
   */
  useEffect(() => {
    if (tab !== 'tasks' || !pipelineUnseen) return
    try {
      const seenMap = readSeenMap(localStorage.getItem(SEEN_MAP_KEY))
      const now = Date.now()
      const next = { ...seenMap }
      for (const r of unseenPipelineReports(chatReportItems, seenMap)) {
        next[r.sessionId] = Math.max(now, Number(r.at) || 0)
      }
      localStorage.setItem(SEEN_MAP_KEY, JSON.stringify(next))
      setPipelineUnseen(0)
    } catch {
      /* 保存できなくても表示は続ける */
    }
  }, [tab, pipelineUnseen, chatReportItems])

  /** チャットタブを開いた時刻を「見た」として端末に残す（ナビの点を消す）。 */
  const markChatSeen = useCallback(() => {
    const at = Date.now()
    chatSeenRef.current = at
    setChatUnread(0)
    try {
      localStorage.setItem(SEEN_NAV_KEY, String(at))
    } catch {
      /* 保存できなくても表示は続ける */
    }
  }, [])

  /*
   * バッジ即時同期エンジン（SPEC-PILOT-V3 §3.2 / D17②）。
   *
   * バッジの元になる 6 本（/api/overview, /api/review, /api/review/feed, /api/inbox,
   * /api/review/chat-reports, /api/live）は、それぞれ独立した 15 秒ポーリングを持っている。
   * スリープ復帰・タブ切替ではその「最大 15 秒」がそのまま体感の遅れになるので
   * （実測: 復帰直後は古い数字が残った）、復帰の合図で全員を**並列に**叩き直す。
   * 連打は 1,500 ms のスロットルで抑える（`force` のときだけ素通し）。
   */
  const WAKE_THROTTLE_MS = 1500
  const syncersRef = useRef([])
  const lastWakeAtRef = useRef(0)
  /** 同期関数を登録する（戻り値を呼ぶと解除）。 */
  const registerSyncer = useCallback((fn) => {
    syncersRef.current.push(fn)
    return () => {
      syncersRef.current = syncersRef.current.filter((f) => f !== fn)
    }
  }, [])
  const syncAllBadges = useCallback(
    ({ force = false } = {}) => {
      const now = Date.now()
      if (!force && now - lastWakeAtRef.current < WAKE_THROTTLE_MS) return
      lastWakeAtRef.current = now
      for (const fn of syncersRef.current) {
        try {
          Promise.resolve(fn()).catch(() => {})
        } catch {
          /* 1 本が落ちても他は叩く */
        }
      }
      // 画面側（チャットの会話一覧・タスクの板）も同じ合図で最新化する
      try {
        emitHmEvent(HM_EVENTS.WAKE_SYNC)
      } catch {
        /* noop */
      }
    },
    [WAKE_THROTTLE_MS],
  )

  // 復帰の合図: 表示に戻った / フォーカスした / オンラインに戻った
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') syncAllBadges()
    }
    const onFocus = () => syncAllBadges()
    const onOnline = () => syncAllBadges({ force: true })
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [syncAllBadges])

  // 下部タブの切替: 出てきた画面の数字を待たせない
  useEffect(() => {
    syncAllBadges({ force: true })
  }, [tab, syncAllBadges])

  // チャットタブへ移ったら既読（開いている＝見ている）。タブを離れている間に届いた分だけ点になる。
  useEffect(() => {
    if (tab === 'chat') markChatSeen()
  }, [tab, markChatSeen])

  // ChatPane からの別会話未読数・応答中状態・レビュータブ誘導・セッション遷移イベントを連携する
  useEffect(() => {
    const onOtherUnread = (e) => setOtherChatUnread(Number(e.detail?.count) || 0)
    const onChatStreaming = (e) => setChatStreaming(Boolean(e.detail?.streaming))
    const onOpenReview = (e) => {
      setTab('review')
      setReviewFocus({ ...(e.detail || {}), nonce: Date.now() })
    }
    const onOpenSession = (e) => {
      setTab('chat')
      if (!chatMountedRef.current && e.detail) setPendingChatOpen(e.detail)
    }
    // 統合レポートの導線はチャットをアンマウントしない設計なので、pending で渡せば届く
    const onDiscussPipeline = (e) => {
      setTab('chat')
      setPendingDiscuss({ ...(e.detail || {}), nonce: Date.now() })
    }
    const onOpenBoard = (e) => {
      setTab('tasks')
      setFocusBoard({ board: e.detail?.board ?? null, nonce: Date.now() })
    }
    // どの画面からでも 1 タップで「いま何が動いているか」（LiveSheet）を開ける逃げ道。
    // ArchitectJobBar / LiveSheet 自身 / デモの導線が同じイベントを使う（SPEC V9 §3.2）。
    const onOpenLive = () => setLiveOpen(true)
    // 特定のタスクを開きたい（LiveSheet の「📋 タスク」）。ボード切替は済ませ、
    // タスク詳細を開くのは TasksPane 側（V9-B3）が受ける。
    const onOpenTask = (e) => {
      setTab('tasks')
      setFocusBoard({
        board: e.detail?.board ?? null,
        taskId: e.detail?.taskId ?? e.detail?.id ?? null,
        nonce: Date.now(),
      })
    }
    window.addEventListener(HM_EVENTS.CHAT_UNREAD, onOtherUnread)
    window.addEventListener(HM_EVENTS.CHAT_STREAMING, onChatStreaming)
    window.addEventListener(HM_EVENTS.OPEN_REVIEW, onOpenReview)
    window.addEventListener(HM_EVENTS.OPEN_SESSION, onOpenSession)
    window.addEventListener(HM_EVENTS.DISCUSS_PIPELINE, onDiscussPipeline)
    window.addEventListener(HM_EVENTS.OPEN_BOARD, onOpenBoard)
    window.addEventListener(HM_EVENTS.OPEN_LIVE, onOpenLive)
    window.addEventListener(HM_EVENTS.OPEN_TASK, onOpenTask)
    return () => {
      window.removeEventListener(HM_EVENTS.CHAT_UNREAD, onOtherUnread)
      window.removeEventListener(HM_EVENTS.CHAT_STREAMING, onChatStreaming)
      window.removeEventListener(HM_EVENTS.OPEN_REVIEW, onOpenReview)
      window.removeEventListener(HM_EVENTS.OPEN_SESSION, onOpenSession)
      window.removeEventListener(HM_EVENTS.DISCUSS_PIPELINE, onDiscussPipeline)
      window.removeEventListener(HM_EVENTS.OPEN_BOARD, onOpenBoard)
      window.removeEventListener(HM_EVENTS.OPEN_LIVE, onOpenLive)
      window.removeEventListener(HM_EVENTS.OPEN_TASK, onOpenTask)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const r = await api('/api/review/chat-reports?limit=200')
        if (!alive) return
        const items = Array.isArray(r.items) ? r.items : []
        // チャットタブを開いている間は常に既読（点が出ても意味がない）
        if (tabRef.current === 'chat') markChatSeen()
        setChatReportItems(items)
        setChatUnread(newerThan(items, chatSeenRef.current).length)
        try {
          const seenMap = readSeenMap(localStorage.getItem(SEEN_MAP_KEY))
          // 未見のパイプライン報告はナビのタスクバッジに出す
          setPipelineUnseen(unseenPipelineReports(items, seenMap).length)
          if (!chatMountedRef.current) {
            const activeId = readActiveChatId(localStorage)
            setOtherChatUnread(otherUnreadReports(items, seenMap, activeId ? [activeId] : []).length)
          }
        } catch {
          /* noop */
        }
        /*
         * チャットタブを開いたままでも気づけるように、新しい報告が届いたらトーストを出す
         * （点は「開いている間は既読」で消えるため、開いたまま待つと何も出なかった。実測）。
         * 出すのは**チャットタブを見ているとき**だけ — 他のタブでは点が役目を果たす。
         */
        const newest = items.reduce((a, i) => (Number(i?.at) > Number(a?.at ?? -1) ? i : a), null)
        const newestAt = Number(newest?.at) || 0
        if (chatReportedAtRef.current === null) {
          chatReportedAtRef.current = newestAt // 初回は「今の最新」を基準にするだけ
        } else if (tabRef.current === 'chat' && newestAt > chatReportedAtRef.current) {
          chatReportedAtRef.current = newestAt
          const label = newest.label || newest.taskId || ''
          // 15 秒ごとの interval から呼ばれるので、翻訳は現在の言語を読む tGlobal を使う
          notify(label ? tGlobal('app.reviewDoneLabel', { label }) : tGlobal('app.reviewDone'))
        } else if (newestAt > chatReportedAtRef.current) {
          chatReportedAtRef.current = newestAt
        }
      } catch {
        /* 完了報告は補助情報。取れなくても画面は壊さない */
      }
    }
    sync()
    const offSync = registerSyncer(sync)
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') sync()
    }, 15000)
    const onManual = () => sync()
    window.addEventListener(HM_EVENTS.REFRESH_REPORTS, onManual)
    return () => {
      alive = false
      clearInterval(id)
      offSync()
      window.removeEventListener(HM_EVENTS.REFRESH_REPORTS, onManual)
    }
    // notify はこの useEffect より後で定義される（同一レンダー内で TDZ になるため deps に入れない）。
    // 値は useCallback([]) で固定なので、依存に入れなくても stale にはならない。
  }, [markChatSeen, registerSyncer])

  useEffect(() => {
    try {
      lastSeenRef.current = Number(localStorage.getItem(HM_STORAGE.REVIEW_SEEN_AT)) || 0
    } catch {
      lastSeenRef.current = 0
    }
  }, [])

  // ディープリンクのシートは、タスクタブへ **prop で渡して** 開く（`setTimeout` の橋は廃止）。
  // タスクタブが未マウントでも、マウント直後の最初のレンダーで消費される。
  useEffect(() => {
    if (booting || deepLink?.open !== 'inbox') return
    requestInboxOpen(deepLink.task ?? null)
  }, [booting, deepLink, requestInboxOpen])

  // ハッシュでの要求（#inbox[:task]）は同一ドキュメント遷移なので取りこぼさない
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace(/^#/, '')
      if (!hash.startsWith('inbox')) return
      const task = hash.includes(':') ? hash.split(':')[1] : null
      requestInboxOpen(task)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [requestInboxOpen])

  const toastTimer = useRef(null)
  // 各タブは初回表示時にマウントし、以降は切替で破棄せず保持する
  useEffect(() => {
    setMountedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }))
  }, [tab])

  // タブが増えても選択中が見えるように、切替時に横スクロールで寄せる
  const navRef = useRef(null)
  useEffect(() => {
    const el = navRef.current?.querySelector('.nav-item.on')
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
  }, [tab])

  const notify = useCallback((msg) => {
    setToast({ msg, at: Date.now() })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/overview')
      setOverview(data)
      setConn('ok')
      setAuthNeeded(false)
      return data
    } catch (e) {
      if (e.status === 401) {
        setAuthNeeded(true)
        return null
      }
      setConn(e.code === 'OFFLINE' ? 'offline' : 'error')
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      // QR ペアリング（`?token=` / `#token=`）: Cookie を確立してから URL を掃除する（SPEC §8.2）。
      // 失敗しても素のログイン画面に落ちるだけで、他は今までどおり動く。
      try {
        await consumePairToken()
      } catch {
        /* ペアリングは補助経路 */
      }
      if (!alive) return
      await refresh()
      if (alive) setBooting(false)
    })()
    const id = setInterval(() => {
      if (!alive) return
      if (document.visibilityState === 'visible') refresh()
    }, 5000)
    // 復帰時の取り直しは `syncAllBadges` がまとめて行う（リスナーを二重に張らない）
    const offSync = registerSyncer(refresh)
    return () => {
      alive = false
      clearInterval(id)
      offSync()
    }
  }, [refresh, registerSyncer])

  /*
   * OS アプリアイコンバッジ（SPEC-PILOT-V3 §3.2 / D17①）。
   * 出すのは「人が対応すべき合計」= レビュー判断待ち ＋ 承認待ち。実行中タスク数は出さない
   * （裏で動いているだけで数字が残り、逆に答えるべきものがあっても 0 のままだった）。
   * 0 のときは `clearAppBadge()` — 0 の丸は「何かある」と誤読させる。
   */
  const badgeCount = appBadgeCount({ reviewWaiting, inboxPending })
  useEffect(() => {
    try {
      if (badgeCount > 0) navigator.setAppBadge?.(badgeCount)
      else navigator.clearAppBadge?.()
    } catch {
      /* 未対応端末 */
    }
  }, [badgeCount])

  // レビュー待ちの件数と進行中件数をナビのバッジに出す。ReviewPane が一覧を取り直したら
  // `hm:review-items` で同じ items を流してくるので、15 秒待たずに同期する。
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const r = await api('/api/review')
        if (!alive) return
        const items = Array.isArray(r.items) ? r.items : []
        setReviewItems(items)
        setReviewWaiting(waitingCount(items))
        setReviewRunning(runningCount(items))
      } catch {
        /* 取れないときは前の値を保つ（バッジは補助情報なので画面を壊さない） */
      }
    }
    const onItems = (e) => {
      const items = Array.isArray(e.detail?.items) ? e.detail.items : []
      setReviewItems(items)
      setReviewWaiting(waitingCount(items))
      setReviewRunning(runningCount(items))
    }
    sync()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && tabRef.current !== 'review') sync()
    }, 15000)
    window.addEventListener(HM_EVENTS.REVIEW_ITEMS, onItems)
    const offSync = registerSyncer(sync)
    return () => {
      alive = false
      clearInterval(id)
      offSync()
      window.removeEventListener(HM_EVENTS.REVIEW_ITEMS, onItems)
    }
  }, [registerSyncer])

  // レビューの進行中件数と作業フィードの未読。判断待ちの件数（上の effect）と同じ 15 秒で回す。
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const r = await api('/api/review/feed?limit=20')
        if (alive) setReviewUnseen(unseenNotices(r.items, lastSeenRef.current).length)
      } catch {
        /* フィードは補助情報。取れなくても画面は壊さない */
      }
    }
    const onItems = (e) => {
      if (alive) setReviewRunning(runningCount(e.detail?.items))
    }
    // レビュータブを開いている間は「見ている＝既読」。開いた時点を端末に残す
    const onSeen = (e) => {
      const at = Number(e.detail?.at) || Date.now()
      lastSeenRef.current = at
      setReviewUnseen(0)
      try {
        localStorage.setItem(HM_STORAGE.REVIEW_SEEN_AT, String(at))
      } catch {
        /* 保存できなくても表示は続ける */
      }
    }
    sync()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && tabRef.current !== 'review') sync()
    }, 15000)
    window.addEventListener(HM_EVENTS.REVIEW_ITEMS, onItems)
    window.addEventListener(HM_EVENTS.REVIEW_SEEN, onSeen)
    const offSync = registerSyncer(sync)
    return () => {
      alive = false
      clearInterval(id)
      offSync()
      window.removeEventListener(HM_EVENTS.REVIEW_ITEMS, onItems)
      window.removeEventListener(HM_EVENTS.REVIEW_SEEN, onSeen)
    }
  }, [registerSyncer])

  // 承認待ちの件数をタスクタブのバッジに出す。TasksPane が一覧を取り直したら
  // `hm:inbox-items` で同じ items を流してくるので、15 秒待たずに同期する。
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const r = await api('/api/inbox')
        if (alive) setInboxPending(pendingCount(r.items))
      } catch {
        /* 取れないときは前の値を保つ（バッジは補助情報なので画面を壊さない） */
      }
    }
    const onItems = (e) => setInboxPending(pendingCount(e.detail?.items))
    sync()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && tabRef.current !== 'tasks') sync()
    }, 15000)
    window.addEventListener(HM_EVENTS.INBOX_ITEMS, onItems)
    const offSync = registerSyncer(sync)
    return () => {
      alive = false
      clearInterval(id)
      offSync()
      window.removeEventListener(HM_EVENTS.INBOX_ITEMS, onItems)
    }
  }, [registerSyncer])

  // 稼働中のライブターン数をタスクタブの進行中ドットに出す。
  // TasksPane の /api/live ポーリングとも `hm:live-turns` で同期する。
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const d = await api('/api/live')
        if (!alive) return
        setLiveTurns(Number(d?.counts?.turns ?? 0))
        setLiveTurnsList(Array.isArray(d?.turns) ? d.turns : [])
        setLiveArchitect(Number(d?.counts?.architect ?? 0))
      } catch {
        /* 補助情報 */
      }
    }
    const onTurns = (e) => {
      if (!alive) return
      setLiveTurns(Number(e.detail?.turns ?? 0))
      if (Array.isArray(e.detail?.items)) setLiveTurnsList(e.detail.items)
      if (e.detail?.architect !== undefined) setLiveArchitect(Number(e.detail.architect) || 0)
    }
    sync()
    // タスクタブでも止めない: TasksPane の `hm:live-turns` はターン数しか運ばないので、
    // ここを省くと「タスクタブにいる間だけ Architect が ⚡ に数えられない」穴が空く（実測）。
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') sync()
    }, 15000)
    window.addEventListener(HM_EVENTS.LIVE_TURNS, onTurns)
    const offSync = registerSyncer(sync)
    return () => {
      alive = false
      clearInterval(id)
      offSync()
      window.removeEventListener(HM_EVENTS.LIVE_TURNS, onTurns)
    }
  }, [registerSyncer])

  /*
   * 計器盤の 💎（キャッシュ燃費）。SPEC §5.5 — `/api/usage` の集計を 60 秒キャッシュで読む。
   * サーバ側も 30 秒キャッシュなので、端末側は 60 秒で十分（毎秒叩かない）。
   */
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const d = await api('/api/usage?hours=24')
        if (alive) setUsageData(d)
      } catch {
        /* 補助情報。取れなくてもピルを出さないだけ */
      }
    }
    sync()
    const id = setInterval(() => document.visibilityState === 'visible' && sync(), 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // 計器盤の値（純関数で組み立てる。lib/telemetry.js）
  const gw = gwState({ conn, bridge: overview?.bridge ?? null })
  const waitingTotal = reviewWaiting + inboxPending
  const running = runningTotal({ tasksRunning: overview?.runningTasks, turns: liveTurns, architectRunning: liveArchitect })
  const lastTool = latestToolName(liveTurnsList)
  const cachePct = cachePercent(usageData?.cacheHitRate)

  /**
   * 🔔 タップ。判断待ちがあればそのタスクを Review タブで開き、
   * 承認待ちしか無ければタスクタブのインボックスを開く（どこにいても 1 タップ）。
   */
  const jumpToWaiting = useCallback(() => {
    haptic('tap')
    const target = reviewJumpTarget({ reviewItems, inboxPending })
    if (!target) return
    if (target.kind === 'review') {
      setTab('review')
      setReviewFocus({ taskId: target.taskId, nonce: Date.now() })
      return
    }
    setTab('tasks')
    requestInboxOpen(null)
  }, [reviewItems, inboxPending, requestInboxOpen])

  // 殻は公開・データは認証の内側なので、未ログインならここでトークンを入れる
  if (authNeeded) {
    return (
      <div className="login">
        <h1>Hermes Pilot</h1>
        <p>{t('app.loginPrompt')}</p>
        <input
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="~/.hermes/plugin-data/hermes-pilot/token"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          onClick={() => {
            const clean = tokenInput.trim()
            if (clean) location.href = `/auth?t=${encodeURIComponent(clean)}`
          }}
        >
          {t('app.loginButton')}
        </button>
        <p className="hint">{t('app.loginHint')}</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <span
          className="brand"
          onDoubleClick={(e) => {
            if (getActiveVibe() !== 'dopamine') return
            const rect = e.currentTarget.getBoundingClientRect()
            celebrate('allClear', {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.bottom + 8),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            })
          }}
        >
          Hermes <b>Pilot</b>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            className="icon-btn"
            aria-label={t('app.search')}
            onClick={() => {
              haptic('tap')
              setSearchOpen(true)
            }}
          >
            <Icon name="search" size={18} />
          </button>
          <span className={`conn ${conn}`} title={conn === 'ok' ? t('app.connected') : t('app.disconnected')}>
            {conn === 'ok' ? '●' : '○'}
          </span>
        </span>
      </header>

      {/*
        コックピット計器盤（SPEC §5.5 / D15⑤）。パイロットが 1 秒で状況を見て
        ボトルネックへ飛べるようにする: GW / 判断待ち / 稼働 / キャッシュ燃費。
        数字は 0 のとき出さない（0 のピルは「何かある」と誤読させる）。
      */}
      <div className="telemetry" role="status" aria-live="polite">
        <button
          className={`t-pill gw ${gw}`}
          onClick={() => {
            haptic('tap')
            refresh()
          }}
          aria-label={gw === 'ok' ? t('app.gwOkAria') : t('app.gwDownAria')}
          title={gw === 'ok' ? t('app.connected') : t('app.bridgeOffline')}
        >
          {gw === 'ok' ? (
            <>
              <i className="t-dot ok" aria-hidden="true" />
              {t('status.gw')}
            </>
          ) : (
            <span className="t-gw-bad">
              {t('status.gw')} · {gw === 'offline' ? t('status.offline') : t('app.gwError')}
            </span>
          )}
        </button>

        {waitingTotal > 0 ? (
          <button className="t-pill warn pill-warn-pulse" onClick={jumpToWaiting} aria-label={t('app.jumpWaitingAria', { n: waitingTotal })}>
            🔔 {t('status.reviewWaiting', { n: waitingTotal })}
          </button>
        ) : null}

        {running > 0 ? (
          <button
            className="t-pill run"
            onClick={() => {
              haptic('tap')
              setLiveOpen(true)
            }}
            aria-label={t('app.jumpRunningAria', { n: running })}
          >
            <i className="t-dot live" aria-hidden="true" />⚡ {t('status.running', { n: running })}
            {lastTool ? <span className="t-tool"> · {lastTool}</span> : null}
          </button>
        ) : null}

        {cachePct !== null ? (
          <button
            className="t-pill gem"
            onClick={() => {
              haptic('tap')
              setUsageOpen(true)
            }}
            aria-label={t('app.cacheAria', { pct: cachePct })}
          >
            💎 {cachePct}%
          </button>
        ) : null}
      </div>

      {conn !== 'ok' ? (
        <div className="banner">
          {t('app.bridgeOffline')}
          <button
            onClick={() => {
              haptic('tap')
              refresh()
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      <main className="panes">
        {booting ? (
          <Loader label={t('common.loading')} />
        ) : (
          <>
            {mountedTabs.tasks ? (
              <TabHost active={tab === 'tasks'}>
                <ErrorBoundary tab="tasks">
                  <TasksPane
                    overview={overview}
                    refresh={refresh}
                    notify={notify}
                    initialInbox={deepLink?.open === 'inbox' ? deepLink : null}
                    focusBoard={focusBoard}
                    onConsumedFocusBoard={() => setFocusBoard(null)}
                    taskToolRequest={pendingTaskTool}
                    onConsumedTaskTool={() => setPendingTaskTool(null)}
                    pendingInboxOpen={pendingInboxOpen}
                    onConsumedPendingInboxOpen={() => setPendingInboxOpen(null)}
                    active={tab === 'tasks'}
                  />
                </ErrorBoundary>
              </TabHost>
            ) : null}

            {mountedTabs.review ? (
              <TabHost active={tab === 'review'}>
                <ErrorBoundary tab="review">
                  <ReviewPane
                    notify={notify}
                    focusRequest={reviewFocus}
                    onConsumedFocus={() => setReviewFocus(null)}
                    active={tab === 'review'}
                  />
                </ErrorBoundary>
              </TabHost>
            ) : null}

            {mountedTabs.notes ? (
              <TabHost active={tab === 'notes'}>
                <ErrorBoundary tab="notes">
                  <MemosPane
                    notify={notify}
                    onOpenChat={(chatId) => {
                      setPendingChatOpen({ id: chatId })
                      setTab('chat')
                    }}
                  />
                </ErrorBoundary>
              </TabHost>
            ) : null}

            {mountedTabs.term ? (
              <TabHost active={tab === 'term'}>
                <ErrorBoundary tab="term">
                  <Suspense fallback={<Loader label={t('app.termLoading')} />}>
                    <TermPane notify={notify} active={tab === 'term'} />
                  </Suspense>
                </ErrorBoundary>
              </TabHost>
            ) : null}

            {mountedTabs.settings ? (
              <TabHost active={tab === 'settings'}>
                <ErrorBoundary tab="settings">
                  <SettingsPane overview={overview} notify={notify} refresh={refresh} />
                </ErrorBoundary>
              </TabHost>
            ) : null}

            {mountedTabs.chat ? (
              <TabHost active={tab === 'chat'}>
                <ErrorBoundary tab="chat">
                  <ChatPane
                    notify={notify}
                    chatReports={chatReportItems}
                    reviewItems={reviewItems}
                    liveTurns={liveTurnsList}
                    active={tab === 'chat'}
                    openRequest={pendingChatOpen}
                    onConsumedOpen={() => setPendingChatOpen(null)}
                    discussRequest={pendingDiscuss}
                    onConsumedDiscuss={() => setPendingDiscuss(null)}
                  />
                </ErrorBoundary>
              </TabHost>
            ) : null}
          </>
        )}
      </main>

      <nav className="nav" ref={navRef}>
        {TABS.map((item) => {
          // 丸バッジはタスクタブ（承認待ち）とレビュータブ（判断待ち）にだけ出す。
          // タブ内の表示とは別物で、ここは下部ナビのアイコン右上の小さな丸。
          const label = t(item.key)
          // タスクタブは「承認待ち」に加えて、未見のパイプライン完了レポートも数える
          // （報告カードはタスクタブに出るのにナビに何も出ていなかった・実機）
          const tasksBadge = inboxPending + pipelineUnseen
          const badge = item.id === 'review' ? reviewWaiting : item.id === 'tasks' ? tasksBadge : 0
          const tasksRunning = (Number(overview?.runningTasks) || 0) + liveTurns + liveArchitect
          // レビュータブは「判断待ち（数字） > 未読の完了（緑の点） > 反映中（青の点）」の順で 1 つだけ出す。
          // タスクタブは「承認待ち（数字） > 稼働中（青の点）」、チャットタブは「未読完了（緑の点） > 応答中（青の点）」。
          const state =
            item.id === 'review'
              ? navBadgeState({ waiting: reviewWaiting, unseen: reviewUnseen, running: reviewRunning })
              : item.id === 'tasks'
                ? navBadgeState({ waiting: tasksBadge, running: tasksRunning })
                : item.id === 'chat'
                  ? navBadgeState({ unseen: Math.max(chatUnread, otherChatUnread), running: chatStreaming ? 1 : 0 })
                  : null
          const dot = !badge && state === 'done' ? 'done' : !badge && state === 'running' ? 'running' : null
          const aria = badge
            ? t(item.id === 'review' ? 'app.navWaiting' : 'app.navApproval', { label, n: badge })
            : dot === 'done'
              ? t('app.navDone', { label })
              : dot === 'running'
                ? t(item.id === 'review' ? 'app.navReflecting' : 'app.navRunning', { label })
                : undefined
          return (
            <button
              key={item.id}
              className={`nav-item${tab === item.id ? ' on' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              aria-label={aria}
              onClick={() => {
                if (tab !== item.id) haptic('tap')
                setTab(item.id)
              }}
            >
              <span className="nav-icon">
                <Icon name={item.icon} />
                {badge ? (
                  <span className="nav-badge" aria-hidden="true">
                    {badge}
                  </span>
                ) : null}
                {dot ? <span className={`nav-dot ${dot}`} aria-hidden="true" /> : null}
              </span>
              <span>{label}</span>
            </button>
          )
        })}
      </nav>

      {/* トーストの位置はタブで変える（チャット/端末は下端に入力欄とスニペット帯がある・SPEC P5） */}
      {toast ? <div className={`toast ${tab}`}>{toast.msg}</div> : null}

      {searchOpen ? (
        <SearchSheet
          notify={notify}
          onClose={() => setSearchOpen(false)}
          onOpenSession={(hit) => {
            // チャットタブへ切り替え、開く会話は prop で渡す（`setTimeout` + イベントの橋は廃止）。
            // ChatPane は未マウントでも `openRequest` を最初のレンダーで消費する。
            setTab('chat')
            setPendingChatOpen({
              id: hit.sessionId,
              messageId: hit.messageId,
              profile: hit.profile,
            })
          }}
        />
      ) : null}

      {/* 計器盤の ⚡ / 💎 から開くシート（どのタブにいても同じものが出る） */}
      {liveOpen ? <LiveSheet notify={notify} onClose={() => setLiveOpen(false)} onAbortTask={refresh} /> : null}
      {usageOpen ? <UsageSheet data={usageData} hours={24} onClose={() => setUsageOpen(false)} /> : null}

      {/* Dopamine のパーティクル・コンボ・オールクリア演出（Serotonin では何も出さない） */}
      <FxLayer />
    </div>
  )
}
