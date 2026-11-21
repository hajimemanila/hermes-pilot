import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Sheet } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { celebrate } from '../lib/vibe.js'
import {
  DEFAULT_SWEEP,
  SWEEP_PRESETS,
  buildSweepPayload,
  normalizePreset,
  normalizeReport,
  recommendSweep,
  sweepCounts,
} from '../lib/coherenceSweep.js'
import { buildSeedPayload } from '../lib/specSeed.js'
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'

const ANGLES = [
  { id: 'feature', key: 'brainstorm.angleFeature' },
  { id: 'ux', key: 'brainstorm.angleUx' },
  { id: 'edge', key: 'brainstorm.angleEdge' },
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
      emitHmEvent(HM_EVENTS.MEMOS_CHANGED)
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
      new CustomEvent(HM_EVENTS.DISCUSS_PIPELINE, {
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

/**
 * `🛠 Refactor & audit` — generic coherence sweeps (SPEC-COHERENCE §3.6 / D82).
 *
 * The old sheet filed three lines of this repository's own vocabulary (`SOUL.md`, `OAuth boundary`,
 * `i18n`, `390px responsive`). Any other repository got nonsense. Now:
 *
 * - six language-agnostic presets (`state-flow` / `contracts` / `hotspots` / `docs-specs` /
 *   `bug-hunt` / `custom`)
 * - `bug-hunt` additionally offers one opt-in checkbox (default off): reproduce-first auto-fix.
 *   Off means the filed task is a read-only report; on means "write the failing test first, then
 *   fix only what it proves". The flag resets whenever the preset changes or the sheet reopens.
 * - the live `GET /api/coherence/report` result on open: counts per preset, recommended preset
 *   pre-selected (never overriding a preset the person picked, or the `initialPreset` C7 passes in)
 * - two ways to start it: one kanban task, or a multi-batch SPEC through the Spec Architect
 *   (`runner: 'hermes'`, `executionPolicy: 'zero-stop'`)
 *
 * Verification instructions stay abstract — they are delegated to the target repository's own
 * memory / rule docs / SPEC `Verify` section (D85). The endpoint may be missing (older bridge) or
 * offline: the sheet then shows the unavailable state and still files the sweep.
 *
 * @param {{board?: string, repo?: string|null, initialPreset?: string,
 *          onClose?: Function, notify?: Function}} props sheet props
 * @returns {any} sheet
 */
export function RefactorSheet({ board = '', repo = null, initialPreset = '', onClose, notify }) {
  const { t, lang } = useI18n()
  const [preset, setPreset] = useState(() => normalizePreset(initialPreset || DEFAULT_SWEEP))
  const [target, setTarget] = useState('')
  const [report, setReport] = useState(null)
  const [reportState, setReportState] = useState('loading') // loading | ready | error
  const [busy, setBusy] = useState(null) // 'single' | 'spec' | null
  const [error, setError] = useState(null)
  // bug-hunt の再現先行オプトイン（既定 OFF＝調査レポート専念・プリセット変更で戻す）
  const [autoFix, setAutoFix] = useState(false)
  // 人が選び直したら診断結果の推奨で上書きしない（`initialPreset` での起動も同じ扱い）
  const touched = useRef(Boolean(String(initialPreset ?? '').trim()))
  const repoId = typeof repo === 'string' ? repo : ''

  const loadReport = useCallback(
    async (fresh = false) => {
      const params = new URLSearchParams()
      if (board) params.set('board', board)
      if (repoId) params.set('repo', repoId)
      if (fresh) params.set('fresh', '1')
      const qs = params.toString()
      setReportState('loading')
      try {
        const data = await api(`/api/coherence/report${qs ? `?${qs}` : ''}`)
        const next = normalizeReport(data)
        setReport(next)
        setReportState('ready')
        if (!touched.current) setPreset(recommendSweep(next))
      } catch {
        // ルート未実装・オフラインでもスイープは起動できる（診断は飾りにしない）
        setReport(null)
        setReportState('error')
      }
    },
    [board, repoId],
  )

  useEffect(() => {
    loadReport(false)
  }, [loadReport])

  const counts = sweepCounts(report)
  const recommended = report ? recommendSweep(report) : ''

  const pick = (id) => {
    touched.current = true
    setPreset(id)
    // 別プリセットへ移ったら再現先行は必ず OFF に戻す（前回の選択を持ち越さない）
    if (id !== 'bug-hunt') setAutoFix(false)
  }

  const submit = async (mode) => {
    if (busy) return
    if (!board) {
      setError(t('coherence.noBoard'))
      return
    }
    setBusy(mode)
    setError(null)
    const payload = buildSweepPayload({ preset, report, target, mode, board, lang, autoFix })
    try {
      if (mode === 'spec') {
        await api('/api/architect/seed', {
          method: 'POST',
          body: buildSeedPayload({
            seedText: payload.seedText,
            // 複数バッチ化は仕様書を人が確認してから起動する（既定の承認フローを飛ばさない）
            autoStart: false,
            executionPolicy: 'zero-stop',
            board,
            repo: repoId || null,
            lang,
          }),
        })
        notify?.(t('coherence.launchedSpec'))
      } else {
        await api(`/api/boards/${encodeURIComponent(board)}/tasks`, {
          method: 'POST',
          body: { title: payload.title, body: payload.body, priority: 1 },
        })
        notify?.(t('coherence.launched'))
      }
      celebrate('launch')
      onClose?.()
    } catch (e) {
      setError(e?.message || t('coherence.failed'))
      setBusy(null)
    }
  }

  const repoName = report?.repoRoot ? String(report.repoRoot).split('/').filter(Boolean).pop() : ''

  return (
    <Sheet title={`🛠 ${t('refactor.title')}`} onClose={() => !busy && onClose?.()}>
      <p className="seed-lead">{t('coherence.lead')}</p>

      <div className={`coh-report${reportState === 'error' ? ' is-muted' : ''}`} role="status" aria-live="polite">
        <span className="coh-report-text">
          {reportState === 'loading'
            ? t('coherence.reportLoading')
            : reportState === 'error'
              ? t('coherence.reportUnavailable')
              : t('coherence.reportSummary', {
                  hard: report.counts.hardFailCount,
                  soft: report.counts.softSignalCount,
                  hotspots: report.counts.hotspotCount,
                })}
        </span>
        {reportState === 'ready' && repoName ? (
          <span className="coh-report-meta">{t('coherence.reportRepo', { repo: repoName })}</span>
        ) : null}
        <button
          type="button"
          className="coh-refresh"
          onClick={() => loadReport(true)}
          disabled={reportState === 'loading'}
          aria-label={t('coherence.refreshAria')}
        >
          ↻ {t('coherence.refresh')}
        </button>
      </div>

      <div className="list-head">{t('coherence.preset')}</div>
      <div className="coh-presets" role="radiogroup" aria-label={t('coherence.preset')}>
        {SWEEP_PRESETS.map((id) => {
          const on = preset === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`coh-preset${on ? ' on' : ''}`}
              onClick={() => pick(id)}
            >
              <span className="coh-preset-head">
                <span className="coh-preset-name">{t(`coherence.preset.${id}`)}</span>
                {counts[id] ? <span className="coh-count">{counts[id]}</span> : null}
              </span>
              <span className="coh-preset-desc">{t(`coherence.preset.${id}.desc`)}</span>
              {recommended === id ? <span className="coh-rec">{t('coherence.recommended')}</span> : null}
            </button>
          )
        })}
      </div>

      <input
        type="text"
        className="memo-input coh-target"
        value={target}
        placeholder={t('coherence.targetPh')}
        aria-label={t('coherence.targetLabel')}
        enterKeyHint="done"
        onChange={(e) => setTarget(e.target.value)}
      />

      {preset === 'bug-hunt' ? (
        <label className="seed-toggle coh-toggle">
          <input
            type="checkbox"
            checked={autoFix}
            onChange={(e) => setAutoFix(e.target.checked)}
          />
          <span>{t('coherence.preset.bug-hunt.autoFix')}</span>
        </label>
      ) : null}

      {error ? <div className="seed-error" style={{ marginTop: 8 }}>{error}</div> : null}

      <div className="coh-actions">
        <button
          type="button"
          className="coh-action primary"
          disabled={Boolean(busy) || !board}
          onClick={() => submit('single')}
        >
          <span className="coh-action-name">
            {busy === 'single' ? t('coherence.working') : t('coherence.launchSingle')}
          </span>
          <span className="coh-action-desc">{t('coherence.launchSingleHint')}</span>
        </button>
        <button
          type="button"
          className="coh-action"
          disabled={Boolean(busy) || !board}
          onClick={() => submit('spec')}
        >
          <span className="coh-action-name">
            {busy === 'spec' ? t('coherence.working') : t('coherence.launchSpec')}
          </span>
          <span className="coh-action-desc">{t('coherence.launchSpecHint')}</span>
        </button>
      </div>
    </Sheet>
  )
}
