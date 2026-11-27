import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatSessions } from './chat/useChatSessions.js'
import { useChatReports } from './chat/useChatReports.js'
import { DEFAULT_PROFILE, STORED_PROFILE_KEY, applyDefaultProfile, subscribePilotProfile } from '../lib/profile.js'
import { pinnedRepos, readLastRepo, readPendingRepo, readRecent } from '../lib/repoPicker.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import { chatSplitChrome } from '../lib/chatSplit.js'
import { orderProfiles } from '../lib/profileOrder.js'
import { api } from '../api.js'
import { readSnippetBars, subscribeSnippetBars } from '../lib/snippetBars.js'
import { useI18n } from '../i18n/index.js'
import { t } from '../i18n/lang.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { useWakeSync } from '../lib/useWakeSync.js'
import { ChatSessionList, fitComposer } from './chat/ChatParts.jsx'
import { useChatComposer } from './chat/useChatComposer.js'
import { useChatSession } from './chat/useChatSession.js'
import { ChatAttachRail, ChatComposer } from './chat/ChatComposer.jsx'
import { ChatReportBanner, ChatTimeline, scrollToMessage } from './chat/ChatTimeline.jsx'
import { ChatChips, ChatHead, ChatMinimalHead, ChatNewChatSheet } from './chat/ChatHeadBar.jsx'
import { useChatConnection } from './chat/useChatConnection.js'
import { useChatChrome } from './chat/ChatChrome.jsx'
import { ChatSheets } from './chat/ChatSheets.jsx'
import { LAST_CHAT_KEY, followUpPromptFor } from '../lib/chatReports.js'
import { haptic } from '../lib/haptic.js'

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
  const [usage, setUsage] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [thinking, setThinking] = useState('')
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
  // スニペット一覧・接続・通知の state は `chat/useChatConnection.js`（CSW3-5）

  // 帯の表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）。設定タブの切替にイベントでその場で追従する
  const [bars, setBars] = useState(() => readSnippetBars())
  useEffect(() => subscribeSnippetBars(setBars), [])

  const sidRef = useRef(null)
  const storedRef = useRef(null)
  const storedProfileRef = useRef(DEFAULT_PROFILE)
  const repoRef = useRef(null)
  const reposRef = useRef([])
  const listRef = useRef(null)
  const stickRef = useRef(true)
  const progressRef = useRef([])
  progressRef.current = progress

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
   * 接続・通知・ドロワー・レポートカードの操作（境界③ `chat/useChatConnection.js`・CSW3-5）。
   * ソケットはこのフックの中で 1 回だけ張る（分割で購読を 2 本にしない）。
   * `ready` の復帰・イベント反映はここが持ち、`ChatPane` は戻り値を描画に使うだけ。
   */
  const conn = useChatConnection({
    notify,
    lang,
    active,
    sid,
    storedSid,
    liveTurns,
    currentIds,
    otherUnreads,
    unreadIds,
    readonlyFocusId: readonly?.focusId,
    blocks,
    progress,
    thinking,
    isWorking,
    linkedReview,
    lastReportKey,
    listRef,
    stickRef,
    progressRef,
    sidRef,
    storedRef,
    storedProfileRef,
    sessionsRef,
    loadSessions,
    markSessionRead,
    markAllSessionsRead,
    markReportsSeen,
    markAllReportsRead,
    scrollToHit,
    setSid,
    setStoredSid,
    setTitle,
    setBlocks,
    setProgress,
    setStreaming,
    setRunStartedAt,
    setThinking,
    setThinkingExpanded,
    setUsage,
    setExpandedTools,
    setDrawer,
    setReceiptCtx,
  })
  const { rpc, showBanner, connState, sockRef, resumeRef, resumeInto } = conn

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
    send,
    interrupt,
    insertSnippet,
    sendText,
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
    connRef: conn.connRef,
    sockRef,
    openRef: conn.openRef,
    pendingOpenRef: conn.pendingOpenRef,
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

  /*
   * 進行バー・仕様バナー・定型チップ帯（境界④ `chat/ChatChrome.jsx`・CSW3-5）。
   * 材料の取得（Architect ジョブ）とローカルの × も同じフックが持つ。
   */
  const chrome = useChatChrome({
    active,
    seedOpen,
    repo,
    sid,
    activeDrawerSid,
    notify,
    bars,
    hotSnippets: conn.hotSnippets,
    readonly,
    streaming,
    insertSnippet,
    setSnippetSheet,
  })

  // 復帰・回線回復時に会話一覧・Architect 進行バー・未取得スニペットを取り直す
  useWakeSync(() => {
    if (!active) return
    const rpcNow = sockRef.current?.rpc
    if (rpcNow) loadSessions(rpcNow)
    chrome.loadSpecJobs()
    if (!conn.snippets.length) conn.loadSnippets()
  })

  /** 統合レポートカードの「💬 次の一手を相談」。 */
  const discussReport = useCallback(
    (report) => {
      haptic('tap')
      prefillComposer(followUpPromptFor(report, t('chat.discussFallback'), { t, lang }))
    },
    [prefillComposer],
  )

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
      dcLink={conn.dcLink}
      chips={chipsNode}
      onOpenDrawer={conn.openDrawer}
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
      feed={{ timeline, reports, reportOpen, setReportOpen, isWorking, nowTick, runStartedAt, activeLiveTurn, progress, thinking, thinkingExpanded, setThinkingExpanded, linkedReview, workerFeed: conn.workerFeed, usage, justSettled }}
      handlers={{ discussReport, openReportReceipt: conn.openReportReceipt, openReportBoard: conn.openReportBoard, copyCode: conn.copyCode, toggleToolExpand: conn.toggleToolExpand, onOpenBubbleMenu: setBubbleMenu }}
      ui={{ readonly, expandedTools }}
    />
  )

  /* 添付レール（入力欄のすぐ上）。中身は `chat/ChatComposer.jsx` */
  const attachNode = <ChatAttachRail attached={attached} setAttached={setAttached} objectUrlsRef={objectUrlsRef} />

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
    refreshing: conn.drawerRefreshing,
    markDisabled: !drawerUnread && !otherUnreads.length,
    onRefresh: () => conn.refreshDrawerData({ force: true }),
    onMarkAllRead: conn.markAllDrawerRead,
    onOpenOrphan: conn.openOrphanReport,
    onNewChat: openProfileSheet,
    onOpenSession: (s) => openSessionSafe(s.id, null, s.profile ?? 'default'),
  }

  /* 進行バー・仕様バナー・定型チップ帯のノード（中身は `chat/ChatChrome.jsx`。並びの正本は下の 1 ペイン分岐） */
  const jobBarNode = chrome.jobBar
  const specBannerNode = chrome.specBannerCard
  const actionBarNode = chrome.actionBar

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

      {/* 添付・定型文・Seed・MD・ドロワー・レシート・バブルメニュー（境界⑤ `chat/ChatSheets.jsx`） */}
      <ChatSheets
        composer={composer}
        seedOpen={seedOpen}
        seedBoard={chrome.seedBoard}
        repo={repo}
        chat={sid ?? activeDrawerSid ?? null}
        notify={notify}
        onCloseSeed={() => setSeedOpen(false)}
        onSeeded={() => chrome.loadSpecJobs()}
        specMdSheet={chrome.specMdSheet}
        drawerOpen={drawer}
        onCloseDrawer={() => setDrawer(false)}
        drawerTitle={t('chat.drawerTitle')}
        listProps={sessionListProps}
        receiptCtx={receiptCtx}
        onCloseReceipt={() => setReceiptCtx(null)}
        bubbleMenu={bubbleMenu}
        onCloseBubbleMenu={() => setBubbleMenu(null)}
        sid={sid}
        title={title}
        readonly={readonly}
      />

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
    </div>
  )
}
