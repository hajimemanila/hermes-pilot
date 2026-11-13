import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { readDeepLink } from './lib/deeplink.js'

import { api } from './api.js'
import { navBadgeState, pendingCount, runningCount, unseenNotices, waitingCount } from './lib/reviewView.js'
import { SEEN_MAP_KEY, SEEN_NAV_KEY, newerThan, otherUnreadReports, readActiveChatId, readSeenMap } from './lib/chatReports.js'
import { TasksPane } from './features/TasksPane.jsx'
import { ChatPane } from './features/ChatPane.jsx'
import { SettingsPane } from './features/SettingsPane.jsx'
import { ReviewPane } from './features/ReviewPane.jsx'
import { SearchSheet } from './features/SearchSheet.jsx'
import { Icon, Loader } from './components/Ui.jsx'
import { haptic } from './lib/haptic.js'
import { useI18n } from './i18n/index.js'
import { t as tGlobal } from './i18n/lang.js'
import { initTheme } from './lib/theme.js'
import { consumePairToken } from './lib/pairing.js'

const TermPane = lazy(() => import('./features/TermPane.jsx').then((m) => ({ default: m.TermPane })))

const TABS = [
  { id: 'tasks', key: 'nav.tasks', icon: 'grid' },
  { id: 'review', key: 'nav.review', icon: 'pen' },
  { id: 'chat', key: 'nav.chat', icon: 'chat' },
  { id: 'term', key: 'nav.term', icon: 'term' },
  { id: 'settings', key: 'nav.settings', icon: 'gear' },
]

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
    this.state = { error: null }
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

  render() {
    if (this.state.error) {
      return <TabError error={this.state.error} onRetry={() => this.setState({ error: null })} />
    }
    return this.props.children
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
  const [chatMounted, setChatMounted] = useState(tab === 'chat')
  const chatHostRef = useRef(null)
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
  const [chatUnread, setChatUnread] = useState(0)
  const [otherChatUnread, setOtherChatUnread] = useState(0)
  const [liveTurns, setLiveTurns] = useState(0)
  const [liveTurnsList, setLiveTurnsList] = useState([])
  const [reviewItems, setReviewItems] = useState([])
  const [chatStreaming, setChatStreaming] = useState(false)
  const [reviewFocus, setReviewFocus] = useState(null)
  const [pendingChatOpen, setPendingChatOpen] = useState(null)
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
    window.addEventListener('hm:chat-unread', onOtherUnread)
    window.addEventListener('hm:chat-streaming', onChatStreaming)
    window.addEventListener('hm:open-review', onOpenReview)
    window.addEventListener('hm:open-session', onOpenSession)
    return () => {
      window.removeEventListener('hm:chat-unread', onOtherUnread)
      window.removeEventListener('hm:chat-streaming', onChatStreaming)
      window.removeEventListener('hm:open-review', onOpenReview)
      window.removeEventListener('hm:open-session', onOpenSession)
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
        if (!chatMountedRef.current) {
          try {
            const seenMap = readSeenMap(localStorage.getItem(SEEN_MAP_KEY))
            const activeId = readActiveChatId(localStorage)
            setOtherChatUnread(otherUnreadReports(items, seenMap, activeId ? [activeId] : []).length)
          } catch {
            /* noop */
          }
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
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') sync()
    }, 15000)
    const onManual = () => sync()
    window.addEventListener('hm:refresh-reports', onManual)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:refresh-reports', onManual)
    }
    // notify はこの useEffect より後で定義される（同一レンダー内で TDZ になるため deps に入れない）。
    // 値は useCallback([]) で固定なので、依存に入れなくても stale にはならない。
  }, [markChatSeen])

  useEffect(() => {
    try {
      lastSeenRef.current = Number(localStorage.getItem('hm.reviewSeenAt')) || 0
    } catch {
      lastSeenRef.current = 0
    }
  }, [])

  // ディープリンクのシートは「マウント済みの pane に届くイベント」で開く。
  // 既存の hm:open-session（検索→チャット）と同じ経路で、WebAPK の復元挙動に左右されない。
  useEffect(() => {
    if (booting || deepLink?.open !== 'inbox') return undefined
    const id = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('hm:open-inbox', { detail: { task: deepLink.task } }))
    }, 200)
    return () => clearTimeout(id)
  }, [booting, deepLink])

  // ハッシュでの要求（#inbox[:task]）は同一ドキュメント遷移なので取りこぼさない
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace(/^#/, '')
      if (!hash.startsWith('inbox')) return
      const task = hash.includes(':') ? hash.split(':')[1] : null
      window.dispatchEvent(new CustomEvent('hm:open-inbox', { detail: { task } }))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const toastTimer = useRef(null)
  // チャットは初回に開いたときだけマウントし、以降はタブを移っても残す（下の pane-host）。
  useEffect(() => {
    if (tab === 'chat') setChatMounted(true)
  }, [tab])

  // 隠している間はフォーカスもキー入力も入れない（隠れた入力欄に物理キーボードが吸われるのを防ぐ）。
  useEffect(() => {
    const host = chatHostRef.current
    if (!host) return
    const hidden = tab !== 'chat'
    if ('inert' in host) host.inert = hidden
    if (hidden) {
      const active = document.activeElement
      if (active && host.contains(active) && typeof active.blur === 'function') active.blur()
    }
  }, [tab, chatMounted])

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
    const onVis = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh])

  // 実行中タスク数をアプリバッジに出す（対応端末のみ）
  useEffect(() => {
    const running = overview?.runningTasks ?? 0
    try {
      if (running > 0) navigator.setAppBadge?.(running)
      else navigator.clearAppBadge?.()
    } catch {
      /* 未対応 */
    }
  }, [overview?.runningTasks])

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
    window.addEventListener('hm:review-items', onItems)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:review-items', onItems)
    }
  }, [])

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
        localStorage.setItem('hm.reviewSeenAt', String(at))
      } catch {
        /* 保存できなくても表示は続ける */
      }
    }
    sync()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && tabRef.current !== 'review') sync()
    }, 15000)
    window.addEventListener('hm:review-items', onItems)
    window.addEventListener('hm:review-seen', onSeen)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:review-items', onItems)
      window.removeEventListener('hm:review-seen', onSeen)
    }
  }, [])

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
    window.addEventListener('hm:inbox-items', onItems)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:inbox-items', onItems)
    }
  }, [])

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
      } catch {
        /* 補助情報 */
      }
    }
    const onTurns = (e) => {
      if (!alive) return
      setLiveTurns(Number(e.detail?.turns ?? 0))
      if (Array.isArray(e.detail?.items)) setLiveTurnsList(e.detail.items)
    }
    sync()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && tabRef.current !== 'tasks') sync()
    }, 15000)
    window.addEventListener('hm:live-turns', onTurns)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:live-turns', onTurns)
    }
  }, [])

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
        <span className="brand">Hermes<b>Pilot</b></span>
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
        <ErrorBoundary tab={tab}>
          {booting ? (
            <Loader label={t('common.loading')} />
          ) : tab === 'tasks' ? (
            <TasksPane
              overview={overview}
              refresh={refresh}
              notify={notify}
              initialInbox={deepLink?.open === 'inbox' ? deepLink : null}
            />
          ) : tab === 'review' ? (
            <ReviewPane notify={notify} focusRequest={reviewFocus} onConsumedFocus={() => setReviewFocus(null)} />
          ) : tab === 'term' ? (
            <Suspense fallback={<Loader label={t('app.termLoading')} />}>
              <TermPane notify={notify} />
            </Suspense>
          ) : tab === 'settings' ? (
            <SettingsPane overview={overview} notify={notify} refresh={refresh} />
          ) : null}
          {/*
            チャットはタブを移っても作り直さない（q1=A）。隠すだけなのでスクロール位置・
            ツール使用ログ・書きかけが残り、他のタブにいる間も進捗を受け続ける（q2=A）。
            display:none だとスクロール位置が飛ぶので、CSS 側で絶対配置 + visibility で隠す。
          */}
          {chatMounted && !booting ? (
            <div
              className={`pane-host${tab === 'chat' ? '' : ' is-hidden'}`}
              ref={chatHostRef}
              aria-hidden={tab === 'chat' ? undefined : 'true'}
            >
              <ErrorBoundary tab="chat">
                <ChatPane
                  notify={notify}
                  chatReports={chatReportItems}
                  reviewItems={reviewItems}
                  liveTurns={liveTurnsList}
                  active={tab === 'chat'}
                  openRequest={pendingChatOpen}
                  onConsumedOpen={() => setPendingChatOpen(null)}
                />
              </ErrorBoundary>
            </div>
          ) : null}
        </ErrorBoundary>
      </main>

      <nav className="nav" ref={navRef}>
        {TABS.map((item) => {
          // 丸バッジはタスクタブ（承認待ち）とレビュータブ（判断待ち）にだけ出す。
          // タブ内の表示とは別物で、ここは下部ナビのアイコン右上の小さな丸。
          const label = t(item.key)
          const badge = item.id === 'review' ? reviewWaiting : item.id === 'tasks' ? inboxPending : 0
          const tasksRunning = (Number(overview?.runningTasks) || 0) + liveTurns
          // レビュータブは「判断待ち（数字） > 未読の完了（緑の点） > 反映中（青の点）」の順で 1 つだけ出す。
          // タスクタブは「承認待ち（数字） > 稼働中（青の点）」、チャットタブは「未読完了（緑の点） > 応答中（青の点）」。
          const state =
            item.id === 'review'
              ? navBadgeState({ waiting: reviewWaiting, unseen: reviewUnseen, running: reviewRunning })
              : item.id === 'tasks'
                ? navBadgeState({ waiting: inboxPending, running: tasksRunning })
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

      {toast ? <div className="toast">{toast.msg}</div> : null}

      {searchOpen ? (
        <SearchSheet
          notify={notify}
          onClose={() => setSearchOpen(false)}
          onOpenSession={(hit) => {
            // チャットタブに切り替えてから、そのセッションを開くよう伝える
            setTab('chat')
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent('hm:open-session', {
                  detail: { id: hit.sessionId, messageId: hit.messageId, profile: hit.profile },
                }),
              )
            }, 120)
          }}
        />
      ) : null}
    </div>
  )
}
