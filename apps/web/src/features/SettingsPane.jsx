import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useInstallState, swState } from '../lib/useInstallState.js'
import { diagnosePwa } from '../lib/pwaDiagnose.js'
import { RefreshButton, Sheet, Spinner, fmtBytes, fmtDateTime, relTime } from '../components/Ui.jsx'
import { haptic, isHapticEnabled, setHapticEnabled } from '../lib/haptic.js'
import { getActiveVibe, onVibeChange, setVibe } from '../lib/vibe.js'
import { isSoundEnabled, playSound, setSoundEnabled } from '../lib/soundFx.js'
import { foldAudit } from '../lib/auditFold.js'
import { useI18n } from '../i18n/index.js'
import { LANGS } from '../i18n/lang.js'
import { useTheme } from '../lib/useTheme.js'
import { PipelinePanel } from './PipelinePanel.jsx'
import { BOARD_KEY } from '../lib/repoPicker.js'

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

/** Vibe Mode の選択肢（SPEC-PILOT-V5 §3.1 / D24）。Serotonin でもハプティックは残る。 */
const VIBE_CHOICES = [
  { value: 'dopamine', key: 'settings.vibeDopamine' },
  { value: 'serotonin', key: 'settings.vibeSerotonin' },
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

/**
 * スニペット設定（チャット / 端末の共通モデル・SPEC §3.4 / D13）。
 * 組み込みの Hot / Hidden、ユーザー定義の追加・編集・削除、既定に戻す を扱う。
 * 保存に成功したら `hm:snippets` / `hm:term-snippets` を発火して各画面を即時再読込させる。
 */
function SnippetsSection({ notify, lang }) {
  const { t } = useI18n()
  const [kind, setKind] = useState('chat')
  const [data, setData] = useState({ chat: null, term: null })
  const [draft, setDraft] = useState({ label: '', text: '', hot: false, run: true })
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState(false)

  const path = kind === 'term' ? '/api/snippets/term' : '/api/snippets'
  const eventName = kind === 'term' ? 'hm:term-snippets' : 'hm:snippets'
  const cur = data[kind]
  const overrides = cur?.overrides ?? {}
  const custom = cur?.custom ?? []
  const customMax = cur?.customMax ?? 16
  const builtin = (cur?.allSnippets ?? []).filter((s) => !s.custom)
  const mine = (cur?.allSnippets ?? []).filter((s) => s.custom)

  const load = useCallback(async () => {
    try {
      const d = await api(`${path}?lang=${encodeURIComponent(lang)}`)
      setData((prev) => ({ ...prev, [kind]: d }))
    } catch (e) {
      notify(e.message)
    }
  }, [path, kind, lang, notify])

  useEffect(() => {
    load()
  }, [load])

  const save = useCallback(
    async (body, done) => {
      setBusy(true)
      try {
        const d = await api(path, { method: 'PUT', body })
        setData((prev) => ({ ...prev, [kind]: d }))
        window.dispatchEvent(new Event(eventName))
        if (done) notify(done)
        return true
      } catch (e) {
        notify(e.message)
        return false
      } finally {
        setBusy(false)
      }
    },
    [path, kind, eventName, notify],
  )

  /** 組み込みの Hot を切り替える（override を書く）。 */
  const toggleHot = (s) =>
    save({ overrides: { ...overrides, [s.id]: { ...(overrides[s.id] ?? {}), hot: !s.hot } } })

  /** 組み込みの表示 / 非表示を切り替える。 */
  const toggleHidden = (s) =>
    save({ overrides: { ...overrides, [s.id]: { ...(overrides[s.id] ?? {}), hidden: !s.hidden } } })

  /** ユーザー定義を丸ごと保存する（追加・編集・削除の共通経路）。 */
  const saveCustom = (list, done) => save({ custom: list }, done)

  const toggleCustomHot = (s) =>
    saveCustom(custom.map((x) => (x.id === s.id ? { ...x, hot: !x.hot } : x)))

  const addDraft = async () => {
    const label = draft.label.trim()
    const text = draft.text.trim()
    if (!label || !text) return notify(t('settings.needNameAndText'))
    if (custom.length >= customMax) return notify(t('settings.snippetLimit', { max: customMax }))
    const item = { label, text, hot: draft.hot }
    if (kind === 'term') item.run = draft.run
    const ok = await saveCustom([...custom, item], t('settings.saved'))
    if (ok) setDraft({ label: '', text: '', hot: false, run: true })
  }

  const saveEdit = async () => {
    if (!edit) return
    const label = edit.label.trim()
    const text = edit.text.trim()
    if (!label || !text) return notify(t('settings.needNameAndText'))
    const next = custom.map((x) =>
      x.id === edit.id ? { ...x, label, text, hot: edit.hot, ...(kind === 'term' ? { run: edit.run } : {}) } : x,
    )
    const ok = await saveCustom(next, t('settings.saved'))
    if (ok) setEdit(null)
  }

  /** 既定に戻す（チャット・端末の両方を初期化し、両画面に通知する・SPEC §3.4）。 */
  const resetDefaults = async () => {
    setBusy(true)
    try {
      const [chat, term] = await Promise.all([
        api('/api/snippets', { method: 'PUT', body: { reset: true } }),
        api('/api/snippets/term', { method: 'PUT', body: { reset: true } }),
      ])
      setData({ chat, term })
      setEdit(null)
      setDraft({ label: '', text: '', hot: false, run: true })
      window.dispatchEvent(new Event('hm:snippets'))
      window.dispatchEvent(new Event('hm:term-snippets'))
      notify(t('settings.snippetResetDone'))
    } catch (e) {
      notify(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* 見出しはカード共通の枠（SPEC §3.4-2）。右端に「既定に戻す」 */}
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">
          ⚡
        </span>
        <span className="settings-card-title">{t('settings.snippets')}</span>
        <span className="settings-card-action">
          <button className="link" disabled={busy} onClick={resetDefaults}>
            {t('settings.snippetReset')}
          </button>
        </span>
      </div>

      <div className="chips" role="group" aria-label={t('settings.snippets')} style={{ marginBottom: 10 }}>
        <button className={`chip${kind === 'chat' ? ' on' : ''}`} onClick={() => setKind('chat')}>
          {t('settings.snippetChat')}
        </button>
        <button className={`chip${kind === 'term' ? ' on' : ''}`} onClick={() => setKind('term')}>
          {t('settings.snippetTerm')}
        </button>
      </div>

      <div className="list-head">
        <span>{t('settings.snippetBuiltin')}</span>
      </div>
      <div className="list">
        {builtin.map((s) => (
          <div key={s.id} className="row static">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.label}
              </span>
              <span className="row-sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.text.replace(/\n/g, ' ')}
              </span>
            </span>
            <button
              className={`chip${s.hot ? ' on' : ''}`}
              disabled={busy}
              onClick={() => toggleHot(s)}
              aria-label={`${t('settings.snippetHot')} ${s.label}`}
            >
              {t('settings.snippetHot')}
            </button>
            <button
              className={`chip${s.hidden ? '' : ' on'}`}
              disabled={busy}
              onClick={() => toggleHidden(s)}
              aria-label={`${s.hidden ? t('settings.snippetShow') : t('settings.snippetHide')} ${s.label}`}
            >
              {s.hidden ? t('settings.snippetShow') : t('settings.snippetHide')}
            </button>
          </div>
        ))}
        {!builtin.length ? <div className="empty">{t('settings.snippetsEmpty')}</div> : null}
      </div>

      <div className="list-head">
        <span>{t('settings.customSnippets', { count: custom.length, max: customMax })}</span>
      </div>
      <div className="list">
        {mine.map((s) => (
          <div key={s.id} className="row static">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">
                {s.label}
                {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>{t('settings.bar')}</span> : null}
                {kind === 'term' && s.run ? <span className="pill" style={{ marginLeft: 6 }}>{t('term.run')}</span> : null}
                {s.hidden ? <span className="pill" style={{ marginLeft: 6 }}>{t('settings.snippetHiddenPill')}</span> : null}
              </span>
              <span className="row-sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.text.replace(/\n/g, ' ')}
              </span>
            </span>
            <button className="link" disabled={busy} onClick={() => toggleCustomHot(s)}>
              {t('settings.snippetHot')}
            </button>
            <button
              className="link"
              disabled={busy}
              onClick={() => setEdit({ id: s.id, label: s.label, text: s.text, hot: s.hot, run: s.run !== false })}
            >
              {t('settings.snippetEdit')}
            </button>
            <button className="link" disabled={busy} onClick={() => saveCustom(custom.filter((x) => x.id !== s.id))}>
              {t('settings.delete')}
            </button>
          </div>
        ))}
        {!mine.length ? <div className="empty">{t('settings.snippetsEmpty')}</div> : null}
      </div>

      {edit ? (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row-sub" style={{ marginBottom: 8 }}>{t('settings.snippetEditTitle')}</div>
          <input
            className="inp"
            placeholder={t('settings.snippetNamePlaceholder')}
            maxLength={20}
            value={edit.label}
            onChange={(e) => setEdit({ ...edit, label: e.target.value })}
          />
          <textarea
            className="inp"
            placeholder={kind === 'term' ? t('settings.snippetCommandPlaceholder') : t('settings.snippetTextPlaceholder')}
            rows={3}
            maxLength={400}
            value={edit.text}
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            style={{ marginTop: 8, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <label className="row-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input type="checkbox" checked={edit.hot} onChange={(e) => setEdit({ ...edit, hot: e.target.checked })} />
            {t('settings.showInBar')}
          </label>
          {kind === 'term' ? (
            <label className="row-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <input type="checkbox" checked={edit.run} onChange={(e) => setEdit({ ...edit, run: e.target.checked })} />
              {t('settings.snippetRun')}
            </label>
          ) : null}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy} onClick={saveEdit}>
              {t('settings.snippetSave')}
            </button>
            <button className="link" style={{ marginLeft: 10 }} onClick={() => setEdit(null)}>
              {t('settings.snippetCancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginTop: 10 }}>
        <div className="row-sub" style={{ marginBottom: 8 }}>{t('settings.snippetAddTitle')}</div>
        <input
          className="inp"
          placeholder={t('settings.snippetNamePlaceholder')}
          maxLength={20}
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
        <textarea
          className="inp"
          placeholder={kind === 'term' ? t('settings.snippetCommandPlaceholder') : t('settings.snippetTextPlaceholder')}
          rows={3}
          maxLength={400}
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          style={{ marginTop: 8, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <label className="row-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={draft.hot} onChange={(e) => setDraft({ ...draft, hot: e.target.checked })} />
          {t('settings.showInBar')}
        </label>
        {kind === 'term' ? (
          <label className="row-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <input type="checkbox" checked={draft.run} onChange={(e) => setDraft({ ...draft, run: e.target.checked })} />
            {t('settings.snippetRun')}
          </label>
        ) : null}
        <button
          className="btn"
          onClick={addDraft}
          disabled={busy || custom.length >= customMax}
          style={{ marginTop: 10 }}
        >
          {busy ? t('settings.saving') : t('settings.snippetAdd')}
        </button>
      </div>

      <div className="row-sub" style={{ padding: '10px 6px 0', lineHeight: 1.7 }}>
        {t('settings.snippetHint')}
      </div>
    </>
  )
}

/** 設定タブのショートカットナビ（SPEC-PILOT-V3 §3.4）。並び順がカードの並び順。 */
const SECTIONS = [
  { id: 'sec-appearance', icon: '🎨', key: 'settings.secAppearance' },
  { id: 'sec-pairing', icon: '📱', key: 'settings.secPairing' },
  { id: 'sec-snippets', icon: '⚡', key: 'settings.secSnippets' },
  { id: 'sec-pipeline', icon: '🏗️', key: 'settings.secPipeline' },
  { id: 'sec-repos', icon: '📁', key: 'settings.secRepos' },
  { id: 'sec-audit', icon: '🛡️', key: 'settings.secAudit' },
  { id: 'sec-status', icon: '🩺', key: 'settings.secStatus' },
]

/** カード見出し（アイコン＋見出し＋右端の操作）。6 カードで共通の枠。 */
function CardHead({ icon, title, action }) {
  return (
    <div className="settings-card-head">
      <span className="settings-card-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-card-title">{title}</span>
      {action ? <span className="settings-card-action">{action}</span> : null}
    </div>
  )
}

export function SettingsPane({ overview, notify, refresh }) {
  const { lang, t, pref, setPref } = useI18n()
  const { pref: themePref, setPref: setThemePref } = useTheme()
  const install = useInstallState()
  const [diag, setDiag] = useState(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [audit, setAudit] = useState(null)
  /** 監査ログ 9 件目以降の展開状態（SPEC §3.4）。 */
  const [auditExpanded, setAuditExpanded] = useState(false)
  const [log, setLog] = useState(null)
  const [logName, setLogName] = useState('gateway')
  const [sessions, setSessions] = useState([])
  const [hapticOn, setHapticOn] = useState(() => isHapticEnabled())
  // Vibe Mode と効果音（SPEC-PILOT-V5 §3.1 / D24）。切替はその場で `<html data-vibe>` に効く
  const [vibeMode, setVibeMode] = useState(() => getActiveVibe())
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled())
  useEffect(() => onVibeChange(setVibeMode), [])

  // リポジトリ（自動スキャン先・追加・非表示）。SPEC §5.1
  const [repoList, setRepoList] = useState([])
  const [scanDirs, setScanDirs] = useState([])
  const [scanDraft, setScanDraft] = useState('')
  const [pathDraft, setPathDraft] = useState('')
  const [repoBusy, setRepoBusy] = useState(false)

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
    loadRepos()
    api('/api/sessions?limit=5')
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {})
  }, [loadAudit, loadRepos])

  const openLog = async (name) => {
    try {
      const d = await api(`/api/logs?file=${encodeURIComponent(name)}&lines=200`)
      setLog({ name: d.file, text: d.text })
    } catch (e) {
      notify(e.message)
    }
  }

  /** ショートカットチップ → 対象カードへスムーズスクロール（粘着バー分は scroll-margin で逃がす）。 */
  const scrollToSection = useCallback((id) => {
    haptic('tap')
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [])

  const mem = overview?.system?.memory
  const disk = overview?.system?.disk
  const bridge = overview?.bridge
  const kanbanStats = overview?.kanban

  // 監査ログは API が古い順で返すので、新しい順に直してから 8 件に折りたたむ（SPEC §3.4）
  const auditNewestFirst = Array.isArray(audit) ? audit.slice().reverse() : []
  const auditFold = foldAudit(auditNewestFirst, { expanded: auditExpanded })

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
      {/* 粘着ショートカットナビ（SPEC §3.4-1）。タップで各カードへ移動する */}
      <nav className="settings-nav" aria-label={t('settings.sections')}>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="settings-nav-chip" onClick={() => scrollToSection(s.id)}>
            <span aria-hidden="true">{s.icon}</span>
            <span>{t(s.key)}</span>
          </button>
        ))}
      </nav>

      {/* 1. 外観・端末 */}
      <section id="sec-appearance" className="card settings-card">
        <CardHead icon="🎨" title={t('settings.secAppearance')} />

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

        {/* Vibe Mode（SPEC-PILOT-V5 §3.1 / D24）。画面切替なしで 1 タップ */}
        <div className="list-head">
          <span>{t('settings.vibe')}</span>
        </div>
        <div className="chips" style={{ marginBottom: 6 }} role="group" aria-label={t('settings.vibe')}>
          {VIBE_CHOICES.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`chip vibe-chip${vibeMode === o.value ? ' on' : ''}`}
              aria-pressed={vibeMode === o.value}
              onClick={() => {
                haptic('tap')
                setVibe(o.value)
                setVibeMode(o.value)
                // Dopamine に切り替えた瞬間だけ「鳴る・光る」を確かめられるようにする
                if (o.value === 'dopamine') playSound('approve')
                notify?.(t('settings.vibeSwitched', { mode: t(o.key) }))
              }}
            >
              {t(o.key)}
            </button>
          ))}
        </div>
        <p className="row-sub" style={{ marginBottom: 8, lineHeight: 1.6 }}>
          {t('settings.vibeHint')}
        </p>

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

        {/* 効果音（Web Audio 合成・外部ファイルなし）。Dopamine のときだけ意味を持つ */}
        <div className="kv" style={{ alignItems: 'center', marginTop: 8 }}>
          <span>
            {t('settings.sound')}
            <span className="row-sub" style={{ display: 'block', lineHeight: 1.5, marginTop: 2 }}>
              {t('settings.soundHint')}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={soundOn}
            aria-label={t('settings.sound')}
            className={`hm-switch${soundOn ? ' on' : ''}`}
            onClick={() => {
              const next = setSoundEnabled(!soundOn)
              setSoundOn(next)
              haptic('tap')
              // ON にした瞬間に 1 音鳴らして確かめられるようにする（ユーザー操作内なので iOS でも鳴る）
              if (next) playSound('approve')
            }}
          >
            <span className="hm-switch-knob" />
          </button>
        </div>
      </section>

      {/* 2. ペアリング */}
      <section id="sec-pairing" className="card settings-card">
        <CardHead icon="📱" title={t('settings.secPairing')} />
        <div className="row-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
          {t('settings.pairingHint')}
        </div>
        <button className="btn hm-btn-inner" style={{ marginTop: 10 }} disabled={pairBusy} onClick={openPairing}>
          {pairBusy ? <Spinner size={14} /> : null}
          <span>{pairBusy ? t('settings.pairingLoading') : t('settings.showPairingQr')}</span>
        </button>
      </section>

      {/* 3. スニペット（見出しは SnippetsSection 側が描く） */}
      <section id="sec-snippets" className="card settings-card">
        <SnippetsSection notify={notify} lang={lang} />
      </section>

      {/* 4. パイプライン＆Architect（SPEC V5 §3.2・§3.3 / D25・D26①）
          Architect のランナー（Hermes Native / Opt-in agy）と 1 タップ環境最適化。 */}
      <section id="sec-pipeline" className="card settings-card">
        <CardHead icon="🏗️" title={t('settings.secPipeline')} />
        <PipelinePanel
          notify={notify}
          board={
            (() => {
              try {
                return localStorage.getItem(BOARD_KEY) ?? ''
              } catch {
                return ''
              }
            })()
          }
        />
      </section>

      {/* 4. リポジトリ管理 */}
      <section id="sec-repos" className="card settings-card">
        <CardHead
          icon="📁"
          title={t('settings.repos', { count: repoList.length })}
          action={
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
          }
        />
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

        <input
          className="inp"
          style={{ marginTop: 10 }}
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
      </section>

      {/* 5. 監査＆ログ（監査ログは最新 8 件＋アコーディオン） */}
      <section id="sec-audit" className="card settings-card">
        <CardHead
          icon="🛡️"
          title={t('settings.secAudit')}
          action={<RefreshButton variant="link" onRefresh={loadAudit} />}
        />

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
        </div>
        <div className="list">
          {auditFold.visible.map((a, i) => (
            <div key={`${a.at ?? 'x'}-${a.kind ?? ''}-${i}`} className="row static">
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
          {!auditFold.visible.length ? <div className="empty">{t('settings.auditEmpty')}</div> : null}
        </div>
        {auditFold.canExpand ? (
          <button
            type="button"
            className="btn settings-audit-more"
            aria-expanded={auditFold.expanded}
            style={{ marginTop: 8 }}
            onClick={() => {
              haptic('tap')
              setAuditExpanded((v) => !v)
            }}
          >
            {auditFold.expanded
              ? t('settings.auditCollapse')
              : t('settings.auditShowMore', { count: auditFold.hiddenCount })}
          </button>
        ) : null}
      </section>

      {/* 6. システム状態・診断 */}
      <section id="sec-status" className="card settings-card">
        <CardHead icon="🩺" title={t('settings.secStatus')} />
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

        <div className="row-sub" style={{ padding: '10px 0 0', lineHeight: 1.7 }}>
          {t('settings.about', { version: '0.1.0' })}{' '}
          <span className="mono">~/.hermes/plugin-data/hermes-pilot/token</span>
        </div>
      </section>

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
