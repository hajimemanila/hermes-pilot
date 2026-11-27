/**
 * 入力欄まわり（添付・送信・定型スニペット）の state とハンドラ（`ChatPane.jsx` から切り出し）。
 *
 * ここが持つのは「入力中の本文」「添付（画像・ファイル）とその取り込み」「添付シート・
 * スニペット一覧シートの開閉」「送信（セッション作成・添付のアップロード・1 度だけ再送）」
 * 「定型文のカーソル位置への挿入」だけ。会話の接続・タイムライン・セッション一覧は
 * `ChatPane.jsx` 側の責務のまま置く。
 *
 * 設計: `docs/SPEC-COHERENCE-SWEEP-3.md` §3.3 / Batch CSW3-2。移動のみで、値・文字列・
 * 分岐・順序は変えていない。state はこのフックが唯一の持ち主で、`ChatPane.jsx` は
 * 戻り値をそのまま使う（開閉フラグを二重に持たない）。
 *
 * 依存は引数で受ける:
 * - 送信はセッションを作り直すことがあるので `sid` / `profile` / `rpc` / `resumeInto` /
 *   `setBlocks` / `storedRef` / `storedProfileRef` が要る。
 * - `taRef` は `prefillComposer` と吹き出しメニューのフォーカスが読む。
 * - `insertSnippet` は定型チップ帯（`actionBarNode`）が読む。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { writePendingRepo } from '../../lib/repoPicker.js'
import { haptic } from '../../lib/haptic.js'
import { celebrate } from '../../lib/vibe.js'
import { t } from '../../i18n/lang.js'
import { fitComposer } from './ChatParts.jsx'

/**
 * @param {object} args
 * @param {(msg: string) => void} args.notify 失敗を利用者に伝える
 * @param {(method: string, params?: object) => Promise<any>} args.rpc ソケットの RPC
 * @param {string|null} args.sid いま開いている会話
 * @param {(v: string|null) => void} args.setSid 会話を差し替える
 * @param {(v: string|null) => void} args.setStoredSid 復元用の会話 id
 * @param {(v: string) => void} args.setStoredProfile 復元用のプロファイル
 * @param {string} args.profile 送信に使うプロファイル
 * @param {string} args.pilotDefault 既定プロファイル
 * @param {boolean} args.streaming 応答が流れているか
 * @param {(v: boolean) => void} args.setStreaming
 * @param {(v: string) => void} args.setThinking 中断時に経過表示を消す
 * @param {(fn: (prev: any[]) => any[]) => void} args.setBlocks タイムラインへ積む
 * @param {(v: string) => void} args.setTitle 会話タイトル
 * @param {{current: string|null}} args.storedRef
 * @param {{current: string}} args.storedProfileRef
 * @param {{current: object|null}} args.repoRef 作業ディレクトリに使うリポジトリ
 * @param {(rpc: any, target: string, prof?: string) => Promise<{ok: boolean, sid?: string}>} args.resumeInto
 * @param {(v: boolean) => void} args.setSeedOpen 仕様の種シート
 */
export function useChatComposer({
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
}) {
  const [text, setText] = useState('')

  // 添付
  const [attached, setAttached] = useState([])
  const [attachSheet, setAttachSheet] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)
  const imgInputRef = useRef(null)
  const camInputRef = useRef(null)
  const fileInputRef = useRef(null)

  // 定型スニペット
  const [snippetSheet, setSnippetSheet] = useState(false)
  const taRef = useRef(null)
  const objectUrlsRef = useRef(new Set())

  // プレビューの object URL は、この箱が消えるときにまとめて解放する
  useEffect(() => {
    const urls = objectUrlsRef.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

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
        setStoredProfile(profile || pilotDefault)
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
    [text, attached, streaming, sid, rpc, notify, stageAttachments, resumeInto, profile, pilotDefault],
  )

  const send = useCallback(() => sendText(), [sendText])

  const interrupt = useCallback(async () => {
    if (!sid) return
    await rpc('session.interrupt', { session_id: sid })
    setStreaming(false)
    setThinking('')
    notify(t('chat.interrupted'))
  }, [sid, rpc, notify])

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

  return {
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
  }
}
