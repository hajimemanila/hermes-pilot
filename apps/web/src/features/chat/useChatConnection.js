/**
 * 接続と通知（ソケット 1 本・`ready` の復帰・イベント反映・ドロワー・レポートカードの
 * 操作・検索スクロール・スニペット取得）を `ChatPane.jsx` から切り出した
 * （`docs/SPEC-COHERENCE-SWEEP-3.md` §3.3 / Batch CSW3-5）。
 *
 * 移動のみ: 値・文字列・分岐・順序・依存配列は変えていない。
 * `useChatSocket` の呼び出しはこのファイルの 1 か所だけ。分割で購読が 2 本になると
 * メッセージが二重に出る（同 SPEC §6）。state はこのフックが持ち、`ChatPane` は
 * 戻り値をそのまま描画に使う（開閉フラグや購読を二重に持たない）。
 *
 * 並びは「ソケット → イベント反映 → スクロール追従 → ドロワー → レポートカード」。
 * `onEvent` が `markSessionRead` / `loadSessions` を ref 無しで直接読めるよう、
 * `useChatSessions` の後・`useChatReports` の後に呼ぶ前提（`ChatPane` 側の順序）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatSocket } from '../../lib/useChatSocket.js'
import { api } from '../../api.js'
import { shouldReconnectToast } from '../../lib/netRecovery.js'
import { pickResumeTarget } from '../../lib/chatResume.js'
import { readPendingRepo } from '../../lib/repoPicker.js'
import { mergeProgress } from '../../lib/toolProgress.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { followUpPromptFor } from '../../lib/chatReports.js'
import { refreshSync, setSyncParams, subscribeSync } from '../../lib/syncSources.js'
import { haptic } from '../../lib/haptic.js'
import { t } from '../../i18n/lang.js'
import { DRAWER_REFRESH_THROTTLE_MS, commitProgressToBlocks } from './ChatParts.jsx'

/**
 * @param {object} args
 * @param {(msg: string) => void} args.notify 失敗・状態変化を利用者に伝える
 * @param {string} args.lang いまの UI 言語（相談文の組み立てに使う）
 * @param {boolean} args.active このタブが見えているか
 * @param {string|null} args.sid いま話している会話
 * @param {string|null} args.storedSid 起票元の会話
 * @param {Array} args.liveTurns 稼働中のターン
 * @param {string[]} args.currentIds 画面に出している会話の ID（既読の対象）
 * @param {string[]} args.otherUnreads 他の会話の未読
 * @param {string[]} args.unreadIds 未読の完了報告の宛先（既読にする対象）
 * @param {string|null} args.readonlyFocusId 検索ヒットで寄せる発言
 * @param {Array} args.blocks タイムライン
 * @param {Array} args.progress ツール行
 * @param {string} args.thinking 思考ログ
 * @param {boolean} args.isWorking 応答中か
 * @param {object|null} args.linkedReview 紐づくレビュー
 * @param {string|null} args.lastReportKey 直近の完了報告のキー
 * @param {{current: any}} args.listRef タイムラインのスクロール領域
 * @param {{current: boolean}} args.stickRef 下端追従
 * @param {{current: Array}} args.progressRef 進捗行（`onEvent` が読む）
 * @param {{current: string|null}} args.sidRef
 * @param {{current: string|null}} args.storedRef
 * @param {{current: string}} args.storedProfileRef
 * @param {{current: Array}} args.sessionsRef
 * @param {(rpc: any) => Promise<Array>} args.loadSessions
 * @param {(id: string, n?: number) => void} args.markSessionRead
 * @param {() => void} args.markAllSessionsRead
 * @param {(id: string) => void} args.markReportsSeen
 * @param {() => void} args.markAllReportsRead
 * @param {(mid: string) => void} args.scrollToHit ヒット発言へ寄せる
 * @param {(v: string|null) => void} args.setSid
 * @param {(v: string|null) => void} args.setStoredSid
 * @param {(v: string) => void} args.setTitle
 * @param {(v: any) => void} args.setBlocks
 * @param {(v: any) => void} args.setProgress
 * @param {(v: boolean) => void} args.setStreaming
 * @param {(v: number|null) => void} args.setRunStartedAt
 * @param {(v: string) => void} args.setThinking
 * @param {(v: boolean) => void} args.setThinkingExpanded
 * @param {(v: object|null) => void} args.setUsage
 * @param {(fn: (prev: object) => object) => void} args.setExpandedTools
 * @param {(v: boolean) => void} args.setDrawer
 * @param {(v: object|null) => void} args.setReceiptCtx
 */
export function useChatConnection({
  notify,
  lang,
  active,
  sid,
  storedSid,
  liveTurns,
  currentIds,
  otherUnreads,
  unreadIds,
  readonlyFocusId,
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
}) {
  const [workerFeed, setWorkerFeed] = useState(null)
  const [dcLink, setDcLink] = useState(null)
  // ドロワーの「↻ 更新」の実行中表示（D22③）
  const [drawerRefreshing, setDrawerRefreshing] = useState(false)
  // 定型スニペット
  const [snippets, setSnippets] = useState([])

  const sockRef = useRef(null)
  const openRef = useRef(null)
  const pendingOpenRef = useRef(null)
  const connRef = useRef('idle')
  // `useChatSession`（この位置より後で呼ぶ）が返す `resumeInto` を、それより前で組み立てる
  // `onReady` と入力欄（`useChatComposer`）から呼ぶための入口。呼び出しは必ずマウント後なので、
  // ref から最新の実装を読む（identity は空依存で固定し、フックの再生成を招かない）。
  const resumeRef = useRef(null)
  // ドロワー自動リフレッシュのスロットル（最後に走った時刻・D22②）
  const drawerRefreshAtRef = useRef(0)
  // 稼働中ターン数の前回値（減少＝ワーカー完了で一覧を取り直す・D22②）
  const prevLiveCountRef = useRef(0)
  const notifiedOffline = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active

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
    if (readonlyFocusId) return
    // 進捗行と thinking も「新しい内容」なので追従対象。ここを deps に入れ忘れると
    // ツール行が増えてもスクロールせず、最後の行が下端（入力欄の裏）に隠れる（実測）。
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks, isWorking, progress, thinking, linkedReview, workerFeed, readonlyFocusId, lastReportKey])

  // ヒットした発言が見える位置までスクロール（レイアウト確定後に2回）
  useEffect(() => {
    if (!readonlyFocusId) return
    const a = setTimeout(() => scrollToHit(readonlyFocusId), 120)
    const b = setTimeout(() => scrollToHit(readonlyFocusId), 500)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [readonlyFocusId, blocks.length, scrollToHit])

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

  /**
   * ドロワーの「レポート」行（会話一覧に宛先が無い報告）を開く。
   * 既読にしてから App へ渡し、対象 repo の会話を開いて相談文を置いてもらう。
   */
  const openOrphanReport = useCallback((report) => {
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
  }, [markReportsSeen])

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

  const hotSnippets = snippets.filter((s) => s.hot).slice(0, 8)

  return {
    rpc,
    showBanner,
    connState,
    sockRef,
    openRef,
    pendingOpenRef,
    connRef,
    resumeRef,
    resumeInto,
    workerFeed,
    dcLink,
    drawerRefreshing,
    refreshDrawerData,
    openDrawer,
    markAllDrawerRead,
    copyCode,
    toggleToolExpand,
    openOrphanReport,
    openReportBoard,
    openReportReceipt,
    snippets,
    loadSnippets,
    hotSnippets,
  }
}
