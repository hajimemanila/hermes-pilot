import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatSocket } from '../lib/useChatSocket.js'
import { DEFAULT_PROFILE, STORED_PROFILE_KEY, applyDefaultProfile } from '../lib/profile.js'
import { pickResumeTarget, recentSessions } from '../lib/chatResume.js'
import { api } from '../api.js'
import { Icon, Sheet, relTime, fmtBytes } from '../components/Ui.jsx'

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
export function ChatPane({ notify }) {
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
  const [usage, setUsage] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [thinking, setThinking] = useState('')
  const [dcLink, setDcLink] = useState(null)
  // resume できない会話（カンバン作業ログ等）は読み取り専用で表示する
  const [readonly, setReadonly] = useState(null)
  // いま話しているプロファイル（SPEC-PROFILE-CHAT）。既定は DEFAULT_PROFILE（mobile）
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  // 直近の会話のプロファイル（起動時の復元に使う）
  const [storedProfile, setStoredProfile] = useState(DEFAULT_PROFILE)
  const [profiles, setProfiles] = useState([])
  const [profileSheet, setProfileSheet] = useState(false)

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
  const sessionsRef = useRef([])
  const listRef = useRef(null)
  const taRef = useRef(null)
  const stickRef = useRef(true)
  const notifiedOffline = useRef(false)

  sidRef.current = sid
  storedRef.current = storedSid
  storedProfileRef.current = storedProfile

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

  /** サーバのセッションに繋ぎ直す（履歴も置き換える）。`prof` は他プロファイルの時だけ渡す。 */
  const resumeInto = useCallback(async (rpc, target, prof = 'default') => {
    const r = await rpc('session.resume', {
      session_id: target,
      ...(prof && prof !== 'default' ? { profile: prof } : {}),
    })
    const res = r?.result
    if (!res?.session_id) return { ok: false, sid: null, error: r?.error ?? null }
    setSid(res.session_id)
    setStoredSid(res.resumed ?? target)
    setProfile(prof || 'default')
    const msgs = Array.isArray(res.messages) ? res.messages : []
    setBlocks(
      msgs
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text ?? '') }))
        .filter((m) => m.text.trim().length > 0),
    )
    return { ok: true, sid: res.session_id }
  }, [])

  /** 通知の処理。 */
  const onEvent = useCallback((msg) => {
    const type = msg?.params?.type
    const p = msg?.params?.payload ?? {}
    const sidMsg = msg?.params?.session_id
    if (sidMsg && sidRef.current && sidMsg !== sidRef.current) return

    if (type === 'message.start') {
      setStreaming(true)
      setRunStartedAt(Date.now())
      setThinking('')
      setBlocks((prev) => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && last.open && !last.text) return prev
        return [...prev, { role: 'assistant', text: '', open: true }]
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
        else next.push({ role: 'assistant', text: chunk, open: true })
        return next
      })
      return
    }
    if (type === 'message.complete') {
      setRunStartedAt(null)
      setStreaming(false)
      setThinking('')
      setUsage(p.usage ?? null)
      setBlocks((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: p.text ?? last.text, open: false }
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

  useEffect(() => {
    if (!streaming) return undefined
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [streaming])

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
    } catch {
      /* noop */
    }
  }, [])
  useEffect(() => {
    try {
      if (storedSid) localStorage.setItem('hm.storedSid', storedSid)
      else localStorage.removeItem('hm.storedSid')
      localStorage.setItem(STORED_PROFILE_KEY, storedProfile || DEFAULT_PROFILE)
    } catch {
      /* noop */
    }
  }, [storedSid, storedProfile])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // 検索ヒット位置へ寄せるときは末尾スクロールをしない
    if (readonly?.focusId) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks, streaming, readonly?.focusId])

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
          setAttached((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              kind: isImage ? 'image' : 'file',
              name: raw.name || (isImage ? 'image' : 'file'),
              bytes: file.size,
              file,
              preview: isImage ? URL.createObjectURL(file) : null,
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
      if (override == null) setText('')
      setAttached([])
      setStreaming(true)
      setBlocks((prev) => [
        ...prev,
        {
          role: 'user',
          text: shown,
          images: imgs.map((a) => ({ url: a.preview, name: a.name })),
          files: files.map((a) => ({ name: a.name, bytes: a.bytes })),
        },
        { role: 'assistant', text: '', open: true },
      ])

      const failed = (msg) => {
        setStreaming(false)
        notify(msg)
        setBlocks((prev) => [...prev, { role: 'notice', text: msg }])
      }

      let target = sid
      if (!target) {
        const r = await rpc('session.create', {
          title: shown.slice(0, 24),
          ...(profile && profile !== 'default' ? { profile } : {}),
        })
        target = r?.result?.session_id
        setStoredSid(r?.result?.stored_session_id ?? null)
        setStoredProfile(profile || DEFAULT_PROFILE)
        if (!target) return failed('セッションを作成できませんでした')
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
      navigator.vibrate?.(8)
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

  const newSession = useCallback((prof = DEFAULT_PROFILE) => {
    const next = prof || DEFAULT_PROFILE
    setSid(null)
    setStoredSid(null)
    setTitle('')
    setBlocks([])
    setUsage(null)
    setReadonly(null)
    setProfile(next)
    setStoredProfile(next)
    setDrawer(false)
    setProfileSheet(false)
  }, [])

  /** resume できない会話を読み取り専用で開く（カンバン作業ログなど）。 */
  const loadTranscript = useCallback(
    async (sessionId, focusId, title, profile = null) => {
      try {
        const q = new URLSearchParams({ limit: '80' })
        // 他プロファイルの会話は state.db が別なので profile を渡す（読み取り専用で開く）
        if (profile && profile !== 'default') q.set('profile', profile)
        const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`)
        if (!d.ok) {
          notify(d.reason ?? 'この会話は開けません')
          return
        }
        setSid(null)
        setReadonly({
          sessionId,
          focusId: focusId ?? null,
          title: d.title ?? title ?? '',
          profile: profile && profile !== 'default' ? profile : null,
        })
        setBlocks(
          (d.messages ?? []).map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.text,
            mid: m.id,
          })),
        )
        if (d.title || title) setTitle(d.title || title)
        if (focusId) {
          requestAnimationFrame(() => scrollToHit(focusId))
        }
      } catch (e) {
        notify(e.message)
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
  const openSessionSafe = useCallback((id, focusId = null, prof = 'default') => {
    if (!id) return
    if (connRef.current === 'ready') openRef.current?.(id, focusId, prof)
    else pendingOpenRef.current = { id, focusId, profile: prof }
  }, [])

  // 検索結果など外側から「このセッションを開く」と指示された場合
  useEffect(() => {
    const onOpen = (e) => openSessionSafe(e?.detail?.id, e?.detail?.messageId ?? null)
    window.addEventListener('hm:open-session', onOpen)
    return () => window.removeEventListener('hm:open-session', onOpen)
  }, [openSessionSafe])

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
        el.style.height = `${Math.min(140, el.scrollHeight)}px`
      })
      navigator.vibrate?.(6)
    },
    [text, sendText],
  )

  const openProfileSheet = useCallback(() => {
    setDrawer(false)
    setProfileSheet(true)
  }, [])

  const hotSnippets = snippets.filter((s) => s.hot).slice(0, 8)

  /** 新しい会話で選べるプロファイル（既定を先頭・毎回同じ順）。 */
  const orderedProfiles = useMemo(() => {
    const list = profiles.length ? profiles : [DEFAULT_PROFILE]
    const rank = (p) => (p === DEFAULT_PROFILE ? 0 : p === 'default' ? 1 : p === 'nanokvm' ? 2 : 3)
    return [...new Set(list)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }, [profiles])

  return (
    <div className="pane chat" data-conn={connState}>
      <div className="chat-head">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="会話一覧">
          <Icon name="grid" size={18} />
        </button>
        <span className="chat-title">{title || 'チャット'}</span>
        <span
          className={`prof-chip${profile !== DEFAULT_PROFILE ? ' on' : ''}`}
          title={`この会話のプロファイル: ${profile}`}
        >
          {profile}
        </span>
        {dcLink?.url ? (
          <button
            className="icon-btn dc-icon"
            title={`Discord: ${dcLink.chatName ?? ''}`}
            aria-label="Discord のスレッドを開く"
            onClick={() => window.open(dcLink.url, '_blank', 'noopener')}
          >
            <span aria-hidden="true">#</span>
          </button>
        ) : null}
        <button className="icon-btn" onClick={openProfileSheet} aria-label="新しい会話（プロファイルを選ぶ）">
          <Icon name="plus" size={18} />
        </button>
      </div>

      {/* 切断直後（2秒未満）は出さない */}
      {showBanner ? <div className="banner">接続を回復しています…</div> : null}
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
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {!blocks.length ? (
          <div className="empty">
            <div>メッセージを送って開始</div>
            {recentSessions(sessions, profile, 2).length ? (
              <div className="empty-recent">
                {recentSessions(sessions, profile, 2).map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const ok = await resumeInto(sockRef.current?.rpc, x.id, x.profile || profile)
                      if (ok?.ok) setStoredSid(x.id)
                    }}
                  >
                    直前の会話を開く: {(x.title || x.id).slice(0, 18)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {blocks.map((b, i) =>
          b.role === 'user' ? (
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
              <div className="bubble">{b.text || (b.open ? <span className="dots">…</span> : '')}</div>
            </div>
          ) : (
            <div key={i} className="msg notice">
              {b.text}
            </div>
          ),
        )}
        {streaming ? (
          <div className="thinking">
            {(() => {
              const sec = runStartedAt ? Math.max(0, Math.floor((nowTick - runStartedAt) / 1000)) : 0
              const mm = String(Math.floor(sec / 60)).padStart(2, '0')
              const ss = String(sec % 60).padStart(2, '0')
              return (
                <>
                  <b>実行中 {mm}:{ss}</b>
                  <span className="m"> ・ツールを動かしています（結果はこの下に出ます）</span>
                  {thinking ? <div className="thinking-text">{thinking}</div> : null}
                </>
              )
            })()}
          </div>
        ) : null}
        {usage ? (
          <div className="usage">
            in {usage.input ?? 0} / out {usage.output ?? 0}
            {usage.cache_read ? ` / cache ${usage.cache_read}` : ''}
          </div>
        ) : null}
      </div>

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
                onClick={() => setAttached((prev) => prev.filter((x) => x.id !== a.id))}
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
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(120, el.scrollHeight)}px`
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
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
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
        <Sheet title="新しい会話のプロファイル" onClose={() => setProfileSheet(false)}>
          {orderedProfiles.map((p) => (
            <button key={p} className="row" onClick={() => newSession(p)}>
              <span className="row-main">
                <span className="row-title">
                  {p}
                  {p === DEFAULT_PROFILE ? <span className="prof-chip">既定</span> : null}
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
              <Icon name="chevron" size={16} />
            </button>
          ))}
          <div className="row-sub" style={{ padding: '10px 6px 18px', lineHeight: 1.7 }}>
            選んだプロファイルで新しい会話を作ります。既存の会話は一覧から開けば、そのプロファイルのまま続けられます。
          </div>
        </Sheet>
      ) : null}

      {drawer ? (
        <Sheet title="会話" onClose={() => setDrawer(false)}>
          <button className="row" onClick={openProfileSheet}>
            <span className="row-main">
              <span className="row-title">新しい会話</span>
              <span className="row-sub">プロファイルを選んで作る</span>
            </span>
            <Icon name="plus" size={16} />
          </button>
          {sessions.map((s) => {
            const foreign = s.profile && s.profile !== DEFAULT_PROFILE
            return (
              <button
                key={`${s.profile ?? 'default'}:${s.id}`}
                className={`row${s.id === storedSid ? ' on' : ''}`}
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
                <Icon name="chevron" size={16} />
              </button>
            )
          })}
        </Sheet>
      ) : null}
    </div>
  )
}
