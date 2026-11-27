/**
 * 会話を開く経路（新規会話・resume・`openRequest` の消費・更新・ボード作成・
 * リポジトリ選択）を `ChatPane.jsx` から切り出した（`docs/SPEC-COHERENCE-SWEEP-3.md`
 * §3.3 / Batch CSW3-4）。
 *
 * 移動のみ: 値・文字列・分岐・順序は変えていない。
 * - `openRequest` は `openSessionSafe(...)` → `onConsumedOpen?.()` の順
 * - `discussRequest` は「会話を開く → 相談文を置く → `onConsumedDiscuss?.()`」の順
 * （props 契約テストはキー集合しか見ないので、順序はこのファイルで担保する）
 *
 * state の持ち主は `ChatPane.jsx` のまま。`sid` / `blocks` / `readonly` は
 * タイムライン・入力欄・完了報告の突き合わせが同じ値を読むので、所有者を 2 つに割らない
 * （`useChatComposer` と同じ型で、setter を受け取るだけのフックにする）。
 */

import { useCallback, useEffect } from 'react'
import { api } from '../../api.js'
import { defaultBoard, matchRepoByCwd, rememberRepo, repoLabel, writePendingRepo } from '../../lib/repoPicker.js'
import { foldTranscriptMessages } from '../../lib/toolProgress.js'
import { LATEST_REPORT_ID, toEpochMs } from '../../lib/chatReports.js'
import { sep } from '../../lib/format.js'
import { HM_EVENTS, emitHmEvent } from '../../contracts/events.js'
import { localizeError, t } from '../../i18n/lang.js'

/**
 * @param {object} args
 * @param {(msg: string) => void} args.notify 失敗を利用者に伝える
 * @param {(method: string, params?: object) => Promise<any>} args.rpc ソケットの RPC
 * @param {Array} args.sessions 会話一覧
 * @param {{current: any}} args.sessionsRef
 * @param {{current: string|null}} args.storedRef
 * @param {{current: string|null}} args.sidRef
 * @param {{current: string}} args.connRef 接続状態
 * @param {{current: any}} args.sockRef
 * @param {{current: any}} args.openRef ready 後に開く会話（`onReady` が読む）
 * @param {{current: any}} args.pendingOpenRef 接続前に予約した「開く」
 * @param {{current: Array}} args.reposRef
 * @param {object|null} args.repoStep 新規会話シートの段
 * @param {boolean} args.repoBusy ボード作成中
 * @param {string} args.repoPick シートで選択中のプロファイル
 * @param {string} args.profile いま話しているプロファイル
 * @param {string} args.pilotDefault 既定プロファイル
 * @param {boolean} args.streaming 応答が流れているか
 * @param {object|null} args.readonly 読み取り専用で開いている会話
 * @param {object|null} args.openRequest 外から「この会話を開く」と頼まれた分
 * @param {() => void} [args.onConsumedOpen]
 * @param {object|null} args.discussRequest 「次の一手を相談」の依頼
 * @param {() => void} [args.onConsumedDiscuss]
 * @param {(prompt: string) => void} args.prefillComposer 相談文を入力欄へ置く
 * @param {(mid: string) => void} args.scrollToHit ヒット発言へ寄せる
 * @param {(id: string) => void} args.markReportsSeen 完了報告を既読にする
 * @param {(id: string, n?: number) => void} args.markSessionRead 会話を既読にする
 * @param {(sid: string, prof?: string) => void} args.hydrateTranscriptTools
 * @param {(rpc: any) => Promise<Array>} args.loadSessions
 * @param {(v: string|null) => void} args.setSid
 * @param {(v: string|null) => void} args.setStoredSid
 * @param {(v: string) => void} args.setTitle
 * @param {(v: any) => void} args.setBlocks
 * @param {(v: object|null) => void} args.setTranscriptMeta
 * @param {(v: any) => void} args.setUsage
 * @param {(v: object|null) => void} args.setReadonly
 * @param {(v: string) => void} args.setProfile
 * @param {(v: string) => void} args.setStoredProfile
 * @param {(v: any) => void} args.setRepo
 * @param {(fn: (prev: Array) => Array) => void} args.setRepos
 * @param {(v: string) => void} args.setRepoPick
 * @param {(v: object|null) => void} args.setRepoStep
 * @param {(v: boolean) => void} args.setRepoBusy
 * @param {(v: boolean) => void} args.setDrawer 一覧ドロワー
 * @param {(v: boolean) => void} args.setProfileSheet 新規会話シート
 * @param {(v: boolean) => void} args.setLoadingChat 会話の読み込み中
 */
export function useChatSession({
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
  setSid,
  setStoredSid,
  setTitle,
  setBlocks,
  setTranscriptMeta,
  setUsage,
  setReadonly,
  setProfile,
  setStoredProfile,
  setRepo,
  setRepos,
  setRepoPick,
  setRepoStep,
  setRepoBusy,
  setDrawer,
  setProfileSheet,
  setLoadingChat,
}) {
  /** リポジトリ一覧（`force` で最新スキャン、通常はキャッシュ）。 */
  const ensureRepos = useCallback(async ({ force = false } = {}) => {
    if (!force && reposRef.current.length) return reposRef.current
    try {
      const d = await api(force ? '/api/repos?fresh=1' : '/api/repos')
      const list = Array.isArray(d?.repos) ? d.repos : []
      setRepos(list)
      return list
    } catch {
      return force ? reposRef.current : []
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
        markSessionRead(
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

  /** 新しい会話を始める（プロファイル + リポジトリ + ボード）。 */
  const startSession = useCallback(
    (prof = pilotDefault, pick = null, board = null) => {
      const next = prof || pilotDefault
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
    [notify, pilotDefault],
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
        markSessionRead(
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
        openSessionSafe(target, null, found?.profile || profile || pilotDefault)
      } else {
        const matched = await findRepoByPath(discussRequest.repoPath)
        if (!alive) return
        startSession(
          profile || pilotDefault,
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
    pilotDefault,
    findRepoByPath,
  ])

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
      const r = await resumeInto(rpcFn, target, profile || pilotDefault)
      if (!r?.ok) {
        notify(r?.error?.message ? t('chat.updateFailed', { message: r.error.message }) : t('chat.updateChatFailed'))
        return false
      }
    }
    return true
  }, [loadSessions, streaming, readonly, loadTranscript, resumeInto, profile, pilotDefault, notify])

  const openProfileSheet = useCallback(() => {
    setDrawer(false)
    setProfileSheet(true)
    setRepoStep(null)
    setRepoPick(profile || pilotDefault)
    // 開くたびに最新リポ一覧を再取得（裏で git init したリポも即反映）
    ensureRepos({ force: true })
  }, [profile, pilotDefault, ensureRepos])

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
    // startSession はこのフックの引数（依存は毎回同じ）
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

  return {
    ensureRepos,
    findRepoByPath,
    resumeInto,
    startSession,
    openSessionSafe,
    refreshChat,
    openProfileSheet,
    pickRepo,
    createRepoBoard,
  }
}
