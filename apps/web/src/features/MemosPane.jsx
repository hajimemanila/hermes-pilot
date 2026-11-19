import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, Loader, RefreshButton, Sheet } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'
import { draftSnapshot, hasDraftContent, isDraftDirty } from '../lib/memoDraft.js'
import { memoMenuRows, showsCardButtons, showsListMenu } from '../lib/memoListMenu.js'
import { checklistPreview, readMemosView, rememberMemosView } from '../lib/memoView.js'
import { celebrate } from '../lib/vibe.js'

const COLORS = ['default', 'teal', 'amber', 'violet']

/** 表示切替セグメント（glyph は記号なので翻訳しない・読み上げは i18n）。 */
const VIEW_OPTIONS = [
  { view: 'one', glyph: '1', labelKey: 'notes.viewOne' },
  { view: 'two', glyph: '2', labelKey: 'notes.viewTwo' },
  { view: 'list', glyph: '☰', labelKey: 'notes.viewList' },
]

function parseTagsInput(raw) {
  return String(raw ?? '')
    .split(/[,、\s]+/)
    .map((s) => s.trim().replace(/^#+/, ''))
    .filter(Boolean)
}

export function MemosPane({ notify, onOpenChat }) {
  const { t } = useI18n()
  const [memos, setMemos] = useState([])
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all') // 'all' | 'pinned' | 'report' | `tag:${name}`
  const [quickText, setQuickText] = useState('')
  const [editing, setEditing] = useState(null) // null | memo draft
  const [checkDraft, setCheckDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // 表示モードは端末保存（既定=二列・SPEC §2.2 / Q2=A）
  const [view, setView] = useState(() => readMemosView(typeof localStorage === 'undefined' ? null : localStorage))
  // リスト表示の `⋯` メニューを開いているメモ（null なら閉じている）
  const [menuFor, setMenuFor] = useState(null)
  // 開いた時点の下書きスナップショット（新規は null）と、閉じる前の 3 択の状態
  const [baseline, setBaseline] = useState(null)
  const [confirming, setConfirming] = useState(false)
  // 「戻る」でシートの履歴を積み直すための番号（Sheet の historyKey）
  const [sheetArm, setSheetArm] = useState(0)

  const loadAll = useCallback(async () => {
    try {
      const [mRes, rRes] = await Promise.allSettled([api('/api/memos'), api('/api/chat-reports?limit=20')])
      if (mRes.status === 'fulfilled' && Array.isArray(mRes.value?.memos)) {
        setMemos(mRes.value.memos)
      }
      if (rRes.status === 'fulfilled' && Array.isArray(rRes.value?.reports)) {
        setReports(rRes.value.reports)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
    const onChanged = () => loadAll()
    window.addEventListener('hm:memos-changed', onChanged)
    return () => window.removeEventListener('hm:memos-changed', onChanged)
  }, [loadAll])

  const allTags = useMemo(() => {
    const set = new Set()
    for (const m of memos) {
      for (const tg of m.tags || []) set.add(tg)
    }
    return [...set].slice(0, 12)
  }, [memos])

  const savedReportKeys = useMemo(() => {
    const s = new Set()
    for (const m of memos) {
      if (m.source?.reportKey) s.add(m.source.reportKey)
    }
    return s
  }, [memos])

  const filteredMemos = useMemo(() => {
    const q = query.trim().toLowerCase()
    return memos.filter((m) => {
      if (filter === 'pinned' && !m.pinned) return false
      if (filter === 'report' && m.kind !== 'report') return false
      if (filter.startsWith('tag:')) {
        const tag = filter.slice(4).toLowerCase()
        if (!(m.tags || []).some((x) => x.toLowerCase() === tag)) return false
      }
      if (!q) return true
      const hay = [
        m.title,
        m.body,
        ...(m.tags || []),
        ...(m.checklist || []).map((c) => c.text),
      ]
        .join('\n')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [memos, filter, query])

  const quickCreate = useCallback(async () => {
    const text = quickText.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      const res = await api('/api/memos', {
        method: 'POST',
        body: { title: '', body: text, tags: ['idea'], kind: 'note', color: 'default' },
      })
      if (res?.memo) setMemos((prev) => [res.memo, ...prev])
      setQuickText('')
      celebrate('approve')
      notify?.(t('notes.saved'))
    } catch (e) {
      notify?.(e?.message || 'Error')
    } finally {
      setSaving(false)
    }
  }, [quickText, saving, notify, t])

  const togglePin = useCallback(async (memo, e) => {
    e?.stopPropagation?.()
    haptic('tap')
    const nextPinned = !memo.pinned
    setMemos((prev) => prev.map((m) => (m.id === memo.id ? { ...m, pinned: nextPinned } : m)))
    const res = await api(`/api/memos/${encodeURIComponent(memo.id)}`, {
      method: 'PATCH',
      body: { pinned: nextPinned },
    })
    if (res?.memo) loadAll()
  }, [loadAll])

  const toggleChecklistItem = useCallback(async (memo, itemId, e) => {
    e?.stopPropagation?.()
    haptic('tap')
    const targetItem = (memo.checklist || []).find((c) => c.id === itemId)
    if (targetItem && !targetItem.done) {
      celebrate('spark', { x: e?.clientX, y: e?.clientY, sound: false })
    }
    const nextList = (memo.checklist || []).map((c) => (c.id === itemId ? { ...c, done: !c.done } : c))
    setMemos((prev) => prev.map((m) => (m.id === memo.id ? { ...m, checklist: nextList } : m)))
    await api(`/api/memos/${encodeURIComponent(memo.id)}`, {
      method: 'PATCH',
      body: { checklist: nextList },
    })
  }, [])

  const saveReportAsMemo = useCallback(async (r) => {
    const key = r.key || `${r.at || ''}:${r.title || ''}`
    if (savedReportKeys.has(key)) return
    try {
      const res = await api('/api/memos', {
        method: 'POST',
        body: {
          title: r.title || r.specTitle || 'Report',
          body: r.summary || r.body || '',
          tags: ['report'],
          kind: 'report',
          color: 'amber',
          source: {
            chatId: r.chat || undefined,
            board: r.board || undefined,
            reportKey: key,
          },
        },
      })
      if (res?.memo) {
        setMemos((prev) => [res.memo, ...prev])
        celebrate('approve')
        notify?.(t('notes.inboxSaved'))
      }
    } catch (e) {
      notify?.(e?.message || 'Error')
    }
  }, [savedReportKeys, notify, t])

  const openEditor = (memo = null) => {
    haptic('tap')
    setCheckDraft('')
    setConfirming(false)
    if (memo) {
      const draft = {
        id: memo.id,
        title: memo.title || '',
        body: memo.body || '',
        tagsText: (memo.tags || []).join(', '),
        pinned: Boolean(memo.pinned),
        color: memo.color || 'default',
        kind: memo.kind || 'note',
        checklist: [...(memo.checklist || [])],
      }
      setEditing(draft)
      setBaseline(draftSnapshot(draft))
    } else {
      setEditing({
        id: null,
        title: '',
        body: '',
        tagsText: 'idea',
        pinned: false,
        color: 'default',
        kind: 'note',
        checklist: [],
      })
      // 新規は保存済みの基準が無い（中身が 1 つでも入ったら未保存の変更とみなす）
      setBaseline(null)
    }
  }

  const submitEditor = async () => {
    if (!editing || saving) return false
    const tags = parseTagsInput(editing.tagsText)
    // 新規は中身が空なら保存しない（既存は本文を空にできる＝変更を保存できる）
    if (!editing.id && !hasDraftContent(editing)) return false
    setSaving(true)
    try {
      let saved = false
      if (editing.id) {
        const res = await api(`/api/memos/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          body: {
            title: editing.title,
            body: editing.body,
            tags,
            pinned: editing.pinned,
            color: editing.color,
            checklist: editing.checklist,
          },
        })
        if (res?.memo) {
          loadAll()
          celebrate('approve')
          notify?.(t('notes.saved'))
          saved = true
        }
      } else {
        const res = await api('/api/memos', {
          method: 'POST',
          body: {
            title: editing.title,
            body: editing.body,
            tags,
            pinned: editing.pinned,
            color: editing.color,
            kind: 'note',
            checklist: editing.checklist,
          },
        })
        if (res?.memo) {
          loadAll()
          celebrate('approve')
          notify?.(t('notes.saved'))
          saved = true
        }
      }
      if (saved) {
        setConfirming(false)
        setBaseline(null)
        setEditing(null)
      }
      return saved
    } catch (e) {
      notify?.(e?.message || 'Error')
      return false
    } finally {
      setSaving(false)
    }
  }

  /** シートを閉じる唯一の入口（背景タップ・✕・端末の戻る）。未保存のときだけ 3 択。 */
  const requestClose = useCallback(() => {
    if (saving) return
    if (!isDraftDirty(editing, baseline)) {
      setConfirming(false)
      setEditing(null)
      return
    }
    haptic('tap')
    setConfirming(true)
  }, [editing, baseline, saving])

  /** 「保存する」— 保存できたら閉じる。失敗時は入力を持ったまま編集へ戻す。 */
  const saveAndClose = async () => {
    setConfirming(false)
    await submitEditor()
  }

  /** 「破棄する」— 下書きを捨てて閉じる（カードは保存済みの内容に戻る）。 */
  const discardAndClose = () => {
    haptic('tap')
    setConfirming(false)
    setCheckDraft('')
    setBaseline(null)
    setEditing(null)
  }

  /** 「戻る」— 入力を持ったまま編集画面へ戻る。戻るキーで消費した履歴を積み直す。 */
  const keepEditing = () => {
    haptic('tap')
    setConfirming(false)
    setSheetArm((n) => n + 1)
  }

  const deleteEditing = async () => {
    if (!editing?.id || saving) return
    setSaving(true)
    try {
      await api(`/api/memos/${encodeURIComponent(editing.id)}`, { method: 'DELETE' })
      setMemos((prev) => prev.filter((m) => m.id !== editing.id))
      setConfirming(false)
      setBaseline(null)
      setEditing(null)
      notify?.(t('notes.deleted'))
    } catch (e) {
      notify?.(e?.message || 'Error')
    } finally {
      setSaving(false)
    }
  }

  const sendToBrainstorm = (memo, e) => {
    e?.stopPropagation?.()
    haptic('tap')
    const seed = [memo.title, memo.body].filter(Boolean).join('\n').trim()
    window.dispatchEvent(new CustomEvent('hm:open-brainstorm', { detail: { seed, memoId: memo.id } }))
  }

  const sendToSeed = (memo, e) => {
    e?.stopPropagation?.()
    haptic('tap')
    const seed = [
      memo.title,
      memo.body,
      ...(memo.checklist || []).map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`),
    ]
      .filter(Boolean)
      .join('\n')
      .trim()
    window.dispatchEvent(new CustomEvent('hm:open-seed', { detail: { seed, repo: memo.source?.repo, board: memo.source?.board } }))
  }

  /**
   * リスト表示の `⋯` メニューから 1 行を実行する（シートは先に閉じる）。
   * @param {string} action `pin` / `brainstorm` / `seed` / `chat`
   * @param {object} memo
   */
  const runMenuAction = (action, memo) => {
    setMenuFor(null)
    if (!memo) return
    if (action === 'pin') togglePin(memo)
    else if (action === 'brainstorm') sendToBrainstorm(memo)
    else if (action === 'seed') sendToSeed(memo)
    else if (action === 'chat' && memo.source?.chatId) {
      haptic('tap')
      onOpenChat?.(memo.source.chatId)
    }
  }

  /** 表示モードを切り替えて端末へ保存する。 */
  const changeView = (next) => {
    haptic('tap')
    setView(next)
    try {
      rememberMemosView(window.localStorage, next)
    } catch {
      // 端末保存が使えない環境ではその場の表示だけ切り替える
    }
  }

  const unreadReports = useMemo(
    () =>
      reports.filter((r) => {
        const key = r.key || `${r.at || ''}:${r.title || ''}`
        return !savedReportKeys.has(key)
      }),
    [reports, savedReportKeys],
  )

  return (
    <div className="pane memos-pane">
      <div className="memos-header">
        <div className="memos-header-titles">
          <div className="memos-header-title">💡 {t('notes.title')}</div>
          <div className="memos-header-sub">{t('notes.subtitle')}</div>
        </div>
        <div className="memos-header-actions">
          <button type="button" className="btn primary memos-new-btn" onClick={() => openEditor(null)}>
            {t('notes.newBtn')}
          </button>
          <RefreshButton variant="icon" onRefresh={loadAll} />
        </div>
      </div>

      {/* Keep 風クイック入力バー */}
      <div className="memos-quick-bar">
        <input
          type="text"
          className="memos-quick-input"
          value={quickText}
          placeholder={t('notes.quickPlaceholder')}
          onChange={(e) => setQuickText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent?.isComposing) {
              e.preventDefault()
              quickCreate()
            }
          }}
        />
        <button type="button" className="btn" disabled={!quickText.trim() || saving} onClick={quickCreate}>
          {t('notes.addChecklistBtn')}
        </button>
      </div>

      {/* 検索バー（右端に 1 / 2 / ☰ の表示切替・Q2=A） */}
      <div className="memos-search-row">
        <input
          type="search"
          className="memos-search-input"
          value={query}
          placeholder={t('notes.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="memos-view-seg" role="group" aria-label={t('notes.viewGroupAria')}>
          {VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.view}
              type="button"
              className={`memos-view-btn${view === opt.view ? ' on' : ''}`}
              aria-pressed={view === opt.view}
              aria-label={t(opt.labelKey)}
              title={t(opt.labelKey)}
              onClick={() => changeView(opt.view)}
            >
              {opt.glyph}
            </button>
          ))}
        </div>
      </div>

      {/* タグ・種別フィルタ */}
      <div className="chips memos-filter-chips">
        <button type="button" className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
          {t('notes.filterAll')}
        </button>
        <button type="button" className={`chip${filter === 'pinned' ? ' on' : ''}`} onClick={() => setFilter('pinned')}>
          {t('notes.filterPinned')}
        </button>
        <button type="button" className={`chip${filter === 'report' ? ' on' : ''}`} onClick={() => setFilter('report')}>
          {t('notes.filterReports')}
        </button>
        {allTags.map((tg) => (
          <button
            key={tg}
            type="button"
            className={`chip${filter === `tag:${tg}` ? ' on' : ''}`}
            onClick={() => setFilter(filter === `tag:${tg}` ? 'all' : `tag:${tg}`)}
          >
            #{tg}
          </button>
        ))}
      </div>

      {/* 定期・完了レポート受信箱（未保存分） */}
      {unreadReports.length ? (
        <details className="memos-inbox-box">
          <summary className="memos-inbox-summary">
            <span>📬 {t('notes.inboxHead', { n: unreadReports.length })}</span>
            <Icon name="chevron" size={14} />
          </summary>
          <div className="memos-inbox-list">
            {unreadReports.slice(0, 6).map((r, idx) => (
              <div key={r.key || idx} className="memos-inbox-row">
                <div className="memos-inbox-main">
                  <div className="row-title">{r.title || r.specTitle || 'Report'}</div>
                  {r.summary ? <div className="row-sub">{r.summary}</div> : null}
                </div>
                <button type="button" className="btn" onClick={() => saveReportAsMemo(r)}>
                  {t('notes.inboxSave')}
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {loading ? <Loader label={t('common.loading')} /> : null}

      {!loading && !filteredMemos.length ? <div className="empty">{t('notes.empty')}</div> : null}

      {/* Keep 風カードグリッド（view-one / view-two / view-list） */}
      <div className={`memos-grid view-${view}`}>
        {filteredMemos.map((m) => {
          const meta = [m.source?.chatTitle, m.source?.repo, m.source?.board].filter(Boolean).join(' · ')
          // 二列は高さ 220px 固定なので、チェックリストは先頭 3 件＋「+N」に畳む（Q4=A）
          const check = checklistPreview(m.checklist, view)
          return (
            <article
              key={m.id}
              className={`card memo-card color-${m.color || 'default'}${m.pinned ? ' is-pinned' : ''}`}
              onClick={() => openEditor(m)}
            >
              <div className="memo-card-head">
                <div className="memo-card-title">{m.title || (m.kind === 'report' ? '📬 Report' : '💡')}</div>
                {showsCardButtons(view) ? (
                  <button
                    type="button"
                    className={`memo-pin-btn${m.pinned ? ' on' : ''}`}
                    aria-label={m.pinned ? t('notes.unpin') : t('notes.pin')}
                    onClick={(e) => togglePin(m, e)}
                  >
                    📌
                  </button>
                ) : null}
                {showsListMenu(view) ? (
                  <button
                    type="button"
                    className="memo-more-btn"
                    aria-label={t('notes.more')}
                    aria-haspopup="dialog"
                    onClick={(e) => {
                      e.stopPropagation()
                      haptic('tap')
                      setMenuFor(m)
                    }}
                  >
                    ⋯
                  </button>
                ) : null}
              </div>
              {m.body ? <div className="memo-card-body">{m.body}</div> : null}
              {m.checklist?.length ? (
                <div className="memo-checklist">
                  {check.visible.map((c) =>
                    view === 'two' ? (
                      // 二列カード（高さ 220px 固定）では行は表示専用にする。1 行 17px の
                      // 付け外しは誤タップで別の項目を反転させるため、44px を確保できない
                      // ここではボタンにしない（付け外しはカード全体タップ→編集シート）。
                      <span key={c.id} className={`memo-check-row${c.done ? ' done' : ''}`}>
                        <span aria-hidden="true">{c.done ? '☑' : '☐'}</span>
                        <span>{c.text}</span>
                      </span>
                    ) : (
                      <button
                        key={c.id}
                        type="button"
                        className={`memo-check-row${c.done ? ' done' : ''}`}
                        onClick={(e) => toggleChecklistItem(m, c.id, e)}
                      >
                        <span aria-hidden="true">{c.done ? '☑' : '☐'}</span>
                        <span>{c.text}</span>
                      </button>
                    ),
                  )}
                  {/* 二列は高さ 220px に収めるため残りを「+N」に畳む（タップはカード全体＝編集シート） */}
                  {check.hidden ? (
                    <span className="memo-check-more">
                      {t('notes.moreItems', { n: check.hidden })}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {m.tags?.length ? (
                <div className="memo-tags">
                  {m.tags.map((tg) => (
                    <span key={tg} className="memo-tag">
                      #{tg}
                    </span>
                  ))}
                </div>
              ) : null}
              {meta ? <div className="memo-source-meta">{t('notes.sourceMeta', { meta })}</div> : null}
              {showsCardButtons(view) ? (
                <div className="memo-card-actions">
                  <button type="button" className="report-card-btn" onClick={(e) => sendToBrainstorm(m, e)}>
                    {t('notes.brainstorm')}
                  </button>
                  <button type="button" className="report-card-btn primary" onClick={(e) => sendToSeed(m, e)}>
                    {t('notes.toSeed')}
                  </button>
                  {m.source?.chatId && onOpenChat ? (
                    <button
                      type="button"
                      className="report-card-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        haptic('tap')
                        onOpenChat(m.source.chatId)
                      }}
                    >
                      {t('notes.openChat')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      {/* リスト表示の `⋯` メニュー（タイトル = メモ名・行は §2.2 の 4 つ） */}
      {menuFor ? (
        <Sheet
          title={menuFor.title || t('notes.menuTitle')}
          onClose={() => setMenuFor(null)}
        >
          <div className="memo-menu">
            {memoMenuRows(menuFor, { canOpenChat: Boolean(onOpenChat) }).map((row) => (
              <button
                key={row.action}
                type="button"
                className="memo-menu-row"
                onClick={() => runMenuAction(row.action, menuFor)}
              >
                {t(row.labelKey)}
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {/* 編集・作成シート */}
      {editing ? (
        <Sheet
          title={editing.id ? t('notes.editTitle') : t('notes.createTitle')}
          onClose={requestClose}
          historyKey={sheetArm}
        >
          {/* 未保存のときだけ出す 3 択（シートを重ねず本文へインラインで置く） */}
          {confirming ? (
            <div className="memo-unsaved" role="alertdialog" aria-label={t('notes.unsavedTitle')}>
              <div className="memo-unsaved-title">{t('notes.unsavedTitle')}</div>
              <div className="memo-unsaved-sub">{t('notes.unsavedSub')}</div>
              <div className="memo-unsaved-actions">
                <button type="button" className="btn primary" disabled={saving} onClick={saveAndClose}>
                  {t('notes.saveAndClose')}
                </button>
                <button type="button" className="btn ghost" disabled={saving} onClick={discardAndClose}>
                  {t('notes.discard')}
                </button>
                <button type="button" className="btn" onClick={keepEditing}>
                  {t('notes.keepEditing')}
                </button>
              </div>
            </div>
          ) : null}
          {/* 3 択のあいだは入力欄を隠す（下書きは state に残るので「戻る」で戻せる） */}
          <div className="memo-editor" style={confirming ? { display: 'none' } : undefined}>
            <label className="memo-field-label">
              <span>{t('notes.fieldTitle')}</span>
              <input
                type="text"
                className="memo-input"
                value={editing.title}
                placeholder={t('notes.fieldTitlePh')}
                onChange={(e) => setEditing((cur) => ({ ...cur, title: e.target.value }))}
              />
            </label>
            <label className="memo-field-label">
              <span>{t('notes.fieldBody')}</span>
              <textarea
                rows={4}
                className="memo-textarea"
                value={editing.body}
                placeholder={t('notes.fieldBodyPh')}
                onChange={(e) => setEditing((cur) => ({ ...cur, body: e.target.value }))}
              />
            </label>
            <div className="memo-field-label">
              <span>{t('notes.fieldChecklist')}</span>
              <div className="memo-editor-checks">
                {editing.checklist.map((c) => (
                  <div key={c.id} className="memo-editor-check-item">
                    <input
                      type="checkbox"
                      checked={c.done}
                      onChange={() =>
                        setEditing((cur) => ({
                          ...cur,
                          checklist: cur.checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)),
                        }))
                      }
                    />
                    <span className={c.done ? 'done' : ''}>{c.text}</span>
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        setEditing((cur) => ({ ...cur, checklist: cur.checklist.filter((x) => x.id !== c.id) }))
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="memo-check-add-row">
                  <input
                    type="text"
                    className="memo-input"
                    value={checkDraft}
                    placeholder={t('notes.addChecklistPh')}
                    onChange={(e) => setCheckDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      const txt = checkDraft.trim()
                      if (!txt) return
                      setEditing((cur) => ({
                        ...cur,
                        checklist: [...cur.checklist, { id: `c_${Date.now()}`, text: txt, done: false }],
                      }))
                      setCheckDraft('')
                    }}
                  >
                    {t('notes.addChecklistBtn')}
                  </button>
                </div>
              </div>
            </div>
            <label className="memo-field-label">
              <span>{t('notes.fieldTags')}</span>
              <input
                type="text"
                className="memo-input"
                value={editing.tagsText}
                placeholder={t('notes.fieldTagsPh')}
                onChange={(e) => setEditing((cur) => ({ ...cur, tagsText: e.target.value }))}
              />
            </label>
            <div className="memo-color-row">
              <span>{t('notes.colorLabel')}</span>
              <div className="chips" style={{ padding: 0 }}>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`chip${editing.color === c ? ' on' : ''}`}
                    onClick={() => setEditing((cur) => ({ ...cur, color: c }))}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="memo-editor-actions">
              <button
                type="button"
                className="btn primary"
                disabled={saving || (!editing.id && !hasDraftContent(editing))}
                onClick={submitEditor}
              >
                {t('notes.save')}
              </button>
              {editing.id ? (
                <button type="button" className="btn ghost" disabled={saving} onClick={deleteEditing}>
                  {t('notes.delete')}
                </button>
              ) : null}
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
