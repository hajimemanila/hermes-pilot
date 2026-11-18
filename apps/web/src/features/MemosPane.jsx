import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, Loader, RefreshButton, Sheet } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'
import { celebrate } from '../lib/vibe.js'

const COLORS = ['default', 'teal', 'amber', 'violet']

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
    if (memo) {
      setEditing({
        id: memo.id,
        title: memo.title || '',
        body: memo.body || '',
        tagsText: (memo.tags || []).join(', '),
        pinned: Boolean(memo.pinned),
        color: memo.color || 'default',
        kind: memo.kind || 'note',
        checklist: [...(memo.checklist || [])],
      })
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
    }
  }

  const submitEditor = async () => {
    if (!editing || saving) return
    const tags = parseTagsInput(editing.tagsText)
    if (!editing.title.trim() && !editing.body.trim() && !editing.checklist.length) return
    setSaving(true)
    try {
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
        }
      }
      setEditing(null)
    } catch (e) {
      notify?.(e?.message || 'Error')
    } finally {
      setSaving(false)
    }
  }

  const deleteEditing = async () => {
    if (!editing?.id || saving) return
    setSaving(true)
    try {
      await api(`/api/memos/${encodeURIComponent(editing.id)}`, { method: 'DELETE' })
      setMemos((prev) => prev.filter((m) => m.id !== editing.id))
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

      {/* 検索バー */}
      <div className="memos-search-row">
        <input
          type="search"
          className="memos-search-input"
          value={query}
          placeholder={t('notes.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
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

      {/* Keep 風カードグリッド */}
      <div className="memos-grid">
        {filteredMemos.map((m) => {
          const meta = [m.source?.chatTitle, m.source?.repo, m.source?.board].filter(Boolean).join(' · ')
          return (
            <article
              key={m.id}
              className={`card memo-card color-${m.color || 'default'}${m.pinned ? ' is-pinned' : ''}`}
              onClick={() => openEditor(m)}
            >
              <div className="memo-card-head">
                <div className="memo-card-title">{m.title || (m.kind === 'report' ? '📬 Report' : '💡')}</div>
                <button
                  type="button"
                  className={`memo-pin-btn${m.pinned ? ' on' : ''}`}
                  aria-label={m.pinned ? t('notes.unpin') : t('notes.pin')}
                  onClick={(e) => togglePin(m, e)}
                >
                  📌
                </button>
              </div>
              {m.body ? <div className="memo-card-body">{m.body}</div> : null}
              {m.checklist?.length ? (
                <div className="memo-checklist">
                  {m.checklist.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`memo-check-row${c.done ? ' done' : ''}`}
                      onClick={(e) => toggleChecklistItem(m, c.id, e)}
                    >
                      <span aria-hidden="true">{c.done ? '☑' : '☐'}</span>
                      <span>{c.text}</span>
                    </button>
                  ))}
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
            </article>
          )
        })}
      </div>

      {/* 編集・作成シート */}
      {editing ? (
        <Sheet title={editing.id ? t('notes.editTitle') : t('notes.createTitle')} onClose={() => setEditing(null)}>
          <div className="memo-editor">
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
                disabled={saving || (!editing.title.trim() && !editing.body.trim() && !editing.checklist.length)}
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
