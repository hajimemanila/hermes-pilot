import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useI18n } from '../i18n/index.js'
import { haptic } from '../lib/haptic.js'

/**
 * 設定タブ「パイプライン＆Architect」（SPEC V5 §3.2・§3.3 / D25・D26①・
 * SPEC-PILOT-V11 §3.3 / D51）。
 *
 * 2 つのことだけを 1 画面に置く。どちらも**状態が見える**ことを優先する。
 *
 * 1. **Architect の実行ランナー** — `Hermes Native` 固定（外部 AI CLI は起動しない）。
 *    仕様書は「自分のターミナル等で `docs/SPEC-*.md` を置いて 1 タップ実装」または
 *    「この画面の `Spec Seed` から Hermes Native で仕様策定」の 2 ルートで入る。
 * 2. **1 タップ環境最適化** — `POST /api/pipeline/optimize` で `SOUL.md` へ A2B 行動規範を
 *    冪等追記し、`spec-architect` ほかのスキルを配置する。適用済みかどうかは
 *    `GET /api/pipeline/status` を読み直して表示する（自己申告で「適用した」と言わない）。
 *
 * @param {{notify?: Function, board?: string}} props トーストと対象ボード
 * @returns {any} カード本体
 */
export function PipelinePanel({ notify, board = '' }) {
  const { t } = useI18n()
  const [status, setStatus] = useState(null)
  const [statusMissing, setStatusMissing] = useState(false)
  const [jobs, setJobs] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    // SOUL / スキルの適用状態（V5-1 の API。無いブリッジでは「使えない」と出す）
    try {
      const s = await api('/api/pipeline/status')
      if (s?.ok) {
        setStatus(s)
        setStatusMissing(false)
      } else {
        setStatusMissing(true)
      }
    } catch {
      setStatusMissing(true)
    }
    // Architect ジョブと未起票 SPEC の件数
    try {
      const qs = board ? `?board=${encodeURIComponent(board)}` : ''
      const j = await api(`/api/architect/jobs${qs}`)
      if (j?.ok) setJobs(j)
    } catch {
      setJobs(null)
    }
  }, [board])

  useEffect(() => {
    load()
  }, [load])

  /** SOUL.md ＋ スキル配置を 1 タップで適用する。 */
  const optimize = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    haptic('action')
    try {
      const r = await api('/api/pipeline/optimize', { method: 'POST', body: {} })
      if (r?.ok) {
        setStatus(r.status ?? status)
        notify?.(t('settings.pipelineOptimized'))
      } else {
        setError(r?.error ?? t('settings.pipelineUnavailable'))
      }
    } catch (e) {
      setError(e?.code === 'UNKNOWN_ENDPOINT' ? t('settings.pipelineUnavailable') : e?.message ?? '')
    } finally {
      setBusy(false)
      load()
    }
  }, [busy, load, notify, status, t])

  const soulApplied = Boolean(status?.soul?.applied)
  const skillNames = Array.isArray(status?.hermes?.present) ? status.hermes.present.length : 0
  const skillTotal = Array.isArray(status?.bundled?.names) ? status.bundled.names.length : 0

  return (
    <>
      <p className="row-sub" style={{ marginBottom: 10, lineHeight: 1.6 }}>
        {t('settings.pipelineLead')}
      </p>

      <div className="kv" style={{ alignItems: 'center' }}>
        <span>{t('settings.pipelineRunner')}</span>
        <span className="pill on">{t('seed.runnerHermes')}</span>
      </div>
      <p className="row-sub" style={{ margin: '6px 0 10px', lineHeight: 1.6 }}>
        {t('settings.pipelineRunnerHint')}
      </p>

      {statusMissing ? (
        <p className="row-sub" style={{ marginBottom: 10, lineHeight: 1.6 }}>
          {t('settings.pipelineUnavailable')}
        </p>
      ) : (
        <div className="kv">
          <span>{t('settings.pipelineSoul')}</span>
          <b>{soulApplied ? t('settings.pipelineApplied') : t('settings.pipelineMissing')}</b>
        </div>
      )}
      {skillTotal ? (
        <div className="kv">
          <span>{t('settings.pipelineSkills')}</span>
          <b>
            {skillNames}/{skillTotal}
          </b>
        </div>
      ) : null}
      {jobs ? (
        <div className="kv">
          <span>{t('settings.pipelineJobs')}</span>
          <b>{Array.isArray(jobs.jobs) ? jobs.jobs.length : 0}</b>
        </div>
      ) : null}
      {jobs && Array.isArray(jobs.pending) ? (
        <div className="kv">
          <span>{t('settings.pipelinePending')}</span>
          <b>{jobs.pending.length}</b>
        </div>
      ) : null}

      <button
        type="button"
        className="seed-submit"
        style={{ marginTop: 10 }}
        disabled={busy || statusMissing}
        onClick={optimize}
      >
        {busy ? t('settings.pipelineOptimizing') : t('settings.pipelineOptimize')}
      </button>

      {error ? <div className="seed-error" style={{ marginTop: 8 }}>{error}</div> : null}
    </>
  )
}
