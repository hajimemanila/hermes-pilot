import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Sheet, fmtBytes, relTime } from '../components/Ui.jsx'

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
  const [audit, setAudit] = useState(null)
  const [log, setLog] = useState(null)
  const [logName, setLogName] = useState('gateway')
  const [sessions, setSessions] = useState([])

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

  const loadAudit = useCallback(async () => {
    try {
      const d = await api('/api/audit?lines=80')
      setAudit(d.lines ?? [])
    } catch (e) {
      notify(e.message)
    }
  }, [notify])

  useEffect(() => {
    loadAudit()
    loadSnippets()
    api('/api/sessions?limit=5')
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {})
  }, [loadAudit, loadSnippets])

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
  const ops = overview?.ops

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
          <span>SystemOps</span>
          <b className={ops?.ok === false ? 'bad-text' : ''}>{ops ? (ops.ok ? 'Clean' : 'Blocked') : '—'}</b>
        </div>
        <div className="kv">
          <span>最終確認</span>
          <b>{relTime(overview?.checkedAt)}</b>
        </div>
        <div className="kv">
          <span>起動元</span>
          <b>{launchSource()}</b>
        </div>
        <button className="btn" onClick={() => refresh?.()} style={{ marginTop: 10 }}>
          再取得
        </button>
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
        <span>ログ</span>
      </div>
      <div className="row">
        {['gateway', 'errors', 'agent'].map((n) => (
          <button key={n} className="chip" onClick={() => openLog(n)} style={{ marginRight: 6 }}>
            {n}.log
          </button>
        ))}
      </div>

      <div className="list-head">
        <span>監査ログ（緊急操作・端末）</span>
        <button className="link" onClick={loadAudit}>
          更新
        </button>
      </div>
      <div className="list">
        {(audit ?? []).slice().reverse().map((a, i) => (
          <div key={i} className="row static">
            <span className="row-main">
              <span className="row-title">{a.kind}</span>
              <span className="row-sub">
                {new Date(a.at).toLocaleString('ja-JP')}
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
