import React, { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { Sheet } from '../../components/Ui.jsx'
import { useI18n } from '../../i18n/index.js'
import { haptic } from '../../lib/haptic.js'
import { repoLabel } from '../../lib/repoPicker.js'
import { SEED_MAX, canSubmit } from '../../lib/specSeed.js'
import { celebrateAction } from '../../lib/vibe.js'
import { BeforeAfterTimelapse } from './BeforeAfterTimelapse.jsx'
import { LiveRadarCard } from './LiveRadarCard.jsx'

/**
 * Autopilot 上部常設のプロジェクト切替＋同一オリジン成果物プレビューバー。
 */
export function AutopilotProjectBar({ boards = [], board = null, preview = null, onOpenPicker }) {
  const { t } = useI18n()
  const active = boards.find((b) => b.slug === board) || null
  const label = active?.name || active?.label || board || t('autopilot.project.select')
  return (
    <div className="ap-project-bar">
      <button
        type="button"
        className="ap-project-btn"
        onClick={() => {
          haptic('tap')
          onOpenPicker?.()
        }}
        aria-label={t('autopilot.project.switchAria')}
      >
        <span aria-hidden="true">{active?.icon || '📁'}</span>
        <span className="ap-project-name">{label}</span>
        <span className="ap-project-caret" aria-hidden="true">▾</span>
      </button>
      {preview?.url && (
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ap-preview-chip"
          onClick={() => haptic('action')}
        >
          🌐 {t('autopilot.project.openPreview')} ↗
        </a>
      )}
    </div>
  )
}

/**
 * Autopilot 内のプロジェクト新規作成＋過去プロジェクト／リポジトリ切替シート。
 */
export function AutopilotProjectSheet({
  boards = [],
  board = null,
  onSelectBoard,
  onCreatedProject,
  onClose,
  notify,
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [unboarded, setUnboarded] = useState([])
  const [busyRepoId, setBusyRepoId] = useState('')

  useEffect(() => {
    let alive = true
    api('/api/repos?fresh=1')
      .then((d) => {
        if (!alive) return
        const list = Array.isArray(d?.repos) ? d.repos : []
        setUnboarded(list.filter((r) => !(r.boards?.length)))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const createNew = async (e) => {
    e?.preventDefault?.()
    const clean = String(name || '').trim()
    if (!clean || creating) return
    setCreating(true)
    try {
      const res = await api('/api/repos/new', { method: 'POST', body: { name: clean } })
      if (!res?.ok || !res.board?.slug) {
        notify?.(res?.error || t('autopilot.project.createFailed'))
        return
      }
      notify?.(t('autopilot.project.created', { name: res.board.slug }))
      await onCreatedProject?.(res.board.slug)
      onClose?.()
    } catch (err) {
      notify?.(err?.message || t('autopilot.project.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  const attachRepo = async (repo) => {
    if (!repo?.id || busyRepoId) return
    setBusyRepoId(repo.id)
    try {
      const res = await api(`/api/repos/${encodeURIComponent(repo.id)}/board`, { method: 'POST', body: {} })
      if (!res?.ok || !res.board?.slug) {
        notify?.(res?.error || t('chat.boardCreateFailed'))
        return
      }
      await onCreatedProject?.(res.board.slug)
      onClose?.()
    } catch (err) {
      notify?.(err?.message || t('chat.boardCreateFailed'))
    } finally {
      setBusyRepoId('')
    }
  }

  return (
    <Sheet title={`📁 ${t('autopilot.project.sheetTitle')}`} onClose={onClose}>
      <form className="ap-new-proj-card" onSubmit={createNew}>
        <div className="ap-new-proj-title">✨ {t('autopilot.project.newTitle')}</div>
        <div className="ap-launcher-bar">
          <input
            type="text"
            className="ap-launcher-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('autopilot.project.newPlaceholder')}
            aria-label={t('autopilot.project.newPlaceholder')}
          />
          <button type="submit" className="ap-launcher-submit" disabled={creating || !name.trim()}>
            {creating ? t('chat.creating') : t('autopilot.project.newBtn')}
          </button>
        </div>
      </form>

      <div className="pick-list">
        {boards.map((b) => (
          <button
            key={b.slug}
            type="button"
            className={`pick-item${board === b.slug ? ' on' : ''}`}
            onClick={() => {
              haptic('tap')
              onSelectBoard?.(b.slug)
              onClose?.()
            }}
          >
            <span aria-hidden="true">{b.icon || '📁'}</span>
            <span className="pick-main">
              <span className="pick-title">{b.name || b.label || b.slug}</span>
              <span className="pick-sub">{b.slug}</span>
            </span>
            <span className="pick-meta">{board === b.slug ? '✓' : ''}</span>
          </button>
        ))}

        {unboarded.length > 0 && <div className="sec">{t('tasks.unboardedRepos')}</div>}
        {unboarded.map((r) => (
          <button
            key={r.id}
            type="button"
            className="pick-item"
            disabled={Boolean(busyRepoId)}
            onClick={() => attachRepo(r)}
          >
            <span aria-hidden="true">📂</span>
            <span className="pick-main">
              <span className="pick-title">{repoLabel(r)}</span>
              <span className="pick-sub">{r.path}</span>
            </span>
            <span className="pick-meta">{busyRepoId === r.id ? t('chat.creating') : t('tasks.createBoardAction')}</span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

/**
 * 選択肢ごとのビジュアルモック描画（実スクショ優先、無ければ案ごとの差別化プレビュー）。
 */
export function OptionMockPreview({ option, question, shotUrl, layoutVariant, theme, t }) {
  const [imgFailed, setImgFailed] = useState(false)
  if (shotUrl && !imgFailed) {
    return (
      <div className={`ap-mock-frame ap-theme-${theme || 'cyan'}`}>
        <img
          src={shotUrl}
          alt={option?.label || question?.text || t('autopilot.mockLabel')}
          className="ap-card-shot"
          onError={() => setImgFailed(true)}
        />
      </div>
    )
  }

  const variant = String(layoutVariant || option?.id || 'A').toUpperCase()
  return (
    <div className={`ap-template-preview ap-variant-${variant} ap-theme-${theme || 'cyan'}`} aria-hidden="true">
      <div className="ap-tpl-bar">
        <span className="ap-tpl-dot" />
        <span className="ap-tpl-badge">{variant}</span>
        <span className="ap-tpl-title">{option?.label || question?.title || t('autopilot.mockLabel')}</span>
      </div>
      {variant === 'B' ? (
        <div className="ap-tpl-split">
          <div className="ap-tpl-tile" />
          <div className="ap-tpl-tile" />
          <div className="ap-tpl-tile wide" />
        </div>
      ) : variant === 'C' ? (
        <div className="ap-tpl-compact">
          <div className="ap-tpl-row" />
          <div className="ap-tpl-row" />
          <div className="ap-tpl-row short" />
        </div>
      ) : (
        <div className="ap-tpl-body">
          <div className="ap-tpl-ring" />
          <div className="ap-tpl-lines">
            <span />
            <span />
          </div>
          <div className="ap-tpl-cta" />
        </div>
      )}
    </div>
  )
}

/**
 * 第1幕: ライト層向けのビジュアル・スターターカード＋1行入力ランチャー。
 */
export function StarterStage({ recipes = [], onStartSeed, onOpenPicker, onSwitchCockpit, notify }) {
  const { t } = useI18n()
  const [seedText, setSeedText] = useState('')
  const [busy, setBusy] = useState(false)

  const launch = async (text, e) => {
    if (busy || !canSubmit(text) || !onStartSeed) return
    setBusy(true)
    try {
      const rect = e?.currentTarget?.getBoundingClientRect?.()
      celebrateAction('launch', {
        x: rect ? Math.round(rect.left + rect.width / 2) : null,
        y: rect ? Math.round(rect.top + rect.height / 2) : null,
        sfx: true,
      })
      await onStartSeed(text)
      setSeedText('')
    } catch (err) {
      notify?.(err?.message || t('seed.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ap-stage-panel ap-starter-panel">
      <div className="ap-starter-hero">
        <div className="ap-starter-glow" aria-hidden="true" />
        <span className="ap-starter-kicker">✨ {t('autopilot.startKicker')}</span>
        <h2 className="ap-starter-title">{t('autopilot.startTitle')}</h2>
        <p className="ap-starter-sub">{t('autopilot.startSub')}</p>
      </div>

      <div className="ap-recipe-rail" role="list" aria-label={t('autopilot.recipesAria')}>
        {recipes.map((r) => (
          <button
            key={r.id}
            type="button"
            role="listitem"
            disabled={busy}
            className={`ap-recipe-card ap-theme-${r.accent}`}
            onClick={(e) => {
              haptic('action')
              launch(t(r.seedKey), e)
            }}
          >
            <span className="ap-recipe-icon" aria-hidden="true">{r.icon}</span>
            <span className="ap-recipe-title">{t(r.titleKey)}</span>
            <span className="ap-recipe-sub">{t(r.subKey)}</span>
            <span className="ap-recipe-go">{t('autopilot.recipeStart')} →</span>
          </button>
        ))}
      </div>

      <form
        className="ap-launcher-form"
        onSubmit={(e) => {
          e.preventDefault()
          launch(seedText, e)
        }}
      >
        <div className="ap-launcher-bar">
          <input
            type="text"
            className="ap-launcher-input"
            maxLength={SEED_MAX}
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            placeholder={t('autopilot.startPlaceholder')}
            aria-label={t('autopilot.startPlaceholder')}
          />
          <button
            type="submit"
            className="ap-launcher-submit"
            disabled={busy || !canSubmit(seedText)}
          >
            {busy ? t('seed.submitting') : `✨ ${t('autopilot.startBtn')}`}
          </button>
        </div>
      </form>

      {onOpenPicker && (
        <button
          type="button"
          className="ap-pill-ghost"
          onClick={() => {
            haptic('tap')
            onOpenPicker()
          }}
        >
          + {t('autopilot.project.newOrSwitch')}
        </button>
      )}
      {onSwitchCockpit && (
        <button type="button" className="ap-subtle-link" onClick={onSwitchCockpit}>
          🎛 {t('autopilot.openCockpit')}
        </button>
      )}
    </div>
  )
}

const LIVE_STEPS = [
  'autopilot.live.stepDesign',
  'autopilot.live.stepBuild',
  'autopilot.live.stepVerify',
  'autopilot.live.stepFinish',
]

/**
 * 第3幕: 自走実装中のライブ制作スタジオカード（4段階ゲージ＋AI実況＋ワイプ比較）。
 */
export function LiveStudioCard({ stage, onSwitchCockpit, onSaveMemo }) {
  const { t } = useI18n()
  const [split, setSplit] = useState(50)
  const [memoOpen, setMemoOpen] = useState(false)
  const [memoText, setMemoText] = useState('')
  const stepIdx = Math.max(0, Math.min(3, Number(stage?.stepIndex) || 0))
  const total = Number(stage?.totalCount) || 0
  const done = Number(stage?.doneCount) || 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : Math.round(((stepIdx + 1) / 4) * 75)
  const compare = stage?.compareItem
  const afterSrc = compare ? `/api/review/${encodeURIComponent(compare.id)}/image` : null
  const beforeSrc = compare?.review?.hasCompare ? `${afterSrc}?compare=1` : afterSrc

  return (
    <section className="ap-stage-panel ap-live-studio" aria-label={t('autopilot.live.aria')}>
      <div className="ap-studio-card">
        <header className="ap-studio-head">
          <span className="ap-live-pill">
            <span className="ap-live-dot" aria-hidden="true" />
            {t('autopilot.live.badge')}
          </span>
          {total > 0 && (
            <span className="ap-batch-pill">
              {done} / {total}
            </span>
          )}
        </header>

        <h2 className="ap-studio-title">
          {stage?.activeTask?.title || stage?.activeJob?.seed || t('autopilot.live.building')}
        </h2>

        <ol className="ap-step-track">
          {LIVE_STEPS.map((key, idx) => (
            <li
              key={key}
              className={`ap-step-node${idx < stepIdx ? ' done' : idx === stepIdx ? ' current' : ''}`}
            >
              <span className="ap-step-dot" aria-hidden="true" />
              <span className="ap-step-label">{t(key)}</span>
            </li>
          ))}
        </ol>

        <div className="ap-progress-rail" aria-hidden="true">
          <div className="ap-progress-fill" style={{ width: `${Math.max(12, pct)}%` }} />
        </div>

        <div className="ap-ticker-box" role="status">
          <span className="ap-ticker-text">{t(stage?.activityKey || 'autopilot.live.actWorking')}</span>
          {stage?.toolLabel && <span className="ap-ticker-sub">{stage.toolLabel}</span>}
        </div>

        <LiveRadarCard initialLive={stage?.live || null} />

        {afterSrc && (
          <div className="ap-wipe-inline">
            <div className="ap-wipe-stage">
              <img src={afterSrc} alt={t('autopilot.wipe.after')} className="ap-wipe-img" />
              <div className="ap-wipe-before" style={{ width: `${split}%` }}>
                <img src={beforeSrc} alt={t('autopilot.wipe.before')} className="ap-wipe-img" />
              </div>
              <div className="ap-wipe-divider" style={{ left: `${split}%` }} aria-hidden="true" />
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={split}
              onChange={(e) => setSplit(Number(e.target.value))}
              aria-label={t('autopilot.wipe.sliderAria')}
              className="ap-wipe-slider"
            />
          </div>
        )}

        {memoOpen ? (
          <form
            className="ap-remix-note-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (memoText.trim()) {
                onSaveMemo?.(memoText.trim())
                setMemoText('')
                setMemoOpen(false)
              }
            }}
          >
            <input
              type="text"
              className="ap-remix-input"
              value={memoText}
              onChange={(e) => setMemoText(e.target.value)}
              placeholder={t('autopilot.live.memoPlaceholder')}
            />
            <button type="submit" className="ap-remix-send">{t('autopilot.live.memoSend')}</button>
          </form>
        ) : (
          <footer className="ap-studio-foot">
            <button
              type="button"
              className="ap-pill-ghost"
              onClick={() => {
                haptic('tap')
                setMemoOpen(true)
              }}
            >
              💬 {t('autopilot.live.addMemo')}
            </button>
            {onSwitchCockpit && (
              <button type="button" className="ap-pill-ghost" onClick={onSwitchCockpit}>
                🎛 {t('autopilot.live.inspect')}
              </button>
            )}
          </footer>
        )}
      </div>
    </section>
  )
}

/**
 * 第4幕: 完成＆成果物ランチカード（URLリンク / 起動コマンド1タップコピー / 完了レシート）。
 */
export function CompletionCard({ deliverable, onOpenReceipt, onStartNew, onSwitchCockpit, notify }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const copyCmd = async () => {
    if (!deliverable?.launchCmd) return
    try {
      await globalThis.navigator?.clipboard?.writeText?.(deliverable.launchCmd)
      haptic('success')
      setCopied(true)
      notify?.(t('autopilot.complete.copied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      notify?.(deliverable.launchCmd)
    }
  }

  return (
    <section className="ap-stage-panel ap-complete-panel" aria-label={t('autopilot.complete.aria')}>
      <div className="ap-complete-card">
        <div className="ap-complete-ribbon">🏆 {t('autopilot.complete.badge')}</div>
        <h2 className="ap-complete-title">{deliverable?.title || t('autopilot.complete.title')}</h2>
        {deliverable?.summary && <p className="ap-complete-summary">{deliverable.summary}</p>}

        {deliverable?.shotUrl && (
          <BeforeAfterTimelapse
            beforeUrl={deliverable.beforeShotUrl}
            afterUrl={deliverable.shotUrl}
            title={deliverable.title}
            t={t}
          />
        )}

        <div className="ap-deliverable-actions">
          {deliverable?.previewUrl && (
            <a
              href={deliverable.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ap-deliverable-btn primary"
              onClick={() => haptic('action')}
            >
              🌐 {t('autopilot.complete.openPreview')} ↗
            </a>
          )}
          {deliverable?.launchCmd && (
            <button type="button" className="ap-deliverable-btn cmd" onClick={copyCmd}>
              <code>{deliverable.launchCmd}</code>
              <span>{copied ? '✓' : '📋'}</span>
            </button>
          )}
          {!deliverable?.previewUrl && !deliverable?.launchCmd && deliverable?.entryPath && (
            <div className="ap-deliverable-path">{deliverable.entryPath}</div>
          )}
        </div>

        <div className="ap-complete-row">
          {onOpenReceipt && (
            <button
              type="button"
              className="ap-pill-ghost"
              onClick={() => {
                haptic('tap')
                onOpenReceipt()
              }}
            >
              🧾 {t('autopilot.complete.receipt')}
            </button>
          )}
          {onSwitchCockpit && (
            <button type="button" className="ap-pill-ghost" onClick={onSwitchCockpit}>
              🎛 {t('autopilot.openCockpit')}
            </button>
          )}
        </div>

        {onStartNew && (
          <button
            type="button"
            className="ap-launcher-submit"
            onClick={() => {
              haptic('action')
              onStartNew()
            }}
          >
            ✨ {t('autopilot.complete.startNext')}
          </button>
        )}
      </div>
    </section>
  )
}
