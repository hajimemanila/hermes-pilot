import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Sheet } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { api } from '../api.js'
import { celebrate } from '../lib/vibe.js'
import {
  DEFAULT_EXECUTION_POLICY,
  EXECUTION_POLICIES,
  SEED_MAX,
  TEMPLATE_IDS,
  buildSeedPayload,
  canSubmit,
  executionPolicyHintKey,
  executionPolicyKey,
} from '../lib/specSeed.js'

/**
 * `Spec Seed` シート（SPEC V5 §3.3 ① / D26①・SPEC V7 §3.3 / D33・D35・
 * SPEC-PILOT-V11 §3.3 / D51）。
 *
 * ゼロタイピングで仕様策定を始める入口。「一行メモ」だけで
 * `POST /api/architect/seed` に種を渡し、Architect（`Hermes Native` 固定）が
 * 1タップ設計インタビュー → 仕様書まで進める。外部 AI CLI は起動しない。
 *
 * - 音声は **OS キーボードの標準音声入力**を使う（Web Speech API の自前マイクは
 *   非 Secure Context・`continuous` 非互換で必ず失敗したため削除。SPEC V7 §1.3）
 * - 展開時にテキストエリアへ自動フォーカス（キーボードのマイクを 1 タップで呼べる）
 * - 実行方針（`Zero-stop` 既定 / `Visual-gate`）を選び `executionPolicy` として送る
 * - テンプレートチップで「喋る手間」も省ける
 * - **「承認後に自動でバッチを起票」**（既定 OFF）を ON にすると、仕様書ができた瞬間に
 *   確認タップなしで起票・自走開始まで繋がる（D23 のハイブリッド A2B）
 * - 送信成功で `celebrate('launch')`（Vibe 連動の演出・触覚）＋トースト
 *
 * @param {{board?: string, repo?: string|null, chat?: string|null, onClose: Function,
 *          onSeeded?: Function, notify?: Function}} props ボード・リポジトリ・起票元チャット
 * @returns {any} シート
 */
export function SpecSeedSheet({ board = '', repo = null, chat = null, onClose, onSeeded, notify }) {
  const { t, lang } = useI18n()
  const [text, setText] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [executionPolicy, setExecutionPolicy] = useState(DEFAULT_EXECUTION_POLICY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  // 開いたらすぐ打てる（音声はキーボードのマイクを 1 タップ）。
  // シートのアニメーション中に focus すると取りこぼすことがあるので少し待つ。
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 150)
    return () => clearTimeout(timer)
  }, [])

  /** テンプレートチップ: 前置きを置いてフォーカス（喋る手間より速い）。 */
  const applyTemplate = useCallback((id) => {
    const prefix = t(`seed.tpl.${id}Text`)
    setText((cur) => {
      const body = String(cur ?? '')
      if (body.startsWith(prefix)) return body
      return `${prefix}${body}`.slice(0, SEED_MAX)
    })
    inputRef.current?.focus()
  }, [t])

  /** 種を送る（202 で即返る。仕様書はあとから Review / Tasks に届く）。 */
  const submit = useCallback(async () => {
    if (busy || !canSubmit(text)) return
    setBusy(true)
    setError(null)
    try {
      const res = await api('/api/architect/seed', {
        method: 'POST',
        body: buildSeedPayload({ seedText: text, autoStart, executionPolicy, board, repo, chat, lang }),
      })
      // Vibe 連動の演出＋触覚（Dopamine 時のみ音が鳴る）。未初期化でも落ちない。
      try {
        celebrate('launch')
      } catch {
        /* 演出は本質ではない */
      }
      notify?.(t('seed.toast'))
      onSeeded?.(res)
      onClose?.()
    } catch (e) {
      setError(e?.message ?? t('seed.failed'))
      setBusy(false)
    }
  }, [autoStart, board, busy, chat, executionPolicy, lang, notify, onClose, onSeeded, repo, t, text])

  return (
    <Sheet title={`📝 ${t('seed.title')}`} onClose={() => !busy && onClose?.()}>
      <p className="seed-lead">{t('seed.lead')}</p>

      <div className="seed-row">
        <span className="seed-label">{t('seed.runner')}</span>
        <span className="pill on">{t('seed.runnerHermes')}</span>
      </div>

      <textarea
        ref={inputRef}
        className="seed-input"
        value={text}
        maxLength={SEED_MAX}
        placeholder={t('seed.placeholder')}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        aria-label={t('seed.placeholder')}
        enterKeyHint="done"
      />

      {/* 音声は OS キーボードのマイクに一本化（自前の Web Speech API は削除した） */}
      <div className="seed-actions">
        <span className="seed-hint seed-hint-inline">{t('seed.voiceHint')}</span>
        <span className="seed-count">
          {text.length}/{SEED_MAX}
        </span>
      </div>

      <div className="chips seed-templates">
        {TEMPLATE_IDS.map((id) => (
          <button key={id} type="button" className="chip" onClick={() => applyTemplate(id)}>
            {t(`seed.tpl.${id}`)}
          </button>
        ))}
      </div>

      {/* 実行方針（D35）。どちらでも Quick Review インタビューは実施し、
          生成する SPEC 各バッチの既定 Execution Mode だけを切り替える */}
      <div className="seed-row seed-policy-head">
        <span className="seed-label">{t('seed.policy')}</span>
      </div>
      <div className="seed-seg" role="group" aria-label={t('seed.policyAria')}>
        {EXECUTION_POLICIES.map((id) => (
          <button
            key={id}
            type="button"
            className={`seed-seg-btn${executionPolicy === id ? ' on' : ''}`}
            aria-pressed={executionPolicy === id}
            onClick={() => setExecutionPolicy(id)}
          >
            <span className="seed-seg-name">{t(executionPolicyKey(id))}</span>
            {id === DEFAULT_EXECUTION_POLICY ? (
              <span className="seed-seg-tag">{t('seed.policyDefault')}</span>
            ) : null}
          </button>
        ))}
      </div>
      <p className="seed-hint seed-policy-hint">{t(executionPolicyHintKey(executionPolicy))}</p>

      <label className="seed-toggle">
        <input
          type="checkbox"
          checked={autoStart}
          onChange={(e) => {
            setAutoStart(e.target.checked)
            if (e.target.checked) celebrate('approve')
          }}
        />
        <span>
          {t('seed.autoStart')}
          <br />
          <span className="seed-hint">{t('seed.autoStartHint')}</span>
        </span>
      </label>

      {error ? <div className="seed-error">{error}</div> : null}

      <button
        type="button"
        className="seed-submit"
        disabled={busy || !canSubmit(text)}
        onClick={submit}
      >
        {busy ? t('seed.submitting') : `✨ ${t('seed.submit')}`}
      </button>
    </Sheet>
  )
}
