import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChatSocket } from '../lib/useChatSocket.js'
import { DEFAULT_PROFILE, STORED_PROFILE_KEY, applyDefaultProfile } from '../lib/profile.js'
import { boardSummary, defaultBoard, matchRepoByCwd, pinnedRepos, readLastRepo, readPendingRepo, readRecent, rememberRepo, repoLabel, writePendingRepo } from '../lib/repoPicker.js'
import { pickResumeTarget, recentSessions } from '../lib/chatResume.js'
import { useSplitLayout } from '../lib/useSplitLayout.js'
import { chatSplitChrome } from '../lib/chatSplit.js'
import { orderProfiles } from '../lib/profileOrder.js'
import { foldTranscriptMessages, mergeProgress, shortenPath } from '../lib/toolProgress.js'
import { isWaiting } from '../lib/reviewView.js'
import { api } from '../api.js'
import { shouldSendOnEnter } from '../lib/composerKey.js'
import { readSnippetBars, subscribeSnippetBars } from '../lib/snippetBars.js'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'
import { SpecSeedSheet } from './SpecSeedSheet.jsx'
import { SpecReadyBanner } from '../components/SpecReadyBanner.jsx'
import { ArchitectJobBar } from '../components/ArchitectJobBar.jsx'
import { jobPollMs, pickActiveArchitectJob, pickSpecBanner } from '../lib/specSeed.js'
import { celebrate } from '../lib/vibe.js'
import { LATEST_REPORT_ID, LAST_CHAT_KEY, SEEN_MAP_KEY, followUpPromptFor, isPipelineReport, markAllReportsSeenMap, maxReportAtFor, mergeTimeline, orphanPipelineReports, otherUnreadReports, recentPipelineReports, unseenPipelineReports, readSeenMap, reportIdsFor, reportLines, reportSummaryLine, setSeen, toEpochMs, unreadSessions } from '../lib/chatReports.js'
import { SESSION_SEEN_KEY, bootstrapSessionSeen, drawerUnreadCount as countDrawerUnread, markAllSessionsSeen, markSessionSeen, readSessionSeen, serializeSessionSeen, sessionRowBadges, syncActiveSessionSeen } from '../lib/sessionUnread.js'
import { Icon, Loader, RefreshButton, Sheet, fmtBytes, fmtDateTime, relTime } from '../components/Ui.jsx'
import { haptic } from '../lib/haptic.js'
import { useI18n } from '../i18n/index.js'
import { localizeError, t } from '../i18n/lang.js'
import { sep } from '../lib/format.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { ChatSessionList, DRAWER_REFRESH_THROTTLE_MS, MarkdownBody, PipelineReportCard, ToolRows, commitProgressToBlocks, fitComposer } from './chat/ChatParts.jsx'

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
  const [sessions, setSessions] = useState([])
  const [sid, setSid] = useState(null)
  const [storedSid, setStoredSid] = useState(null)
  const [title, setTitle] = useState('')
  const [blocks, setBlocks] = useState([])
  // 履歴ページネーション（`before=<oldestId>` で遡る）の状態
  const [transcriptMeta, setTranscriptMeta] = useState(null)
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
  // ドロワーの「↻ 更新」の実行中表示（D22③）
  const [drawerRefreshing, setDrawerRefreshing] = useState(false)
  const [thinking, setThinking] = useState('')
  const [dcLink, setDcLink] = useState(null)
  // レビューの完了報告（起票した会話にだけ流れる 1 行。行の取得は App が 1 回だけ行う）
  // と、会話一覧の行に出す「新着の点」の既読（端末に残す）。
  const [seenMap, setSeenMap] = useState({})
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
  /*
   * 会話ごとの「見た」記録（`{ [sessionId]: { count, at } }`・SPEC-PILOT-V3 §3.1 / D16②）。
   * 完了報告の既読（`seenMap`）とは別物で、こちらは**返信の新着**（message_count の増分）を見る。
   */
  const [sessionSeen, setSessionSeen] = useState({})
  const imgInputRef = useRef(null)
  const camInputRef = useRef(null)
  const fileInputRef = useRef(null)

  // 定型スニペット
  const [snippets, setSnippets] = useState([])
  const [snippetSheet, setSnippetSheet] = useState(false)
  const pressRef = useRef({})
  // 帯の表示トグル（SPEC-PILOT-V7 §3.4 / V7-4）。設定タブの切替にイベントでその場で追従する
  const [bars, setBars] = useState(() => readSnippetBars())
  useEffect(() => subscribeSnippetBars(setBars), [])

  const sidRef = useRef(null)
  const storedRef = useRef(null)
  const storedProfileRef = useRef(DEFAULT_PROFILE)
  const repoRef = useRef(null)
  const reposRef = useRef([])
  const sessionsRef = useRef([])
  /*
   * 最新の完了報告（`chatReports` の props）を ref でも持つ（SPEC-PILOT-V4 §3.1 / D22①）。
   * `markReportsSeen` を `useCallback([])` のままにするため、依存配列に props を足さずに
   * 最新値を読む。時刻スキューの吸収に「その会話の最新 at」が要る。
   */
  const chatReportsRef = useRef([])
  chatReportsRef.current = Array.isArray(chatReports) ? chatReports : []
  const listRef = useRef(null)
  // 過去履歴を先頭に足したときのスクロール基準（layout effect で使い捨てる）
  const prependAnchorRef = useRef(null)
  // ドロワー自動リフレッシュのスロットル（最後に走った時刻・D22②）
  const drawerRefreshAtRef = useRef(0)
  // 稼働中ターン数の前回値（減少＝ワーカー完了で一覧を取り直す・D22②）
  const prevLiveCountRef = useRef(0)
  // 配列添字ではなく「ブロック実体ごとに一意で安定した key」を作るための記録。
  // mid が無い（ライブ生成中・resume 直後）ブロックは `at` が同値になることがあり、
  // 素朴な `at-<at>` だと key 衝突で React が古い DOM を残す（実測: state 43 件 / DOM 45 件）。
  const blockKeysRef = useRef(new WeakMap())
  const blockKeySeqRef = useRef(0)
  const taRef = useRef(null)
  const stickRef = useRef(true)
  const progressRef = useRef([])
  /** `markSessionRead` を `onEvent` から使うための参照（定義順の都合）。 */
  const markReadRef = useRef(null)
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
   * 統合レポートの `repoPath` から、その会話を作るべきリポジトリを探す。
   *
   * リポジトリ一覧は遅延取得（`ensureRepos`）なので、まだ取れていなければここで取りに行く。
   * これをしないと、Tasks タブのバナーから相談を始めてもリポジトリが決まらず、
   * `'__latest__'` 宛のレポートがタイムラインに合流しない（実測）。
   */
  const findRepoByPath = useCallback(
    async (repoPath) => {
      const path = String(repoPath ?? '').trim().toLowerCase()
      if (!path) return null
      const pick = (list) =>
        (Array.isArray(list) ? list : []).find(
          (x) => x?.path && String(x.path).trim().toLowerCase() === path,
        ) ?? null
      const hit = pick(reposRef.current)
      if (hit) return hit
      try {
        return pick(await ensureRepos())
      } catch {
        return null
      }
    },
    [ensureRepos],
  )

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
  const loadSpecJobs = useCallback(async () => {
    try {
      const qs = seedBoard ? `?board=${encodeURIComponent(seedBoard)}` : ''
      const d = await api(`/api/architect/jobs${qs}`)
      if (d?.ok) setSpecJobs(d)
    } catch {
      setSpecJobs(null)
    }
  }, [seedBoard])

  /** 進行バーに出すジョブ（SPEC V6 §3.3 ②）。`spec_ready` / `launched` はバナーが引き継ぐ。 */
  const activeJob = useMemo(
    () => pickActiveArchitectJob(specJobs?.jobs ?? [], specJobClosed, seedBoard),
    [specJobs, specJobClosed, seedBoard],
  )

  /**
   * 進行バーの「🔍 進捗詳細」（SPEC-PILOT-V9 §3.3 ③ / D43 後半）。
   *
   * チャットにはタスク詳細も `LiveSheet` も無いので、`App` が受け取るイベントで振る:
   * - `taskId` あり … `hm:open-task`（タスクタブへ切り替えてそのタスク詳細／WorkerFeed）
   * - `taskId` なし … `hm:open-live`（カンバンタスクを持たない Agy Opt-in の全体監視）
   */
  const inspectArchitectJob = useCallback((job) => {
    if (!job) return
    haptic('tap')
    try {
      const event = job.taskId ? HM_EVENTS.OPEN_TASK : HM_EVENTS.OPEN_LIVE
      window.dispatchEvent(
        new CustomEvent(event, {
          detail: {
            taskId: job.taskId ?? null,
            board: job.board ?? seedBoard ?? null,
            jobId: job.id ?? null,
          },
        }),
      )
    } catch {
      /* 遷移できなくても画面は壊さない */
    }
  }, [seedBoard])

  // 進行中は 4 秒・人待ち／停止は 20 秒（SPEC V6 §3.3 ③）
  const jobPollInterval = jobPollMs(activeJob)

  useEffect(() => {
    if (!active && !seedOpen) return undefined
    loadSpecJobs()
    const timer = setInterval(loadSpecJobs, jobPollInterval)
    return () => clearInterval(timer)
  }, [active, seedOpen, loadSpecJobs, jobPollInterval])

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

  /** state.db のツール実行履歴を会話ブロックへ復元する（再接続・切替後も足跡を残す）。 */
  const hydrateTranscriptTools = useCallback(async (sessionId, prof = 'default') => {
    if (!sessionId) return
    const profileParam = prof && prof !== 'default' ? prof : null
    try {
      const q = new URLSearchParams({ limit: '300', tools: '1' })
      if (profileParam) q.set('profile', profileParam)
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
      if (!d?.ok || !Array.isArray(d.messages)) return
      if (storedRef.current !== sessionId && sidRef.current !== sessionId) return
      // 遡れる余地（古い側にまだメッセージがあるか）を覚えておく
      setTranscriptMeta({
        sessionId,
        profile: profileParam,
        hasMore: Boolean(d.hasMore),
        oldestId: d.oldestId ?? null,
        loadingMore: false,
      })
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

  /**
   * 上端の「↑ 過去の履歴を読み込む」から、`before=<oldestId>` で古い側を1ページ足す。
   *
   * 先頭に挿入するとブラウザは同じ scrollTop を保つため、見ていた位置が下へずれる。
   * 追加後の scrollHeight 差分だけ scrollTop を足して「読んでいた行」を動かさない。
   */
  const loadOlderTranscript = useCallback(async () => {
    const meta = transcriptMeta
    if (!meta?.sessionId || !meta.hasMore || !meta.oldestId || meta.loadingMore) return
    // 「いま画面の先頭に見えている発言」を基準に、先頭追加後も同じ位置に置く
    const sc = listRef.current
    const anchorEl = sc?.querySelector('[data-mid]')
    prependAnchorRef.current = anchorEl
      ? { mid: anchorEl.getAttribute('data-mid'), top: anchorEl.getBoundingClientRect().top }
      : null
    // 追加分で末尾へ飛ばされないように先に追従を止める
    stickRef.current = false
    setTranscriptMeta((m) => (m ? { ...m, loadingMore: true } : m))
    try {
      const q = new URLSearchParams({ limit: '250', before: String(meta.oldestId), tools: '1' })
      if (meta.profile && meta.profile !== 'default') q.set('profile', meta.profile)
      const d = await api(`/api/sessions/${encodeURIComponent(meta.sessionId)}/transcript?${q}`)
      if (!d?.ok) {
        notify(localizeError(d) || t('chat.cannotOpen'))
        prependAnchorRef.current = null
        setTranscriptMeta((m) => (m ? { ...m, loadingMore: false } : m))
        return
      }
      const { blocks: older } = foldTranscriptMessages(d.messages ?? [], toEpochMs)
      setBlocks((prev) => {
        const seen = new Set(prev.filter((b) => b.mid != null).map((b) => `m${b.mid}`))
        const add = older.filter((b) => b.mid == null || !seen.has(`m${b.mid}`))
        return add.length ? [...add, ...prev] : prev
      })
      setTranscriptMeta({
        sessionId: meta.sessionId,
        profile: meta.profile ?? null,
        hasMore: Boolean(d.hasMore),
        oldestId: d.oldestId ?? null,
        loadingMore: false,
      })
    } catch (e) {
      notify(e?.message || t('chat.cannotOpen'))
      prependAnchorRef.current = null
      setTranscriptMeta((m) => (m ? { ...m, loadingMore: false } : m))
    }
  }, [transcriptMeta, notify])

  /**
   * 先頭に履歴を足した直後、基準にした発言が同じ画面位置に来るよう scrollTop を補正する。
   *
   * `requestAnimationFrame` では React のコミット前に走ることがあり補正が空振りした（実測）。
   * コミット後＝layout effect で測り直す。ブラウザの scroll anchoring が既に補正していれば
   * 差分は 0 なので二重にずらさない。
   */
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    if (!anchor) return
    prependAnchorRef.current = null
    const sc = listRef.current
    if (!sc) return
    const el = sc.querySelector(`[data-mid="${anchor.mid}"]`)
    if (!el) return
    const delta = el.getBoundingClientRect().top - anchor.top
    if (delta) sc.scrollTop = Math.max(0, sc.scrollTop + delta)
  }, [blocks])

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
        /*
         * 開いた＝見た（返信新着のピルを消す・D16② / SPEC-PILOT-V4 §3.1 D22①）。
         * 一覧の `message_count` はドロワーを開いた時点で古いことがある（I9②）ので、
         * **実際に読んだメッセージ数**との大きい方を記録する。小さい方を書くと直後の
         * ポーリングで差分が新着として再点灯する。
         */
        markReadRef.current?.(
          resolvedSid,
          Math.max(
            Number(sessionsRef.current.find((s) => String(s.id) === String(resolvedSid))?.message_count) || 0,
            msgs.length,
          ),
        )
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
              if (hit) markReadRef.current?.(hit.id, hit.message_count)
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

  /** 接続が ready になったとき（初回・再接続の両方）。 */
  const onReady = useCallback(async () => {
    const rpc = sockRef.current?.rpc
    if (!rpc) return
    if (notifiedOffline.current) {
      notifiedOffline.current = false
      notify(t('chat.reconnected'))
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
        notify(t('chat.previousChatFailed'))
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
      const saved = localStorage.getItem(HM_STORAGE.STORED_SID)
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
        localStorage.setItem(HM_STORAGE.STORED_SID, storedSid)
        localStorage.setItem(LAST_CHAT_KEY, storedSid)
      } else {
        localStorage.removeItem(HM_STORAGE.STORED_SID)
      }
      localStorage.setItem(STORED_PROFILE_KEY, storedProfile || DEFAULT_PROFILE)
    } catch {
      /* noop */
    }
  }, [storedSid, storedProfile])

  /*
   * 実際に画面へ出している会話の ID（SPEC-PILOT-V3 §3.1 / D16①）。
   *
   * `readonly`（カンバン作業ログ等の閲覧専用）を開いている間は、**親チャットではなく
   * 閲覧中の会話**が「いま見ている会話」になる。以前はドロワーのハイライトが
   * `storedSid`（＝起票元の親チャット）だけを見ていたため、親が選択中に見えていた。
   */
  const activeDrawerSid = readonly?.sessionId || sid || storedSid || null
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
   * 統合レポート（`kind: 'pipeline'`）は「宛先の会話」に加えて、リポジトリが一致する
   * `'__latest__'` 宛の報告も合流させる（§3.2 ② / §3.3 ①）。読み取り専用の閲覧中は
   * 親チャットの報告を混ぜない（既存の `currentIds` と同じ境界）。
   */
  const reportIds = useMemo(
    () => reportIdsFor(currentIds, chatReports, readonly ? '' : repo?.path ?? ''),
    [currentIds, chatReports, readonly, repo?.path],
  )
  const reports = useMemo(() => reportLines(chatReports, reportIds), [chatReports, reportIds])
  const timeline = useMemo(() => mergeTimeline(blocks, reports), [blocks, reports])
  const lastReportKey = reports.length ? reports[reports.length - 1].key : ''

  useEffect(() => {
    if (!isWorking) return undefined
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isWorking])

  // 紐づいた Review 自律ワーカーが実行中の間は直近ツールステップを 4 秒ごとに取得する
  const linkedWorkerId = linkedReview && (linkedReview.status === 'running' || linkedReview.status === 'ready') ? linkedReview.id : null
  useEffect(() => {
    if (!linkedWorkerId) {
      setWorkerFeed(null)
      return undefined
    }
    let alive = true
    const load = async () => {
      try {
        const r = await api(`/api/review/${encodeURIComponent(linkedWorkerId)}/worker?limit=8`)
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
  }, [blocks, isWorking, progress, thinking, linkedReview, workerFeed, readonly?.focusId, lastReportKey])

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

  // 会話ごとの既読（会話一覧の行の点。レビュー chat-badge-01 q2=A の「行の点」）。
  useEffect(() => {
    try {
      setSeenMap(readSeenMap(localStorage.getItem(SEEN_MAP_KEY)))
      setSessionSeen(readSessionSeen(localStorage.getItem(SESSION_SEEN_KEY)))
    } catch {
      setSeenMap({})
      setSessionSeen({})
    }
  }, [])

  /** その会話の新着を既読にする（行の点を消す）。 **時刻スキュー対策込み**（D22①）。 */
  const markReportsSeen = useCallback((id) => {
    if (!id) return
    /*
     * サーバ側 `at` が端末時計より先（数秒〜数分）だと `Date.now()` だけを書いても
     * `at <= seen` が偽のままになり緑の件数バッジが消えない（実機 I9③）。
     * その会話に届いている最新 `at` との大きい方を既読時刻にする。
     */
    const latestAt = maxReportAtFor(chatReportsRef.current, id)
    setSeenMap((prev) => {
      const next = setSeen(prev, id, Math.max(Date.now(), latestAt))
      try {
        localStorage.setItem(SEEN_MAP_KEY, JSON.stringify(next))
      } catch {
        /* 保存できなくても表示は続ける */
      }
      return next
    })
  }, [])

  /**
   * その会話を「見た」にする（返信新着のピルを消す・SPEC-PILOT-V3 §3.1 / D16②）。
   * `messageCount` が読めないときは前の記録を保つ（数を捏造すると新着が消えなくなる）。
   */
  const markSessionRead = useCallback((sessionId, messageCount) => {
    if (!sessionId) return
    setSessionSeen((prev) => {
      const next = markSessionSeen(prev, sessionId, messageCount, Date.now())
      try {
        localStorage.setItem(SESSION_SEEN_KEY, serializeSessionSeen(next))
      } catch {
        /* 保存できなくても表示は続ける */
      }
      return next
    })
  }, [])
  markReadRef.current = markSessionRead

  // 初回の一覧読み込みで、初見の会話をベースライン登録する
  // （しないと起動直後に全会話が返信新着として一斉に点く）。
  // さらに**表示中の会話**は一覧の `message_count` 増加に追従させて既読を進める（D22①）。
  // ここが無いと、開いている会話の増分が記録されず、別会話へ移った瞬間に NEW / +N が戻る。
  useEffect(() => {
    if (!sessions.length) return
    setSessionSeen((prev) => {
      const stamp = Date.now()
      const boot = bootstrapSessionSeen(prev, sessions, stamp)
      const next =
        active && activeDrawerSid ? syncActiveSessionSeen(boot, sessions, activeDrawerSid, stamp) : boot
      try {
        localStorage.setItem(SESSION_SEEN_KEY, serializeSessionSeen(next))
      } catch {
        /* noop */
      }
      return next
    })
  }, [sessions, active, activeDrawerSid])

  // 復帰（スリープ・タブ切替）の合図や Review 送信直後に会話一覧と Architect 進行バーを取り直す。
  useEffect(() => {
    const onWake = () => {
      const rpcNow = sockRef.current?.rpc
      if (rpcNow) loadSessions(rpcNow)
      loadSpecJobs()
    }
    window.addEventListener(HM_EVENTS.WAKE_SYNC, onWake)
    return () => window.removeEventListener(HM_EVENTS.WAKE_SYNC, onWake)
  }, [loadSessions, loadSpecJobs])

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
    const stamp = Date.now()
    setSessionSeen((prev) => {
      const next = markAllSessionsSeen(prev, sessions, stamp)
      try {
        localStorage.setItem(SESSION_SEEN_KEY, serializeSessionSeen(next))
      } catch {
        /* noop */
      }
      return next
    })
    setSeenMap((prev) => {
      const next = markAllReportsSeenMap(prev, chatReportsRef.current, stamp)
      try {
        localStorage.setItem(SEEN_MAP_KEY, JSON.stringify(next))
      } catch {
        /* noop */
      }
      return next
    })
  }, [sessions])

  const unreadIds = useMemo(() => unreadSessions(chatReports, seenMap), [chatReports, seenMap])
  const otherUnreads = useMemo(
    () => otherUnreadReports(chatReports, seenMap, currentIds),
    [chatReports, seenMap, currentIds],
  )

  /**
   * 会話一覧に宛先が無いパイプライン完了レポート（ドロワーに専用行として出す）。
   *
   * worker / UI セッション宛ての報告は `/api/sessions` に現れないため、これが無いと
   * 「どの会話に報告が入ったのか」を UI から辿れない（実機フィードバック）。
   */
  /** 直近 24 時間のパイプライン報告（会話一覧に居る場合の📋印用・既読でも残す）。 */
  const recentPipelines = useMemo(() => recentPipelineReports(chatReports), [chatReports])
  /** 未読のパイプライン報告（会話一覧に宛先が無いものだけを「専用行」として出す）。 */
  const unseenPipelines = useMemo(() => unseenPipelineReports(chatReports, seenMap), [chatReports, seenMap])
  const drawerOrphanReports = useMemo(
    () => orphanPipelineReports(unseenPipelines, (sessions ?? []).map((x) => x.id)),
    [unseenPipelines, sessions],
  )
  /** パイプライン報告が届いている会話 ID（一覧に居る場合の📋印用）。 */
  const pipelineSessionIds = useMemo(
    () => new Set(recentPipelines.map((r) => String(r.sessionId))),
    [recentPipelines],
  )

  /** 会話ごとの未読完了報告の**件数**（ドロワーの行に数字のピルを出す・D16②）。 */
  const unreadReportMap = useMemo(() => {
    const map = {}
    for (const r of Array.isArray(chatReports) ? chatReports : []) {
      const sid = String(r?.sessionId ?? '')
      const at = Number(r?.at)
      if (!sid || !Number.isFinite(at)) continue
      if (at <= (Number(seenMap[sid]) || 0)) continue
      map[sid] = (map[sid] || 0) + 1
    }
    return map
  }, [chatReports, seenMap])

  /** ドロワーの行に出すバッジ（未読完了・返信新着・実行中・表示中）を 1 回で組む。 */
  const sessionBadges = useMemo(() => {
    const live = new Set(
      (Array.isArray(liveTurns) ? liveTurns : []).map((t) => String(t?.sessionId ?? '')).filter(Boolean),
    )
    const out = {}
    for (const s of Array.isArray(sessions) ? sessions : []) {
      out[`${s.profile ?? 'default'}:${s.id}`] = sessionRowBadges({
        session: s,
        unreadReportMap,
        seenMap: sessionSeen,
        activeDrawerSid,
        liveSessionIds: live,
      })
    }
    return out
  }, [sessions, unreadReportMap, sessionSeen, activeDrawerSid, liveTurns])

  /** `≡` に出す未読会話数（完了報告の未読＋別会話の返信新着のユニーク数）。 */
  const drawerUnread = useMemo(() => countDrawerUnread(Object.values(sessionBadges)), [sessionBadges])

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
        notify(t('chat.maxAttachments'))
        return
      }
      for (const raw of picked.slice(0, room)) {
        const isImage = (raw.type || '').startsWith('image/')
        const limit = isImage ? 10 * 1024 * 1024 : 25 * 1024 * 1024
        if (raw.size > limit) {
          notify(
            t('chat.tooLarge', {
              name: raw.name || t('chat.fileFallback'),
              mb: Math.round(limit / 1048576),
            }),
          )
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
      if (!navigator.clipboard?.read) throw new Error(t('chat.clipReadUnsupported'))
      const items = await navigator.clipboard.read()
      const files = []
      for (const it of items) {
        const type = (it.types ?? []).find((x) => x.startsWith('image/'))
        if (!type) continue
        const blob = await it.getType(type)
        const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1]
        files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }))
      }
      if (!files.length) throw new Error(t('chat.clipNoImage'))
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
      fr.onerror = () => reject(new Error(t('chat.readFailed')))
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
        if (r?.error) throw new Error(t('chat.attachImageFailed', { message: r.error.message }))
      } else {
        const dataUrl = await fileToDataUrl(a.file)
        const r = await rpc('file.attach', { session_id: sessionId, data_url: dataUrl, name: a.name })
        if (r?.error) throw new Error(t('chat.attachFailed', { message: r.error.message }))
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
      const shown = body || (items.length ? t('chat.checkAttachments') : '')

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
        setStoredSid(r?.result?.stored_session_id ?? target ?? null)
        setStoredProfile(profile || DEFAULT_PROFILE)
        if (!target) return failed(t('chat.sessionCreateFailed'))
        writePendingRepo(globalThis.localStorage, null)
        setSid(target)
        setTitle(shown.slice(0, 24))
      }

      const compose = (refs) =>
        refs.length
          ? `${shown}${t('chat.attachmentsHeader')}${refs.map((x) => `- ${x}`).join('\n')}${t('chat.attachInstruction')}`
          : shown

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
      if (r?.error) failed(t('chat.sendFailed', { message: r.error.message }))
      haptic('action')
      celebrate('send', { sfx: t('fx.sfx.send') })
    },
    [text, attached, streaming, sid, rpc, notify, stageAttachments, resumeInto, profile],
  )

  const send = useCallback(() => sendText(), [sendText])

  const interrupt = useCallback(async () => {
    if (!sid) return
    await rpc('session.interrupt', { session_id: sid })
    setStreaming(false)
    setThinking('')
    notify(t('chat.interrupted'))
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
      setTranscriptMeta(null)
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
        notify(t('chat.newChatWith', { target: `${repoLabel(chosen)}${boardSlug ? ` ${sep()} ${boardSlug}` : ''}` }))
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
        const q = new URLSearchParams({ limit: '300', tools: '1' })
        // 他プロファイルの会話は state.db が別なので profile を渡す（読み取り専用で開く）
        if (profile && profile !== 'default') q.set('profile', profile)
        const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
        if (!d.ok) {
          notify(localizeError(d) || t('chat.cannotOpen'))
          return false
        }
        setSid(null)
        setReadonly({
          sessionId,
          focusId: focusId ?? null,
          title: d.title ?? title ?? '',
          profile: profile && profile !== 'default' ? profile : null,
        })
        // 読み取り専用でも開いた＝見た（D16②）。ここで親チャット `storedSid` は触らない
        // （リロード時は最後の通常会話へ戻る既存挙動を保つための境界）。
        // 一覧の `message_count` が古い場合に備え、実際に読んだ数との大きい方を記録する（D22①）。
        const { blocks: folded } = foldTranscriptMessages(d.messages ?? [], toEpochMs)
        markReadRef.current?.(
          sessionId,
          Math.max(
            Number(sessionsRef.current.find((s) => String(s.id) === String(sessionId))?.message_count) || 0,
            Array.isArray(d.messages) ? d.messages.length : 0,
          ),
        )
        setBlocks(folded)
        setTranscriptMeta({
          sessionId,
          profile: profile && profile !== 'default' ? profile : null,
          hasMore: Boolean(d.hasMore),
          oldestId: d.oldestId ?? null,
          loadingMore: false,
        })
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
      setTranscriptMeta(null)
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
        notify(err?.message ? t('chat.openFailed', { message: err.message }) : t('chat.resumeFailed'))
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
      // 開いた会話の新着（レビューの完了報告）は見た扱いにする（行の点を消す）
      markReportsSeen(id)
      if (connRef.current === 'ready') openRef.current?.(id, focusId, prof)
      else pendingOpenRef.current = { id, focusId, profile: prof }
    },
    [markReportsSeen],
  )

  // 検索結果など外側から「このセッションを開く」と指示された場合
  useEffect(() => {
    const onOpen = (e) => openSessionSafe(e?.detail?.id, e?.detail?.messageId ?? null, e?.detail?.profile || 'default')
    window.addEventListener(HM_EVENTS.OPEN_SESSION, onOpen)
    return () => window.removeEventListener(HM_EVENTS.OPEN_SESSION, onOpen)
  }, [openSessionSafe])

  useEffect(() => {
    if (!openRequest?.id) return
    openSessionSafe(openRequest.id, openRequest.messageId ?? null, openRequest.profile || 'default')
    onConsumedOpen?.()
  }, [openRequest, openSessionSafe, onConsumedOpen])

  /*
   * Tasks タブの完走サマリバナー「💬 チャットで次の一手を相談」からの依頼
   * （SPEC-PILOT-V4 §3.3 ③ / D20③）。App が `hm:discuss-pipeline` を受けて渡す。
   *
   *  - 有効なセッション ID … その会話を開いて相談文を置く
   *  - `'__latest__'` / 空 … repo が一致する新しい会話を作って相談文を置く
   * どちらも送信はしない（ユーザーが読んでから 1 タップ）。
   */
  useEffect(() => {
    if (!discussRequest) return undefined
    let alive = true
    const target = String(discussRequest.sessionId ?? '').trim()
    const run = async () => {
      if (target && target !== LATEST_REPORT_ID) {
        const found = sessionsRef.current.find((s) => String(s.id) === target)
        openSessionSafe(target, null, found?.profile || profile || DEFAULT_PROFILE)
      } else {
        const matched = await findRepoByPath(discussRequest.repoPath)
        if (!alive) return
        startSession(
          profile || DEFAULT_PROFILE,
          matched ?? null,
          discussRequest.board ? { slug: discussRequest.board } : null,
        )
      }
      // 送り手（Tasks / レポート一覧）が既に UI 言語で組み立てた文面。ここで言語判定はしない
      prefillComposer(String(discussRequest.prompt ?? '').trim() || t('chat.discussFallback'))
      onConsumedDiscuss?.()
    }
    run()
    return () => {
      alive = false
    }
  }, [
    discussRequest,
    openSessionSafe,
    startSession,
    prefillComposer,
    onConsumedDiscuss,
    profile,
    findRepoByPath,
  ])

  // --- スニペット ---------------------------------------------------------

  /** カーソル位置に挿入（{{...}} は選択状態にする）。 */
  const insertSnippet = useCallback(
    (s, sendNow = false) => {
      setSnippetSheet(false)
      // 1 タップにつき 1 回だけ振動させる（ここで一度だけ鳴らし、先の分岐では鳴らさない）
      haptic('tap')
      // 仕様の種は「文字を流し込む」チップではなく、1 行メモのシートを開く
      if (s?.action === 'seed') {
        setSeedOpen(true)
        return
      }
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
      // 振動は関数の先頭で 1 回だけ（ここで鳴らすと挿入時に 2 回になった・実測）
    },
    [text, sendText],
  )

  /** チャットタブの「更新」: 会話一覧・完了報告・現在開いている会話を最新化する。 */
  const refreshChat = useCallback(async () => {
    emitHmEvent(HM_EVENTS.REFRESH_REPORTS)
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
        notify(r?.error?.message ? t('chat.updateFailed', { message: r.error.message }) : t('chat.updateChatFailed'))
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
        notify(res?.error ?? t('chat.boardCreateFailed'))
        return
      }
      notify(t('chat.boardCreated', { slug: res.board.slug }))
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
   * 新しい会話で選べるプロファイル。
   * 並び順は (1) DEFAULT_PROFILE (2) 'default' (3) 直近利用順 (4) 名前順（SPEC §5.3）。
   * 直近利用順はセッション一覧の最終活動時刻から作る（プロファイル名の決め打ちはしない）。
   */
  const orderedProfiles = useMemo(() => orderProfiles(profiles, sessions, DEFAULT_PROFILE), [profiles, sessions])

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

  /* プロファイル札・リポジトリ札（1 ペインはヘッダ内・2 カラムは左の下端スタック） */
  const chipsNode = (
    <>
      <span
        className={`prof-chip${profile !== DEFAULT_PROFILE ? ' on' : ''}`}
        title={t('chat.profileTitle', { profile })}
      >
        {profile}
      </span>
      {repo ? (
        <button
          className="prof-chip repo-chip"
          title={t('chat.repoTitle', { id: repo.id, path: repo.path })}
          aria-label={t('chat.repoTitleShort', { id: repo.id })}
          onClick={() => {
            haptic('tap')
            openProfileSheet()
          }}
        >
          {repo.id}
        </button>
      ) : null}
    </>
  )

  /* 1 ペインのヘッダ（2 カラムでは出さない: 一覧は左カラムが持つ） */
  const chatHeadNode = (
    <div className="chat-head">
      <button
        className="icon-btn"
        onClick={() => {
          haptic('tap')
          openDrawer()
        }}
        aria-label={drawerUnread ? t('chat.sessionsAria', { n: drawerUnread }) : t('chat.sessions')}
      >
        <Icon name="grid" size={18} />
        {drawerUnread ? (
          <span className="drawer-btn-badge" aria-hidden="true">
            {drawerUnread}
          </span>
        ) : null}
        {!drawerUnread && otherUnreads.length ? <span className="nav-dot done" aria-hidden="true" /> : null}
      </button>
      <span className="chat-title">{title || t('chat.title')}</span>
      {chipsNode}
      {dcLink?.url ? (
        <button
          className="icon-btn dc-icon"
          title={`Discord: ${dcLink.chatName ?? ''}`}
          aria-label={t('chat.discordAria')}
          onClick={() => {
            haptic('tap')
            window.open(dcLink.url, '_blank', 'noopener')
          }}
        >
          <span aria-hidden="true">#</span>
        </button>
      ) : null}
      <RefreshButton variant="icon" ariaLabel={t('chat.refreshChatAria')} onRefresh={refreshChat} />
      <button
        className="icon-btn"
        onClick={() => {
          haptic('tap')
          openProfileSheet()
        }}
        aria-label={t('chat.newChatAria')}
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  )

  /* オフライン・完了レポート・読み取り専用のバナー（Q1=A: 2 カラムでは左の下端へ） */
  const bannerNode = (
    <>
      {/* 切断直後（2秒未満）は出さない */}
      {showBanner ? <div className="banner">{t('chat.recovering')}</div> : null}
      {otherUnreads.length ? (
        <div className="chat-report-banner" role="status">
          <span className="chat-report-banner-text">
            {t('chat.otherReport', {
              label:
                otherUnreads[0].label ||
                otherUnreads[0].taskId ||
                reportSummaryLine(otherUnreads[0], 40) ||
                String(otherUnreads[0].text ?? '').slice(0, 28),
            })}
          </span>
          <button
            type="button"
            className="chat-report-btn primary"
            onClick={() => {
              haptic('tap')
              const u = otherUnreads[0]
              /*
               * 宛先の会話が決まらなかった統合レポート（`__latest__`・§3.2 ②）:
               *  - すでに通常会話を開いている → そのタイムラインへ合流（`reportIdsFor` が載せる）
               *  - まだ開いていない → repo を突き合わせて新しい会話を作る
               * 会話 ID が分かっている通常の報告は従来どおりその会話を開く。
               * **`Open` は移動だけ**（SPEC-enter-enter-discuss-next-ste Q3=A）。相談文を置くのは
               * 到着先のレポートカードの「💬 次の一手を相談」= `discussReport` の役目で、
               * ここで prefill すると「ラベルと動作が違う」「入力欄が勝手に埋まる」になる。
               */
              if (u.sessionId === LATEST_REPORT_ID) {
                const target = storedRef.current ?? sidRef.current
                if (target) {
                  markReportsSeen(LATEST_REPORT_ID)
                  requestAnimationFrame(() => {
                    const el = listRef.current
                    if (el) el.scrollTop = el.scrollHeight
                  })
                  return
                }
                markReportsSeen(LATEST_REPORT_ID)
                findRepoByPath(u.repoPath).then((matched) => {
                  startSession(profile || DEFAULT_PROFILE, matched ?? null, u.board ? { slug: u.board } : null)
                })
                return
              }
              const found = sessions.find((s) => String(s.id) === u.sessionId)
              openSessionSafe(u.sessionId, null, found?.profile || profile || DEFAULT_PROFILE)
            }}
          >
            {t('chat.open')}
          </button>
          <button
            type="button"
            className="chat-report-btn"
            onClick={() => {
              haptic('tap')
              markReportsSeen(otherUnreads[0].sessionId)
            }}
          >
            {t('chat.seen')}
          </button>
        </div>
      ) : null}
      {readonly ? (
        <div className="banner ro">
          {t('chat.readonly')}
          {readonly.profile
            ? t('chat.readonlyProfileSuffix', { profile: readonly.profile })
            : t('chat.readonlyBoardSuffix')}
        </div>
      ) : null}
    </>
  )

  /* タイムライン（両レイアウト共通。右カラムではこれが縦を全部使う） */
  const timelineNode = (
    <>
      {/* 「↓ 最新へ」ピルをスクロール領域の下端に留める箱（spec-chat-jump-pos Q1=A）。
          .chat-scroll の伸長はこの箱が持ち、ピルはこの箱の下端 8px を基準に置く。 */}
      <div className="chat-body">
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
            <Loader label={connState === 'connecting' ? t('chat.connecting') : t('chat.loadingChat')} />
          ) : !blocks.length ? (
            <div className="empty">
              <div>{t('chat.sendToStart')}</div>
              {recentSessions(sessions, profile, 2).length ? (
                <div className="empty-recent" aria-label={t('chat.recentAria')}>
                  <div className="empty-recent-head">{t('chat.recentHead')}</div>
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
          {transcriptMeta?.hasMore && transcriptMeta?.oldestId ? (
            <button
              type="button"
              className="chat-older"
              disabled={transcriptMeta.loadingMore}
              onClick={() => {
                haptic('tap')
                loadOlderTranscript()
              }}
            >
              {transcriptMeta.loadingMore ? t('chat.loadingOlder') : t('chat.loadOlder')}
            </button>
          ) : null}
          {timeline.map((item, itemIdx) => {
            if (item.kind === 'report') {
              const r = item.report
              if (isPipelineReport(r)) {
                // 統合レポートはリッチカード（§3.3 ②）。既定は最新 1 件だけ展開する。
                const ri = reports.findIndex((x) => x.key === r.key)
                const isNewest = ri === reports.length - 1
                const isOpen = r.key in reportOpen ? Boolean(reportOpen[r.key]) : isNewest
                return (
                  <PipelineReportCard
                    key={r.key}
                    report={r}
                    open={isOpen}
                    onToggle={() => {
                      haptic('tap')
                      setReportOpen((prev) => ({ ...prev, [r.key]: !isOpen }))
                    }}
                    onDiscuss={() => discussReport(r)}
                    onReceipt={() => openReportReceipt(r)}
                    onOpenBoard={() => openReportBoard(r)}
                    onCopyCode={copyCode}
                  />
                )
              }
              return (
                <div key={r.key} className="msg report" title={fmtDateTime(r.at)}>
                  <span className="report-body">🖊 {r.text}</span>
                  <button
                    type="button"
                    className="report-link"
                    onClick={() => {
                      haptic('tap')
                      window.dispatchEvent(
                        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
                          detail: { taskId: r.taskId, label: r.label },
                        }),
                      )
                    }}
                  >
                    {t('chat.reviewAndAnnotate')}
                  </button>
                </div>
              )
            }
            const b = item.block
            const i = item.index
            // 配列添字だと履歴を先頭に足したとき開閉状態（expandedTools）がズレる。
            // mid が無いブロックは実体ごとに採番した key を使い、衝突（= 幽霊 DOM）を防ぐ。
            let blockKey = b.mid != null && b.mid !== '' ? `mid-${b.mid}` : blockKeysRef.current.get(b)
            if (!blockKey) {
              blockKeySeqRef.current += 1
              blockKey = `at-${b.at || i}-${blockKeySeqRef.current}`
              blockKeysRef.current.set(b, blockKey)
            }
            return b.role === 'user' ? (
              <div
                key={blockKey}
                data-mid={b.mid}
                className={`msg user${readonly?.focusId && b.mid === readonly.focusId ? ' hit' : ''}`}
              >
                <div className="bubble">
                  {b.images?.length ? (
                    <div className="bubble-imgs">
                      {b.images.map((img, k) =>
                        img.url ? (
                          <span className="bubble-img" key={k}>
                            <img src={img.url} alt={img.name ?? t('chat.attachedImage')} />
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
                  {b.text ? (
                    <button
                      type="button"
                      className="bubble-menu-btn"
                      aria-label={t('chat.bubbleMenuAria')}
                      onClick={(e) => {
                        e.stopPropagation()
                        haptic('tap')
                        setBubbleMenu({ text: b.text, role: 'user', mid: b.mid ?? null })
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : b.role === 'assistant' ? (
              <div
                key={blockKey}
                data-mid={b.mid}
                className={`msg bot${readonly?.focusId && b.mid === readonly.focusId ? ' hit' : ''}`}
              >
                <div className={`bubble${justSettled && itemIdx === timeline.length - 1 ? ' vibe-settle-flash' : ''}`}>
                  {b.tools?.length ? (
                    <details className="msg-tools">
                      <summary>{t('chat.toolsRan', { count: b.tools.length })}</summary>
                      <ToolRows
                        rows={b.tools}
                        prefix={blockKey}
                        expandedMap={expandedTools}
                        onToggle={toggleToolExpand}
                      />
                    </details>
                  ) : null}
                  {b.text ? (
                    <>
                      <MarkdownBody text={b.text} onCopyCode={copyCode} copyLabel={t('chat.copy')} />
                      <button
                        type="button"
                        className="bubble-menu-btn"
                        aria-label={t('chat.bubbleMenuAria')}
                        onClick={(e) => {
                          e.stopPropagation()
                          haptic('tap')
                          setBubbleMenu({ text: b.text, role: 'assistant', mid: b.mid ?? null })
                        }}
                      >
                        <Icon name="more" size={14} />
                      </button>
                    </>
                  ) : b.open ? (
                    <span className="dots">…</span>
                  ) : (
                    ''
                  )}
                </div>
              </div>
            ) : (
              <div key={blockKey} className="msg notice">
                {b.text}
              </div>
            )
          })}
          {isWorking ? (() => {
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
              <div className="thinking thinking-card" data-heat={sec >= 30 ? 'high' : 'normal'} role="status">
                <div className="working-head">
                  <span className="working-dot" aria-hidden="true" />
                  <b className="working-shimmer">Working… {mm}:{ss}</b>
                  <span className="working-meta">
                    {progress.length
                      ? t('chat.toolProgress', { n: progress.length })
                      : activeLiveTurn?.lastTool?.name
                        ? t('chat.lastTool', { name: activeLiveTurn.lastTool.name })
                        : t('chat.thinking')}
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
              </div>
            )
          })() : null}
          {linkedReview ? (
            isWaiting(linkedReview) ? (
              <div className="chat-live-card warn" role="status">
                <div className="chat-live-head">
                  <span className="chat-live-title">
                    {t('chat.reviewLabel', { title: linkedReview.review?.title || linkedReview.title })}
                  </span>
                  <button
                    type="button"
                    className="chat-report-btn primary"
                    onClick={() => {
                      haptic('tap')
                      window.dispatchEvent(
                        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
                          detail: { taskId: linkedReview.id, label: linkedReview.review?.label },
                        }),
                      )
                    }}
                  >
                    {t('chat.openInReview')}
                  </button>
                </div>
                <div className="chat-live-sub">
                  {t('chat.linkedWaiting')}
                </div>
              </div>
            ) : (
              <div className="chat-live-card running" data-heat={linkedReview.status === 'running' ? 'high' : 'normal'} role="status">
                <div className="chat-live-head">
                  <span className="working-dot" aria-hidden="true" />
                  <b className="working-shimmer">
                    {linkedReview.status === 'running' ? t('chat.workerRunning') : t('chat.workerQueued')}
                  </b>
                  <button
                    type="button"
                    className="chat-report-btn"
                    onClick={() => {
                      haptic('tap')
                      window.dispatchEvent(
                        new CustomEvent(HM_EVENTS.OPEN_REVIEW, {
                          detail: { taskId: linkedReview.id, label: linkedReview.review?.label },
                        }),
                      )
                    }}
                  >
                    {t('chat.watchProgress')}
                  </button>
                </div>
                <div className="chat-live-sub">{linkedReview.review?.title || linkedReview.title}</div>
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
                      prefix={`worker-${linkedReview.id}`}
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
            className={`chat-jump-bottom${isWorking || linkedReview ? ' active' : ''}`}
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
            {isWorking || linkedReview ? t('chat.jumpLatest') : t('chat.jumpBottomPlain')}
          </button>
        ) : null}
      </div>
    </>
  )

  /* 添付レール（入力欄のすぐ上） */
  const attachNode = (
    <>
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
                aria-label={t('chat.removeAttachment')}
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
    </>
  )

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

  /* 入力欄（読み取り専用のときは .composer-ro） */
  const composerNode = (
    <>
      {readonly ? <div className="composer-ro">{t('chat.readonlyComposer')}</div> : null}
      <div className="composer" style={readonly ? { display: 'none' } : undefined}>
        <button
          className="plus"
          aria-label={t('chat.attachAria')}
          onClick={() => setAttachSheet(true)}
          disabled={streaming}
        >
          <span aria-hidden="true">+</span>
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={t('chat.composerPlaceholder')}
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
            // Enter は改行。送信は丸ボタンと、物理キーボードの Shift+Enter だけ（レビュー enter-key-01）
            if (!shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent?.isComposing })) return
            e.preventDefault()
            send()
          }}
        />
        {streaming ? (
          <button className="send stop" onClick={interrupt} aria-label={t('chat.interrupt')}>
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button
            className="send"
            onClick={send}
            disabled={(!text.trim() && !attached.length) || attachBusy}
            aria-label={t('chat.sendAria')}
          >
            <Icon name="send" size={18} />
          </button>
        )}
      </div>
    </>
  )

  /* 右カラムの最小ヘッダ（タイトル・↻・＋だけ。バナーもチップも置かない） */
  const minimalHeadNode = (
    <div className="chat-split-head">
      <span className="chat-title">{title || t('chat.title')}</span>
      <RefreshButton variant="icon" ariaLabel={t('chat.refreshChatAria')} onRefresh={refreshChat} />
      <button
        className="icon-btn"
        onClick={() => {
          haptic('tap')
          openProfileSheet()
        }}
        aria-label={t('chat.newChatAria')}
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  )

  /* セッション一覧（1 ペインはドロワー・2 カラムは左カラムの上） */
  const sessionListNode = (
    <ChatSessionList
      sessions={sessions}
      sessionBadges={sessionBadges}
      pipelineSessionIds={pipelineSessionIds}
      readonlySessionId={readonly?.sessionId}
      orphanReports={drawerOrphanReports}
      refreshing={drawerRefreshing}
      markDisabled={!drawerUnread && !otherUnreads.length}
      onRefresh={() => refreshDrawerData({ force: true })}
      onMarkAllRead={markAllDrawerRead}
      onOpenOrphan={openOrphanReport}
      onNewChat={openProfileSheet}
      onOpenSession={(s) => openSessionSafe(s.id, null, s.profile ?? 'default')}
    />
  )

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
            <div className="chat-split-list">{sessionListNode}</div>
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
        <Sheet title={t('chat.attachSheetTitle')} onClose={() => setAttachSheet(false)}>
          <div className="list">
            <button
              className="list-item"
              onClick={() => {
                setAttachSheet(false)
                imgInputRef.current?.click()
              }}
            >
              <span style={{ flex: 1 }}>
                <span className="row-title">{t('chat.pickImage')}</span>
                <span className="row-sub" style={{ display: 'block' }}>{t('chat.pickImageSub')}</span>
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
                <span className="row-title">{t('chat.takePhoto')}</span>
                <span className="row-sub" style={{ display: 'block' }}>{t('chat.takePhotoSub')}</span>
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
                <span className="row-title">{t('chat.pickFile')}</span>
                <span className="row-sub" style={{ display: 'block' }}>
                  {t('chat.pickFileSub')}
                </span>
              </span>
              <Icon name="chevron" />
            </button>
            <button className="list-item" onClick={pasteFromClipboard}>
              <span style={{ flex: 1 }}>
                <span className="row-title">{t('chat.fromClipboard')}</span>
                <span className="row-sub" style={{ display: 'block' }}>{t('chat.fromClipboardSub')}</span>
              </span>
              <Icon name="chevron" />
            </button>
            {/* 定型チップ帯を隠したときの入口（SPEC-PILOT-V7 §3.4）。帯があるときは出さない */}
            {!bars.chat ? (
              <button
                className="list-item"
                onClick={() => {
                  setAttachSheet(false)
                  setSnippetSheet(true)
                }}
              >
                <span style={{ flex: 1 }}>
                  <span className="row-title">{t('chat.snippetsFromPlus')}</span>
                  <span className="row-sub" style={{ display: 'block' }}>{t('chat.snippetsFromPlusSub')}</span>
                </span>
                <Icon name="chevron" />
              </button>
            ) : null}
          </div>
          <div className="row-sub" style={{ padding: '12px 6px 18px', lineHeight: 1.7 }}>
            {t('chat.attachNote')}
          </div>
        </Sheet>
      ) : null}

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

      {snippetSheet ? (
        <Sheet title={t('chat.snippetsTitle')} onClose={() => setSnippetSheet(false)}>
          <div className="list">
            {snippets.map((s) => (
              <button key={s.id} className="list-item" onClick={() => insertSnippet(s)}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row-title" style={{ display: 'block' }}>
                    {s.label}
                    {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>{t('chat.bar')}</span> : null}
                    {s.custom ? <span className="pill" style={{ marginLeft: 6 }}>{t('chat.mine')}</span> : null}
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
            {t('chat.snippetNote')}
            {t('chat.snippetCustomNote')}
          </div>
        </Sheet>
      ) : null}

      {profileSheet ? (
        <Sheet
          title={
            repoStep?.kind === 'board'
              ? t('chat.chooseBoard')
              : repoStep?.kind === 'create'
                ? t('chat.createBoard')
                : repoStep?.kind === 'all'
                  ? t('chat.allRepos')
                  : t('chat.newChat')
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
                      {p === DEFAULT_PROFILE ? <span className="prof-chip">{t('chat.defaultChip')}</span> : null}
                      {repoPick === p ? <span className="prof-chip on">{t('chat.selectedChip')}</span> : null}
                    </span>
                    <span className="row-sub">
                      {p === 'default'
                        ? t('chat.usualWork')
                        : p === DEFAULT_PROFILE
                          ? t('chat.thisDeviceDefault')
                          : t('chat.profileSuffix', { p })}
                    </span>
                  </span>
                  <Icon name={repoPick === p ? 'check' : 'chevron'} size={16} />
                </button>
              ))}

              <div className="sec">{t('chat.repoSection')}</div>
              {pinned.rows.map((r) => (
                <button
                  key={r.id}
                  className={`row${lastRepo === r.id ? ' on' : ''}`}
                  onClick={() => pickRepo(r)}
                  title={t('chat.repoRowTitle', { label: r.label, path: r.path })}
                >
                  <span className="row-main">
                    <span className="row-title">
                      {repoLabel(r)}
                      {lastRepo === r.id ? <span className="prof-chip">{t('chat.lastChip')}</span> : null}
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
                  {t('chat.reposLoading')}
                </div>
              ) : null}
              {pinned.hidden > 0 ? (
                <button className="row" onClick={() => setRepoStep({ kind: 'all' })}>
                  <span className="row-main">
                    <span className="row-title">{t('chat.allReposRow')}</span>
                    <span className="row-sub">
                      {t('chat.reposHidden', { n: pinned.hidden, total: pinned.total })}
                    </span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ) : null}
              <button className="row" onClick={() => startSession(repoPick, null, null)}>
                <span className="row-main">
                  <span className="row-title">{t('chat.noRepo')}</span>
                  <span className="row-sub">{t('chat.noRepoSub')}</span>
                </span>
                <Icon name="chevron" size={16} />
              </button>
              <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
                {t('chat.pickProfileThenRepo')}
                {t('chat.boardBecomesDefault')}
              </div>
            </>
          ) : null}

          {repoStep?.kind === 'all' ? (
            <>
              <div className="sec">{t('chat.allReposSection', { n: repos.length })}</div>
              {repos.map((r) => (
                <button
                  key={r.id}
                  className="row"
                  onClick={() => pickRepo(r)}
                  title={t('chat.repoRowTitle', { label: r.label, path: r.path })}
                >
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
              <div className="sec">{t('chat.repoBoards', { repo: repoLabel(repoStep.repo) })}</div>
              {(repoStep.repo.boards ?? []).map((b) => (
                <button key={b.slug} className="row" onClick={() => startSession(repoPick, repoStep.repo, b)}>
                  <span className="row-main">
                    <span className="row-title">{b.name || b.slug}</span>
                    <span className="row-sub">
                      {b.slug}
                      {b.current ? t('chat.currentBoard') : ''}
                    </span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
              <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
                {t('chat.boardPickNote', { n: repoStep.repo.boards.length })}
              </div>
            </>
          ) : null}

          {repoStep?.kind === 'create' ? (
            <>
              <div className="sec">{t('chat.noBoardsSection')}</div>
              <div className="row-sub" style={{ padding: '6px 6px 12px', lineHeight: 1.7 }}>
                {t('chat.noBoardsBody', { repo: repoLabel(repoStep.repo) })}
              </div>
              <button className="row" onClick={createRepoBoard} disabled={repoBusy} aria-busy={repoBusy}>
                <span className="row-main">
                  <span className="row-title">
                    {repoBusy ? t('chat.creating') : t('chat.createBoardRow', { id: repoStep.repo.id })}
                  </span>
                  <span className="row-sub">{repoStep.repo.path}</span>
                </span>
                <Icon name="check" size={16} />
              </button>
              <button className="row" onClick={() => setRepoStep(null)}>
                <span className="row-main">
                  <span className="row-title">{t('chat.dontCreate')}</span>
                  <span className="row-sub">{t('chat.dontCreateSub')}</span>
                </span>
                <Icon name="chevron" size={16} />
              </button>
            </>
          ) : null}
        </Sheet>
      ) : null}

      {drawer ? (
        <Sheet title={t('chat.drawerTitle')} onClose={() => setDrawer(false)}>
          {sessionListNode}
        </Sheet>
      ) : null}

      {receiptCtx ? (
        <MissionReceiptSheet
          board={receiptCtx.board}
          spec={receiptCtx.spec}
          onClose={() => setReceiptCtx(null)}
          notify={notify}
        />
      ) : null}

      {bubbleMenu ? (
        <Sheet title={t('chat.bubbleMenuTitle')} onClose={() => setBubbleMenu(null)}>
          <div className="bubble-menu-preview">{bubbleMenu.text.slice(0, 180)}</div>
          <div className="pick-list">
            <button
              type="button"
              className="pick-item"
              onClick={async () => {
                try {
                  await navigator.clipboard?.writeText?.(bubbleMenu.text)
                  notify?.(t('chat.bubbleCopied'))
                } catch {
                  notify?.(t('chat.bubbleCopied'))
                }
                setBubbleMenu(null)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">{t('chat.bubbleCopy')}</span>
              </span>
            </button>
            <button
              type="button"
              className="pick-item"
              onClick={async () => {
                const firstLine = bubbleMenu.text.split('\n').map((s) => s.trim()).find(Boolean) || ''
                await api('/api/memos', {
                  method: 'POST',
                  body: {
                    title: firstLine.slice(0, 60),
                    body: bubbleMenu.text,
                    tags: ['clip'],
                    kind: 'clip',
                    color: bubbleMenu.role === 'user' ? 'teal' : 'default',
                    source: {
                      chatId: sid || undefined,
                      chatTitle: title || undefined,
                      board: repo?.board || undefined,
                      repo: repo?.id || undefined,
                      mid: bubbleMenu.mid ? String(bubbleMenu.mid) : undefined,
                    },
                  },
                })
                emitHmEvent(HM_EVENTS.MEMOS_CHANGED)
                celebrate('approve')
                notify?.(t('chat.bubbleSavedMemo'))
                setBubbleMenu(null)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">{t('chat.bubbleSaveMemo')}</span>
              </span>
            </button>
            <button
              type="button"
              className="pick-item"
              onClick={() => {
                const seed = bubbleMenu.text.slice(0, 600)
                setBubbleMenu(null)
                window.dispatchEvent(
                  new CustomEvent(HM_EVENTS.OPEN_SEED, {
                    detail: { seed, repo: repo?.path, board: repo?.board },
                  }),
                )
              }}
            >
              <span className="pick-main">
                <span className="pick-title">{t('chat.bubbleToSeed')}</span>
              </span>
            </button>
          </div>
          {!readonly ? (
            <>
              <div className="list-head" style={{ marginTop: 12 }}>
                {t('chat.bubbleContinueHead')}
              </div>
              <div className="pick-list">
                {[
                  { label: t('chat.bubbleSummarize'), key: 'chat.bubbleSummarizePrompt' },
                  { label: t('chat.bubbleBrainstorm'), key: 'chat.bubbleBrainstormPrompt' },
                  { label: t('chat.bubbleDig'), key: 'chat.bubbleDigPrompt' },
                ].map((act) => (
                  <button
                    key={act.key}
                    type="button"
                    className="pick-item"
                    onClick={() => {
                      const quote = bubbleMenu.text.slice(0, 600).replace(/\n+/g, '\n> ')
                      setBubbleMenu(null)
                      sendText(t(act.key, { quote }))
                    }}
                  >
                    <span className="pick-main">
                      <span className="pick-title">{act.label}</span>
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="pick-item"
                  onClick={() => {
                    const quote = bubbleMenu.text.slice(0, 320).replace(/\n+/g, '\n> ')
                    setText((cur) => (cur ? `${cur}\n> ${quote}\n\n` : `> ${quote}\n\n`))
                    setBubbleMenu(null)
                    setTimeout(() => taRef.current?.focus(), 60)
                  }}
                >
                  <span className="pick-main">
                    <span className="pick-title">{t('chat.bubbleQuote')}</span>
                  </span>
                </button>
              </div>
            </>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  )
}
