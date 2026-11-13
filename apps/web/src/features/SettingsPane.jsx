import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useInstallState, swState } from '../lib/useInstallState.js'
import { diagnosePwa } from '../lib/pwaDiagnose.js'
import { RefreshButton, Sheet, Spinner, fmtBytes, fmtDateTime, relTime } from '../components/Ui.jsx'
import { haptic, isHapticEnabled, setHapticEnabled } from '../lib/haptic.js'
import { useI18n } from '../i18n/index.js'
import { LANGS } from '../i18n/lang.js'
import { useTheme } from '../lib/useTheme.js'

/**
 * 設定タブ。状態の参照・ログ末尾・監査ログ（キルスイッチの履歴）を置く。
 * 破壊的操作はタスクタブの「緊急操作」に集約し、ここは読み取り中心。
 * 表示言語（Auto / English / 日本語）の切替もここに置く（SPEC §6.1）。
 */

/** インストール形態の判定（WebAPK は referrer が android-app://…）。表示名は呼び出し側で訳す。 */
function launchSourceKind() {
  try {
    const ref = document.referrer || ''
    if (ref.startsWith('android-app://')) return 'webapk'
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
    return standalone ? 'standalone' : 'browser'
  } catch {
    return 'unknown'
  }
}

/** 言語セレクタの選択肢（`Auto` は端末の言語に従う）。 */
const LANG_CHOICES = [
  { value: 'auto', key: 'settings.languageAuto' },
  ...LANGS.map((l) => ({ value: l, key: l === 'ja' ? 'settings.languageJa' : 'settings.languageEn' })),
]

/** テーマの選択肢（SPEC §7.1。`System` は端末の明暗に従う）。 */
const THEME_CHOICES = [
  { value: 'dark', key: 'settings.themeDark' },
  { value: 'light', key: 'settings.themeLight' },
  { value: 'system', key: 'settings.themeSystem' },
]

/**
 * ペアリング QR を canvas に**整数ピクセル**で描く。
 *
 * SVG を CSS で縮小すると 1 モジュールが 6.34px のような半端な幅になり、
 * アンチエイリアスで境界がぼやけてスキャナが反応しない（実測）。canvas なら
 * モジュール幅を整数に固定でき、devicePixelRatio でもシャープに描ける。
 * @param {object} props 入力
 * @param {string[]} props.rows 0/1 の行（'1' = 暗モジュール）
 * @param {number} [props.margin] 余白モジュール数
 * @param {number} [props.size] 目標の表示サイズ（px）
 * @returns {React.ReactElement} canvas
 */
function PairQr({ rows, margin = 4, size = 300 }) {
  const ref = React.useRef(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !rows?.length) return
    const n = rows.length + margin * 2
    const scale = Math.max(2, Math.floor(size / n))
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const px = n * scale
    const unit = Math.round(scale * dpr)
    c.width = px * dpr
    c.height = px * dpr
    c.style.width = `${px}px`
    c.style.height = `${px}px`
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = false
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#000000'
    for (let y = 0; y < rows.length; y += 1) {
      for (let x = 0; x < rows[y].length; x += 1) {
        if (rows[y][x] !== '1') continue
        g.fillRect((x + margin) * unit, (y + margin) * unit, unit, unit)
      }
    }
  }, [rows, margin, size])
  return <canvas ref={ref} className="pair-qr-canvas" role="img" aria-label="Pairing QR" />
}

export function SettingsPane({ overview, notify, refresh }) {
  const { t, pref, setPref } = useI18n()
  const { pref: themePref, setPref: setThemePref } = useTheme()
  const install = useInstallState()
  const [diag, setDiag] = useState(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [audit, setAudit] = useState(null)
  const [log, setLog] = useState(null)
  const [logName, setLogName] = useState('gateway')
  const [sessions, setSessions] = useState([])
  const [hapticOn, setHapticOn] = useState(() => isHapticEnabled())

  // リポジトリ（自動スキャン先・追加・非表示）。SPEC §5.1
  const [repoList, setRepoList] = useState([])
  const [scanDirs, setScanDirs] = useState([])
  const [scanDraft, setScanDraft] = useState('')
  const [pathDraft, setPathDraft] = useState('')
  const [repoBusy, setRepoBusy] = useState(false)

  // マイスニペット
  const [custom, setCustom] = useState([])
  const [customMax, setCustomMax] = useState(12)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftText, setDraftText] = useState('')
  const [draftHot, setDraftHot] = useState(false)
  const [saving, setSaving] = useState(false)

  // ペアリング QR（SPEC §8.2）。認証済みセッションから 2 台目を迎える。
  const [pairing, setPairing] = useState(null)
  const [pairBusy, setPairBusy] = useState(false)

  const openPairing = useCallback(async () => {
    haptic('tap')
    setPairBusy(true)
    try {
      const d = await api('/api/auth/pairing')
      setPairing(d)
    } catch (e) {
      notify?.(e.message)
    } finally {
      setPairBusy(false)
    }
  }, [notify])

  const copyPairUrl = useCallback(
    async (url) => {
      try {
        await navigator.clipboard.writeText(url)
        notify?.(t('settings.pairingCopied'))
      } catch {
        notify?.(url)
      }
    },
    [notify, t],
  )

  const loadSnippets = useCallback(async () => {
    try {
      const d = await api('/api/snippets')
      setCustom((d.snippets ?? []).filter((s) => s.custom).map((s) => ({ id: s.id, label: s.label, text: s.text, hot: s.hot })))
      setCustomMax(d.customMax ?? 12)
    } catch (e) {
      notify(e.message)
    }
  }, [notify])

  const saveSnippets = useCallback(
    async (next) => {
      setSaving(true)
      try {
        const d = await api('/api/snippets', { method: 'PUT', body: { custom: next } })
        setCustom((d.custom ?? []).map((s) => ({ id: s.id, label: s.label, text: s.text, hot: s.hot })))
        window.dispatchEvent(new Event('hm:snippets'))
        notify(t('settings.saved'))
      } catch (e) {
        notify(e.message)
      } finally {
        setSaving(false)
      }
    },
    [notify, t],
  )

  const addDraft = () => {
    const label = draftLabel.trim()
    const text = draftText.trim()
    if (!label || !text) return notify(t('settings.needNameAndText'))
    if (custom.length >= customMax) return notify(t('settings.snippetLimit', { max: customMax }))
    saveSnippets([...custom, { label, text, hot: draftHot }])
    setDraftLabel('')
    setDraftText('')
    setDraftHot(false)
  }

  const loadRepos = useCallback(async () => {
    try {
      const d = await api('/api/repos')
      setRepoList(Array.isArray(d?.repos) ? d.repos : [])
      setScanDirs(Array.isArray(d?.scanDirs) ? d.scanDirs : [])
      return true
    } catch (e) {
      notify(e.message)
      return false
    }
  }, [notify])

  /** リポジトリ設定の書き込み（追加・削除・走査先の更新）。 */
  const saveRepos = useCallback(
    async ({ method = 'POST', path = '/api/repos', body, done }) => {
      setRepoBusy(true)
      try {
        const d = await api(path, { method, body })
        setRepoList(Array.isArray(d?.repos) ? d.repos : [])
        if (Array.isArray(d?.scanDirs)) setScanDirs(d.scanDirs)
        notify(done)
        return true
      } catch (e) {
        notify(e.message)
        return false
      } finally {
        setRepoBusy(false)
      }
    },
    [notify],
  )

  const loadAudit = useCallback(async () => {
    try {
      const d = await api('/api/audit?lines=80')
      setAudit(d.lines ?? [])
      return true
    } catch (e) {
      notify(e.message)
      return false
    }
  }, [notify])

  useEffect(() => {
    loadAudit()
    loadSnippets()
    loadRepos()
    api('/api/sessions?limit=5')
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {})
  }, [loadAudit, loadSnippets, loadRepos])

  const openLog = async (name) => {
    try {
      const d = await api(`/api/logs?file=${encodeURIComponent(name)}&lines=200`)
      setLog({ name: d.file, text: d.text })
    } catch (e) {
      notify(e.message)
    }
  }

  const mem = overview?.system?.memory
  const disk = overview?.system?.disk
  const bridge = overview?.bridge
  const kanbanStats = overview?.kanban

  const sourceKind = launchSourceKind()
  const sourceLabel =
    sourceKind === 'standalone'
      ? t('settings.standalone')
      : sourceKind === 'browser'
        ? t('settings.browser')
        : sourceKind === 'webapk'
          ? 'WebAPK'
          : '—'

  return (
    <div className="pane center-readable">
      <div className="list-head">
        <span>{t('settings.language')}</span>
      </div>
      <div className="chips" style={{ marginBottom: 10 }}>
        {LANG_CHOICES.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`chip${pref === o.value ? ' on' : ''}`}
            aria-pressed={pref === o.value}
            onClick={() => {
              haptic('tap')
              setPref(o.value)
            }}
          >
            {t(o.key)}
          </button>
        ))}
      </div>

      {/* テーマ（SPEC §7.1）。Dark が既定、System は端末の明暗に追従する */}
      <div className="list-head">
        <span>{t('settings.theme')}</span>
      </div>
      <div className="chips" style={{ marginBottom: 10 }} role="group" aria-label={t('settings.theme')}>
        {THEME_CHOICES.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`chip${themePref === o.value ? ' on' : ''}`}
            aria-pressed={themePref === o.value}
            onClick={() => {
              haptic('tap')
              setThemePref(o.value)
            }}
          >
            {t(o.key)}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="kv">
          <span>Hermes</span>
          <b>{overview?.hermes?.version ?? '—'}</b>
        </div>
        <div className="kv">
          <span>{t('settings.model')}</span>
          <b>{overview?.hermes?.model ?? '—'}</b>
        </div>
        <div className="kv">
          <span>{t('settings.memory')}</span>
          <b>
            {mem
              ? t('settings.memoryValue', { used: fmtBytes(mem.used), total: fmtBytes(mem.total), percent: mem.percent })
              : '—'}
          </b>
        </div>
        <div className="kv">
          <span>{t('settings.disk')}</span>
          <b>{disk ? t('settings.diskValue', { free: fmtBytes(disk.free), percent: disk.percent }) : '—'}</b>
        </div>
        <div className="kv">
          <span>{t('settings.bridge')}</span>
          <b className={bridge?.ok === false ? 'bad-text' : ''}>
            {bridge ? (bridge.ok ? t('settings.bridgeOk', { uptime: bridge.uptimeSec }) : t('settings.disconnected')) : '—'}
          </b>
        </div>
        <div className="kv">
          <span>{t('settings.reviewWaiting')}</span>
          <b>
            {kanbanStats
              ? t('settings.kanbanValue', { waiting: kanbanStats.reviewWaiting, running: kanbanStats.running })
              : '—'}
          </b>
        </div>
        <div className="kv">
          <span>{t('settings.lastChecked')}</span>
          <b>{relTime(overview?.checkedAt)}</b>
        </div>
        <div className="kv">
          <span>{t('settings.launchSource')}</span>
          <b>{sourceLabel}</b>
        </div>
        <div className="kv">
          <span>{t('settings.installability')}</span>
          <b>
            {install.available
              ? t('settings.installPossible')
              : install.installed
                ? t('settings.installDone')
                : t('settings.installNo')}
          </b>
        </div>
        <div className="kv">
          <span>Service Worker</span>
          <b>{swState()}</b>
        </div>
        <div className="kv" style={{ alignItems: 'center' }}>
          <span>{t('settings.haptics')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={hapticOn}
            aria-label={t('settings.haptics')}
            className={`hm-switch${hapticOn ? ' on' : ''}`}
            onClick={() => {
              const next = setHapticEnabled(!hapticOn)
              setHapticOn(next)
              if (next) haptic('tap')
            }}
          >
            <span className="hm-switch-knob" />
          </button>
        </div>
        <button
          className="btn hm-btn-inner"
          style={{ marginTop: 8 }}
          disabled={diagBusy}
          aria-busy={diagBusy}
          onClick={async () => {
            haptic('tap')
            setDiagBusy(true)
            try {
              const rows = await diagnosePwa()
              setDiag(rows)
              // 端末の状態をホスト側でも読めるように送る（設定タブをスクショしなくて済む）
              api('/api/client-error', {
                method: 'POST',
                body: {
                  kind: 'pwa-diag',
                  href: location.href,
                  referrer: document.referrer || '',
                  displayMode: ['standalone', 'minimal-ui', 'fullscreen', 'browser']
                    .filter((m) => matchMedia(`(display-mode: ${m})`).matches)
                    .join(','),
                  rows,
                },
              }).catch(() => {})
            } finally {
              setDiagBusy(false)
            }
          }}
        >
          {diagBusy ? <Spinner size={14} /> : null}
          <span>{diagBusy ? t('settings.diagRunning') : t('settings.diagRun')}</span>
        </button>
        {diag && (
          <div className="diag" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5 }}>
            {diag.map((r) => (
              <div key={r.label} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                <span style={{ color: r.ok ? '#4ade80' : '#f87171', flex: '0 0 auto' }}>{r.ok ? '✓' : '✗'}</span>
                <span style={{ flex: '1 1 auto', color: r.ok ? 'var(--text)' : '#fca5a5' }}>{r.label}</span>
                <span style={{ flex: '1 1 50%', color: 'var(--muted)', wordBreak: 'break-all', textAlign: 'right' }}>
                  {r.detail}
                </span>
              </div>
            ))}
          </div>
        )}
        {install.available && (
          <button
            className="btn primary"
            style={{ marginTop: 8 }}
            onClick={async () => {
              const r = await install.prompt()
              notify?.(
                r === 'accepted' ? t('settings.installPromptAccepted') : t('settings.installPromptCancelled'),
              )
            }}
          >
            {t('settings.installApp')}
          </button>
        )}
        <RefreshButton
          label={t('settings.refresh')}
          ariaLabel={t('settings.refreshAria')}
          className="hm-btn-inner"
          onRefresh={async () => Boolean(await refresh?.())}
        />
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <div className="row-title">{t('settings.pairing')}</div>
        <div className="row-sub" style={{ marginTop: 4, lineHeight: 1.6 }}>
          {t('settings.pairingHint')}
        </div>
        <button className="btn hm-btn-inner" style={{ marginTop: 10 }} disabled={pairBusy} onClick={openPairing}>
          {pairBusy ? <Spinner size={14} /> : null}
          <span>{pairBusy ? t('settings.pairingLoading') : t('settings.showPairingQr')}</span>
        </button>
      </div>

      <div className="list-head">
        <span>{t('settings.recentSessions')}</span>
      </div>
      <div className="list">
        {sessions.map((s) => (
          <div key={s.id} className="row static">
            <span className={`dot ${s.active ? 'running' : 'done'}`} />
            <span className="row-main">
              <span className="row-title">{s.title ?? s.id}</span>
              <span className="row-sub">
                {s.source} ・ {s.messages} msg ・ {s.lastActivity ?? ''}
              </span>
            </span>
          </div>
        ))}
        {!sessions.length ? <div className="empty">{t('settings.none')}</div> : null}
      </div>

      <div className="list-head">
        <span>{t('settings.repos', { count: repoList.length })}</span>
        <button
          className="link"
          disabled={repoBusy}
          onClick={async () => {
            haptic('tap')
            await saveRepos({ path: '/api/repos/scan', done: t('settings.rescanned') })
          }}
        >
          {t('settings.rescan')}
        </button>
      </div>
      <div className="list">
        {repoList.map((r) => (
          <div key={r.id} className="row static">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">
                {r.label}
                {r.source === 'custom' ? (
                  <span className="pill" style={{ marginLeft: 8 }}>
                    {t('settings.manual')}
                  </span>
                ) : null}
              </span>
              <span className="row-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('settings.repoLine', { path: r.path, source: r.source, count: r.boards?.length ?? 0 })}
              </span>
            </span>
            <button
              className="link"
              disabled={repoBusy}
              onClick={() =>
                saveRepos({
                  method: 'DELETE',
                  path: `/api/repos/${encodeURIComponent(r.id)}`,
                  done: t('settings.hidden'),
                })
              }
            >
              {t('settings.hide')}
            </button>
          </div>
        ))}
        {!repoList.length ? <div className="empty">{t('settings.reposEmpty')}</div> : null}
      </div>

      <div className="list-head">
        <span>{t('settings.scanDirs')}</span>
      </div>
      <div className="list">
        {scanDirs.map((d) => (
          <div key={d} className="row static">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title mono">{d}</span>
            </span>
            <button
              className="link"
              disabled={repoBusy}
              onClick={() =>
                saveRepos({ body: { scanDirs: scanDirs.filter((x) => x !== d) }, done: t('settings.removed') })
              }
            >
              {t('settings.delete')}
            </button>
          </div>
        ))}
        {!scanDirs.length ? <div className="empty">{t('settings.scanDirsEmpty')}</div> : null}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <input
          className="inp"
          placeholder={t('settings.scanDirPlaceholder')}
          maxLength={200}
          value={scanDraft}
          onChange={(e) => setScanDraft(e.target.value)}
        />
        <button
          className="btn"
          disabled={repoBusy || !scanDraft.trim()}
          style={{ marginTop: 8 }}
          onClick={async () => {
            const next = [...scanDirs, scanDraft.trim()]
            if (await saveRepos({ body: { scanDirs: next }, done: t('settings.scanDirAdded') })) setScanDraft('')
          }}
        >
          {t('settings.addScanDir')}
        </button>
        <input
          className="inp"
          placeholder={t('settings.repoPathPlaceholder')}
          maxLength={300}
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          style={{ marginTop: 8 }}
        />
        <button
          className="btn"
          disabled={repoBusy || !pathDraft.trim()}
          style={{ marginTop: 8 }}
          onClick={async () => {
            if (await saveRepos({ body: { path: pathDraft.trim() }, done: t('settings.repoAdded') })) setPathDraft('')
          }}
        >
          {t('settings.addRepo')}
        </button>
      </div>

      <div className="list-head">
        <span>{t('settings.logs')}</span>
      </div>
      <div className="row">
        {['gateway', 'errors', 'agent'].map((n) => (
          <button
            key={n}
            className="chip"
            onClick={() => {
              haptic('tap')
              openLog(n)
            }}
            style={{ marginRight: 6 }}
          >
            {n}.log
          </button>
        ))}
      </div>

      <div className="list-head">
        <span>{t('settings.audit')}</span>
        <RefreshButton variant="link" onRefresh={loadAudit} />
      </div>
      <div className="list">
        {(audit ?? []).slice().reverse().map((a, i) => (
          <div key={i} className="row static">
            <span className="row-main">
              <span className="row-title">{a.kind}</span>
              <span className="row-sub">
                {fmtDateTime(a.at)}
                {a.task ? ` ・ ${a.task}` : ''}
                {a.action ? ` ・ ${a.action}` : ''}
                {a.ok === false ? ` ・ ${t('settings.auditFailed')}` : ''}
              </span>
            </span>
          </div>
        ))}
        {!(audit ?? []).length ? <div className="empty">{t('settings.auditEmpty')}</div> : null}
      </div>

      <div className="list-head">
        <span>{t('settings.customSnippets', { count: custom.length, max: customMax })}</span>
      </div>
      <div className="list">
        {custom.map((s) => (
          <div key={s.id} className="row static">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">
                {s.label}
                {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>{t('settings.bar')}</span> : null}
              </span>
              <span className="row-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.text.replace(/\n/g, ' ')}
              </span>
            </span>
            <button
              className="link"
              disabled={saving}
              onClick={() => saveSnippets(custom.filter((x) => x.id !== s.id))}
            >
              {t('settings.delete')}
            </button>
          </div>
        ))}
        {!custom.length ? <div className="empty">{t('settings.snippetsEmpty')}</div> : null}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <input
          className="inp"
          placeholder={t('settings.snippetNamePlaceholder')}
          maxLength={20}
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
        />
        <textarea
          className="inp"
          placeholder={t('settings.snippetTextPlaceholder')}
          rows={3}
          maxLength={400}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          style={{ marginTop: 8, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <label className="row-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={draftHot} onChange={(e) => setDraftHot(e.target.checked)} />
          {t('settings.showInBar')}
        </label>
        <button className="btn" onClick={addDraft} disabled={saving || custom.length >= customMax} style={{ marginTop: 10 }}>
          {saving ? t('settings.saving') : t('settings.addAndSave')}
        </button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row-sub" style={{ lineHeight: 1.7 }}>
          {t('settings.about', { version: '0.1.0' })}{' '}
          <span className="mono">~/.hermes/plugin-data/hermes-pilot/token</span>
        </div>
      </div>

      {log ? (
        <Sheet title={log.name} onClose={() => setLog(null)}>
          <pre className="logbox">{log.text}</pre>
        </Sheet>
      ) : null}

      {pairing ? (
        <Sheet title={t('settings.pairingTitle')} onClose={() => setPairing(null)}>
          <div className="row-sub" style={{ lineHeight: 1.6 }}>
            {t('settings.pairingScanHint')}
          </div>
          {pairing.qrPng ? (
            <div className="pair-qr">
              <img className="pair-qr-img" src={pairing.qrPng} width={287} height={287} alt="Pairing QR" />
            </div>
          ) : pairing.qrRows ? (
            <div className="pair-qr">
              <PairQr
                rows={pairing.qrRows}
                margin={pairing.qrMargin ?? 4}
                size={Math.min(320, Math.max(220, (typeof window !== 'undefined' ? window.innerWidth : 390) - 70))}
              />
            </div>
          ) : pairing.qrSvg ? (
            <div className="pair-qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          ) : (
            <div className="empty">{t('settings.pairingEmpty')}</div>
          )}
          <div className="list" style={{ marginTop: 10 }}>
            {(pairing.targets ?? []).map((target) => (
              <div key={target.url} className="row static">
                <span className="row-main" style={{ minWidth: 0 }}>
                  <span className="row-title">{target.label}</span>
                  <span
                    className="row-sub mono"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {target.url}
                  </span>
                </span>
                <button className="link" onClick={() => copyPairUrl(target.url)}>
                  {t('settings.pairingCopy')}
                </button>
              </div>
            ))}
          </div>
          <div className="row-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>
            {t('settings.pairingNote')}
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
