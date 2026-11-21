/**
 * 完了報告（パイプラインの `reports`）の突き合わせ・既読・会話一覧バッジ
 * （`ChatPane.jsx` から切り出し）。
 *
 * ここが持つのは 3 つ:
 * - いま見ている会話に流し込む報告の選別（`reportIds` / `reports` / `timeline`）
 * - 報告の既読（`hm.chatReportSeen`）と未読数の集計（`unreadIds` / `otherUnreads` ほか）
 * - 会話一覧の行バッジ（`unreadReportMap` / `sessionBadges` / `drawerUnread`）
 *
 * 返信の新着（`hm.session.seen.v1`）はここではなく境界① `useChatSessions` が持つ。
 * `sessionBadges` は両方を合成するので、`sessions` / `sessionSeen` を入力で受け取る。
 *
 * 設計: `review/sheets/chat-tasks-split-01.md` §2（境界②）。公開 props は変えず、
 * 戻り値は従来の変数名をそのまま使えるようにしている。
 *
 * 注意（触る前に読む）:
 * - `markReportsSeen` は依存配列を空に保つため `chatReports` を ref 経由で読む
 *   （時刻スキュー吸収に「その会話の最新 at」が要る・D22①）。ref はこのフック内に閉じる。
 * - 報告の既読（`SEEN_MAP_KEY`）と返信新着（境界①）は保存キーが別。読み込み effect も別。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SEEN_MAP_KEY,
  markAllReportsSeenMap,
  maxReportAtFor,
  mergeTimeline,
  orphanPipelineReports,
  otherUnreadReports,
  readSeenMap,
  recentPipelineReports,
  reportIdsFor,
  reportLines,
  setSeen,
  unseenPipelineReports,
  unreadSessions,
} from '../../lib/chatReports.js'
import { drawerUnreadCount, sessionRowBadges } from '../../lib/sessionUnread.js'

/**
 * @param {object} args
 * @param {Array} args.chatReports 全完了報告（親 props）
 * @param {Array} args.blocks 表示中の transcript ブロック（境界①の出力・timeline 合成用）
 * @param {string[]} args.currentIds いま見ている会話 ID
 * @param {object|null} args.readonly 閲覧専用モードの指定（あれば親チャットを混ぜない）
 * @param {string} args.repoPath 選択中リポジトリのパス（`'__latest__'` 宛の突き合わせ用）
 * @param {Array} args.sessions 会話一覧（境界①の出力）
 * @param {object} args.sessionSeen 返信新着の既読（境界①の出力）
 * @param {Array} args.liveTurns 稼働中ターン（実行中バッジ用）
 * @param {string|null} args.activeDrawerSid いま見ている会話 ID（表示中バッジ用）
 */
export function useChatReports({
  chatReports,
  blocks,
  currentIds,
  readonly,
  repoPath,
  sessions,
  sessionSeen,
  liveTurns,
  activeDrawerSid,
}) {
  const [seenMap, setSeenMap] = useState({})
  /*
   * 最新の完了報告を ref でも持つ（SPEC-PILOT-V4 §3.1 / D22①）。
   * `markReportsSeen` を `useCallback([])` のままにするため、依存配列に props を足さずに
   * 最新値を読む。時刻スキューの吸収に「その会話の最新 at」が要る。
   */
  const chatReportsRef = useRef([])
  chatReportsRef.current = Array.isArray(chatReports) ? chatReports : []

  /*
   * 統合レポート（`kind: 'pipeline'`）は「宛先の会話」に加えて、リポジトリが一致する
   * `'__latest__'` 宛の報告も合流させる（§3.2 ② / §3.3 ①）。読み取り専用の閲覧中は
   * 親チャットの報告を混ぜない（`currentIds` と同じ境界）。
   */
  const reportIds = useMemo(
    () => reportIdsFor(currentIds, chatReports, readonly ? '' : repoPath ?? ''),
    [currentIds, chatReports, readonly, repoPath],
  )
  const reports = useMemo(() => reportLines(chatReports, reportIds), [chatReports, reportIds])
  const timeline = useMemo(() => mergeTimeline(blocks, reports), [blocks, reports])
  const lastReportKey = reports.length ? reports[reports.length - 1].key : ''

  const unreadIds = useMemo(() => unreadSessions(chatReports, seenMap), [chatReports, seenMap])
  const otherUnreads = useMemo(
    () => otherUnreadReports(chatReports, seenMap, currentIds),
    [chatReports, seenMap, currentIds],
  )

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
  const drawerUnread = useMemo(() => drawerUnreadCount(Object.values(sessionBadges)), [sessionBadges])

  // 完了報告の既読（会話一覧の行の点）。返信新着側の読み込みは境界①が持つ。
  useEffect(() => {
    try {
      setSeenMap(readSeenMap(localStorage.getItem(SEEN_MAP_KEY)))
    } catch {
      setSeenMap({})
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

  /** 完了報告をまとめて既読にする（「✓ すべて既読」の報告側の半分）。 */
  const markAllReportsRead = useCallback(() => {
    const stamp = Date.now()
    setSeenMap((prev) => {
      const next = markAllReportsSeenMap(prev, chatReportsRef.current, stamp)
      try {
        localStorage.setItem(SEEN_MAP_KEY, JSON.stringify(next))
      } catch {
        /* noop */
      }
      return next
    })
  }, [])

  return {
    seenMap,
    reportIds,
    reports,
    timeline,
    lastReportKey,
    unreadIds,
    otherUnreads,
    unseenPipelines,
    recentPipelines,
    pipelineSessionIds,
    drawerOrphanReports,
    unreadReportMap,
    sessionBadges,
    drawerUnread,
    markReportsSeen,
    markAllReportsRead,
  }
}
