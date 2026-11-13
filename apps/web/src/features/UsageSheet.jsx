import React from 'react'
import { Sheet, fmtNumber, relTime } from '../components/Ui.jsx'
import { fmtCost, fmtTokens, fmtPct } from '../lib/format.js'

/**
 * 使用量シート。期間内のコスト・トークン・キャッシュ率とモデル別内訳。
 * データはブリッジの /api/usage（state.db を読み取り専用で集計）。
 */
export function UsageSheet({ data, hours = 24, onClose }) {
  const t = data?.totals
  const ok = Boolean(data?.ok)

  return (
    <Sheet title={`使用量（${hours}h）`} onClose={onClose}>
      {!ok ? (
        <div className="empty">{data?.reason ?? '取得できませんでした'}</div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="kv">
              <span>コスト</span>
              <b>{fmtCost(t.cost)}</b>
            </div>
            <div className="kv">
              <span>入力</span>
              <b>{fmtTokens(t.input)}</b>
            </div>
            <div className="kv">
              <span>出力</span>
              <b>{fmtTokens(t.output)}</b>
            </div>
            <div className="kv">
              <span>キャッシュ読取</span>
              <b>
                {fmtTokens(t.cacheRead)}（{fmtPct(data.cacheHitRate)}）
              </b>
            </div>
            <div className="kv">
              <span>API呼び出し</span>
              <b>{fmtNumber(t.calls)}</b>
            </div>
            <div className="kv">
              <span>セッション</span>
              <b>
                {t.sessions} 件 ・ {t.messages} msg ・ tool {t.tools}
              </b>
            </div>
          </div>

          <div className="list-head">
            <span>モデル別</span>
          </div>
          <div className="row-sub" style={{ padding: '0 2px 6px', lineHeight: 1.6 }}>
            API呼び出し記録からの集計。セッションの見積りとは端数がずれることがあります。
          </div>
          <div className="list">
            {(data.models ?? []).map((m) => (
              <div key={m.model} className="row static">
                <span className="row-main">
                  <span className="row-title">{m.model}</span>
                  <span className="row-sub">
                    in {fmtTokens(m.input)} ・ out {fmtTokens(m.output)} ・ cache {fmtTokens(m.cacheRead)} ・{' '}
                    {m.calls} calls
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {fmtCost(m.cost)}
                </span>
              </div>
            ))}
            {!(data.models ?? []).length ? <div className="empty">記録なし</div> : null}
          </div>

          <div className="list-head">
            <span>コスト上位</span>
          </div>
          <div className="list">
            {(data.topSessions ?? []).map((s) => (
              <div key={`${s.profile ?? 'default'}:${s.id}`} className="row static">
                <span className="row-main">
                  <span className="row-title">{s.title}</span>
                  <span className="row-sub">
                    {s.source || '—'}
                    {s.profile && s.profile !== 'default' ? ` ・ ${s.profile}` : ''} ・ in {fmtTokens(s.input)} ・ out{' '}
                    {fmtTokens(s.output)} ・ {relTime(s.at)}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {fmtCost(s.cost)}
                </span>
              </div>
            ))}
            {!(data.topSessions ?? []).length ? <div className="empty">記録なし</div> : null}
          </div>

          <div className="row-sub" style={{ padding: '12px 4px 18px', lineHeight: 1.7 }}>
            ~/.hermes/state.db の sessions / session_model_usage を読み取り専用で集計（30秒キャッシュ）。
            キャッシュ率は「入力＋キャッシュ読取」に占めるキャッシュ読取の割合です。
          </div>
        </>
      )}
    </Sheet>
  )
}
