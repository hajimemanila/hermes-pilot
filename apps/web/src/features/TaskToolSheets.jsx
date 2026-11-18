import React, { useState } from 'react'
import { api } from '../api.js'
import { Sheet } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { celebrate } from '../lib/vibe.js'

const ANGLES = [
  { id: 'feature', key: 'brainstorm.angleFeature' },
  { id: 'ux', key: 'brainstorm.angleUx' },
  { id: 'edge', key: 'brainstorm.angleEdge' },
]

const REFACTOR_SCOPES = [
  { id: 'css', key: 'refactor.scopeCss' },
  { id: 'code', key: 'refactor.scopeCode' },
  { id: 'rules', key: 'refactor.scopeRules' },
  { id: 'perf', key: 'refactor.scopePerf' },
]

function buildBrainstormItems(seed, angles, t) {
  const topic = String(seed ?? '').trim()
  const items = []
  if (angles.includes('feature')) {
    items.push(t('brainstorm.tpl.feature1', { topic }), t('brainstorm.tpl.feature2'))
  }
  if (angles.includes('ux')) {
    items.push(t('brainstorm.tpl.ux1'), t('brainstorm.tpl.ux2'))
  }
  if (angles.includes('edge')) {
    items.push(t('brainstorm.tpl.edge1'), t('brainstorm.tpl.edge2'))
  }
  return items.map((text, idx) => ({ id: `bs_${Date.now()}_${idx}`, text, done: false }))
}

export function BrainstormSheet({ initialSeed = '', board = '', repo = null, onClose, notify }) {
  const { t } = useI18n()
  const [seed, setSeed] = useState(initialSeed)
  const [angles, setAngles] = useState(['feature', 'ux'])
  const [items, setItems] = useState(() =>
    initialSeed ? buildBrainstormItems(initialSeed, ['feature', 'ux'], t) : [],
  )
  const [busy, setBusy] = useState(false)

  const toggleAngle = (id) => {
    setAngles((prev) => (prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id]))
  }

  const expand = () => {
    if (!seed.trim()) return
    setItems(buildBrainstormItems(seed, angles, t))
    celebrate('approve')
  }

  const saveToMemos = async () => {
    if (!seed.trim() && !items.length) return
    setBusy(true)
    try {
      const checklist = items.length ? items : buildBrainstormItems(seed, angles, t)
      await api('/api/memos', {
        method: 'POST',
        body: {
          title: seed.trim().split('\n')[0].slice(0, 60) || t('brainstorm.title'),
          body: seed.trim(),
          tags: ['brainstorm', ...angles],
          kind: 'note',
          color: 'violet',
          checklist,
          source: { board: board || undefined, repo: repo || undefined },
        },
      })
      window.dispatchEvent(new CustomEvent('hm:memos-changed'))
      celebrate('launch')
      notify?.(t('brainstorm.saved'))
      onClose?.()
    } catch (e) {
      notify?.(e?.message || 'Error')
    } finally {
      setBusy(false)
    }
  }

  const sendToChat = () => {
    const lines = items.map((c) => `- [ ] ${c.text}`).join('\n')
    const prompt = [seed.trim(), lines].filter(Boolean).join('\n\n')
    window.dispatchEvent(
      new CustomEvent('hm:discuss-pipeline', {
        detail: { prompt, board: board || undefined, repoPath: repo || undefined },
      }),
    )
    onClose?.()
  }

  return (
    <Sheet title={`🧠 ${t('brainstorm.title')}`} onClose={onClose}>
      <p className="seed-lead">{t('brainstorm.lead')}</p>
      <textarea
        rows={3}
        className="seed-input"
        value={seed}
        placeholder={t('brainstorm.placeholder')}
        onChange={(e) => setSeed(e.target.value)}
      />
      <div className="list-head" style={{ marginTop: 10 }}>
        {t('brainstorm.angles')}
      </div>
      <div className="chips" style={{ padding: 0, flexWrap: 'wrap' }}>
        {ANGLES.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`chip${angles.includes(a.id) ? ' on' : ''}`}
            onClick={() => toggleAngle(a.id)}
          >
            {t(a.key)}
          </button>
        ))}
      </div>
      <button type="button" className="btn" style={{ width: '100%', marginTop: 10 }} disabled={!seed.trim()} onClick={expand}>
        {t('brainstorm.generate')}
      </button>
      {items.length ? (
        <div className="memo-checklist" style={{ marginTop: 10 }}>
          {items.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`memo-check-row${c.done ? ' done' : ''}`}
              onClick={() => setItems((cur) => cur.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)))}
            >
              <span aria-hidden="true">{c.done ? '☑' : '☐'}</span>
              <span>{c.text}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="memo-editor-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn primary" disabled={busy || (!seed.trim() && !items.length)} onClick={saveToMemos}>
          {t('brainstorm.saveMemo')}
        </button>
        <button type="button" className="btn" disabled={!seed.trim() && !items.length} onClick={sendToChat}>
          {t('brainstorm.sendChat')}
        </button>
      </div>
    </Sheet>
  )
}

export function RefactorSheet({ board = '', onClose, notify }) {
  const { t } = useI18n()
  const [scopes, setScopes] = useState(['css', 'code', 'rules'])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const toggleScope = (id) => {
    setScopes((prev) => (prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id]))
  }

  const submit = async () => {
    if (busy || !board) return
    setBusy(true)
    setError(null)
    try {
      const labels = scopes.map((id) => t(`refactor.scope${id.charAt(0).toUpperCase()}${id.slice(1)}`))
      const body = [
        `Scopes: ${labels.join(', ')}`,
        target.trim() ? `Target: ${target.trim()}` : 'Target: full repository',
        'Check alignment with project rules (SOUL.md, OAuth boundary, i18n, 390px responsive) and remove local duplication/bloat.',
      ].join('\n')
      await api(`/api/boards/${encodeURIComponent(board)}/tasks`, {
        method: 'POST',
        body: {
          title: `[REFACTOR] ${labels[0]}${target.trim() ? ` (${target.trim()})` : ''}`,
          body,
          priority: 1,
        },
      })
      celebrate('launch')
      notify?.(t('refactor.launched'))
      onClose?.()
    } catch (e) {
      setError(e?.message || t('refactor.failed'))
      setBusy(false)
    }
  }

  return (
    <Sheet title={`🛠 ${t('refactor.title')}`} onClose={() => !busy && onClose?.()}>
      <p className="seed-lead">{t('refactor.lead')}</p>
      <div className="list-head">{t('refactor.scope')}</div>
      <div className="chips" style={{ padding: 0, flexWrap: 'wrap' }}>
        {REFACTOR_SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`chip${scopes.includes(s.id) ? ' on' : ''}`}
            onClick={() => toggleScope(s.id)}
          >
            {t(s.key)}
          </button>
        ))}
      </div>
      <input
        type="text"
        className="memo-input"
        style={{ marginTop: 10 }}
        value={target}
        placeholder={t('refactor.targetPh')}
        onChange={(e) => setTarget(e.target.value)}
      />
      {error ? <div className="seed-error" style={{ marginTop: 8 }}>{error}</div> : null}
      <button type="button" className="btn primary" style={{ width: '100%', marginTop: 12 }} disabled={busy || !board} onClick={submit}>
        {t('refactor.launch')}
      </button>
    </Sheet>
  )
}
