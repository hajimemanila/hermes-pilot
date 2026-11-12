import React, { useCallback, useEffect, useRef, useState } from 'react'
import { readDeepLink } from './lib/deeplink.js'

import { api } from './api.js'
import { pendingCount, waitingCount } from './lib/akapenView.js'
import { TasksPane } from './features/TasksPane.jsx'
import { ChatPane } from './features/ChatPane.jsx'
import { TermPane } from './features/TermPane.jsx'
import { SettingsPane } from './features/SettingsPane.jsx'
import { AkapenPane } from './features/AkapenPane.jsx'
import { SearchSheet } from './features/SearchSheet.jsx'
import { Icon } from './components/Ui.jsx'

const TABS = [
  { id: 'tasks', label: 'タスク', icon: 'grid' },
  { id: 'akapen', label: '赤ペン', icon: 'pen' },
  { id: 'chat', label: 'チャット', icon: 'chat' },
  { id: 'term', label: 'ターミナル', icon: 'term' },
  { id: 'settings', label: '設定', icon: 'gear' },
]

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
      return (
        <div className="pane">
          <div className="card">
            <div className="row-title">このタブでエラーが発生しました</div>
            <div className="row-sub" style={{ marginTop: 6, lineHeight: 1.7 }}>
              {String(this.state.error?.message ?? this.state.error)}
            </div>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => this.setState({ error: null })}>
              再試行
            </button>
            <div className="row-sub" style={{ marginTop: 8 }}>
              記録は ~/.hermes/mobile-pwa/client-errors.log
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export function App() {
  const [deepLink] = useState(() => readDeepLink())

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
  // 下部ナビの赤ペンタブに出す判断待ち件数（注釈 1377.jpg の赤 = 小さい丸に数字）。
  // タブ内の表示は AkapenPane の持ち物なので、ここでは数えるだけ。
  const [akapenWaiting, setAkapenWaiting] = useState(0)
  // 下部ナビのタスクタブに出す承認待ち件数（同じ赤の指示。承認待ちは全ボード横断）。
  const [inboxPending, setInboxPending] = useState(0)

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
    refresh().finally(() => alive && setBooting(false))
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

  // 赤ペン待ちの件数をナビのバッジに出す。AkapenPane が一覧を取り直したら
  // `hm:akapen-items` で同じ items を流してくるので、15 秒待たずに同期する。
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const r = await api('/api/akapen')
        if (alive) setAkapenWaiting(waitingCount(r.items))
      } catch {
        /* 取れないときは前の値を保つ（バッジは補助情報なので画面を壊さない） */
      }
    }
    const onItems = (e) => setAkapenWaiting(waitingCount(e.detail?.items))
    sync()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') sync()
    }, 15000)
    window.addEventListener('hm:akapen-items', onItems)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:akapen-items', onItems)
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
      if (document.visibilityState === 'visible') sync()
    }, 15000)
    window.addEventListener('hm:inbox-items', onItems)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('hm:inbox-items', onItems)
    }
  }, [])

  // 殻は公開・データは認証の内側なので、未ログインならここでトークンを入れる
  if (authNeeded) {
    return (
      <div className="login">
        <h1>Hermes Mobile</h1>
        <p>アプリトークンを入力してください</p>
        <input
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="~/.hermes/mobile-pwa/token"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          onClick={() => {
            const t = tokenInput.trim()
            if (t) location.href = `/auth?t=${encodeURIComponent(t)}`
          }}
        >
          入る
        </button>
        <p className="hint">トークンは ~/.hermes/mobile-pwa/token（0600）にあります。</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Hermes<b>Mobile</b></span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="icon-btn" aria-label="検索" onClick={() => setSearchOpen(true)}>
            <Icon name="search" size={18} />
          </button>
          <span className={`conn ${conn}`} title={conn === 'ok' ? '接続中' : '接続できません'}>
            {conn === 'ok' ? '●' : '○'}
          </span>
        </span>
      </header>

      {conn !== 'ok' ? (
        <div className="banner">
          ブリッジに接続できません
          <button onClick={() => refresh()}>再試行</button>
        </div>
      ) : null}

      <main className="panes">
        <ErrorBoundary tab={tab}>
          {booting ? (
            <div className="empty">読み込み中…</div>
          ) : tab === 'tasks' ? (
            <TasksPane
              overview={overview}
              refresh={refresh}
              notify={notify}
              initialInbox={deepLink?.open === 'inbox' ? deepLink : null}
            />
          ) : tab === 'akapen' ? (
            <AkapenPane notify={notify} />
          ) : tab === 'chat' ? (
            <ChatPane notify={notify} />
          ) : tab === 'term' ? (
            <TermPane notify={notify} />
          ) : (
            <SettingsPane overview={overview} notify={notify} refresh={refresh} />
          )}
        </ErrorBoundary>
      </main>

      <nav className="nav" ref={navRef}>
        {TABS.map((t) => {
          // 丸バッジはタスクタブ（承認待ち）と赤ペンタブ（判断待ち）にだけ出す。
          // タブ内の表示とは別物で、ここは下部ナビのアイコン右上の小さな丸。
          const badge = t.id === 'akapen' ? akapenWaiting : t.id === 'tasks' ? inboxPending : 0
          const badgeLabel = t.id === 'akapen' ? '判断待ち' : '承認待ち'
          return (
            <button
              key={t.id}
              className={`nav-item${tab === t.id ? ' on' : ''}`}
              aria-current={tab === t.id ? 'page' : undefined}
              aria-label={badge ? `${t.label}（${badgeLabel} ${badge} 件）` : undefined}
              onClick={() => setTab(t.id)}
            >
              <span className="nav-icon">
                <Icon name={t.icon} />
                {badge ? (
                  <span className="nav-badge" aria-hidden="true">
                    {badge}
                  </span>
                ) : null}
              </span>
              <span>{t.label}</span>
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
                new CustomEvent('hm:open-session', { detail: { id: hit.sessionId, messageId: hit.messageId } }),
              )
            }, 120)
          }}
        />
      ) : null}
    </div>
  )
}
