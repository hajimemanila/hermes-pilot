import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Sheet } from '../components/Ui.jsx'
import { useI18n } from '../i18n/index.js'
import { api } from '../api.js'
import { celebrate } from '../lib/vibe.js'
import {
  SEED_MAX,
  TEMPLATE_IDS,
  buildSeedPayload,
  canSubmit,
  mergeTranscript,
  recognitionCtor,
  speechLocale,
} from '../lib/specSeed.js'

/**
 * `🎙️ Spec Seed` シート（SPEC V5 §3.3 ① / D26①）。
 *
 * ゼロタイピングで仕様策定を始める入口。「一行メモ」か「音声」だけで
 * `POST /api/architect/seed` に種を渡し、Architect（既定 Hermes Native・Opt-in で agy）が
 * 1タップ設計インタビュー → 仕様書まで進める。
 *
 * - 音声は Web Speech API（未対応ブラウザでは入力欄にフォーカスするだけ）
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
  const [runner, setRunner] = useState('hermes')
  const [agyAvailable, setAgyAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const recRef = useRef(null)
  const finalRef = useRef('')
  const supported = typeof window !== 'undefined' && Boolean(recognitionCtor(window))

  // 実行ランナー（既定 Hermes Native。agy がある環境だけ Opt-in を選べる）
  useEffect(() => {
    let alive = true
    api('/api/architect/config')
      .then((d) => {
        if (!alive || !d?.ok) return
        setAgyAvailable(Boolean(d.hasAgyCli))
        setRunner(d.runner === 'antigravity' ? 'antigravity' : 'hermes')
      })
      .catch(() => {
        /* 旧ブリッジ: Hermes Native のまま動かす */
      })
    return () => {
      alive = false
    }
  }, [])

  /** 音声認識を止める（シートを閉じるときも必ず呼ぶ）。 */
  const stopListening = useCallback(() => {
    const rec = recRef.current
    recRef.current = null
    setListening(false)
    if (!rec) return
    try {
      rec.stop()
    } catch {
      /* すでに止まっている */
    }
  }, [])

  useEffect(() => () => stopListening(), [stopListening])

  /** 1 タップで連続認識（UI 言語に追従）。 */
  const toggleDictation = useCallback(() => {
    if (listening) {
      stopListening()
      return
    }
    const Ctor = recognitionCtor(window)
    if (!Ctor) {
      inputRef.current?.focus()
      return
    }
    let rec
    try {
      rec = new Ctor()
    } catch {
      // 権限や非対応でコンストラクタが落ちる構成もある → 入力欄へ逃がす
      setError(t('seed.unsupported'))
      inputRef.current?.focus()
      return
    }
    rec.lang = speechLocale(lang)
    rec.continuous = true
    rec.interimResults = true
    finalRef.current = text
    rec.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i]
        if (res.isFinal) finalRef.current = mergeTranscript(finalRef.current, res[0].transcript)
        else interim = `${interim}${res[0].transcript}`
      }
      setText(mergeTranscript(finalRef.current, interim).slice(0, SEED_MAX))
    }
    rec.onerror = (event) => {
      const code = String(event?.error ?? '')
      // 無音・中断は黙って止める（エラー UI を出さない）
      if (code && code !== 'no-speech' && code !== 'aborted') setError(t('seed.unsupported'))
      stopListening()
    }
    rec.onend = () => {
      if (recRef.current === rec) {
        recRef.current = null
        setListening(false)
      }
    }
    try {
      rec.start()
      recRef.current = rec
      setListening(true)
      setError(null)
    } catch {
      setError(t('seed.unsupported'))
    }
  }, [lang, listening, stopListening, t, text])

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
    stopListening()
    try {
      const res = await api('/api/architect/seed', {
        method: 'POST',
        body: buildSeedPayload({ seedText: text, autoStart, runner, board, repo, chat, lang }),
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
  }, [autoStart, board, busy, chat, lang, notify, onClose, onSeeded, repo, runner, stopListening, t, text])

  const runnerLabel = runner === 'antigravity' ? t('seed.runnerAgy') : t('seed.runnerHermes')

  return (
    <Sheet title={`🎙️ ${t('seed.title')}`} onClose={() => !busy && onClose?.()}>
      <p className="seed-lead">{t('seed.lead')}</p>

      <div className="seed-row">
        <span className="seed-label">{t('seed.runner')}</span>
        <span className={`pill${runner === 'antigravity' ? ' on' : ''}`}>{runnerLabel}</span>
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
      />

      <div className="seed-actions">
        <button
          type="button"
          className={`chip${listening ? ' on' : ''}`}
          onClick={toggleDictation}
          aria-pressed={listening}
        >
          {listening ? `⏹ ${t('seed.listening')}` : `🎙️ ${t('seed.dictate')}`}
        </button>
        <span className="seed-count">
          {text.length}/{SEED_MAX}
        </span>
      </div>
      {!supported ? <p className="seed-hint">{t('seed.unsupported')}</p> : null}

      <div className="chips seed-templates">
        {TEMPLATE_IDS.map((id) => (
          <button key={id} type="button" className="chip" onClick={() => applyTemplate(id)}>
            {t(`seed.tpl.${id}`)}
          </button>
        ))}
      </div>

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

      {agyAvailable ? (
        <label className="seed-toggle">
          <input
            type="checkbox"
            checked={runner === 'antigravity'}
            onChange={(e) => setRunner(e.target.checked ? 'antigravity' : 'hermes')}
          />
          <span>{t('seed.runnerAgy')}</span>
        </label>
      ) : null}

      {error ? <div className="seed-error">{error}</div> : null}

      <button
        type="button"
        className="seed-submit"
        disabled={busy || !canSubmit(text)}
        onClick={submit}
      >
        {busy ? t('seed.submitting') : `🎙️ ${t('seed.submit')}`}
      </button>
    </Sheet>
  )
}
