import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatSocket } from '../lib/useChatSocket.js'
import { useChatSessions } from './chat/useChatSessions.js'
import { useChatReports } from './chat/useChatReports.js'
import { DEFAULT_PROFILE, STORED_PROFILE_KEY, applyDefaultProfile, subscribePilotProfile } from '../lib/profile.js'
import { pinnedRepos, readLastRepo, readPendingRepo, readRecent } from '../lib/repoPicker.js'
import { pickResumeTarget } from '../lib/chatResume.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import { chatSplitChrome } from '../lib/chatSplit.js'
import { orderProfiles } from '../lib/profileOrder.js'
import { mergeProgress } from '../lib/toolProgress.js'
import { api } from '../api.js'
import { readSnippetBars, subscribeSnippetBars } from '../lib/snippetBars.js'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'
import { SpecSeedSheet } from './SpecSeedSheet.jsx'
import { SpecReadyBanner } from '../components/SpecReadyBanner.jsx'
import { SpecMarkdownSheet } from '../components/SpecMarkdownSheet.jsx'
import { ArchitectJobBar } from '../components/ArchitectJobBar.jsx'
import { pickActiveArchitectJob, pickSpecBanner } from '../lib/specSeed.js'
import { celebrate } from '../lib/vibe.js'
import { LAST_CHAT_KEY, followUpPromptFor } from '../lib/chatReports.js'
import { haptic } from '../lib/haptic.js'
import { useI18n } from '../i18n/index.js'
import { t } from '../i18n/lang.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { isOfflineError, shouldReconnectToast } from '../lib/netRecovery.js'
import { refreshSync, setSyncParams, setSyncState, subscribeSync, tickSync } from '../lib/syncSources.js'
import { useWakeSync } from '../lib/useWakeSync.js'
import { ChatSessionList, DRAWER_REFRESH_THROTTLE_MS, commitProgressToBlocks, fitComposer } from './chat/ChatParts.jsx'
import { ChatDrawer } from './chat/ChatDrawer.jsx'
import { useChatComposer } from './chat/useChatComposer.js'
import { useChatSession } from './chat/useChatSession.js'
import { ChatAttachRail, ChatComposer } from './chat/ChatComposer.jsx'
import { ChatAttachSheets } from './chat/ChatAttachSheets.jsx'
import { ChatBubbleMenu, ChatReportBanner, ChatTimeline, scrollToMessage } from './chat/ChatTimeline.jsx'
import { ChatChips, ChatHead, ChatMinimalHead, ChatNewChatSheet } from './chat/ChatHeadBar.jsx'

// 820px 以上のチャットを 2 カラムにする判定（境界の正本は lib/layout.js）
// 左カラム下端へ移す 4 グループの名前（JSX とテストで二重管理しない）

export function ChatPane({
  notify,
  chatReports = [],
  reviewItems = [],
  liveTurns = [],
  active = false,
  openRequest = null,
  onConsumedOpen,
  discussRequest = null,
  onConsumedDiscuss,
}) {
  // 言語切替で再描画させるための購読（翻訳はモジュール側の t が現在の言語を読む）
  const { lang } = useI18n()
  // 820px 以上（`wide`）のときだけ 2 カラムにする（SPEC-ver-0-2-1 §2.3）
  const { wide } = useSplitLayout()
  const [sid, setSid] = useState(null)
  const [storedSid, setStoredSid] = useState(null)
  const [title, setTitle] = useState('')
  const [streaming, setStreaming] = useState(false)
  // ターンの経過時間（長いターンで「動いている」ことが分かるように）
  const [runStartedAt, setRunStartedAt] = useState(null)
  const [nowTick, setNowTick] = useState(Date.now())
  // ツール呼び出しの進捗（Discord と同じ「動いている」が見える行）
  const [progress, setProgress] = useState([])
  const [expandedTools, setExpandedTools] = useState({})
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [workerFeed, setWorkerFeed] = useState(null)
  const [usage, setUsage] = useState(null)
  const [drawer, setDrawer] = useState(false)
  // ドロワーの「↻ 更新」の実行中表示（D22③）
  const [drawerRefreshing, setDrawerRefreshing] = useState(false)
  const [thinking, setThinking] = useState('')
  const [dcLink, setDcLink] = useState(null)
  // レビューの完了報告（起票した会話にだけ流れる 1 行。行の取得は App が 1 回だけ行う）。
  // その既読・突き合わせは境界② `useChatReports` が持つ。
  /*
   * 統合レポートカードの開閉（キー＝報告の key）。未指定は「最新 1 件だけ展開」を既定にする
   * （古いレポートが積まれると会話が押し流されるため・§3.3 ②）。
   */
  const [reportOpen, setReportOpen] = useState({})
  // 完了レシート（SPEC-PILOT-V5 §3.3 ③ / D26③）。統合レポートカードから開く。
  const [receiptCtx, setReceiptCtx] = useState(null)
  const [bubbleMenu, setBubbleMenu] = useState(null)
  // 📝 Spec Seed（SPEC-PILOT-V5 §3.3 ① / D26①）。一行メモから仕様策定を始める。
  const [seedOpen, setSeedOpen] = useState(false)
  // 仕様書の準備完了（A2B クイック起票カード・§3.2 D23）。
  const [specJobs, setSpecJobs] = useState(null)
  const [specFiling, setSpecFiling] = useState(false)
  const [specDismissed, setSpecDismissed] = useState([])
  // 仕様書(MD)プレビュー（SPEC-PILOT-V6 §3.4 ② / D30 ③）。バナーから 1 タップで開く
  const [specMd, setSpecMd] = useState(null)
  // 進行バーで × を押したジョブ（`failed` の再表示を止める。SPEC V6 §3.3 ②）
  const [specJobClosed, setSpecJobClosed] = useState([])
  // resume できない会話（カンバン作業ログ等）は読み取り専用で表示する
  const [readonly, setReadonly] = useState(null)
  // いま話しているプロファイル（既定はブリッジの pilotProfile 設定、フォールバック mobile）
  const [pilotDefault, setPilotDefault] = useState(DEFAULT_PROFILE)
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  const [storedProfile, setStoredProfile] = useState(DEFAULT_PROFILE) // 直近の会話の復元用
  const [profileSheet, setProfileSheet] = useState(false)
  const [repos, setRepos] = useState([])
  const [repo, setRepo] = useState(null)
  const [repoPick, setRepoPick] = useState(DEFAULT_PROFILE)
  const [repoStep, setRepoStep] = useState(null) // {kind:'board'|'create'|'all', repo}
  const [repoBusy, setRepoBusy] = useState(false)
  const [loadingChat, setLoadingChat] = useState(false)

  // 添付・入力欄・定型スニペットの state は `chat/useChatComposer.js` が持つ（CSW3-2）

  // 定型スニペット
  const [snippets, setSnippets] = useState([])
  const pressRef = useRef({})
  // 帯の表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）。設定タブの切替にイベントでその場で追従する
  const [bars, setBars] = useState(() => readSnippetBars())
  useEffect(() => subscribeSnippetBars(setBars), [])

  const sidRef = useRef(null)
  const storedRef = useRef(null)
  const storedProfileRef = useRef(DEFAULT_PROFILE)
  const repoRef = useRef(null)
  const reposRef = useRef([])
  const listRef = useRef(null)
  // ドロワー自動リフレッシュのスロットル（最後に走った時刻・D22②）
  const drawerRefreshAtRef = useRef(0)
  // 稼働中ターン数の前回値（減少＝ワーカー完了で一覧を取り直す・D22②）
  const prevLiveCountRef = useRef(0)
  const stickRef = useRef(true)
  const progressRef = useRef([])
  progressRef.current = progress
  const activeRef = useRef(active)
  activeRef.current = active
  const notifiedOffline = useRef(false)

  sidRef.current = sid
  storedRef.current = storedSid
  storedProfileRef.current = storedProfile
  repoRef.current = repo
  reposRef.current = repos

  /**
   * 画面に出している会話か（transcript の復元が別会話の結果で上書きしないための判定）。
   * ref を読むだけなので同一性は変わらない。
   */
  const isCurrentSession = useCallback((id) => storedRef.current === id || sidRef.current === id, [])

  /*
   * 実際に画面へ出している会話の ID（SPEC-PILOT-V3 §3.1 / D16①）。
   *
   * `readonly`（カンバン作業ログ等の閲覧専用）を開いている間は、**親チャットではなく
   * 閲覧中の会話**が「いま見ている会話」になる。以前はドロワーのハイライトが
   * `storedSid`（＝起票元の親チャット）だけを見ていたため、親が選択中に見えていた。
   *
   * 既読の baseline/sync（`useChatSessions`）と一覧のバッジが同じ値を見るよう、
   * フック呼び出しの前で 1 回だけ導出する。
   */
  const activeDrawerSid = readonly?.sessionId || sid || storedSid || null

  /*
   * セッション一覧・transcript・既読（境界① `features/chat/useChatSessions.js`）。
   * `resumeInto` / `onEvent` より前に置くことで、`markSessionRead` を ref 無しで直接呼べる。
   */
  const {
    sessions,
    profiles,
    blocks,
    setBlocks,
    transcriptMeta,
    setTranscriptMeta,
    sessionSeen,
    sessionsRef,
    loadSessions,
    hydrateTranscriptTools,
    loadOlderTranscript,
    markSessionRead,
    markAllSessionsRead,
  } = useChatSessions({ notify, isCurrentSession, listRef, stickRef, active, activeDrawerSid })

  /** 定型スニペットを読み込む（言語を URL に明示する・SPEC §3.1）。 */
  const langRef = useRef(lang)
  langRef.current = lang
  const loadSnippets = useCallback(async () => {
    const at = lang
    try {
      const d = await api(`/api/snippets?lang=${encodeURIComponent(at)}`)
      // 遅れて届いた別言語の応答で上書きしない
      if (langRef.current !== at) return
      setSnippets(d.snippets ?? [])
    } catch {
      /* 取れなくても入力は使える */
    }
  }, [lang])

  useEffect(() => {
    loadSnippets()
    const onUpdate = () => loadSnippets()
    window.addEventListener(HM_EVENTS.SNIPPETS, onUpdate)
    window.addEventListener(HM_EVENTS.LANG, onUpdate)
    return () => {
      window.removeEventListener(HM_EVENTS.SNIPPETS, onUpdate)
      window.removeEventListener(HM_EVENTS.LANG, onUpdate)
    }
  }, [loadSnippets])

  /**
   * A2B クイック起票カードの材料（`GET /api/architect/jobs`・SPEC V5 §3.2 D23）。
   *
   * Architect が仕様書を書き終えた瞬間にバナーを出すため、表示中は 20 秒ごとに見る。
   * 旧ブリッジ（404）では黙ってカードを出さない。
   *
   * ボード未選択（リポジトリ未指定の会話）でも必ず取得する（SPEC-PILOT-V9 §3.3 ③）。
   * ブリッジの `jobsFor()` はアクティブジョブをボード横断で返すので、別ボードで走っている
   * Architect の進行バーもチャットから消えない。
   */
  const seedBoard = repo?.boards?.[0]?.slug ?? ''
  /** ジョブ一覧の応答を反映する（取得は表の `architectJobs` = TasksPane と共有する 1 回）。 */
  const applySpecJobs = useCallback((d, meta) => {
    if (meta?.error) {
      if (!isOfflineError(meta.error)) setSpecJobs(null)
      return
    }
    if (d?.ok) setSpecJobs(d)
  }, [])

  const loadSpecJobs = useCallback(async () => {
    const r = await refreshSync('architectJobs')
    applySpecJobs(r.value, { error: r.error })
  }, [applySpecJobs])

  /* 進行バーはチャットを見ている間だけ（表の `architectJobs`・進行中は 4 秒）。 */
  useEffect(() => {
    if (!active && !seedOpen) return undefined
    const off = subscribeSync('architectJobs', applySpecJobs)
    tickSync('architectJobs')
    return off
  }, [active, seedOpen, applySpecJobs])

  /** 進行バーに出すジョブ（SPEC V6 §3.3 ②）。`spec_ready` / `launched` はバナーが引き継ぐ。 */
  const activeJob = useMemo(
    () => pickActiveArchitectJob(specJobs?.jobs ?? [], specJobClosed, seedBoard),
    [specJobs, specJobClosed, seedBoard],
  )

  /* 進行中（running / awaiting_spec）だけ 4 秒へ切り替える（表の `architectJobs.everyMsOf`）。 */
  useEffect(() => {
    if (!active) return
    setSyncState({
      architectBusy: Boolean(activeJob && (activeJob.status === 'running' || activeJob.status === 'awaiting_spec')),
    })
  }, [active, activeJob])

  /**
   * 進行バーの「🔍 進捗詳細」（SPEC-PILOT-V9 §3.3 ③ / D43 後半）。
   *
   * チャットにはタスク詳細も `LiveSheet` も無いので、`App` が受け取るイベントで振り分ける:
   * - `taskId` あり … `hm:open-task`（タスクタブへ切り替えてそのタスク詳細／WorkerFeed）
   * - `taskId` なし … `hm:open-live`（カンバンタスクを持たない Agy Opt-in の全体監視）
   *
   * 送信名は条件式で組み立てず、契約ごとにリテラルで書く（`contracts.test.js` が
   * `required` と送信リテラルを突き合わせるため・SPEC D108）。
   */
  const inspectArchitectJob = useCallback((job) => {
    if (!job) return
    haptic('tap')
    if (job.taskId) {
      emitHmEvent(HM_EVENTS.OPEN_TASK, {
        taskId: job.taskId,
        board: job.board ?? seedBoard ?? null,
        jobId: job.id ?? null,
      })
      return
    }
    emitHmEvent(HM_EVENTS.OPEN_LIVE, { jobId: job.id ?? null })
  }, [seedBoard])

  /** 出すカードは 1 枚だけ（完成 SPEC 優先・× で閉じたものは再表示しない）。 */
  const specBanner = useMemo(() => {
    const picked = pickSpecBanner({ specReady: specJobs?.specReady ?? [], pending: specJobs?.pending ?? [] })
    if (!picked || specDismissed.includes(picked.path)) return null
    return picked
  }, [specJobs, specDismissed])

  /** バナーから未起票バッチを一括起票する（既起票はブリッジ側でスキップ）。 */
  const fileSpecBatches = useCallback(
    async (banner) => {
      if (!banner || specFiling) return
      setSpecFiling(true)
      try {
        const r = await api('/api/specs/launch', {
          method: 'POST',
          body: {
            ...(seedBoard ? { board: seedBoard } : {}),
            specRelPath: banner.path,
            batchIds: banner.ids,
            ...(sid ? { chat: sid } : {}),
          },
        })
        notify(t('seed.bannerFiled', { n: (r?.created ?? []).length }))
        try {
          celebrate('launch')
        } catch {
          /* 演出は本質ではない */
        }
        await loadSpecJobs()
      } catch (e) {
        notify(e?.message ?? t('seed.failed'))
      } finally {
        setSpecFiling(false)
      }
    },
    [seedBoard, specFiling, sid, notify, t, loadSpecJobs],
  )

  /** バナーや MD プレビューから未起票 SPEC をアーカイブ退避する（D92）。 */
  const archiveSpecBanner = useCallback(
    async (banner) => {
      if (!banner?.path) return
      try {
        const targetBoard = banner?.board ?? (seedBoard || null)
        const targetRepo = banner?.board && banner.board !== seedBoard ? null : (repo?.id ?? null)
        const r = await api('/api/specs/archive', {
          method: 'POST',
          body: { board: targetBoard, repo: targetRepo, path: banner.path },
        })
        notify(r?.noop ? t('tasks.specArchiveNoop') : t('tasks.specArchiveDone'))
        await loadSpecJobs()
      } catch (e) {
        notify(e?.message ?? t('tasks.specArchiveFailed'))
      }
    },
    [seedBoard, repo?.id, notify, t, loadSpecJobs],
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
      /*
       * 表示中の会話で 1 ターン終わったら「見た」を更新する（SPEC-PILOT-V3 §3.1 / D16②）。
       * 一覧を取り直してから現在の `message_count` で記録する — 数を推測すると、
       * 自分の送信で増えた分まで新着に見えてしまう。
       */
      {
        const target = storedRef.current ?? sidRef.current
        if (target) {
          loadSessions(sockRef.current?.rpc)
            .then((list) => {
              const hit = (Array.isArray(list) ? list : []).find((x) => String(x.id) === String(target))
              if (hit) markSessionRead(hit.id, hit.message_count)
            })
            .catch(() => {})
        }
      }
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
  // `useChatSession`（この位置より後で呼ぶ）が返す `resumeInto` を、それより前で組み立てる
  // `onReady` と入力欄（`useChatComposer`）から呼ぶための入口。呼び出しは必ずマウント後なので、
  // ref から最新の実装を読む（identity は空依存で固定し、フックの再生成を招かない）。
  const resumeRef = useRef(null)
  const resumeInto = useCallback(
    (rpcNow, target, prof) => resumeRef.current?.(rpcNow, target, prof) ?? { ok: false },
    [],
  )

  /** 接続が ready になったとき（初回・再接続の両方）。 */
  const onReady = useCallback(async () => {
    const rpc = sockRef.current?.rpc
    if (!rpc) return
    if (shouldReconnectToast({ active: activeRef.current, wasOffline: notifiedOffline.current })) notify(t('chat.reconnected'))
    notifiedOffline.current = false
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
        notify(t('chat.previousChatFailed'))
      } else {
        const found = sessionsRef.current.find((x) => x.id === pick.sid)
        if (found?.title) setTitle(found.title)
      }
    }
  }, [loadSessions, notify, resumeInto])

  const onState = useCallback((s) => {
    if (s === 'closed' || s === 'error') setStreaming(false)
  }, [])
  const sock = useChatSocket({ onEvent, onReady, onState, active })
  sockRef.current = sock
  const { rpc, showBanner, state: connState } = sock
  connRef.current = connState
  useEffect(() => { if (showBanner) notifiedOffline.current = true }, [showBanner])

  /*
   * 入力欄まわり（添付・送信・定型スニペット）の state とハンドラ（境界: `chat/useChatComposer.js`）。
   * state の持ち主はこのフック 1 つだけ。`ChatPane` は戻り値をそのまま使う（開閉フラグを二重に持たない）。
   */
  const composer = useChatComposer({
    notify,
    rpc,
    sid,
    setSid,
    setStoredSid,
    setStoredProfile,
    profile,
    pilotDefault,
    streaming,
    setStreaming,
    setThinking,
    setBlocks,
    setTitle,
    storedRef,
    storedProfileRef,
    repoRef,
    resumeInto,
    setSeedOpen,
  })
  const {
    text,
    setText,
    attached,
    setAttached,
    attachSheet,
    setAttachSheet,
    attachBusy,
    snippetSheet,
    setSnippetSheet,
    taRef,
    objectUrlsRef,
    imgInputRef,
    camInputRef,
    fileInputRef,
    addFiles,
    pasteFromClipboard,
    sendText,
    send,
    interrupt,
    insertSnippet,
  } = composer

  useEffect(() => {
    try {
      applyDefaultProfile()
      const saved = localStorage.getItem(HM_STORAGE.STORED_SID)
      if (saved && !storedRef.current) setStoredSid(saved)
      const savedProfile = localStorage.getItem(STORED_PROFILE_KEY)
      if (savedProfile) setStoredProfile(savedProfile)
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
      return subscribePilotProfile(() => api('/api/pipeline/status'), (next, { source }) => {
        setPilotDefault(next)
        if ((source === 'event' || (!saved && !pendingRepo?.profile)) && !sidRef.current && !storedRef.current) {
          setProfile(next)
          setStoredProfile(next)
          storedProfileRef.current = next
          setRepoPick(next)
        }
      })
    } catch {
      /* noop */
    }
  }, [])
  useEffect(() => {
    try {
      if (storedSid) {
        localStorage.setItem(HM_STORAGE.STORED_SID, storedSid)
        localStorage.setItem(LAST_CHAT_KEY, storedSid)
      } else {
        localStorage.removeItem(HM_STORAGE.STORED_SID)
      }
      localStorage.setItem(STORED_PROFILE_KEY, storedProfile || pilotDefault)
    } catch {
      /* noop */
    }
  }, [storedSid, storedProfile, pilotDefault])

  /*
   * 実際に画面へ出している会話の ID は上（フック呼び出しの直前）で導出済み。
   * ここから下はその `activeDrawerSid` をそのまま読む。
   */
  /*
   * 完了報告（`reports`）とレビュー誘導バナー（`linkedReview`）の紐づけ先。
   * `readonly` 閲覧中は親チャット `storedSid` を混ぜない — 混ぜると親の完了報告や
   * 「あなたの番」バナーが閲覧中の作業ログに重なって出る（D16①の後半）。
   */
  const currentIds = useMemo(
    () => (readonly?.sessionId ? [String(readonly.sessionId)] : [storedSid, sid].filter(Boolean).map(String)),
    [readonly?.sessionId, storedSid, sid],
  )
  const activeLiveTurn = useMemo(
    () => liveTurns.find((t) => t?.sessionId && currentIds.includes(String(t.sessionId))) ?? null,
    [liveTurns, currentIds],
  )
  const linkedReview = useMemo(() => {
    const activeOnes = (reviewItems ?? []).filter((it) => it && it.status !== 'done')
    const byChat = activeOnes.find((it) => it.review?.chat && currentIds.includes(String(it.review.chat)))
    if (byChat) return byChat
    if (!repo) return null
    const repoPathLow = repo.path ? String(repo.path).toLowerCase() : ''
    return (
      activeOnes.find(
        (it) =>
          !it.review?.chat &&
          (it.review?.repo === repo.id ||
            (repoPathLow && it.review?.target && String(it.review.target).toLowerCase().startsWith(repoPathLow))),
      ) ?? null
    )
  }, [reviewItems, currentIds, repo])
  const isWorking = Boolean(streaming || activeLiveTurn)
  const wasWorkingRef = useRef(false)
  const [justSettled, setJustSettled] = useState(false)
  useEffect(() => {
    if (wasWorkingRef.current && !isWorking) {
      setJustSettled(true)
      const id = setTimeout(() => setJustSettled(false), 240)
      wasWorkingRef.current = isWorking
      return () => clearTimeout(id)
    }
    wasWorkingRef.current = isWorking
    return undefined
  }, [isWorking])
  /*
   * 完了報告の突き合わせ・既読・会話一覧バッジ（境界② `features/chat/useChatReports.js`）。
   * 統合レポート（`kind: 'pipeline'`）は宛先の会話に加えて、リポジトリが一致する
   * `'__latest__'` 宛の報告も合流させる（§3.2 ② / §3.3 ①）。読み取り専用の閲覧中は
   * 親チャットの報告を混ぜない（`currentIds` と同じ境界）。
   */
  const {
    reports,
    timeline,
    lastReportKey,
    unreadIds,
    otherUnreads,
    pipelineSessionIds,
    drawerOrphanReports,
    sessionBadges,
    drawerUnread,
    markReportsSeen,
    markAllReportsRead,
  } = useChatReports({
    chatReports,
    blocks,
    currentIds,
    readonly,
    repoPath: repo?.path ?? '',
    sessions,
    sessionSeen,
    liveTurns,
    activeDrawerSid,
  })

  /** ヒットした発言を画面の上寄りに出す（位置の計算は `chat/ChatTimeline.jsx`）。 */
  const scrollToHit = useCallback((mid) => scrollToMessage(listRef, mid), [])

  /**
   * 相談文を入力欄へ下書きセットする（**送信はしない**・SPEC-PILOT-V4 §3.3 ② / D20③）。
   *
   * 誤送信を避けるため `prompt.submit` は呼ばず、ユーザーが読んで 1 タップで送れる状態にする。
   * オートリサイズとフォーカスまで済ませるので、続けて書き足せる。
   */
  const prefillComposer = useCallback((prompt) => {
    const body = String(prompt ?? '').trim()
    if (!body) return
    setText(body)
    const focus = () => {
      const el = taRef.current
      if (!el) return
      try {
        el.focus({ preventScroll: false })
      } catch {
        el.focus()
      }
      el.style.height = 'auto'
      fitComposer(el)
      try {
        el.setSelectionRange(body.length, body.length)
      } catch {
        /* selection API の無い環境でも入力欄には入っている */
      }
    }
    // タブ切替・新規会話の直後は入力欄がまだ出ていないことがある。rAF と少し後の 2 回試す
    // （実測: 1 回目だけだとフォーカスが body のまま残った）。
    requestAnimationFrame(focus)
    setTimeout(focus, 150)
  }, [])

  /*
   * 会話を開く経路（新規会話・resume・`openRequest` の消費・更新・ボード作成・
   * リポジトリ選択）は `chat/useChatSession.js`（CSW3-4）。
   * state の持ち主はこの pane のまま: フックへは setter と、その時点の値を渡すだけ。
   */
  const {
    ensureRepos,
    findRepoByPath,
    resumeInto: resumeIntoImpl,
    startSession,
    openSessionSafe,
    refreshChat,
    openProfileSheet,
    pickRepo,
    createRepoBoard,
  } = useChatSession({
    notify,
    rpc,
    sessions,
    sessionsRef,
    storedRef,
    sidRef,
    connRef,
    sockRef,
    openRef,
    pendingOpenRef,
    reposRef,
    repoStep,
    repoBusy,
    repoPick,
    profile,
    pilotDefault,
    streaming,
    readonly,
    openRequest,
    onConsumedOpen,
    discussRequest,
    onConsumedDiscuss,
    prefillComposer,
    scrollToHit,
    markReportsSeen,
    markSessionRead,
    hydrateTranscriptTools,
    loadSessions,
    setSid, setStoredSid, setTitle, setBlocks, setTranscriptMeta, setUsage, setReadonly,
    setProfile, setStoredProfile, setRepo, setRepos, setRepoPick, setRepoStep, setRepoBusy,
    setDrawer, setProfileSheet, setLoadingChat,
  })
  resumeRef.current = resumeIntoImpl

  useEffect(() => {
    if (!isWorking) return undefined
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isWorking])

  // 紐づいた Review 自律ワーカーが実行中の間は直近ツールステップを取りに行く（表の `workerFeed` = 4 秒）
  const linkedWorkerId = linkedReview && (linkedReview.status === 'running' || linkedReview.status === 'ready') ? linkedReview.id : null
  useEffect(() => {
    if (!linkedWorkerId) {
      setWorkerFeed(null)
      return undefined
    }
    setSyncParams({ workerFeedId: linkedWorkerId })
    const off = subscribeSync('workerFeed', (r, meta) => {
      if (!meta?.error) setWorkerFeed(r)
    })
    refreshSync('workerFeed')
    return () => {
      off()
      setSyncParams({ workerFeedId: null })
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
  }, [blocks, isWorking, progress, thinking, linkedReview, workerFeed, readonly?.focusId, lastReportKey])

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

  // 復帰・回線回復時に会話一覧・Architect 進行バー・未取得スニペットを取り直す
  useWakeSync(() => {
    if (!activeRef.current) return
    const rpcNow = sockRef.current?.rpc
    if (rpcNow) loadSessions(rpcNow)
    loadSpecJobs()
    if (!snippets.length) loadSnippets()
  })

  /**
   * ドロワーの一覧と完了報告を取り直す（D22②）。
   *
   * `openDrawer()`（≡ を押した瞬間）と、稼働中ワーカーが 1 つ終わった瞬間に呼ぶ。
   * 既定は `DRAWER_REFRESH_THROTTLE_MS`（1.5s）で間引く — 開け閉めの連打で
   * `/api/sessions` を叩き続けないため。`force` はボタン押下用。
   */
  const refreshDrawerData = useCallback(
    async ({ force = false } = {}) => {
      const at = Date.now()
      if (!force && at - drawerRefreshAtRef.current < DRAWER_REFRESH_THROTTLE_MS) return true
      drawerRefreshAtRef.current = at
      try {
        emitHmEvent(HM_EVENTS.REFRESH_REPORTS)
        const rpcNow = sockRef.current?.rpc
        if (connRef.current === 'ready' && rpcNow) {
          setDrawerRefreshing(true)
          try {
            await loadSessions(rpcNow)
          } finally {
            setDrawerRefreshing(false)
          }
        }
        return true
      } catch {
        return false
      }
    },
    [loadSessions],
  )

  /** `≡` でドロワーを開く（開いた瞬間に最新化する・D22②）。 */
  const openDrawer = useCallback(() => {
    setDrawer(true)
    refreshDrawerData()
  }, [refreshDrawerData])

  /*
   * 稼働中のターンが減った＝ワーカーが 1 つ終わった可能性が高いので、
   * そのまま一覧と完了報告を取り直す（ドロワーを開き直さなくてもバッジが揃う・D22②）。
   */
  useEffect(() => {
    const n = Array.isArray(liveTurns) ? liveTurns.length : 0
    const prev = prevLiveCountRef.current
    prevLiveCountRef.current = n
    if (prev > 0 && n < prev) refreshDrawerData({ force: true })
  }, [liveTurns, refreshDrawerData])

  /**
   * ドロワー上部の「✓ すべて既読」（D22③）。
   * 返信新着（`hm.session.seen.v1`）と完了報告（`hm.chatReportSeen`）の**両方**を一括で既読にする。
   */
  const markAllDrawerRead = useCallback(() => {
    // 返信新着（`hm.session.seen.v1`）は境界①、完了報告（`hm.chatReportSeen`）は境界②が持つ
    markAllSessionsRead()
    markAllReportsRead()
  }, [markAllSessionsRead, markAllReportsRead])

  useEffect(() => {
    try {
      emitHmEvent(HM_EVENTS.CHAT_UNREAD, { count: otherUnreads.length })
    } catch {
      /* noop */
    }
  }, [otherUnreads.length])

  useEffect(() => {
    try {
      emitHmEvent(HM_EVENTS.CHAT_STREAMING, { streaming: isWorking })
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
        if (!navigator.clipboard?.writeText) throw new Error(t('chat.copyUnsupported'))
        await navigator.clipboard.writeText(code)
        haptic('tap')
        notify(t('chat.copied'))
      } catch (e) {
        notify(e?.message || t('chat.copyFailed'))
      }
    },
    [notify],
  )

  /** 統合レポートカードの「💬 次の一手を相談」。 */
  const discussReport = useCallback(
    (report) => {
      haptic('tap')
      prefillComposer(followUpPromptFor(report, t('chat.discussFallback'), { t, lang }))
    },
    [prefillComposer],
  )

  /**
   * ドロワーの「レポート」行（会話一覧に宛先が無い報告）を開く。
   * 既読にしてから App へ渡し、対象 repo の会話を開いて相談文を置いてもらう。
   */
  const openOrphanReport = useCallback(
    (report) => {
      if (!report) return
      haptic('tap')
      markReportsSeen(report.sessionId)
      try {
        window.dispatchEvent(
          new CustomEvent(HM_EVENTS.DISCUSS_PIPELINE, {
            detail: {
              sessionId: report.sessionId ?? null,
              repoPath: report.repoPath ?? null,
              board: report.board ?? null,
              prompt: followUpPromptFor(report, t('chat.discussFallback'), { t, lang }),
              title: report.label ?? null,
            },
          }),
        )
      } catch {
        /* noop */
      }
      setDrawer(false)
    },
    [markReportsSeen, prefillComposer],
  )

  /** 統合レポートカードの「📋 ボードを見る」（App が Tasks タブへ切り替える）。 */
  const openReportBoard = useCallback((report) => {
    haptic('tap')
    try {
      emitHmEvent(HM_EVENTS.OPEN_BOARD, { board: report?.board ?? null })
    } catch {
      /* noop */
    }
  }, [])

  /**
   * 統合レポートカードの「🏆 完了レシート」（SPEC-PILOT-V5 §3.3 ③ / D26③）。
   * レポートの board / spec をそのまま渡すので、別ボードの完走でも対象がずれない。
   */
  const openReportReceipt = useCallback((report) => {
    haptic('tap')
    setReceiptCtx({ board: report?.board ?? null, spec: report?.spec ?? null })
  }, [])

  // 開いている会話の新着はタイムラインに出ている＝見えている。既読にして点を残さない
  // （タブを離れている間、または別の会話に届いた分だけが点になる）。
  useEffect(() => {
    if (!active || !currentIds.length) return
    for (const id of currentIds) {
      if (unreadIds.includes(id)) markReportsSeen(id)
    }
  }, [active, currentIds, unreadIds, markReportsSeen])


  const hotSnippets = snippets.filter((s) => s.hot).slice(0, 8)

  /**
   * 新しい会話で選べるプロファイル。
   * 並び順は (1) DEFAULT_PROFILE (2) 'default' (3) 直近利用順 (4) 名前順（SPEC §5.3）。
   * 直近利用順はセッション一覧の最終活動時刻から作る（プロファイル名の決め打ちはしない）。
   */
  const orderedProfiles = useMemo(() => orderProfiles(profiles, sessions, pilotDefault), [profiles, sessions, pilotDefault])

  /** 前回選んだリポジトリ（Q4=A: 次回の初期値。シートを開くたびに読み直す）。 */
  const lastRepo = useMemo(() => readLastRepo(), [profileSheet])

  /** シートに直接並べるリポジトリ 4 行（前回が先頭・残りは「すべて」から）。 */
  const pinned = useMemo(() => pinnedRepos(repos, readRecent()), [repos, profileSheet])

  /*
   * タブレット横持ちの 2 カラム（SPEC-ver-0-2-1 §2.3 / 決定 Q1=A）。
   *
   * `wide`（820px 以上）のときだけ「左 = セッション一覧＋下端スタック / 右 = タイムラインだけ」
   * にする。右カラムへ置くのは最小ヘッダとタイムラインだけで、バナー・チップ・定型チップ帯・
   * 入力欄はすべて左カラムの下端へ寄せる（右の縦を全部本文に使う）。
   * 境界は `lib/layout.js` の 820 を再利用し、`@media` は増やさない
   * （`web/test/layoutBreakpoints.test.js` が `min-width` の集合一致を見ている）。
   * 820px 未満は今までどおり 1 ペインで、DOM の順も変えない。
   */
  const splitChat = wide

  /* プロファイル札・リポジトリ札（1 ペインはヘッダ内・2 カラムは左の下端スタック）。中身は `chat/ChatHeadBar.jsx` */
  const chipsNode = (
    <ChatChips profile={profile} pilotDefault={pilotDefault} repo={repo} onOpenProfileSheet={openProfileSheet} />
  )

  /* 1 ペインのヘッダ（2 カラムでは出さない: 一覧は左カラムが持つ）。中身は `chat/ChatHeadBar.jsx` */
  const chatHeadNode = (
    <ChatHead
      title={title}
      drawerUnread={drawerUnread}
      otherUnreads={otherUnreads}
      dcLink={dcLink}
      chips={chipsNode}
      onOpenDrawer={openDrawer}
      onNewChat={openProfileSheet}
      onRefresh={refreshChat}
    />
  )

  /* オフライン・完了レポート・読み取り専用のバナー（Q1=A: 2 カラムでは左の下端へ）。中身は `chat/ChatTimeline.jsx` */
  const bannerNode = (
    <ChatReportBanner
      showBanner={showBanner}
      otherUnreads={otherUnreads}
      readonly={readonly}
      storedRef={storedRef}
      sidRef={sidRef}
      listRef={listRef}
      markReportsSeen={markReportsSeen}
      findRepoByPath={findRepoByPath}
      startSession={startSession}
      sessions={sessions}
      openSessionSafe={openSessionSafe}
      profile={profile}
      pilotDefault={pilotDefault}
    />
  )

  /* タイムライン（両レイアウト共通。右カラムではこれが縦を全部使う）。中身は `chat/ChatTimeline.jsx` */
  const timelineNode = (
    <ChatTimeline
      scroll={{ listRef, stickRef }}
      session={{ blocks, loadingChat, connState, sessions, profile, resumeInto, sockRef, setStoredSid, transcriptMeta, loadOlderTranscript }}
      feed={{ timeline, reports, reportOpen, setReportOpen, isWorking, nowTick, runStartedAt, activeLiveTurn, progress, thinking, thinkingExpanded, setThinkingExpanded, linkedReview, workerFeed, usage, justSettled }}
      handlers={{ discussReport, openReportReceipt, openReportBoard, copyCode, toggleToolExpand, onOpenBubbleMenu: setBubbleMenu }}
      ui={{ readonly, expandedTools }}
    />
  )

  /* 添付レール（入力欄のすぐ上）。中身は `chat/ChatComposer.jsx` */
  const attachNode = <ChatAttachRail attached={attached} setAttached={setAttached} objectUrlsRef={objectUrlsRef} />

  /* Architect の進行バー（SPEC V6 §3.3 ②） */
  const jobBarNode = (
    <>
      {/* Architect の進行バー（SPEC V6 §3.3 ②）: Seed のあと「今どこか」を画面上部に残す */}
      <ArchitectJobBar
        job={activeJob}
        board={seedBoard}
        repo={repo?.id ?? null}
        chat={sid ?? activeDrawerSid ?? null}
        onInspect={inspectArchitectJob}
        onRetried={() => loadSpecJobs()}
        onDismiss={async (jobId) => {
          // バーがサーバー側へ破棄を永続化したあとに呼ばれる。ローカルでも閉じ、
          // 取得し直して「破棄済みが一覧から消えた」ことを実データで確認する（SPEC V7 §3.3 ③）
          setSpecJobClosed((prev) => [...prev, jobId])
          await loadSpecJobs()
        }}
        notify={notify}
      />
    </>
  )

  /* A2B クイック起票カード（SPEC V5 §3.2 D23） */
  const specBannerNode = (
    <>
      {/* A2B クイック起票カード（SPEC V5 §3.2 D23）: 仕様書ができた瞬間に 1 タップで起票 */}
      <SpecReadyBanner
        banner={specBanner}
        busy={specFiling}
        onFile={fileSpecBatches}
        onDismiss={(b) => setSpecDismissed((prev) => [...prev, b.path])}
        onPreview={(b) => setSpecMd({ path: b.path, title: b.title, board: b.board ?? null })}
        onArchive={archiveSpecBanner}
      />
    </>
  )

  /* 定型チップ帯（SPEC-PILOT-V7 §3.4） */
  const actionBarNode = (
    <>
      {/* 定型チップ帯（設定タブで非表示にできる・SPEC-PILOT-V7 §3.4）。隠したときは
          入力欄の ＋ →「定型文」から同じスニペット一覧を開ける */}
      {bars.chat && (hotSnippets.length || !readonly) ? (
        <div className="action-bar">
          <div className="chips-scroll">
            {hotSnippets.map((s) => (
              <button
                key={s.id}
                className={`snippet-chip${s.trigger ? ' trigger' : ''}`}
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
          <button className="snippet-chip add" onClick={() => setSnippetSheet(true)} aria-label={t('chat.snippetListAria')}>
            <span className="snippet-chip-add-glyph">+</span>
          </button>
        </div>
      ) : null}
    </>
  )

  /* 入力欄（読み取り専用のときは .composer-ro）。中身は `chat/ChatComposer.jsx` */
  const composerNode = (
    <ChatComposer
      readonly={readonly}
      streaming={streaming}
      text={text}
      setText={setText}
      attached={attached}
      attachBusy={attachBusy}
      taRef={taRef}
      addFiles={addFiles}
      send={send}
      onStop={interrupt}
      onOpenAttachSheet={() => setAttachSheet(true)}
    />
  )

  /* 右カラムの最小ヘッダ（タイトル・↻・＋だけ。バナーもチップも置かない）。中身は `chat/ChatHeadBar.jsx` */
  const minimalHeadNode = (
    <ChatMinimalHead title={title} onNewChat={openProfileSheet} onRefresh={refreshChat} />
  )

  /*
   * セッション一覧の材料（1 ペインはドロワー・2 カラムは左カラムの上）。
   * 一覧そのものは `ChatSessionList`（`chat/ChatParts.jsx`）1 つだけなので、
   * ここでは props の束を 1 回だけ組み立てて両方へ渡す。
   */
  const sessionListProps = {
    sessions,
    sessionBadges,
    pipelineSessionIds,
    readonlySessionId: readonly?.sessionId,
    orphanReports: drawerOrphanReports,
    refreshing: drawerRefreshing,
    markDisabled: !drawerUnread && !otherUnreads.length,
    onRefresh: () => refreshDrawerData({ force: true }),
    onMarkAllRead: markAllDrawerRead,
    onOpenOrphan: openOrphanReport,
    onNewChat: openProfileSheet,
    onOpenSession: (s) => openSessionSafe(s.id, null, s.profile ?? 'default'),
  }

  /*
   * 左カラム下端の固定スタック。グループ名と順番の正本は `lib/chatSplit.js` の
   * `chatSplitChrome()`（JSX とテストで二重管理しない）。
   */
  const splitStackNodes = {
    banners: (
      <>
        {bannerNode}
        {jobBarNode}
        {specBannerNode}
      </>
    ),
    chips: chipsNode,
    snippets: actionBarNode,
    composer: (
      <>
        {attachNode}
        {composerNode}
      </>
    ),
  }

  return (
    <div className={splitChat ? 'pane chat split-layout' : 'pane chat'} data-conn={connState}>
      {splitChat ? (
        <>
          <div className="chat-split-master">
            <div className="chat-split-list">
              <ChatSessionList {...sessionListProps} />
            </div>
            <div className="chat-split-stack">
              {chatSplitChrome().map((group) => (
                <div className="chat-split-group" data-chat-group={group} key={group}>
                  {splitStackNodes[group]}
                </div>
              ))}
            </div>
          </div>
          <div className="chat-split-detail">
            {minimalHeadNode}
            {timelineNode}
          </div>
        </>
      ) : (
        <>
          {chatHeadNode}
          {bannerNode}
          {timelineNode}
          {attachNode}
          {jobBarNode}
          {specBannerNode}
          {actionBarNode}
          {composerNode}
        </>
      )}

      <ChatAttachSheets
        attachSheet={attachSheet}
        setAttachSheet={setAttachSheet}
        snippetSheet={snippetSheet}
        setSnippetSheet={setSnippetSheet}
        snippets={snippets}
        insertSnippet={insertSnippet}
        pasteFromClipboard={pasteFromClipboard}
        addFiles={addFiles}
        imgInputRef={imgInputRef}
        camInputRef={camInputRef}
        fileInputRef={fileInputRef}
        bars={bars}
      />

      {seedOpen ? (
        <SpecSeedSheet
          board={seedBoard}
          repo={repo?.id ?? null}
          chat={sid ?? activeDrawerSid ?? null}
          notify={notify}
          onClose={() => setSeedOpen(false)}
          onSeeded={() => loadSpecJobs()}
        />
      ) : null}

      {/* 仕様書(MD)プレビュー（SPEC-PILOT-V6 §3.4 ② / D30）。バナーと同じ 1 枚をここでも開く */}
      {specMd ? (
        <SpecMarkdownSheet
          board={specMd.board ?? (seedBoard || null)}
          repo={specMd.board && specMd.board !== seedBoard ? null : (repo?.id ?? null)}
          path={specMd.path}
          title={specMd.title}
          onClose={() => setSpecMd(null)}
          onArchived={() => loadSpecJobs()}
        />
      ) : null}

      <ChatNewChatSheet
        open={profileSheet}
        repoStep={repoStep}
        setRepoStep={setRepoStep}
        onClose={() => (repoStep ? setRepoStep(null) : setProfileSheet(false))}
        repoPick={repoPick}
        setRepoPick={setRepoPick}
        orderedProfiles={orderedProfiles}
        pilotDefault={pilotDefault}
        pinned={pinned}
        lastRepo={lastRepo}
        onPickRepo={pickRepo}
        repos={repos}
        onStart={startSession}
        onCreateBoard={createRepoBoard}
        boardBusy={repoBusy}
      />

      <ChatDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title={t('chat.drawerTitle')}
        listProps={sessionListProps}
      />

      {receiptCtx ? (
        <MissionReceiptSheet
          board={receiptCtx.board}
          spec={receiptCtx.spec}
          onClose={() => setReceiptCtx(null)}
          notify={notify}
        />
      ) : null}

      {bubbleMenu ? (
        <ChatBubbleMenu
          menu={bubbleMenu}
          onClose={() => setBubbleMenu(null)}
          notify={notify}
          sid={sid}
          title={title}
          repo={repo}
          readonly={readonly}
          sendText={sendText}
          setText={setText}
          taRef={taRef}
        />
      ) : null}
    </div>
  )
}
