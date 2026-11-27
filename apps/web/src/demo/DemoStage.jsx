/**
 * PC ブラウザ用のデバイス筐体シミュレータ（SPEC-PILOT-V5 §3.4 ③ / D27）。
 *
 * **筐体の中身は `<iframe>`**（同じアプリを `?demo-frame=1` で開く）。
 * 理由は実測: CSS の `@media (min-width: 820px)` と `matchMedia` は *ウィンドウ* 幅を見るので、
 * div を 390px に絞っただけでは PC（1280px）で 2 ペイン用の CSS が当たり、Phone 枠の中で
 * タブレット用レイアウトになってしまう。iframe なら中身は 390/820 の独立したビューポートを持ち、
 * `position: fixed` のシート・トースト・下部ナビもそのまま筐体の中に収まる。
 *
 * 狭い画面（< 900px）では筐体を出さず、そのまま全画面の PWA として動く（スマホでの直接閲覧）。
 * 環境の切替（Vibe / 音 / テーマ / 言語）は子フレームへ `postMessage` で即時反映する。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/index.js'
import { getResolvedTheme, setThemePref } from '../lib/theme.js'
import { haptic } from '../lib/haptic.js'
import './demo.css'
import {
  MSG_READY,
  MSG_SET,
  buildEmbeddedFrameSrcDoc,
  frameUrl,
  installSafeStorage,
  isEmbeddedSession,
} from './frame.js'
import { STAGE_MIN_WIDTH as MIN_WIDTH, VIEWS as STAGE_VIEWS, fitScale } from './stage.js'
import { HM_STORAGE } from '../contracts/storage.js'

/** 筐体の実寸（CSS px）。 */
export const VIEWS = STAGE_VIEWS

const VIBE_KEY = HM_STORAGE.VIBE
const SOUND_KEY = HM_STORAGE.SOUND

function readStored(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStored(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* プライベートモードでも切替自体は効かせる */
  }
}

/** 保存値から初期の Vibe を決める（未保存は dopamine。CSS と揃える）。 */
function initialVibe() {
  const saved = readStored(VIBE_KEY)
  if (saved === 'dopamine' || saved === 'serotonin') return saved
  try {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'serotonin'
  } catch {
    /* matchMedia が無い環境 */
  }
  return 'dopamine'
}

/**
 * 子フレームの URL。埋め込み（`google-sites-embed.html` / `srcdoc`）では iframe を張らないので
 * `null` が返る（実装は `frame.js`。JSX を含まないのでテストから直接検証できる）。
 */
export { frameUrl }

export function DemoStage({ children }) {
  const { t, lang, setPref } = useI18n()
  // 単一ファイル埋め込み（D32）: 相対 iframe URL が使えないので、自分の初期 HTML を srcDoc に複製する
  const [embedded] = useState(() => isEmbeddedSession())
  const [viewport, setViewport] = useState('phone')
  const [narrow, setNarrow] = useState(() => (globalThis.innerWidth || 0) < MIN_WIDTH)
  const [vibe, setVibeState] = useState(() => initialVibe())
  const [sound, setSound] = useState(() => readStored(SOUND_KEY) !== '0')
  const [theme, setTheme] = useState(() => getResolvedTheme())
  const [scale, setScale] = useState(1)
  const [ready, setReady] = useState(false)
  const [box, setBox] = useState({ width: 0, height: 0 })
  // 埋め込みでは iframe の `src` を差し替えられないので、key を変えて文書ごと作り直す
  const [frameKey, setFrameKey] = useState(0)
  const canvasRef = useRef(null)
  const frameRef = useRef(null)

  // 画面幅で「筐体を出すか」を決める。狭くなったら Full に落とす
  useEffect(() => {
    const onResize = () => {
      const isNarrow = (globalThis.innerWidth || 0) < MIN_WIDTH
      setNarrow(isNarrow)
      if (isNarrow) setViewport('full')
    }
    onResize()
    globalThis.addEventListener?.('resize', onResize)
    return () => globalThis.removeEventListener?.('resize', onResize)
  }, [])

  // 実寸と使える領域から拡大率を出す（バーの高さは CSS と揃える）
  useEffect(() => {
    const compute = () => {
      const el = canvasRef.current
      if (!el) {
        setScale(1)
        return
      }
      const rect = el.getBoundingClientRect()
      setBox({ width: Math.round(rect.width), height: Math.round(rect.height) })
      const size = VIEWS[viewport]
      setScale(size ? fitScale(size, rect.width - 24, rect.height - 24) : 1)
    }
    compute()
    globalThis.addEventListener?.('resize', compute)
    return () => globalThis.removeEventListener?.('resize', compute)
  }, [viewport, narrow, ready])

  /** 子フレームへ現在の環境設定を送る。 */
  const pushSettings = useCallback(() => {
    const win = frameRef.current?.contentWindow
    if (!win) return
    try {
      win.postMessage({ type: MSG_SET, detail: { vibe, sound, theme: getResolvedTheme(), lang } }, '*')
    } catch {
      /* フレーム未生成 */
    }
    // `theme` は本文で直接読まない（getResolvedTheme）が、テーマ切替だけでも送り直すために依存に入れる
  }, [vibe, sound, theme, lang])

  // 子から「準備できた」が来たら設定を流し込む（取りこぼし防止に 2 回送る）
  useEffect(() => {
    const onMessage = (ev) => {
      if (ev?.data?.type !== MSG_READY) return
      setReady(true)
      pushSettings()
      setTimeout(pushSettings, 150)
    }
    globalThis.addEventListener?.('message', onMessage)
    return () => globalThis.removeEventListener?.('message', onMessage)
  }, [pushSettings])

  // 設定が変わったら即時反映（リロード不要）
  useEffect(() => {
    if (ready) pushSettings()
  }, [ready, pushSettings])

  const setVibe = useCallback((next) => {
    haptic('tap')
    setVibeState(next)
    writeStored(VIBE_KEY, next)
    document.documentElement.dataset.vibe = next
  }, [])

  const toggleSound = useCallback(() => {
    haptic('tap')
    setSound((prev) => {
      const next = !prev
      writeStored(SOUND_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  const toggleTheme = useCallback(() => {
    haptic('tap')
    const next = getResolvedTheme() === 'dark' ? 'light' : 'dark'
    setThemePref(next)
    setTheme(next)
  }, [])

  const toggleLang = useCallback(() => {
    haptic('tap')
    setPref(lang === 'ja' ? 'en' : 'ja')
  }, [lang, setPref])

  /** ツアーを最初から: 子フレームを読み直す（デモの状態は文書ごとなので作り直しで戻る）。 */
  const restart = useCallback(() => {
    haptic('action')
    setReady(false)
    if (embedded) {
      // `srcDoc` は差し替えられないので key を進めて iframe を作り直す（同じ複製が新しい文書として起動する）
      setFrameKey((k) => k + 1)
      return
    }
    const frame = frameRef.current
    if (frame) {
      frame.src = frameUrl(globalThis.location?.href ?? '', false)
      return
    }
    globalThis.location?.reload?.()
  }, [embedded])

  const size = VIEWS[viewport] ?? (box.width ? box : { width: 1024, height: 768 })
  const isFull = viewport === 'full'
  const url = useMemo(() => frameUrl(globalThis.location?.href ?? '', embedded), [embedded])
  /**
   * 埋め込み時の筐体の中身。
   *
   * `srcdoc` は相対 URL を持てないので、**起動前に退避した自分の初期 HTML** を複製し、
   * `demo/frame.js` が目印（`__HM_DEMO_FRAME__`）を 1 行差し込む。子は目印を見て
   * 筐体バーを描かずバナー＋アプリだけを出す = PC 幅でもデバイスシミュレータが成立する。
   * 退避できていない（空）ときは従来どおり全画面にフォールバックする。
   */
  const srcDoc = useMemo(
    () => (embedded ? buildEmbeddedFrameSrcDoc(globalThis.__HM_INITIAL_HTML__) : ''),
    [embedded],
  )

  // 埋め込み（srcdoc / sandbox）では保存領域の参照だけで落ちるので、先に安全な実装へ差し替える
  useEffect(() => {
    if (embedded) installSafeStorage()
  }, [embedded])

  // スマホ実機（狭い画面）と、複製元が取れなかった埋め込み: 筐体を出さず、
  // `children`（バナー＋アプリ）をそのまま全画面に置く
  if (narrow || (embedded && !srcDoc)) {
    return <div className="demo-mobile">{children}</div>
  }

  return (
    <div className="demo-shell">
      <div className="demo-bar" role="toolbar" aria-label={t('demo.barAria')}>
        <span className="demo-bar-brand">
          <span aria-hidden="true">🎮</span> {t('demo.badge')}
        </span>

        <div className="demo-bar-group" role="group" aria-label={t('demo.viewAria')}>
          {['phone', 'tablet', 'full'].map((id) => (
            <button
              key={id}
              type="button"
              className={`demo-chip${viewport === id ? ' on' : ''}`}
              aria-pressed={viewport === id}
              onClick={() => {
                haptic('tap')
                setViewport(id)
              }}
            >
              {t(`demo.view.${id}`)}
            </button>
          ))}
        </div>

        <div className="demo-bar-group" role="group" aria-label={t('demo.envAria')}>
          <button
            type="button"
            className={`demo-chip vibe ${vibe}`}
            aria-pressed={vibe === 'dopamine'}
            onClick={() => setVibe(vibe === 'dopamine' ? 'serotonin' : 'dopamine')}
          >
            {vibe === 'dopamine' ? t('demo.vibe.dopamine') : t('demo.vibe.serotonin')}
          </button>
          <button type="button" className={`demo-chip${sound ? ' on' : ''}`} aria-pressed={sound} onClick={toggleSound}>
            {sound ? t('demo.sound.on') : t('demo.sound.off')}
          </button>
          <button type="button" className="demo-chip" onClick={toggleTheme}>
            {theme === 'dark' ? t('demo.theme.dark') : t('demo.theme.light')}
          </button>
          <button type="button" className="demo-chip" onClick={toggleLang}>
            {lang === 'ja' ? 'JA' : 'EN'}
          </button>
          <button type="button" className="demo-chip restart" onClick={restart}>
            {t('demo.restart')}
          </button>
        </div>
      </div>

      <div className={`demo-canvas${isFull ? ' is-full' : ''}`} ref={canvasRef}>
        <div
          className={`demo-device${isFull ? ' is-full' : ''}`}
          data-kind={viewport}
          style={{ width: size.width * scale, height: size.height * scale }}
        >
          <div
            className={`demo-device-screen${isFull ? ' is-full' : ''}`}
            style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          >
            {embedded ? (
              // 埋め込み: 相対 URL が無いので、複製した自分の初期 HTML（srcDoc）を新しい文書として起動する
              <iframe
                key={`srcdoc-${frameKey}`}
                ref={frameRef}
                className="demo-frame"
                title={t('demo.badge')}
                srcDoc={srcDoc}
                width={size.width}
                height={size.height}
                onLoad={() => {
                  setReady(true)
                  pushSettings()
                  setTimeout(pushSettings, 150)
                }}
              />
            ) : (
              <iframe
                ref={frameRef}
                className="demo-frame"
                title={t('demo.badge')}
                src={url}
                width={size.width}
                height={size.height}
                onLoad={() => {
                  setReady(true)
                  pushSettings()
                  setTimeout(pushSettings, 150)
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
