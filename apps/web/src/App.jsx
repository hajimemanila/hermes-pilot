import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { TasksPane } from './features/TasksPane.jsx'
import { ChatPane } from './features/ChatPane.jsx'
import { TermPane } from './features/TermPane.jsx'
import { SettingsPane } from './features/SettingsPane.jsx'
import { Icon } from './components/Ui.jsx'

const TABS = [
  { id: 'tasks', label: 'タスク', icon: 'grid' },
  { id: 'chat', label: 'チャット', icon: 'chat' },
  { id: 'term', label: '端末', icon: 'term' },
  { id: 'settings', label: '設定', icon: 'gear' },
]

export function App() {
  const [tab, setTab] = useState('tasks')
  const [overview, setOverview] = useState(null)
  const [conn, setConn] = useState('ok')
  const [authNeeded, setAuthNeeded] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [toast, setToast] = useState(null)
  const [booting, setBooting] = useState(true)
  const toastTimer = useRef(null)

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
        <span className={`conn ${conn}`} title={conn === 'ok' ? '接続中' : '接続できません'}>
          {conn === 'ok' ? '●' : '○'}
        </span>
      </header>

      {conn !== 'ok' ? (
        <div className="banner">
          ブリッジに接続できません
          <button onClick={() => refresh()}>再試行</button>
        </div>
      ) : null}

      <main className="panes">
        {booting ? (
          <div className="empty">読み込み中…</div>
        ) : tab === 'tasks' ? (
          <TasksPane overview={overview} refresh={refresh} notify={notify} />
        ) : tab === 'chat' ? (
          <ChatPane notify={notify} />
        ) : tab === 'term' ? (
          <TermPane notify={notify} />
        ) : (
          <SettingsPane overview={overview} notify={notify} refresh={refresh} />
        )}
      </main>

      <nav className="nav">
        {TABS.map((t) => (
          <button key={t.id} className={`nav-item${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {toast ? <div className="toast">{toast.msg}</div> : null}
    </div>
  )
}
