import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatSocket } from '../lib/useChatSocket.js'
import { DEFAULT_PROFILE, STORED_PROFILE_KEY, applyDefaultProfile } from '../lib/profile.js'
import {
  boardSummary,
  defaultBoard,
  matchRepoByCwd,
  pinnedRepos,
  readLastRepo,
  readPendingRepo,
  readRecent,
  rememberRepo,
  repoLabel,
  writePendingRepo,
} from '../lib/repoPicker.js'
import { pickResumeTarget, recentSessions } from '../lib/chatResume.js'
import { foldTranscriptMessages, mergeProgress, shortenPath } from '../lib/toolProgress.js'
import { isWaiting } from '../lib/akapenView.js'
import { api } from '../api.js'
import { composerHeight } from '../lib/composerSize.js'
import { shouldSendOnEnter } from '../lib/composerKey.js'
import {
  LAST_CHAT_KEY,
  SEEN_MAP_KEY,
  mergeTimeline,
  otherUnreadReports,
  readSeenMap,
  reportLines,
  setSeen,
  toEpochMs,
  unreadSessions,
} from '../lib/chatReports.js'
import { Icon, Loader, RefreshButton, Sheet, relTime, fmtBytes } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'

/** 入力欄を内容に合わせて伸ばす（枠の分を足さないと 2px 溢れて縦棒が出る）。 */
function fitComposer(el, cap = 120) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${composerHeight({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, offsetHeight: el.offsetHeight, cap })}px`
}

/** ツール実行行を直近のアシスタント発話へ畳み込んで保持する。 */
function commitProgressToBlocks(prev, toolRows) {
  if (!toolRows?.length) return prev
  const closed = toolRows.map((r) => ({ ...r, done: true }))
  const next = prev.slice()
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].role === 'assistant') {
      next[i] = { ...next[i], tools: [...(next[i].tools ?? []), ...closed] }
      return next
    }
    if (next[i].role === 'user') break
  }
  return [...next, { role: 'assistant', text: '', open: false, tools: closed, at: Date.now() }]
}

/**
 * メッセージ本文の ```code``` フェンスをモバイル用スクロール枠＋コピーボタン付きで描画する。
 * @param {string} raw 本文
 * @param {(code:string)=>void} onCopy コピー処理
 */
function renderFormattedText(raw, onCopy) {
  const s = String(raw ?? '')
  if (!s.includes('```')) return s
  const parts = []
  const re = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g
  let last = 0
  let m
  let idx = 0
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index))
    const lang = m[1] || 'code'
    const code = m[2].replace(/\n$/, '')
    parts.push(
      <div className="code-block" key={`c-${idx++}`}>
        <div className="code-head">
          <span>{lang}</span>
          <button
            type="button"
            className="code-copy"
            onClick={(e) => {
              e.stopPropagation()
              onCopy(code)
            }}
          >
            コピー
          </button>
        </div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>,
    )
    last = m.index + m[0].length
  }
  if (last < s.length) parts.push(s.slice(last))
  return parts.length ? parts : s
}

/** ツール行の一覧（タップで省略前の全文を展開）。 */
function ToolRows({ rows, prefix, expandedMap, onToggle }) {
  return (
    <ol className="tool-rows">
      {rows.map((r, idx) => {
        const key = `${prefix}-${r.id || ''}-${idx}`
        const expanded = Boolean(expandedMap[key])
        const text = expanded ? r.full || r.detail : r.detail || r.full
        const hasMore = Boolean(r.full && r.full !== r.detail)
        return (
          <li
            key={key}
            className={`${r.done ? 'done' : 'run'}${expanded ? ' expanded' : ''}${hasMore ? ' tappable' : ''}`}
            onClick={
              hasMore
                ? (e) => {
                    e.stopPropagation()
                    onToggle(key)
                  }
                : undefined
            }
          >
            <span className="tool-state" aria-hidden="true">
              {r.done ? '✓' : <span className="tool-spin" />}
            </span>
            <span className="tool-name">{r.name}</span>
            {text ? <span className="tool-detail">{text}</span> : null}
            {r.done ? (
              <span className="tool-ms">{r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ''}</span>
            ) : (
              <span className="tool-ms">…</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * チャットタブ。ブリッジの /ws/chat 経由で Hermes の JSON-RPC（/api/ws）を話す。
 *
 * 添付は Hermes 自身の口を使う（ブリッジ側にストレージを持たない）:
 *   - 画像: `image.attach_bytes {session_id, content_base64, filename}` … 次のターンに載る
 *   - ファイル: `file.attach {session_id, data_url, name}` … ワークスペースに置かれ `@file:` 参照が返る
 * 送信時にまとめて attach → prompt.submit する（セッション再作成に強い）。
 *
 * 定型スニペットは `GET /api/snippets`（組み込み + マイ）。タップで挿入、長押しで即送信。
 */
export function ChatPane({
  notify,
  chatReports = [],
  akapenItems = [],
  liveTurns = [],
  active = false,
  openRequest = null,
  onConsumedOpen,
}) {
  const [sessions, setSessions] = useState([])
  const [sid, setSid] = useState(null)
  const [storedSid, setStoredSid] = useState(null)
  const [title, setTitle] = useState('')
  const [blocks, setBlocks] = useState([])
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(false)
  // ターンの経過時間（長いターンで「動いている」ことが分かるように）
  const [runStartedAt, setRunStartedAt] = useState(null)
  const [nowTick, setNowTick] = useState(Date.now())
  // ツール呼び出しの進捗（Discord と同じ「動いている」が見える行）
  const [progress, setProgress] = useState([])
  const [expandedTools, setExpandedTools] = useState({})
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [workerFeed, setWorkerFeed] = useState(null)
  const [usage, setUsage] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [thinking, setThinking] = useState('')
  const [dcLink, setDcLink] = useState(null)
  // 赤ペンの完了報告（起票した会話にだけ流れる 1 行。行の取得は App が 1 回だけ行う）
  // と、会話一覧の行に出す「新着の点」の既読（端末に残す）。
  const [seenMap, setSeenMap] = useState({})
  // resume できない会話（カンバン作業ログ等）は読み取り専用で表示する
  const [readonly, setReadonly] = useState(null)
  // いま話しているプロファイル（SPEC-PROFILE-CHAT）。既定は DEFAULT_PROFILE（mobile）
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  // 直近の会話のプロファイル（起動時の復元に使う）
  const [storedProfile, setStoredProfile] = useState(DEFAULT_PROFILE)
  const [profiles, setProfiles] = useState([])
  const [profileSheet, setProfileSheet] = useState(false)
  // 新しい会話のリポジトリ（＝作業ディレクトリ）。決定は sheets/repo-picker-01-1 の 4 問すべて A
  const [repos, setRepos] = useState([])
  const [repo, setRepo] = useState(null) // この会話で選んだもの
  const [repoPick, setRepoPick] = useState(DEFAULT_PROFILE) // シートで選択中のプロファイル
  const [repoStep, setRepoStep] = useState(null) // {kind:'board'|'create'|'all', repo}
  const [repoBusy, setRepoBusy] = useState(false)
  const [loadingChat, setLoadingChat] = useState(false)

  // 添付
  const [attached, setAttached] = useState([])
  const [attachSheet, setAttachSheet] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)
  const imgInputRef = useRef(null)
  const camInputRef = useRef(null)
  const fileInputRef = useRef(null)

  // 定型スニペット
  const [snippets, setSnippets] = useState([])
  const [snippetSheet, setSnippetSheet] = useState(false)
  const pressRef = useRef({})

  const sidRef = useRef(null)
  const storedRef = useRef(null)
  const storedProfileRef = useRef(DEFAULT_PROFILE)
  const repoRef = useRef(null)
  const reposRef = useRef([])
  const sessionsRef = useRef([])
  const listRef = useRef(null)
  const taRef = useRef(null)
  const stickRef = useRef(true)
  const progressRef = useRef([])
  progressRef.current = progress
  const notifiedOffline = useRef(false)
  const objectUrlsRef = useRef(new Set())

  useEffect(() => {
    const urls = objectUrlsRef.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  sidRef.current = sid
  storedRef.current = storedSid
  storedProfileRef.current = storedProfile
  repoRef.current = repo
  reposRef.current = repos

  /** リポジトリ一覧（未取得なら /api/repos から取ってキャッシュ）。 */
  const ensureRepos = useCallback(async () => {
    if (reposRef.current.length) return reposRef.current
    try {
      const d = await api('/api/repos')
      const list = Array.isArray(d?.repos) ? d.repos : []
      setRepos(list)
      return list
    } catch {
      return []
    }
  }, [])

  /**
   * セッション一覧を取り直す。
   *
   * `session.list`（WS/JSON-RPC）は既定プロファイルのゲートウェイにしか届かないため、
   * タスクタブ同様に**全プロファイル横断**へ。ブリッジの `/api/sessions` が profile 付きで
   * 合成済みなので、そちらを優先し、失敗時だけ従来の RPC にフォールバックする。
   */
  const loadSessions = useCallback(async (rpc) => {
    try {
      const d = await api('/api/sessions?limit=40')
      const list = (d.sessions ?? []).map((x) => ({
        id: x.id,
        title: x.title,
        source: x.source,
        profile: x.profile ?? 'default',
        message_count: x.messages ?? 0,
        is_active: x.active,
        started_at: x.lastActive ? Math.floor(x.lastActive / 1000) : null,
      }))
      if (Array.isArray(d.profiles) && d.profiles.length) setProfiles(d.profiles)
      if (list.length) {
        sessionsRef.current = list
        setSessions(list)
        return list
      }
    } catch {
      /* ブリッジが落ちている時は RPC に任せる */
    }
    const r = await rpc('session.list', {})
    const list = r?.result?.sessions ?? []
    sessionsRef.current = list
    setSessions(list)
    return list
  }, [])

  /** 定型スニペットを読み込む。 */
  const loadSnippets = useCallback(async () => {
    try {
      const d = await api('/api/snippets')
      setSnippets(d.snippets ?? [])
    } catch {
      /* 取れなくても入力は使える */
    }
  }, [])

  useEffect(() => {
    loadSnippets()
    const onUpdate = () => loadSnippets()
    window.addEventListener('hm:snippets', onUpdate)
    return () => window.removeEventListener('hm:snippets', onUpdate)
  }, [loadSnippets])

  /** state.db のツール実行履歴を会話ブロックへ復元する（再接続・切替後も足跡を残す）。 */
  const hydrateTranscriptTools = useCallback(async (sessionId, prof = 'default') => {
    if (!sessionId) return
    try {
      const q = new URLSearchParams({ limit: '100', tools: '1' })
      if (prof && prof !== 'default') q.set('profile', prof)
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
      if (!d?.ok || !Array.isArray(d.messages)) return
      if (storedRef.current !== sessionId && sidRef.current !== sessionId) return
      const { blocks: folded } = foldTranscriptMessages(d.messages, toEpochMs)
      if (!folded.length) return
      setBlocks((prev) => {
        // ストリーミング中で最後の開いた気泡がある場合は壊さない
        const lastPrev = prev[prev.length - 1]
        if (lastPrev?.open) return prev
        return folded
      })
    } catch {
      /* ツール履歴復元は補助情報 */
    }
  }, [])

  /** サーバのセッションに繋ぎ直す（履歴も置き換える）。`prof` は他プロファイルの時だけ渡す。 */
  const resumeInto = useCallback(
    async (rpc, target, prof = 'default') => {
      setLoadingChat(true)
      try {
        const r = await rpc('session.resume', {
          session_id: target,
          ...(prof && prof !== 'default' ? { profile: prof } : {}),
        })
        const res = r?.result
        if (!res?.session_id) return { ok: false, sid: null, error: r?.error ?? null }
        writePendingRepo(globalThis.localStorage, null)
        setSid(res.session_id)
        const resolvedSid = res.resumed ?? target
        setStoredSid(resolvedSid)
        setProfile(prof || 'default')
        const cwd = res.info?.cwd ?? res.cwd ?? ''
        if (cwd) {
          ensureRepos().then((list) => {
            if (sidRef.current === res.session_id) setRepo(matchRepoByCwd(list, cwd))
          })
        } else {
          setRepo(null)
        }
        const msgs = Array.isArray(res.messages) ? res.messages : []
        setBlocks(
          msgs
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              text: String(m.text ?? ''),
              at: toEpochMs(m.at ?? m.timestamp ?? m.created_at),
            }))
            .filter((m) => m.text.trim().length > 0),
        )
        hydrateTranscriptTools(resolvedSid, prof)
        return { ok: true, sid: res.session_id }
      } finally {
        setLoadingChat(false)
      }
    },
    [ensureRepos, hydrateTranscriptTools],
  )

  /** 通知の処理。 */
  const onEvent = useCallback((msg) => {
    const type = msg?.params?.type
    const p = msg?.params?.payload ?? {}
    const sidMsg = msg?.params?.session_id
    if (sidMsg && sidRef.current && sidMsg !== sidRef.current) return

    if (type === 'tool.start' || type === 'tool.complete') {
      const args = p.args && typeof p.args === 'object' ? p.args : {}
      setProgress((rows) =>
        mergeProgress(rows, {
          kind: type === 'tool.start' ? 'start' : 'complete',
          id: p.tool_id || p.tool_call_id || p.name || '',
          name: p.name || p.tool_name || 'tool',
          args,
          duration_ms: p.duration_ms,
        }),
      )
      return
    }
    if (type === 'message.start') {
      const carried = progressRef.current
      setStreaming(true)
      setRunStartedAt(Date.now())
      setThinking('')
      setThinkingExpanded(false)
      setProgress([])
      setBlocks((prev) => {
        const folded = carried.length ? commitProgressToBlocks(prev, carried) : prev
        const last = folded[folded.length - 1]
        if (last?.role === 'assistant' && last.open && !last.text) return folded
        return [...folded, { role: 'assistant', text: '', open: true, at: Date.now() }]
      })
      return
    }
    if (type === 'thinking.delta') {
      setThinking((t) => (t + (p.text ?? '')).slice(-400))
      return
    }
    if (type === 'message.delta') {
      const chunk = p.text ?? ''
      if (!chunk) return
      setBlocks((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant' && last.open) next[next.length - 1] = { ...last, text: last.text + chunk }
        else next.push({ role: 'assistant', text: chunk, open: true, at: Date.now() })
        return next
      })
      return
    }
    if (type === 'message.complete') {
      const finishedTools = progressRef.current
      setRunStartedAt(null)
      setStreaming(false)
      setThinking('')
      setThinkingExpanded(false)
      setProgress([])
      setUsage(p.usage ?? null)
      setBlocks((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        const closedTools = finishedTools.map((r) => ({ ...r, done: true }))
        if (last?.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            text: p.text ?? last.text,
            open: false,
            tools: closedTools.length ? [...(last.tools ?? []), ...closedTools] : last.tools,
          }
        } else if (closedTools.length) {
          next.push({ role: 'assistant', text: String(p.text ?? ''), open: false, tools: closedTools, at: Date.now() })
        }
        return next
      })
      return
    }
    if (type === 'session.title') {
      if (p.title) setTitle(p.title)
    }
  }, [])

  const sockRef = useRef(null)
  const openRef = useRef(null)
  const pendingOpenRef = useRef(null)
  const connRef = useRef('idle')

  /** 接続が ready になったとき（初回・再接続の両方）。 */
  const onReady = useCallback(async () => {
    const rpc = sockRef.current?.rpc
    if (!rpc) return
    if (notifiedOffline.current) {
      notifiedOffline.current = false
      notify('再接続しました')
    }
    await loadSessions(rpc)
    // 検索結果などから「開く」を先に頼まれていたら、接続後にそれを優先する
    const pending = pendingOpenRef.current
    pendingOpenRef.current = null
    if (pending) {
      await openRef.current?.(pending.id, pending.focusId ?? null, pending.profile ?? 'default')
      return
    }
    // リポジトリを選んで新しい会話を始めた直後（未送信）なら過去の会話へ戻さない
    if (!storedRef.current && readPendingRepo()) return
    // stored が空でも、同じプロファイルの直近セッションへ戻る（空画面の再発防止）
    const pick = pickResumeTarget({
      storedSid: storedRef.current,
      sessions: sessionsRef.current,
      profile: storedProfileRef.current,
    })
    if (pick) {
      if (pick.from === 'recent') setStoredSid(pick.sid)
      const resumed = await resumeInto(rpc, pick.sid, storedProfileRef.current)
      if (!resumed.ok) {
        // **捨てない**: 一時的な失敗（実行中で resume 不可など）で会話への導線を失うと
        // 以後ずっと空画面になる（実測）。残して次の ready で再試行する。
        setSid(null)
        notify('直前の会話を開けませんでした（もう一度お試しください）')
      } else {
        const found = sessionsRef.current.find((x) => x.id === pick.sid)
        if (found?.title) setTitle(found.title)
      }
    }
  }, [loadSessions, notify, resumeInto])

  const onState = useCallback((s) => {
    if (s === 'closed' || s === 'error') {
      setStreaming(false)
      notifiedOffline.current = true
    }
  }, [])

  const sock = useChatSocket({ onEvent, onReady, onState })
  sockRef.current = sock
  const { rpc, showBanner, state: connState } = sock
  connRef.current = connState

  // 直近の会話を端末に覚える（プロファイルもセットで。他プロファイルの resume に要る）
  useEffect(() => {
    try {
      // 既定を mobile に上げた移行（1回だけ）: 端末に残った前の選択を捨てる
      applyDefaultProfile()
      const saved = localStorage.getItem('hm.storedSid')
      if (saved && !storedRef.current) setStoredSid(saved)
      const savedProfile = localStorage.getItem(STORED_PROFILE_KEY)
      if (savedProfile) setStoredProfile(savedProfile)
      // 未送信でリポジトリを選んでいた場合、リロード後もヘッダー札と cwd を復元する
      const pendingRepo = !saved ? readPendingRepo() : null
      if (pendingRepo) {
        if (pendingRepo.profile) {
          setProfile(pendingRepo.profile)
          setStoredProfile(pendingRepo.profile)
        }
        ensureRepos().then((list) => {
          if (sidRef.current || storedRef.current) return
          const hit = list.find((r) => r.id === pendingRepo.repoId)
          if (hit) setRepo(hit)
        })
      }
    } catch {
      /* noop */
    }
  }, [])
  useEffect(() => {
    try {
      if (storedSid) {
        localStorage.setItem('hm.storedSid', storedSid)
        localStorage.setItem(LAST_CHAT_KEY, storedSid)
      } else {
        localStorage.removeItem('hm.storedSid')
      }
      localStorage.setItem(STORED_PROFILE_KEY, storedProfile || DEFAULT_PROFILE)
    } catch {
      /* noop */
    }
  }, [storedSid, storedProfile])

  /*
   * 新しい赤ペン完了報告が届いたら、末尾を見ていれば自動で最下部へ寄せる
   * （報告の行は会話の最後に足されるので、下に居ないと増えたことに気づけない。実測）。
   * 依存は配列そのものではなく**最後の報告のキー** — 15 秒ごとの取得で配列が作り直される
   * たびにスクロールすると、上へ遡って読んでいる最中に勝手に飛ぶ。
   */
  const currentIds = useMemo(
    () => [storedSid, sid, readonly?.sessionId].filter(Boolean).map(String),
    [storedSid, sid, readonly?.sessionId],
  )
  const activeLiveTurn = useMemo(
    () => liveTurns.find((t) => t?.sessionId && currentIds.includes(String(t.sessionId))) ?? null,
    [liveTurns, currentIds],
  )
  const linkedAkapen = useMemo(() => {
    const activeOnes = (akapenItems ?? []).filter((it) => it && it.status !== 'done')
    const byChat = activeOnes.find((it) => it.akapen?.chat && currentIds.includes(String(it.akapen.chat)))
    if (byChat) return byChat
    if (!repo) return null
    const repoPathLow = repo.path ? String(repo.path).toLowerCase() : ''
    return (
      activeOnes.find(
        (it) =>
          !it.akapen?.chat &&
          (it.akapen?.repo === repo.id ||
            (repoPathLow && it.akapen?.target && String(it.akapen.target).toLowerCase().startsWith(repoPathLow))),
      ) ?? null
    )
  }, [akapenItems, currentIds, repo])
  const isWorking = Boolean(streaming || activeLiveTurn)
  const reports = useMemo(() => reportLines(chatReports, currentIds), [chatReports, currentIds])
  const timeline = useMemo(() => mergeTimeline(blocks, reports), [blocks, reports])
  const lastReportKey = reports.length ? reports[reports.length - 1].key : ''

  useEffect(() => {
    if (!isWorking) return undefined
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isWorking])

  // 紐づいた Akapen 自律ワーカーが実行中の間は直近ツールステップを 4 秒ごとに取得する
  const linkedWorkerId = linkedAkapen && (linkedAkapen.status === 'running' || linkedAkapen.status === 'ready') ? linkedAkapen.id : null
  useEffect(() => {
    if (!linkedWorkerId) {
      setWorkerFeed(null)
      return undefined
    }
    let alive = true
    const load = async () => {
      try {
        const r = await api(`/api/akapen/${encodeURIComponent(linkedWorkerId)}/worker?limit=8`)
        if (alive) setWorkerFeed(r)
      } catch {
        /* 補助情報 */
      }
    }
    load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 4000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [linkedWorkerId])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // 検索ヒット位置へ寄せるときは末尾スクロールをしない
    if (readonly?.focusId) return
    // 進捗行と thinking も「新しい内容」なので追従対象。ここを deps に入れ忘れると
    // ツール行が増えてもスクロールせず、最後の行が下端（入力欄の裏）に隠れる（実測）。
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks, isWorking, progress, thinking, linkedAkapen, workerFeed, readonly?.focusId, lastReportKey])

  /** ヒットした発言を画面の上寄りに出す（offsetTop ではなく実測差分で合わせる）。 */
  const scrollToHit = useCallback((mid) => {
    const sc = listRef.current
    if (!sc || !mid) return
    const el = sc.querySelector(`[data-mid="${mid}"]`)
    if (!el) return
    const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
    sc.scrollTop = Math.max(0, sc.scrollTop + delta - 10)
  }, [])

  // ヒットした発言が見える位置までスクロール（レイアウト確定後に2回）
  useEffect(() => {
    if (!readonly?.focusId) return
    const a = setTimeout(() => scrollToHit(readonly.focusId), 120)
    const b = setTimeout(() => scrollToHit(readonly.focusId), 500)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [readonly?.focusId, blocks.length, scrollToHit])

  // この会話が Discord 由来ならスレッドへのリンクを出す（sessions.json をブリッジが読む）
  useEffect(() => {
    const target = storedSid ?? sid
    if (!target) {
      setDcLink(null)
      return
    }
    let alive = true
    api(`/api/discord/session?session_id=${encodeURIComponent(target)}`)
      .then((d) => alive && setDcLink(d.link ?? null))
      .catch(() => alive && setDcLink(null))
    return () => {
      alive = false
    }
  }, [storedSid, sid])

  // 会話ごとの既読（会話一覧の行の点。赤ペン chat-badge-01 q2=A の「行の点」）。
  useEffect(() => {
    try {
      setSeenMap(readSeenMap(localStorage.getItem(SEEN_MAP_KEY)))
    } catch {
      setSeenMap({})
    }
  }, [])

  /** その会話の新着を既読にする（行の点を消す）。 */
  const markReportsSeen = useCallback((id) => {
    if (!id) return
    setSeenMap((prev) => {
      const next = setSeen(prev, id, Date.now())
      try {
        localStorage.setItem(SEEN_MAP_KEY, JSON.stringify(next))
      } catch {
        /* 保存できなくても表示は続ける */
      }
      return next
    })
  }, [])

  const unreadIds = useMemo(() => unreadSessions(chatReports, seenMap), [chatReports, seenMap])
  const otherUnreads = useMemo(
    () => otherUnreadReports(chatReports, seenMap, currentIds),
    [chatReports, seenMap, currentIds],
  )

  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('hm:chat-unread', { detail: { count: otherUnreads.length } }))
    } catch {
      /* noop */
    }
  }, [otherUnreads.length])

  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('hm:chat-streaming', { detail: { streaming: isWorking } }))
    } catch {
      /* noop */
    }
  }, [isWorking])

  const toggleToolExpand = useCallback((key) => {
    setExpandedTools((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const copyCode = useCallback(
    async (code) => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('このブラウザはコピーに未対応です')
        await navigator.clipboard.writeText(code)
        haptic('tap')
        notify('コードをコピーしました')
      } catch (e) {
        notify(e?.message || 'コピーできませんでした')
      }
    },
    [notify],
  )

  // 開いている会話の新着はタイムラインに出ている＝見えている。既読にして点を残さない
  // （タブを離れている間、または別の会話に届いた分だけが点になる）。
  useEffect(() => {
    if (!active || !currentIds.length) return
    for (const id of currentIds) {
      if (unreadIds.includes(id)) markReportsSeen(id)
    }
  }, [active, currentIds, unreadIds, markReportsSeen])

  // --- 添付の取り込み ------------------------------------------------------

  /** 画像を長辺1600pxに縮小（転送量対策）。 */
  const shrinkImage = async (file, maxEdge = 1600) => {
    if (!file.type?.startsWith('image/') || file.type === 'image/gif') return file
    try {
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
      if (scale >= 0.999 && file.size < 600_000) {
        bitmap.close?.()
        return file
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale)
      canvas.height = Math.round(bitmap.height * scale)
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close?.()
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.9))
      if (!blob || blob.size >= file.size) return file
      return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'image'}.webp`, { type: 'image/webp' })
    } catch {
      return file
    }
  }

  /** 添付を追加（実体の送信は送信時）。 */
  const addFiles = useCallback(
    async (fileList) => {
      const picked = [...(fileList ?? [])].filter(Boolean)
      if (!picked.length) return
      const room = 6 - attached.length
      if (room <= 0) {
        notify('添付は1メッセージ6個までです')
        return
      }
      for (const raw of picked.slice(0, room)) {
        const isImage = (raw.type || '').startsWith('image/')
        const limit = isImage ? 10 * 1024 * 1024 : 25 * 1024 * 1024
        if (raw.size > limit) {
          notify(`${raw.name || 'ファイル'} は大きすぎます（上限 ${Math.round(limit / 1048576)}MB）`)
          continue
        }
        try {
          const file = isImage ? await shrinkImage(raw) : raw
          const preview = isImage ? URL.createObjectURL(file) : null
          if (preview) objectUrlsRef.current.add(preview)
          setAttached((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              kind: isImage ? 'image' : 'file',
              name: raw.name || (isImage ? 'image' : 'file'),
              bytes: file.size,
              file,
              preview,
            },
          ])
        } catch (e) {
          notify(e.message)
        }
      }
    },
    [attached.length, notify],
  )

  /** クリップボードの画像を取り込む。 */
  const pasteFromClipboard = useCallback(async () => {
    try {
      if (!navigator.clipboard?.read) throw new Error('このブラウザはクリップボード読み取りに未対応です')
      const items = await navigator.clipboard.read()
      const files = []
      for (const it of items) {
        const type = (it.types ?? []).find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = await it.getType(type)
        const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1]
        files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }))
      }
      if (!files.length) throw new Error('クリップボードに画像がありません')
      await addFiles(files)
      setAttachSheet(false)
    } catch (e) {
      notify(e.message)
    }
  }, [addFiles, notify])

  // --- 送信 ---------------------------------------------------------------

  const fileToDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('読み込みに失敗しました'))
      fr.readAsDataURL(file)
    })

  /** 添付をセッションに載せる（画像=attach_bytes / ファイル=attach）。 */
  const stageAttachments = useCallback(async (rpc, sessionId, items) => {
    const refs = []
    for (const a of items) {
      if (a.kind === 'image') {
        const dataUrl = await fileToDataUrl(a.file)
        const b64 = dataUrl.split(',')[1] ?? ''
        const r = await rpc('image.attach_bytes', { session_id: sessionId, content_base64: b64, filename: a.name })
        if (r?.error) throw new Error(`画像を添付できません: ${r.error.message}`)
      } else {
        const dataUrl = await fileToDataUrl(a.file)
        const r = await rpc('file.attach', { session_id: sessionId, data_url: dataUrl, name: a.name })
        if (r?.error) throw new Error(`ファイルを添付できません: ${r.error.message}`)
        if (r?.result?.ref_text) refs.push(r.result.ref_text)
      }
    }
    return refs
  }, [])

  /** 本文 + 添付で送る（スニペットの長押しもここを通る）。 */
  const sendText = useCallback(
    async (override) => {
      const body = String(override ?? text).trim()
      if ((!body && !attached.length) || streaming) return
      const items = attached
      const imgs = items.filter((a) => a.kind === 'image')
      const files = items.filter((a) => a.kind === 'file')
      const shown = body || (items.length ? '添付を確認して。' : '')

      // スニペットの長押し送信では、書きかけの下書きを消さない
      if (override == null) {
        setText('')
        // 送信後に入力欄が伸びたまま残らないように高さを戻す（空なのに縦棒が出る原因）
        if (taRef.current) taRef.current.style.height = ''
      }
      setAttached([])
      setStreaming(true)
      const sentAt = Date.now()
      setBlocks((prev) => [
        ...prev,
        {
          role: 'user',
          text: shown,
          at: sentAt,
          images: imgs.map((a) => ({ url: a.preview, name: a.name })),
          files: files.map((a) => ({ name: a.name, bytes: a.bytes })),
        },
        { role: 'assistant', text: '', open: true, at: sentAt + 1 },
      ])

      const failed = (msg) => {
        setStreaming(false)
        notify(msg)
        setBlocks((prev) => [...prev, { role: 'notice', text: msg, at: Date.now() }])
      }

      let target = sid
      if (!target) {
        const r = await rpc('session.create', {
          title: shown.slice(0, 24),
          ...(profile && profile !== 'default' ? { profile } : {}),
          // リポジトリを選んで始めた会話は、その repo を作業ディレクトリにする
          ...(repoRef.current?.path ? { cwd: repoRef.current.path } : {}),
        })
        target = r?.result?.session_id
        setStoredSid(r?.result?.stored_session_id ?? null)
        setStoredProfile(profile || DEFAULT_PROFILE)
        if (!target) return failed('セッションを作成できませんでした')
        writePendingRepo(globalThis.localStorage, null)
        setSid(target)
        setTitle(shown.slice(0, 24))
      }

      const compose = (refs) =>
        refs.length ? `${shown}\n\n添付ファイル:\n${refs.map((x) => `- ${x}`).join('\n')}\n必要なら読んでから答えて。` : shown

      let refs = []
      if (items.length) {
        setAttachBusy(true)
        try {
          refs = await stageAttachments(rpc, target, items)
        } catch (e) {
          setAttachBusy(false)
          return failed(e.message)
        }
        setAttachBusy(false)
      }

      let r = await rpc('prompt.submit', { session_id: target, text: compose(refs) })
      // 再接続で sid が無効なら stored から復元して 1 度だけやり直す
      if (r?.error && /session not found/i.test(r.error.message ?? '')) {
        const stored = storedRef.current
        if (stored) {
          const resumed = await resumeInto(rpc, stored, storedProfileRef.current)
          if (resumed.ok && resumed.sid) {
            target = resumed.sid
            let refs2 = refs
            if (items.length) {
              try {
                refs2 = await stageAttachments(rpc, target, items)
              } catch {
                refs2 = []
              }
            }
            r = await rpc('prompt.submit', { session_id: target, text: compose(refs2) })
          }
        }
      }
      if (r?.error) failed(`送信に失敗: ${r.error.message}`)
      haptic('action')
    },
    [text, attached, streaming, sid, rpc, notify, stageAttachments, resumeInto, profile],
  )

  const send = useCallback(() => sendText(), [sendText])

  const interrupt = useCallback(async () => {
    if (!sid) return
    await rpc('session.interrupt', { session_id: sid })
    setStreaming(false)
    setThinking('')
    notify('中断しました')
  }, [sid, rpc, notify])

  /**
   * 新しい会話を始める（プロファイル + リポジトリ + ボード）。
   *
   * リポジトリは `session.create` の `cwd` として渡す（＝この会話の作業ディレクトリが
   * その repo になる。起票・worker・パスの解決がそこで揃う）。板は端末の `hm.board` に
   * 書く＝タスクタブとクイック起票の既定ボードがその repo の板に切り替わる。
   *
   * @param {string} prof プロファイル
   * @param {object|null} pick 選んだリポジトリ（`/api/repos` の 1 件）
   * @param {{slug: string, name?: string}|null} board 選んだボード
   */
  const startSession = useCallback(
    (prof = DEFAULT_PROFILE, pick = null, board = null) => {
      const next = prof || DEFAULT_PROFILE
      const chosen = pick?.path ? pick : null
      const boardSlug = board?.slug ?? ''
      setSid(null)
      setStoredSid(null)
      setTitle('')
      setBlocks([])
      setUsage(null)
      setReadonly(null)
      setProfile(next)
      setStoredProfile(next)
      setRepo(chosen)
      setRepoStep(null)
      setDrawer(false)
      setProfileSheet(false)
      if (chosen) {
        rememberRepo(globalThis.localStorage, { id: chosen.id, board: boardSlug ? { slug: boardSlug } : null })
        writePendingRepo(globalThis.localStorage, { repoId: chosen.id, profile: next })
        notify(`${repoLabel(chosen)}${boardSlug ? ` ・ ${boardSlug}` : ''} で新しい会話`)
      } else {
        writePendingRepo(globalThis.localStorage, null)
      }
    },
    [notify],
  )

  /** resume できない会話を読み取り専用で開く（カンバン作業ログなど）。 */
  const loadTranscript = useCallback(
    async (sessionId, focusId, title, profile = null) => {
      setLoadingChat(true)
      try {
        const q = new URLSearchParams({ limit: '100', tools: '1' })
        // 他プロファイルの会話は state.db が別なので profile を渡す（読み取り専用で開く）
        if (profile && profile !== 'default') q.set('profile', profile)
        const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
        if (!d.ok) {
          notify(d.reason ?? 'この会話は開けません')
          return false
        }
        setSid(null)
        setReadonly({
          sessionId,
          focusId: focusId ?? null,
          title: d.title ?? title ?? '',
          profile: profile && profile !== 'default' ? profile : null,
        })
        const { blocks: folded } = foldTranscriptMessages(d.messages ?? [], toEpochMs)
        setBlocks(folded)
        if (d.title || title) setTitle(d.title || title)
        if (focusId) {
          requestAnimationFrame(() => scrollToHit(focusId))
        }
        return true
      } catch (e) {
        notify(e.message)
        return false
      } finally {
        setLoadingChat(false)
      }
    },
    [notify, scrollToHit],
  )

  const openSession = useCallback(
    async (storedTarget, focusId = null, prof = 'default') => {
      setDrawer(false)
      setBlocks([])
      setUsage(null)
      setReadonly(null)
      setProfile(prof || 'default')
      const found = sessions.find((s) => s.id === storedTarget && (s.profile ?? 'default') === (prof || 'default'))
      const foundTitle = found?.title ?? sessions.find((s) => s.id === storedTarget)?.title ?? ''
      setTitle(foundTitle)
      const resumed = await resumeInto(rpc, storedTarget, prof)
      if (!resumed.ok) {
        const err = resumed.error
        // カンバン作業ログは Hermes が resume を拒否する（4132）。読むだけなら開ける
        if (err?.code === 4132 || /Kanban worker transcript/i.test(err?.message ?? '')) {
          await loadTranscript(storedTarget, focusId, foundTitle, prof)
          return
        }
        setSid(null)
        setStoredSid(null)
        notify(err?.message ? `開けませんでした: ${err.message}` : 'セッションを復元できませんでした')
      }
    },
    [rpc, resumeInto, sessions, notify, loadTranscript],
  )

  // openSession の最新版を ref に持つ（onReady / イベントから使う）
  openRef.current = openSession

  /** 接続前なら予約して、ready になったら開く。 */
  const openSessionSafe = useCallback(
    (id, focusId = null, prof = 'default') => {
      if (!id) return
      // 開いた会話の新着（赤ペンの完了報告）は見た扱いにする（行の点を消す）
      markReportsSeen(id)
      if (connRef.current === 'ready') openRef.current?.(id, focusId, prof)
      else pendingOpenRef.current = { id, focusId, profile: prof }
    },
    [markReportsSeen],
  )

  // 検索結果など外側から「このセッションを開く」と指示された場合
  useEffect(() => {
    const onOpen = (e) => openSessionSafe(e?.detail?.id, e?.detail?.messageId ?? null, e?.detail?.profile || 'default')
    window.addEventListener('hm:open-session', onOpen)
    return () => window.removeEventListener('hm:open-session', onOpen)
  }, [openSessionSafe])

  useEffect(() => {
    if (!openRequest?.id) return
    openSessionSafe(openRequest.id, openRequest.messageId ?? null, openRequest.profile || 'default')
    onConsumedOpen?.()
  }, [openRequest, openSessionSafe, onConsumedOpen])

  // --- スニペット ---------------------------------------------------------

  /** カーソル位置に挿入（{{...}} は選択状態にする）。 */
  const insertSnippet = useCallback(
    (s, sendNow = false) => {
      setSnippetSheet(false)
      if (sendNow) {
        sendText(s.text)
        return
      }
      const ta = taRef.current
      const cur = text ?? ''
      const start = ta?.selectionStart ?? cur.length
      const end = ta?.selectionEnd ?? cur.length
      const before = cur.slice(0, start)
      const after = cur.slice(end)
      const sep = before && !/\s$/.test(before) ? ' ' : ''
      setText(`${before}${sep}${s.text}${after}`)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (!el) return
        el.focus()
        const base = before.length + sep.length
        const m = /\{\{[^}]*\}\}/.exec(s.text)
        if (m) el.setSelectionRange(base + m.index, base + m.index + m[0].length)
        else el.setSelectionRange(base + s.text.length, base + s.text.length)
        el.style.height = 'auto'
        fitComposer(el)
      })
      haptic('tap')
    },
    [text, sendText],
  )

  /** チャットタブの「更新」: 会話一覧・完了報告・現在開いている会話を最新化する。 */
  const refreshChat = useCallback(async () => {
    window.dispatchEvent(new CustomEvent('hm:refresh-reports'))
    if (connRef.current !== 'ready') {
      sockRef.current?.reconnectNow?.()
      return true
    }
    const rpcFn = sockRef.current?.rpc
    if (!rpcFn) return false
    await loadSessions(rpcFn)
    if (streaming) return true
    if (readonly?.sessionId) {
      return await loadTranscript(readonly.sessionId, readonly.focusId, readonly.title, readonly.profile || 'default')
    }
    const target = storedRef.current ?? sidRef.current
    if (target) {
      const r = await resumeInto(rpcFn, target, profile || DEFAULT_PROFILE)
      if (!r?.ok) {
        notify(r?.error?.message ? `更新できませんでした: ${r.error.message}` : '会話を更新できませんでした')
        return false
      }
    }
    return true
  }, [loadSessions, streaming, readonly, loadTranscript, resumeInto, profile, notify])

  const openProfileSheet = useCallback(() => {
    setDrawer(false)
    setProfileSheet(true)
    setRepoStep(null)
    setRepoPick(profile || DEFAULT_PROFILE)
    // リポジトリ一覧は開いたときに取りに行く（ボードの件数は変わらないので 1 回で足りる）
    ensureRepos()
  }, [profile, ensureRepos])

  /**
   * リポジトリを選んだ（Q2=A）。板が無ければ確認、複数なら次の段、1 つならそのまま開始。
   * @param {object} r 選んだリポジトリ
   */
  const pickRepo = useCallback(
    (r) => {
      if (!r) return
      if (!r.boards?.length) {
        setRepoStep({ kind: 'create', repo: r })
        return
      }
      if (r.boards.length > 1) {
        setRepoStep({ kind: 'board', repo: r })
        return
      }
      startSession(repoPick, r, defaultBoard(r.boards))
    },
    // startSession は下で useCallback 済み（依存は毎回同じ）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoPick],
  )

  /** 板が無いリポジトリにボードを作る（Q3=A: 確認してから作る）。 */
  const createRepoBoard = useCallback(async () => {
    const r = repoStep?.repo
    if (!r || repoBusy) return
    setRepoBusy(true)
    try {
      const res = await api(`/api/repos/${encodeURIComponent(r.id)}/board`, { method: 'POST', body: {} })
      if (!res?.ok || !res.board) {
        notify(res?.error ?? 'ボードを作成できませんでした')
        return
      }
      notify(`ボード ${res.board.slug} を作りました`)
      // 作った板を一覧に反映してから開始（次の会話では「ボード 1 つ」と出る）
      setRepos((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, boards: [{ slug: res.board.slug, name: res.board.name ?? res.board.slug }] } : x)),
      )
      startSession(repoPick, r, { slug: res.board.slug, name: res.board.name ?? res.board.slug })
    } catch (e) {
      notify(e.message)
    } finally {
      setRepoBusy(false)
    }
  }, [repoStep, repoBusy, repoPick, notify, startSession])

  const hotSnippets = snippets.filter((s) => s.hot).slice(0, 8)

  /**
   * 新しい会話で選べるプロファイル（既定を先頭・毎回同じ順）。
   */
  const orderedProfiles = useMemo(() => {
    const list = profiles.length ? profiles : [DEFAULT_PROFILE]
    const rank = (p) => (p === DEFAULT_PROFILE ? 0 : p === 'default' ? 1 : p === 'nanokvm' ? 2 : 3)
    return [...new Set(list)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }, [profiles])

  /** 前回選んだリポジトリ（Q4=A: 次回の初期値。シートを開くたびに読み直す）。 */
  const lastRepo = useMemo(() => readLastRepo(), [profileSheet])

  /** シートに直接並べるリポジトリ 4 行（前回が先頭・残りは「すべて」から）。 */
  const pinned = useMemo(() => pinnedRepos(repos, readRecent()), [repos, profileSheet])

  return (
    <div className="pane chat" data-conn={connState}>
      <div className="chat-head">
        <button
          className="icon-btn"
          onClick={() => {
            haptic('tap')
            setDrawer(true)
          }}
          aria-label={otherUnreads.length ? `会話一覧（未読の完了報告 ${otherUnreads.length} 件）` : '会話一覧'}
        >
          <Icon name="grid" size={18} />
          {otherUnreads.length ? <span className="nav-dot done" aria-hidden="true" /> : null}
        </button>
        <span className="chat-title">{title || 'チャット'}</span>
        <span
          className={`prof-chip${profile !== DEFAULT_PROFILE ? ' on' : ''}`}
          title={`この会話のプロファイル: ${profile}`}
        >
          {profile}
        </span>
        {repo ? (
          <button
            className="prof-chip repo-chip"
            title={`この会話のリポジトリ: ${repo.id}（${repo.path}）`}
            aria-label={`この会話のリポジトリ: ${repo.id}`}
            onClick={() => {
              haptic('tap')
              openProfileSheet()
            }}
          >
            {repo.id}
          </button>
        ) : null}
        {dcLink?.url ? (
          <button
            className="icon-btn dc-icon"
            title={`Discord: ${dcLink.chatName ?? ''}`}
            aria-label="Discord のスレッドを開く"
            onClick={() => {
              haptic('tap')
              window.open(dcLink.url, '_blank', 'noopener')
            }}
          >
            <span aria-hidden="true">#</span>
          </button>
        ) : null}
        <RefreshButton variant="icon" ariaLabel="会話を更新" onRefresh={refreshChat} />
        <button
          className="icon-btn"
          onClick={() => {
            haptic('tap')
            openProfileSheet()
          }}
          aria-label="新しい会話（プロファイルとリポジトリを選ぶ）"
        >
          <Icon name="plus" size={18} />
        </button>
      </div>

      {/* 切断直後（2秒未満）は出さない */}
      {showBanner ? <div className="banner">接続を回復しています…</div> : null}
      {otherUnreads.length ? (
        <div className="chat-report-banner" role="status">
          <span className="chat-report-banner-text">
            🖊 別の会話に完了報告: {otherUnreads[0].label || otherUnreads[0].taskId || otherUnreads[0].text.slice(0, 28)}
          </span>
          <button
            type="button"
            className="chat-report-btn primary"
            onClick={() => {
              haptic('tap')
              const u = otherUnreads[0]
              const found = sessions.find((s) => String(s.id) === u.sessionId)
              openSessionSafe(u.sessionId, null, found?.profile || profile || DEFAULT_PROFILE)
            }}
          >
            開く
          </button>
          <button
            type="button"
            className="chat-report-btn"
            onClick={() => {
              haptic('tap')
              markReportsSeen(otherUnreads[0].sessionId)
            }}
          >
            既読
          </button>
        </div>
      ) : null}
      {readonly ? (
        <div className="banner ro">
          読み取り専用
          {readonly.profile
            ? ` ・ ${readonly.profile} プロファイルの会話（resume できないため記録を表示中）`
            : ' ・ カンバンの作業ログはこのアプリから再開できません（ボードで操作）'}
        </div>
      ) : null}

      <div
        className="chat-scroll"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (!el) return
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          stickRef.current = near
          setAtBottom(near)
        }}
      >
        {!blocks.length && (loadingChat || connState === 'connecting') ? (
          <Loader label={connState === 'connecting' ? '接続中…' : '会話を読み込み中…'} />
        ) : !blocks.length ? (
          <div className="empty">
            <div>メッセージを送って開始</div>
            {recentSessions(sessions, profile, 2).length ? (
              <div className="empty-recent" aria-label="直前に開いていた会話">
                <div className="empty-recent-head">直前に開いていた会話</div>
                {recentSessions(sessions, profile, 2).map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    className="empty-recent-row"
                    title={x.title || x.id}
                    onClick={async () => {
                      const ok = await resumeInto(sockRef.current?.rpc, x.id, x.profile || profile)
                      if (ok?.ok) setStoredSid(x.id)
                    }}
                  >
                    <span className="empty-recent-title">{x.title || x.id}</span>
                    <span className="empty-recent-when">
                      {relTime(toEpochMs(x.updated_at ?? x.started_at))}
                    </span>
                    <span className="empty-recent-mark" aria-hidden="true">
                      ›
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {timeline.map((item) => {
          if (item.kind === 'report') {
            const r = item.report
            return (
              <div key={r.key} className="msg report" title={new Date(r.at).toLocaleString()}>
                <span className="report-body">🖊 {r.text}</span>
                <button
                  type="button"
                  className="report-link"
                  onClick={() => {
                    haptic('tap')
                    window.dispatchEvent(
                      new CustomEvent('hm:open-akapen', {
                        detail: { taskId: r.taskId, label: r.label },
                      }),
                    )
                  }}
                >
                  確認・赤入れ ↗
                </button>
              </div>
            )
          }
          const b = item.block
          const i = item.index
          return b.role === 'user' ? (
            <div
              key={i}
              data-mid={b.mid}
              className={`msg user${readonly?.focusId && b.mid === readonly.focusId ? ' hit' : ''}`}
            >
              <div className="bubble">
                {b.images?.length ? (
                  <div className="bubble-imgs">
                    {b.images.map((img, k) =>
                      img.url ? (
                        <span className="bubble-img" key={k}>
                          <img src={img.url} alt={img.name ?? '添付画像'} />
                        </span>
                      ) : null,
                    )}
                  </div>
                ) : null}
                {b.files?.length ? (
                  <div className="bubble-files">
                    {b.files.map((f, k) => (
                      <span className="file-chip" key={k}>
                        📎 {f.name}
                        {f.bytes ? <span className="file-size">{fmtBytes(f.bytes)}</span> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                {b.text}
              </div>
            </div>
          ) : b.role === 'assistant' ? (
            <div
              key={i}
              data-mid={b.mid}
              className={`msg bot${readonly?.focusId && b.mid === readonly.focusId ? ' hit' : ''}`}
            >
              <div className="bubble">
                {b.tools?.length ? (
                  <details className="msg-tools">
                    <summary>🔧 ツール {b.tools.length} 件を実行</summary>
                    <ToolRows
                      rows={b.tools}
                      prefix={`msg-${i}`}
                      expandedMap={expandedTools}
                      onToggle={toggleToolExpand}
                    />
                  </details>
                ) : null}
                {b.text ? renderFormattedText(b.text, copyCode) : b.open ? <span className="dots">…</span> : ''}
              </div>
            </div>
          ) : (
            <div key={i} className="msg notice">
              {b.text}
            </div>
          )
        })}
        {isWorking ? (
          <div className="thinking thinking-card" role="status">
            {(() => {
              const started = runStartedAt || activeLiveTurn?.startedAt
              const sec = started ? Math.max(0, Math.floor((nowTick - started) / 1000)) : 0
              const mm = String(Math.floor(sec / 60)).padStart(2, '0')
              const ss = String(sec % 60).padStart(2, '0')
              const liveFallbackRows =
                !progress.length && activeLiveTurn?.lastTool?.name
                  ? [{ id: 'live-last', name: activeLiveTurn.lastTool.name, detail: activeLiveTurn.lastActivity || '', full: activeLiveTurn.lastActivity || '', done: false }]
                  : []
              const rowsToShow = progress.length ? progress : liveFallbackRows
              const thinkingLines = thinking ? thinking.trim().split('\n') : []
              const thinkingShown = thinkingExpanded ? thinking.trim() : thinkingLines.slice(-3).join('\n')
              return (
                <>
                  <div className="working-head">
                    <span className="working-dot" aria-hidden="true" />
                    <b className="working-shimmer">Working… {mm}:{ss}</b>
                    <span className="working-meta">
                      {progress.length
                        ? `ツール ${progress.length} 件`
                        : activeLiveTurn?.lastTool?.name
                          ? `直近: ${activeLiveTurn.lastTool.name}`
                          : '思考・ツール実行中'}
                    </span>
                  </div>
                  {rowsToShow.length ? (
                    <ToolRows
                      rows={rowsToShow}
                      prefix="live"
                      expandedMap={expandedTools}
                      onToggle={toggleToolExpand}
                    />
                  ) : null}
                  {thinkingShown ? (
                    <div
                      className={`thinking-text${thinkingExpanded ? ' expanded' : ''}`}
                      onClick={() => setThinkingExpanded((v) => !v)}
                    >
                      {thinkingShown}
                    </div>
                  ) : null}
                </>
              )
            })()}
          </div>
        ) : null}
        {linkedAkapen ? (
          isWaiting(linkedAkapen) ? (
            <div className="chat-live-card warn" role="status">
              <div className="chat-live-head">
                <span className="chat-live-title">
                  🖊 赤ペン判断待ち: {linkedAkapen.akapen?.title || linkedAkapen.title}
                </span>
                <button
                  type="button"
                  className="chat-report-btn primary"
                  onClick={() => {
                    haptic('tap')
                    window.dispatchEvent(
                      new CustomEvent('hm:open-akapen', {
                        detail: { taskId: linkedAkapen.id, label: linkedAkapen.akapen?.label },
                      }),
                    )
                  }}
                >
                  赤ペンで回答 ↗
                </button>
              </div>
              <div className="chat-live-sub">
                あなたの回答待ちです。回答すると自律ワーカーが作業を再開します。
              </div>
            </div>
          ) : (
            <div className="chat-live-card running" role="status">
              <div className="chat-live-head">
                <span className="working-dot" aria-hidden="true" />
                <b className="working-shimmer">
                  {linkedAkapen.status === 'running' ? 'Working… 自律ワーカー稼働中' : '自律ワーカー起動待ち'}
                </b>
                <button
                  type="button"
                  className="chat-report-btn"
                  onClick={() => {
                    haptic('tap')
                    window.dispatchEvent(
                      new CustomEvent('hm:open-akapen', {
                        detail: { taskId: linkedAkapen.id, label: linkedAkapen.akapen?.label },
                      }),
                    )
                  }}
                >
                  進行を見る ↗
                </button>
              </div>
              <div className="chat-live-sub">{linkedAkapen.akapen?.title || linkedAkapen.title}</div>
              {(() => {
                const steps = (workerFeed?.feed?.messages || [])
                  .filter((m) => m.role !== 'user')
                  .slice(-4)
                if (!steps.length) return null
                return (
                  <ToolRows
                    rows={steps.map((m, idx) => {
                      const raw = String(m.text || '').replace(/\s+/g, ' ').trim()
                      return {
                        id: String(m.id ?? idx),
                        name: m.role === 'tool' ? m.toolName || 'tool' : 'agent',
                        detail: shortenPath(raw, 56),
                        full: raw.slice(0, 300),
                        done: idx < steps.length - 1,
                      }
                    })}
                    prefix={`worker-${linkedAkapen.id}`}
                    expandedMap={expandedTools}
                    onToggle={toggleToolExpand}
                  />
                )
              })()}
            </div>
          )
        ) : null}
        {usage ? (
          <div className="usage">
            in {usage.input ?? 0} / out {usage.output ?? 0}
            {usage.cache_read ? ` / cache ${usage.cache_read}` : ''}
          </div>
        ) : null}
      </div>

      {!atBottom && timeline.length > 0 ? (
        <button
          type="button"
          className={`chat-jump-bottom${isWorking || linkedAkapen ? ' active' : ''}`}
          onClick={() => {
            haptic('tap')
            const el = listRef.current
            if (el) {
              el.scrollTop = el.scrollHeight
              stickRef.current = true
              setAtBottom(true)
            }
          }}
        >
          {isWorking || linkedAkapen ? '↓ Working・最新へ' : '↓ 最下部へ'}
        </button>
      ) : null}

      {attached.length ? (
        <div className="attach-rail">
          {attached.map((a) => (
            <div className={`attach-item${a.kind === 'image' ? ' img' : ''}`} key={a.id}>
              {a.kind === 'image' ? (
                <img src={a.preview} alt={a.name} />
              ) : (
                <span className="attach-file">
                  📎<span className="attach-file-name">{a.name}</span>
                </span>
              )}
              <button
                className="attach-x"
                aria-label="添付を外す"
                onClick={() => {
                  if (a.preview) {
                    URL.revokeObjectURL(a.preview)
                    objectUrlsRef.current.delete(a.preview)
                  }
                  setAttached((prev) => prev.filter((x) => x.id !== a.id))
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {hotSnippets.length ? (
        <div className="action-bar">
          <div className="chips-scroll">
            {hotSnippets.map((s) => (
              <button
                key={s.id}
                className="snippet-chip"
                disabled={streaming}
                title={s.text}
                onPointerDown={() => {
                  clearTimeout(pressRef.current?.timer)
                  pressRef.current = { fired: false }
                  pressRef.current.timer = setTimeout(() => {
                    pressRef.current.fired = true
                    insertSnippet(s, true)
                  }, 550)
                }}
                onPointerUp={() => clearTimeout(pressRef.current?.timer)}
                onPointerLeave={() => clearTimeout(pressRef.current?.timer)}
                onPointerCancel={() => clearTimeout(pressRef.current?.timer)}
                onClick={() => {
                  if (pressRef.current?.fired) {
                    pressRef.current.fired = false
                    return
                  }
                  insertSnippet(s)
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button className="snippet-chip add" onClick={() => setSnippetSheet(true)} aria-label="定型スニペット一覧">
            ＋
          </button>
        </div>
      ) : null}

      {readonly ? <div className="composer-ro">読み取り専用 ・ 再開するにはボードで操作してください</div> : null}
      <div className="composer" style={readonly ? { display: 'none' } : undefined}>
        <button
          className="plus"
          aria-label="画像・ファイルを添付"
          onClick={() => setAttachSheet(true)}
          disabled={streaming}
        >
          <span aria-hidden="true">＋</span>
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder="Hermes に送る…"
          onChange={(e) => {
            setText(e.target.value)
            fitComposer(e.target)
          }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.items ?? [])]
              .filter((i) => i.kind === 'file' && (i.type || '').startsWith('image/'))
              .map((i) => i.getAsFile())
              .filter(Boolean)
            if (!files.length) return
            e.preventDefault()
            addFiles(files)
          }}
          onKeyDown={(e) => {
            // Enter は改行。送信は丸ボタンと、物理キーボードの Shift+Enter だけ（赤ペン enter-key-01）
            if (!shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent?.isComposing })) return
            e.preventDefault()
            send()
          }}
        />
        {streaming ? (
          <button className="send stop" onClick={interrupt} aria-label="中断">
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button
            className="send"
            onClick={send}
            disabled={(!text.trim() && !attached.length) || attachBusy}
            aria-label="送信"
          >
            <Icon name="send" size={18} />
          </button>
        )}
      </div>

      <input
        ref={imgInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={camInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {attachSheet ? (
        <Sheet title="添付" onClose={() => setAttachSheet(false)}>
          <div className="list">
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                imgInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">画像を選ぶ</span>
                <span className="row-sub" style={{ display: 'block' }}>ギャラリーから（PNG / JPEG / WebP / GIF）</span>
              </span>
              <Icon name="chevron" />
            </button>
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                camInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">カメラで撮る</span>
                <span className="row-sub" style={{ display: 'block' }}>その場で撮影して添付</span>
              </span>
              <Icon name="chevron" />
            </button>
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                fileInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">ファイルを選ぶ</span>
                <span className="row-sub" style={{ display: 'block' }}>
                  PDF・CSV・コードなど（セッションのワークスペースに置いて @file 参照を渡す）
                </span>
              </span>
              <Icon name="chevron" />
            </button>
            <button className="list-item" onClick={pasteFromClipboard}>
              <span style={{ flex: 1 }}>
                <span className="row-title">クリップボードから</span>
                <span className="row-sub" style={{ display: 'block' }}>コピー中のスクショを貼る（許可ダイアログあり）</span>
              </span>
              <Icon name="chevron" />
            </button>
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            1メッセージ 6 個まで。画像は長辺1600pxに縮小して送ります。入力欄へのペーストでも画像を取り込めます。
          </div>
        </Sheet>
      ) : null}

      {snippetSheet ? (
        <Sheet title="定型スニペット" onClose={() => setSnippetSheet(false)}>
          <div className="list">
            {snippets.map((s) => (
              <button key={s.id} className="list-item" onClick={() => insertSnippet(s)}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-title" style={{ display: 'block' }}>
                    {s.label}
                    {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>バー</span> : null}
                    {s.custom ? <span className="pill" style={{ marginLeft: 6 }}>マイ</span> : null}
                  </span>
                  <span
                    className="row-sub"
                    style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {s.text.replace(/\n/g, ' ')}
                  </span>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            タップで入力欄に挿入（送信はしない）。バーのチップは<b>長押しで即送信</b>。
            マイスニペットは設定タブで追加できます。
          </div>
        </Sheet>
      ) : null}

      {profileSheet ? (
        <Sheet
          title={
            repoStep?.kind === 'board'
              ? 'ボードを選ぶ'
              : repoStep?.kind === 'create'
                ? 'ボードを作る'
                : repoStep?.kind === 'all'
                  ? 'すべてのリポジトリ'
                  : '新しい会話'
          }
          onClose={() => (repoStep ? setRepoStep(null) : setProfileSheet(false))}
        >
          {!repoStep ? (
            <>
              {orderedProfiles.map((p) => (
                <button
                  key={p}
                  className={`row${repoPick === p ? ' on' : ''}`}
                  onClick={() => setRepoPick(p)}
                  aria-pressed={repoPick === p}
                >
                  <span className="row-main">
                    <span className="row-title">
                      {p}
                      {p === DEFAULT_PROFILE ? <span className="prof-chip">既定</span> : null}
                      {repoPick === p ? <span className="prof-chip on">選択</span> : null}
                    </span>
                    <span className="row-sub">
                      {p === 'default'
                        ? '普段の作業（Discord と同じプロファイル）'
                        : p === 'mobile'
                          ? 'PWA の既定（赤ペン・自走実装）'
                          : p === 'nanokvm'
                            ? '実機・nanoKVM 系の隔離プロファイル'
                            : `${p} プロファイル`}
                    </span>
                  </span>
                  <Icon name={repoPick === p ? 'check' : 'chevron'} size={16} />
                </button>
              ))}

              <div className="sec">リポジトリ（作業ディレクトリ）</div>
              {pinned.rows.map((r) => (
                <button
                  key={r.id}
                  className={`row${lastRepo === r.id ? ' on' : ''}`}
                  onClick={() => pickRepo(r)}
                  title={`${r.label}（${r.path}）`}
                >
                  <span className="row-main">
                    <span className="row-title">
                      {repoLabel(r)}
                      {lastRepo === r.id ? <span className="prof-chip">前回</span> : null}
                    </span>
                    <span className="row-sub">
                      {boardSummary(r.boards)}
                      {r.boards.length > 1 ? ' ›' : ''}
                    </span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
              {!repos.length ? (
                <div className="row-sub" style={{ padding: '6px 6px 10px', lineHeight: 1.7 }}>
                  リポジトリ一覧を取得中…（取れないときは「リポジトリを選ばない」で始められます）
                </div>
              ) : null}
              {pinned.hidden > 0 ? (
                <button className="row" onClick={() => setRepoStep({ kind: 'all' })}>
                  <span className="row-main">
                    <span className="row-title">すべてのリポジトリ</span>
                    <span className="row-sub">
                      残り {pinned.hidden} 件（全 {pinned.total} 件）
                    </span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ) : null}
              <button className="row" onClick={() => startSession(repoPick, null, null)}>
                <span className="row-main">
                  <span className="row-title">リポジトリを選ばない</span>
                  <span className="row-sub">作業ディレクトリを決めずに始める</span>
                </span>
                <Icon name="chevron" size={16} />
              </button>
              <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
                プロファイルを選んでから<b>リポジトリ</b>を押すと、その会話が始まります。
                板があるリポジトリは、タスクタブと起票の既定ボードもその板に切り替わります。
              </div>
            </>
          ) : null}

          {repoStep?.kind === 'all' ? (
            <>
              <div className="sec">すべてのリポジトリ（{repos.length} 件）</div>
              {repos.map((r) => (
                <button key={r.id} className="row" onClick={() => pickRepo(r)} title={`${r.label}（${r.path}）`}>
                  <span className="row-main">
                    <span className="row-title">{repoLabel(r)}</span>
                    <span className="row-sub">
                      {boardSummary(r.boards)}
                      {r.boards.length > 1 ? ' ›' : ''}
                    </span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            </>
          ) : null}

          {repoStep?.kind === 'board' ? (
            <>
              <div className="sec">{repoLabel(repoStep.repo)} のボード</div>
              {(repoStep.repo.boards ?? []).map((b) => (
                <button key={b.slug} className="row" onClick={() => startSession(repoPick, repoStep.repo, b)}>
                  <span className="row-main">
                    <span className="row-title">{b.name || b.slug}</span>
                    <span className="row-sub">
                      {b.slug}
                      {b.current ? ' ・ 現在のボード' : ''}
                    </span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
              <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
                押した板が起票の宛先になります（このリポジトリには板が {repoStep.repo.boards.length} つあります）。
              </div>
            </>
          ) : null}

          {repoStep?.kind === 'create' ? (
            <>
              <div className="sec">ボードがありません</div>
              <div className="row-sub" style={{ padding: '6px 6px 12px', lineHeight: 1.7 }}>
                <b>{repoLabel(repoStep.repo)}</b> にはボードがありません。ボードを作ると、この会話からの起票がその板に載ります。
              </div>
              <button className="row" onClick={createRepoBoard} disabled={repoBusy} aria-busy={repoBusy}>
                <span className="row-main">
                  <span className="row-title">{repoBusy ? '作成中…' : `ボード ${repoStep.repo.id} を作る`}</span>
                  <span className="row-sub">{repoStep.repo.path}</span>
                </span>
                <Icon name="check" size={16} />
              </button>
              <button className="row" onClick={() => setRepoStep(null)}>
                <span className="row-main">
                  <span className="row-title">作らない</span>
                  <span className="row-sub">リポジトリの選択に戻る（板は増えません）</span>
                </span>
                <Icon name="chevron" size={16} />
              </button>
            </>
          ) : null}
        </Sheet>
      ) : null}

      {drawer ? (
        <Sheet title="会話" onClose={() => setDrawer(false)}>
          <button className="row" onClick={openProfileSheet}>
            <span className="row-main">
              <span className="row-title">新しい会話</span>
              <span className="row-sub">プロファイルとリポジトリを選んで作る</span>
            </span>
            <Icon name="plus" size={16} />
          </button>
          {sessions.map((s) => {
            const foreign = s.profile && s.profile !== DEFAULT_PROFILE
            // その会話に未読の赤ペン完了報告があるか（行の点。q2=A）
            const unread = unreadIds.includes(String(s.id))
            return (
              <button
                key={`${s.profile ?? 'default'}:${s.id}`}
                className={`row${s.id === storedSid ? ' on' : ''}`}
                title={unread ? '赤ペンの完了報告が届いています' : undefined}
                onClick={() => openSessionSafe(s.id, null, s.profile ?? 'default')}
              >
                <span className="row-main">
                  <span className="row-title">{s.title || s.id}</span>
                  <span className="row-sub">
                    {foreign ? (
                      <span className="prof-chip on">{s.profile}</span>
                    ) : null}
                    {s.source ?? 'cli'} ・ {s.message_count ?? 0} msg ・ {relTime((s.started_at ?? 0) * 1000)}
                    {s.is_active ? ' ・ 稼働中' : ''}
                  </span>
                </span>
                {unread ? <span className="row-dot done" aria-label="赤ペンの完了報告あり" /> : null}
                <Icon name="chevron" size={16} />
              </button>
            )
          })}
        </Sheet>
      ) : null}
    </div>
  )
}
