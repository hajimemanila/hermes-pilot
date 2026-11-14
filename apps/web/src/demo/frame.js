/**
 * デモの「中身」側（筐体の中・スマホ実機の両方で使う）。
 *
 * 役割は 2 つ:
 * 1. 親（`DemoStage`）から来た環境設定を当てる（Vibe / 音 / テーマ / 言語）
 * 2. 筐体モードのとき、親へ「準備できた」を知らせる
 *
 * 設定の当て先は **本番と同じ保存キー**（`hm.vibe` / `hm.sound` / `hm.theme` / `hm.lang`）と
 * 同じ CustomEvent（`hm:vibe`）。デモ専用の抜け道を作らないので、デモで試した設定は本番と同じ意味を持つ。
 */

import { setLang } from '../i18n/lang.js'
import { setThemePref } from '../lib/theme.js'

export const VIBE_KEY = 'hm.vibe'
export const SOUND_KEY = 'hm.sound'

/** 親 → 子のメッセージ種別。 */
export const MSG_SET = 'hm-demo:set'
/** 子 → 親のメッセージ種別（iframes の読み込み完了）。 */
export const MSG_READY = 'hm-demo:ready'

function write(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* 保存できなくても見た目は変える */
  }
}

/**
 * 環境設定を 1 つずつ当てる（受け取った分だけ）。
 *
 * @param {{vibe?: string, sound?: boolean, theme?: string, lang?: string}} detail 設定
 * @param {Document} [doc] 対象の文書（テスト用）
 */
export function applyDemoSettings(detail = {}, doc = globalThis.document) {
  if (!doc) return
  if (detail.vibe === 'dopamine' || detail.vibe === 'serotonin') {
    write(VIBE_KEY, detail.vibe)
    doc.documentElement.dataset.vibe = detail.vibe
    try {
      globalThis.window?.dispatchEvent(new CustomEvent('hm:vibe', { detail: { vibe: detail.vibe } }))
    } catch {
      /* イベントが張れなくても属性は当たっている */
    }
  }
  if (typeof detail.sound === 'boolean') {
    write(SOUND_KEY, detail.sound ? '1' : '0')
    try {
      globalThis.window?.dispatchEvent(new CustomEvent('hm:sound', { detail: { enabled: detail.sound } }))
    } catch {
      /* noop */
    }
  }
  if (detail.theme === 'dark' || detail.theme === 'light') setThemePref(detail.theme)
  if (detail.lang === 'en' || detail.lang === 'ja') setLang(detail.lang)
}

/**
 * 親からの設定を受け取る（筐体モードのときだけ張る）。
 *
 * @param {Window} [win] 対象の window（テスト用）
 * @returns {() => void} 解除関数
 */
export function listenDemoSettings(win = globalThis.window) {
  if (!win?.addEventListener) return () => {}
  const onMessage = (ev) => {
    const data = ev?.data
    if (!data || data.type !== MSG_SET) return
    applyDemoSettings(data.detail || {})
  }
  win.addEventListener('message', onMessage)
  return () => win.removeEventListener('message', onMessage)
}

/** 親へ「準備できた」を知らせる。 */
export function announceReady(win = globalThis.window) {
  try {
    if (win?.parent && win.parent !== win) win.parent.postMessage({ type: MSG_READY }, '*')
  } catch {
    /* 親が居ない（単体で開いた）ときは何もしない */
  }
}
