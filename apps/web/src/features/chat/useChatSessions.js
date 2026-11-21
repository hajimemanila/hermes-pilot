/**
 * チャットのセッション一覧・transcript・既読管理（`ChatPane.jsx` から切り出し）。
 *
 * ここが持つのは「会話一覧（`/api/sessions`）」「表示中の transcript と履歴ページネーション」
 * 「会話ごとの返信新着の既読（`hm.session.seen.v1`）」の 3 つだけ。
 * 会話本体（ソケット・送信・添付・入力欄）は `ChatPane.jsx` に残す。
 *
 * 設計: `review/sheets/chat-tasks-split-01.md` §1 / §10-1（境界①）。
 * 公開 props は変えず、戻り値は従来の変数名をそのまま使えるようにしている。
 *
 * 注意（触る前に読む）:
 * - `loadOlderTranscript` は `prependAnchorRef` + 末尾の `useLayoutEffect` と**セット**で動く。
 *   先頭に古い履歴を足したとき、読んでいた行が動かないよう `scrollTop` を補正する。
 * - 既読の baseline/sync effect（`sessionSeen` の持ち主）はここにある。`active` /
 *   `activeDrawerSid` を引数で受け取るのはそのため。
 * - `isCurrentSession` は ref 経由で読む（親が毎描画インライン関数を渡しても
 *   `hydrateTranscriptTools` の同一性が変わらない＝`socket` のコールバックが再生成されない）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../api.js'
import { foldTranscriptMessages } from '../../lib/toolProgress.js'
import { toEpochMs } from '../../lib/chatReports.js'
import {
  SESSION_SEEN_KEY,
  bootstrapSessionSeen,
  markAllSessionsSeen,
  markSessionSeen,
  readSessionSeen,
  serializeSessionSeen,
  syncActiveSessionSeen,
} from '../../lib/sessionUnread.js'
import { localizeError, t } from '../../i18n/lang.js'

/**
 * @param {object} args
 * @param {(msg: string) => void} args.notify 失敗を利用者に伝える
 * @param {(sessionId: string) => boolean} args.isCurrentSession 画面に出している会話か
 * @param {{current: HTMLElement|null}} args.listRef 発言リストのスクロール要素
 * @param {{current: boolean}} args.stickRef 末尾追従のフラグ（履歴を足す間は止める）
 * @param {boolean} args.active チャットタブが表示中か
 * @param {string|null} args.activeDrawerSid いま見ている会話 ID
 */
export function useChatSessions({ notify, isCurrentSession, listRef, stickRef, active, activeDrawerSid }) {
  const [sessions, setSessions] = useState([])
  const [profiles, setProfiles] = useState([])
  const [blocks, setBlocks] = useState([])
  // 履歴ページネーション（`before=<oldestId>` で遡る）の状態
  const [transcriptMeta, setTranscriptMeta] = useState(null)
  /*
   * 会話ごとの「見た」記録（`{ [sessionId]: { count, at } }`・SPEC-PILOT-V3 §3.1 / D16②）。
   * 完了報告の既読（`seenMap`）とは別物で、こちらは**返信の新着**（message_count の増分）を見る。
   */
  const [sessionSeen, setSessionSeen] = useState({})
  const sessionsRef = useRef([])
  // 過去履歴を先頭に足したときのスクロール基準（layout effect で使い捨てる）
  const prependAnchorRef = useRef(null)
  // `isCurrentSession` は親がインライン関数で渡す想定なので、同一性を ref に逃がす
  const isCurrentRef = useRef(isCurrentSession)
  isCurrentRef.current = isCurrentSession

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

  /** state.db のツール実行履歴を会話ブロックへ復元する（再接続・切替後も足跡を残す）。 */
  const hydrateTranscriptTools = useCallback(async (sessionId, prof = 'default') => {
    if (!sessionId) return
    const profileParam = prof && prof !== 'default' ? prof : null
    try {
      const q = new URLSearchParams({ limit: '300', tools: '1' })
      if (profileParam) q.set('profile', profileParam)
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
      if (!d?.ok || !Array.isArray(d.messages)) return
      if (!isCurrentRef.current?.(sessionId)) return
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
  }, [transcriptMeta, notify, listRef, stickRef])

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
  }, [blocks, listRef])

  // 会話ごとの既読（会話一覧の行の点。レビュー chat-badge-01 q2=A の「行の点」）。
  useEffect(() => {
    try {
      setSessionSeen(readSessionSeen(localStorage.getItem(SESSION_SEEN_KEY)))
    } catch {
      setSessionSeen({})
    }
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

  /**
   * 返信新着（`hm.session.seen.v1`）を一括で既読にする（ドロワー上部の「✓ すべて既読」）。
   * 完了報告（`hm.chatReportSeen`）側は境界② `useChatReports` の担当。
   */
  const markAllSessionsRead = useCallback(() => {
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
  }, [sessions])

  return {
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
  }
}
