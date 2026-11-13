import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useInstallState, swState } from '../lib/useInstallState.js'
import { diagnosePwa } from '../lib/pwaDiagnose.js'
import { RefreshButton, Sheet, Spinner, fmtBytes, fmtDateTime, relTime } from '../components/Ui.jsx'
import { haptic, isHapticEnabled, setHapticEnabled } from '../lib/haptic.js'

/**
 * 設定タブ。状態の参照・ログ末尾・監査ログ（キルスイッチの履歴）を置く。
 * 破壊的操作はタスクタブの「緊急操作」に集約し、ここは読み取り中心。
 */

/** インストール形態の判定（WebAPK は referrer が android-app://…）。 */
function launchSource() {
  try {
    const ref = document.referrer || ''
    if (ref.startsWith('android-app://')) return 'WebAPK'
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
    return standalone ? 'スタンドアロン' : 'ブラウザ'
  } catch {
    return '—'
  }
}
export function SettingsPane({ overview, notify, refresh }) {
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
        notify('保存しました')
      } catch (e) {
        notify(e.message)
      } finally {
        setSaving(false)
      }
    },
    [notify],
  )

  const addDraft = () => {
    const label = draftLabel.trim()
    const text = draftText.trim()
    if (!label || !text) return notify('名前と文言を入れてください')
    if (custom.length >= customMax) return notify(`マイスニペットは${customMax}個までです`)
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

  return (
    <div className="pane">
      <div className="card">
        <div className="kv">
          <span>Hermes</span>
          <b>{overview?.hermes?.version ?? '—'}</b>
        </div>
        <div className="kv">
          <span>モデル</span>
          <b>{overview?.hermes?.model ?? '—'}</b>
        </div>
        <div className="kv">
          <span>メモリ</span>
          <b>{mem ? `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}（${mem.percent}%）` : '—'}</b>
        </div>
        <div className="kv">
          <span>ディスク</span>
          <b>{disk ? `${fmtBytes(disk.free)} 空き（${disk.percent}% 使用）` : '—'}</b>
        </div>
        <div className="kv">
          <span>稼働状態</span>
          <b className={bridge?.ok === false ? 'bad-text' : ''}>
            {bridge ? (bridge.ok ? `正常（${bridge.uptimeSec}s）` : '切断') : '—'}
          </b>
        </div>
        <div className="kv">
          <span>判断待ち</span>
          <b>{kanbanStats ? `${kanbanStats.reviewWaiting} 件 / 稼働 ${kanbanStats.running}` : '—'}</b>
        </div>
        <div className="kv">
          <span>最終確認</span>
          <b>{relTime(overview?.checkedAt)}</b>
        </div>
        <div className="kv">
          <span>起動元</span>
          <b>{launchSource()}</b>
        </div>
        <div className="kv">
          <span>インストール可否</span>
          <b>{install.available ? '可能（ボタンで実行）' : install.installed ? 'インストール済み' : '不可（要件未達）'}</b>
        </div>
        <div className="kv">
          <span>Service Worker</span>
          <b>{swState()}</b>
        </div>
        <div className="kv" style={{ alignItems: 'center' }}>
          <span>タップ時の振動</span>
          <button
            type="button"
            role="switch"
            aria-checked={hapticOn}
            aria-label="タップ時の振動"
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
          <span>{diagBusy ? '診断中…' : 'PWA 診断を実行'}</span>
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
              notify?.(r === 'accepted' ? 'インストールを開始しました' : 'キャンセルしました')
            }}
          >
            アプリとしてインストール
          </button>
        )}
        <RefreshButton
          label="再取得"
          ariaLabel="状態を再取得"
          className="hm-btn-inner"
          onRefresh={async () => Boolean(await refresh?.())}
        />
      </div>

      <div className="list-head">
        <span>直近のセッション</span>
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
        {!sessions.length ? <div className="empty">なし</div> : null}
      </div>

      <div className="list-head">
        <span>リポジトリ（{repoList.length}）</span>
        <button
          className="link"
          disabled={repoBusy}
          onClick={async () => {
            haptic('tap')
            await saveRepos({ path: '/api/repos/scan', done: '再スキャンしました' })
          }}
        >
          再スキャン
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
                    手動
                  </span>
                ) : null}
              </span>
              <span className="row-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.path} ・ {r.source} ・ ボード {r.boards?.length ?? 0}
              </span>
            </span>
            <button
              className="link"
              disabled={repoBusy}
              onClick={() => saveRepos({ method: 'DELETE', path: `/api/repos/${encodeURIComponent(r.id)}`, done: '一覧から外しました' })}
            >
              非表示
            </button>
          </div>
        ))}
        {!repoList.length ? <div className="empty">見つかりません（下の欄で追加）</div> : null}
      </div>

      <div className="list-head">
        <span>自動スキャン先（直下 1 階層）</span>
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
              onClick={() => saveRepos({ body: { scanDirs: scanDirs.filter((x) => x !== d) }, done: '外しました' })}
            >
              削除
            </button>
          </div>
        ))}
        {!scanDirs.length ? <div className="empty">未設定（下の欄で追加）</div> : null}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <input
          className="inp"
          placeholder="走査先（例: ~/Projects）"
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
            if (await saveRepos({ body: { scanDirs: next }, done: '走査先を追加しました' })) setScanDraft('')
          }}
        >
          走査先に追加
        </button>
        <input
          className="inp"
          placeholder="リポジトリのパス（例: ~/work/my-repo）"
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
            if (await saveRepos({ body: { path: pathDraft.trim() }, done: 'リポジトリを追加しました' })) setPathDraft('')
          }}
        >
          リポジトリを追加
        </button>
      </div>

      <div className="list-head">
        <span>ログ</span>
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
        <span>監査ログ（緊急操作・端末）</span>
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
                {a.ok === false ? ' ・ 失敗' : ''}
              </span>
            </span>
          </div>
        ))}
        {!(audit ?? []).length ? <div className="empty">まだありません</div> : null}
      </div>

      <div className="list-head">
        <span>マイスニペット（{custom.length}/{customMax}）</span>
      </div>
      <div className="list">
        {custom.map((s) => (
          <div key={s.id} className="row static">
            <span className="row-main" style={{ minWidth: 0 }}>
              <span className="row-title">
                {s.label}
                {s.hot ? <span className="pill" style={{ marginLeft: 8 }}>バー</span> : null}
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
              削除
            </button>
          </div>
        ))}
        {!custom.length ? <div className="empty">まだありません（下の欄から追加）</div> : null}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <input
          className="inp"
          placeholder="名前（例: 議事録）"
          maxLength={20}
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
        />
        <textarea
          className="inp"
          placeholder="入力欄に挿入する文言（{{ここ}} は選択状態で挿入）"
          rows={3}
          maxLength={400}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          style={{ marginTop: 8, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <label className="row-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={draftHot} onChange={(e) => setDraftHot(e.target.checked)} />
          チャットのバーにも出す
        </label>
        <button className="btn" onClick={addDraft} disabled={saving || custom.length >= customMax} style={{ marginTop: 10 }}>
          {saving ? '保存中…' : '追加して保存'}
        </button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row-sub" style={{ lineHeight: 1.7 }}>
          Hermes Mobile v{overview?.hermes ? '0.1.0' : '0.1.0'} ・ 既存ダッシュボード（9119）は変更していません。
          トークンは <span className="mono">~/.hermes/mobile-pwa/token</span>。
        </div>
      </div>

      {log ? (
        <Sheet title={log.name} onClose={() => setLog(null)}>
          <pre className="logbox">{log.text}</pre>
        </Sheet>
      ) : null}
    </div>
  )
}
