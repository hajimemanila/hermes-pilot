import React, { useState } from 'react'
import { Sheet, fmtNumber, relTime } from '../components/Ui.jsx'
import { fmtCost, fmtTokens, fmtPct } from '../lib/format.js'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'
import { MissionReceiptSheet } from './MissionReceiptSheet.jsx'

/**
 * 使用量シート。期間内のコスト・トークン・キャッシュ率とモデル別内訳。
 * データはブリッジの /api/usage（state.db を読み取り専用で集計）。
 *
 * 上部の 1 タップ導線から完了レシート（SPEC-PILOT-V5 §3.3 ③ / D26③）を開ける。
 * `board` / `spec` は任意（渡されなければ全プロファイル合算のレシートになる）。
 */
export function UsageSheet({ data, hours = 24, onClose, board = null, spec = null }) {
  const { t } = useI18n()
  const totals = data?.totals
  const ok = Boolean(data?.ok)
  const [receiptOpen, setReceiptOpen] = useState(false)

  return (
    <>
    <Sheet title={t('usage.title', { hours })} onClose={onClose}>
      {!ok ? (
        <div className="empty">{data?.reason ?? t('usage.failed')}</div>
      ) : (
        <>
          <button
            type="button"
            className="report-card-btn primary receipt-open-btn"
            onClick={() => {
              haptic('tap')
              setReceiptOpen(true)
            }}
          >
            {t('receipt.create')}
          </button>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="kv">
              <span>{t('usage.cost')}</span>
              <b>{fmtCost(totals.cost)}</b>
            </div>
            <div className="kv">
              <span>{t('usage.input')}</span>
              <b>{fmtTokens(totals.input)}</b>
            </div>
            <div className="kv">
              <span>{t('usage.output')}</span>
              <b>{fmtTokens(totals.output)}</b>
            </div>
            <div className="kv">
              <span>{t('usage.cacheRead')}</span>
              <b>
                {fmtTokens(totals.cacheRead)} ({fmtPct(data.cacheHitRate)})
              </b>
            </div>
            <div className="kv">
              <span>{t('usage.apiCalls')}</span>
              <b>{fmtNumber(totals.calls)}</b>
            </div>
            <div className="kv">
              <span>{t('usage.sessions')}</span>
              <b>{t('usage.sessionSummary', { sessions: totals.sessions, messages: totals.messages, tools: totals.tools })}</b>
            </div>
          </div>

          <div className="list-head">
            <span>{t('usage.byModel')}</span>
          </div>
          <div className="row-sub" style={{ padding: '0 2px 6px', lineHeight: 1.6 }}>
            {t('usage.byModelNote')}
          </div>
          <div className="list">
            {(data.models ?? []).map((m) => (
              <div key={m.model} className="row static">
                <span className="row-main">
                  <span className="row-title">{m.model}</span>
                  <span className="row-sub">
                    {t('usage.modelLine', {
                      input: fmtTokens(m.input),
                      output: fmtTokens(m.output),
                      cache: fmtTokens(m.cacheRead),
                      calls: m.calls,
                    })}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {fmtCost(m.cost)}
                </span>
              </div>
            ))}
            {!(data.models ?? []).length ? <div className="empty">{t('usage.none')}</div> : null}
          </div>

          <div className="list-head">
            <span>{t('usage.topSessions')}</span>
          </div>
          <div className="list">
            {(data.topSessions ?? []).map((s) => (
              <div key={`${s.profile ?? 'default'}:${s.id}`} className="row static">
                <span className="row-main">
                  <span className="row-title">{s.title}</span>
                  <span className="row-sub">
                    {t('usage.sessionLine', {
                      source: s.source || '—',
                      profile: s.profile && s.profile !== 'default' ? ` ・ ${s.profile}` : '',
                      input: fmtTokens(s.input),
                      output: fmtTokens(s.output),
                      at: relTime(s.at),
                    })}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {fmtCost(s.cost)}
                </span>
              </div>
            ))}
            {!(data.topSessions ?? []).length ? <div className="empty">{t('usage.none')}</div> : null}
          </div>

          <div className="row-sub" style={{ padding: '12px 4px 18px', lineHeight: 1.7 }}>
            {t('usage.footnote')}
          </div>
        </>
      )}
    </Sheet>
    {receiptOpen ? (
      <MissionReceiptSheet
        board={board}
        spec={spec}
        hours={hours}
        onClose={() => setReceiptOpen(false)}
      />
    ) : null}
    </>
  )
}
