/**
 * 「＋ 注釈」シート（`ReviewPane.jsx` から切り出し）。
 * 端末の画像 / library から注釈タスクを作る。対象リポジトリの記憶は `lib/repoPicker.js`。
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '../../api.js'
import { Sheet } from '../../components/Ui.jsx'
import { haptic } from '../../lib/haptic.js'
import { readActiveChatId } from '../../lib/chatReports.js'
import { rememberReviewRepo } from '../../lib/repoPicker.js'
import { capturedLabel, repoLabel } from '../../lib/reviewView.js'
import { t } from '../../i18n/lang.js'
import { useI18n } from '../../i18n/index.js'

/** 端末画像を長辺1600px / JPEG 0.85 に縮小して dataURL にする。 */
function downscaleFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight)
      const scale = Math.min(1, 1600 / long)
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(t('review.imageLoadFailed')))
    }
    img.src = url
  })
}

/** 「＋ 注釈」シートを開く前から候補と対象リポジトリを先読みしておくキャッシュ。 */
let cachedAnnoLibrary = null
let cachedAnnoTargets = null

export function prefetchAnnotationData() {
  return Promise.allSettled([
    api('/api/review/library?limit=36').then((r) => {
      cachedAnnoLibrary = r.items || []
      return cachedAnnoLibrary
    }),
    api('/api/review/targets').then((r) => {
      cachedAnnoTargets = r.targets || []
      return cachedAnnoTargets
    }),
  ])
}

/**
 * 注釈の対象を id か path で引く（SPEC-ver-0-2-1 §2.1・大小文字は無視）。
 *
 * 保存しているのは repo の **id**、`ReadOnlyDetail` から来るのは **path** なので、
 * 片方だけ照合すると「シートを開くたび空に戻る」が再発する。規則は 1 箇所だけに置く。
 *
 * @param {Array<{id: string, path: string}>} list `/api/review/targets` の応答
 * @param {string|null|undefined} want id または path
 * @returns {object|null} 一致した対象
 */
function findTarget(list, want) {
  const w = String(want ?? '').trim().toLowerCase()
  if (!w || !Array.isArray(list)) return null
  return (
    list.find((x) => String(x?.id ?? '').toLowerCase() === w) ??
    list.find((x) => String(x?.path ?? '').toLowerCase() === w) ??
    null
  )
}

/** 「＋ 注釈」: 端末の画像 / library・直近スクショ から注釈タスクを作る。 */
export function NewAnnotationSheet({ onCreated, onClose, notify, initialTarget = '' }) {
  const { t } = useI18n()
  const [items, setItems] = useState(() => cachedAnnoLibrary)
  const [targets, setTargets] = useState(() => cachedAnnoTargets || [])
  const [target, setTarget] = useState(() => {
    const hit = findTarget(cachedAnnoTargets, initialTarget)
    return hit?.path || cachedAnnoTargets?.[0]?.path || ''
  })
  const [repoOnly, setRepoOnly] = useState(Boolean(initialTarget))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [targetOpen, setTargetOpen] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    let alive = true
    api('/api/review/library?limit=36')
      .then((r) => {
        const list = r.items || []
        cachedAnnoLibrary = list
        if (alive) setItems(list)
      })
      .catch((e) => {
        if (!alive) return
        if (!cachedAnnoLibrary) setItems([])
        setError(e?.message || t('review.listFailed'))
      })
    api('/api/review/targets')
      .then((r) => {
        const list = r.targets || []
        cachedAnnoTargets = list
        if (!alive) return
        setTargets(list)
        const hit = findTarget(list, initialTarget)
        // 既定は指定リポジトリまたは先頭候補（サーバ側で先頭に並ぶ）
        setTarget((prev) => prev || hit?.path || list[0]?.path || '')
      })
      .catch(() => {
        if (alive && !cachedAnnoTargets) setTargets([])
      })
    return () => {
      alive = false
    }
  }, [initialTarget])

  async function create(body) {
    setBusy(true)
    setError(null)
    try {
      // 起票元の会話（完了報告を戻す宛先 `chat=`）。新規会話未送信中でも直前の会話 ID を引き継ぐ。
      const chat = readActiveChatId()
      const r = await api('/api/review/annotation/new', { method: 'POST', body: { ...body, chat } })
      if (!r?.ok) throw new Error(r?.message || t('review.createFailed'))
      // 対象が確定したので覚える（次にシートを開いたとき同じリポジトリから始まる）
      const chosen = findTarget(targets, body?.target)
      if (chosen?.id) rememberReviewRepo(globalThis.localStorage, chosen.id)
      notify?.(t('review.createdAnno', { image: r.image }))
      onCreated?.(r)
    } catch (e) {
      setError(e?.message || t('review.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function onPick(ev) {
    const f = ev.target.files?.[0]
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      const dataUrl = await downscaleFile(f)
      await create({ source: 'upload', image: dataUrl, title: f.name.replace(/\.[a-z]+$/i, ''), slug: f.name, target })
    } catch (e) {
      setError(e?.message || t('review.importFailed'))
      setBusy(false)
    }
  }

  const selectedTarget = targets.find((tg) => tg.path === target) || null
  const shownItems =
    repoOnly && selectedTarget && items
      ? items.filter((it) => it.repo?.id === selectedTarget.id)
      : items

  return (
    <Sheet title={t('review.newAnnoTitle')} onClose={onClose}>
      <div className="ak-new">
        <div className="list-head">{t('review.sourceDevice')}</div>
        <button className="btn primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t('review.pickFromDevice')}
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        {targets.length ? (
          <>
            <div className="list-head" style={{ marginTop: 4 }}>{t('review.target')}</div>
            <button
              type="button"
              className="pick-item spec-now"
              aria-expanded={targets.length > 1 ? targetOpen : undefined}
              onClick={() => {
                if (targets.length <= 1) return
                haptic('tap')
                setTargetOpen((v) => !v)
              }}
            >
              <span className="pick-main">
                <span className="pick-title">
                  {selectedTarget
                    ? t('review.targetOption', { label: selectedTarget.label, id: selectedTarget.id })
                    : t('review.target')}
                </span>
                <span className="pick-sub">{t('review.target')}</span>
              </span>
              <span className="pick-meta">
                {targets.length > 1 ? `${targets.length}` : null}
                {targets.length > 1 ? <span aria-hidden="true">{targetOpen ? '▴' : '▾'}</span> : null}
              </span>
            </button>
            {targetOpen && targets.length > 1 ? (
              <div className="pick-list spec-accordion" role="listbox" aria-label={t('review.target')}>
                {targets
                  .filter((tg) => tg.path !== target)
                  .map((tg) => (
                    <button
                      key={tg.path}
                      type="button"
                      className="pick-item"
                      onClick={() => {
                        haptic('tap')
                        setTarget(tg.path)
                        setTargetOpen(false)
                      }}
                    >
                      <span className="pick-main">
                        <span className="pick-title">
                          {t('review.targetOption', { label: tg.label, id: tg.id })}
                        </span>
                      </span>
                      <span className="pick-meta" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
              </div>
            ) : null}
          </>
        ) : null}
        <div className="list-head" style={{ marginTop: 4 }}>{t('review.sourceLibrary')}</div>
        {selectedTarget && items?.length ? (
          <div className="chips" style={{ padding: 0 }}>
            <button
              type="button"
              className={`chip${repoOnly ? ' on' : ''}`}
              onClick={() => {
                haptic('tap')
                setRepoOnly(true)
              }}
            >
              {t('review.onlyRepo', { id: selectedTarget.id })}
            </button>
            <button
              type="button"
              className={`chip${!repoOnly ? ' on' : ''}`}
              onClick={() => {
                haptic('tap')
                setRepoOnly(false)
              }}
            >
              {t('review.all')}
            </button>
          </div>
        ) : null}
        {error ? <div className="ak-error">{error}</div> : null}
        <div className="ak-new-sub">{t('review.librarySub', { n: shownItems ? shownItems.length : '…' })}</div>
        {shownItems && !shownItems.length ? (
          <div className="ak-worker-empty">
            {repoOnly ? t('review.repoEmpty') : t('review.libraryEmpty')}
          </div>
        ) : null}
        <div className="ak-new-grid">
          {(shownItems || []).map((it) => (
            <button
              key={it.path}
              type="button"
              className="ak-new-item"
              disabled={busy}
              onClick={() => create({ source: it.source === 'capture' ? 'capture' : 'library', path: it.path, title: it.name.replace(/^\d{8}-\d{4}-/, '').replace(/\.[a-z]+$/i, ''), target })}
            >
              <span className="ak-new-thumb">
                <img src={`/api/review/library/file?path=${encodeURIComponent(it.path)}`} alt="" loading="lazy" />
                <span className="ak-new-tag">{it.source}</span>
              </span>
              {/* 取得日時とリポジトリ名: 同じ画面のショットが並ぶので、これが無いと選べない */}
              <span className="ak-new-cap">
                <span className="ak-new-when">{capturedLabel(it.mtime)}</span>
                <span className="ak-new-repo" title={`${repoLabel(it.repo)} · ${it.path}`}>
                  {repoLabel(it.repo)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="ak-hint">{t('review.newAnnoHint')}</p>
      </div>
    </Sheet>
  )
}
