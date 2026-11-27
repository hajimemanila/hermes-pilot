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
import { HM_EVENTS, emitHmEvent } from '../contracts/events.js'
import { HM_STORAGE } from '../contracts/storage.js'
import { createMemoryStorage, safeStorage } from '../lib/safeStorage.js'

export const VIBE_KEY = HM_STORAGE.VIBE
export const SOUND_KEY = HM_STORAGE.SOUND

/** 親 → 子のメッセージ種別。 */
export const MSG_SET = 'hm-demo:set'
/** 子 → 親のメッセージ種別（iframes の読み込み完了）。 */
export const MSG_READY = 'hm-demo:ready'

/**
 * 単一ファイル埋め込み（`dist-demo/google-sites-embed.html`）が立てる目印。
 *
 * この HTML は `<iframe srcdoc>` や Google Sites のサンドボックス枠に**そのまま**置かれる。
 * その環境では相対 URL が解決できず（`./?demo-frame=1` は 404）、`localStorage` の
 * プロパティ参照そのものが `SecurityError` になる。両方をここで吸収する。
 */
const EMBED_FLAG = '__HM_DEMO_EMBED__'

/**
 * 埋め込み（srcdoc / sandbox / file:// 以外の一時オリジン）で動いているか。
 *
 * @param {Window} [win] 対象の window
 * @returns {boolean} 埋め込みなら true
 */
export function isEmbeddedSession(win = globalThis.window) {
  if (!win) return false
  if (win[EMBED_FLAG] === true) return true
  try {
    const loc = win.location
    if (!loc) return false
    const href = String(loc.href ?? '')
    const protocol = String(loc.protocol ?? '')
    if (protocol === 'about:' || protocol === 'blob:' || protocol === 'data:') return true
    // `srcdoc` は about:srcdoc になるが、念のため href でも見る
    return href.startsWith('about:srcdoc') || href === 'about:blank'
  } catch {
    return false
  }
}

/**
 * 子フレームの URL（相対なので GitHub Pages の下層パスでも動く）。
 *
 * 単一ファイル埋め込み（`google-sites-embed.html` / `srcdoc`）では相対 URL が解決できず
 * iframe が 404 するので、**`null` を返して iframe 自体を作らせない**（SPEC-PILOT-V6 D32）。
 *
 * @param {string} [href] 親の URL
 * @param {boolean} [embedded] 埋め込み環境か
 * @returns {string|null} URL（埋め込みでは null）
 */
export function frameUrl(href = globalThis.location?.href ?? '', embedded = false) {
  if (embedded) return null
  try {
    const url = new URL('./', href)
    url.searchParams.set('demo-frame', '1')
    return url.href
  } catch {
    return './?demo-frame=1'
  }
}

/**
 * 「この文書は筐体（`DemoStage`）の中身」と示す目印。
 *
 * 通常の静的サイトでは `?demo-frame=1` の URL で区別できるが、埋め込みビルドの
 * `google-sites-embed.html` は **相対 URL が解決できず iframe を張れない**。そこで親は
 * 自分の初期 HTML を `srcDoc` に複製し、`<html>` に目印属性を 1 つ足して子を作る
 * （`buildEmbeddedFrameSrcDoc`）。子はこの目印を見て筐体バーを描かず、バナー＋アプリだけを出す。
 *
 * 目印は **HTML の属性**（`FRAME_ATTR`）で付ける。JS のブール値だと、複製元の HTML には
 * アプリのバンドル（= この定数の文字列そのもの）が入っているため、文字列一致では
 * 「もう目印が入っている」と誤判定して何も注入できなかった（実測）。
 */
export const FRAME_FLAG = '__HM_DEMO_FRAME__'

/** `<html>` に付ける目印属性（`srcdoc` 複製ではこちらを使う）。 */
export const FRAME_ATTR = 'data-hm-frame'

/** 筐体の中身を開くときのクエリ名（`?demo-frame=1`）。 */
export const FRAME_QUERY = 'demo-frame'

/**
 * 筐体（iframe）の中身として開かれた文書か。
 *
 * 3 通りを 1 か所で判定する:
 * - 静的サイト: `?demo-frame=1`
 * - 埋め込み（`srcdoc`）: `<html data-hm-frame="1">`（親が複製時に付ける）
 * - 明示フラグ: `window.__HM_DEMO_FRAME__ === true`（テスト・将来の手動起動用）
 *
 * @param {Window} [win] 対象の window
 * @returns {boolean} 筐体の中身なら true
 */
export function isFrameSession(win = globalThis.window) {
  if (!win) return false
  try {
    if (win[FRAME_FLAG] === true) return true
  } catch {
    /* 目印が読めなくても次の判定へ */
  }
  try {
    if (win.document?.documentElement?.getAttribute?.(FRAME_ATTR) === '1') return true
  } catch {
    /* document が読めない環境は URL 判定だけに任せる */
  }
  try {
    const search = String(win.location?.search ?? '')
    if (!search) return false
    return new URLSearchParams(search).get(FRAME_QUERY) === '1'
  } catch {
    return false
  }
}

/**
 * 埋め込み（`srcdoc`）の筐体に載せる `srcDoc` を作る。
 *
 * 相対 URL が使えない環境でデバイスシミュレータを出すための唯一の方法が
 * 「自分の文書をそのまま複製する」こと。親は起動前に退避した初期 HTML
 * （`window.__HM_INITIAL_HTML__`）をここへ渡し、`<html>` に目印を 1 つ足す。
 * 目印は属性なので、子は**描画より前**（バンドル評価時）に自分の立場を知れる。
 *
 * 冪等: すでに目印がある HTML を渡したら**そのまま返す**（二重に付けない）。
 * 複製できない入力（空・`<html>` が無い断片）は `''` を返し、呼び出し側は
 * 筐体を出さず全画面にフォールバックする。
 *
 * @param {string} html 複製元の HTML（`document.documentElement.outerHTML` 相当）
 * @returns {string} `srcDoc`（複製できないときは空文字）
 */
export function buildEmbeddedFrameSrcDoc(html) {
  const source = String(html ?? '')
  if (!source.trim()) return ''
  const root = /<html\b([^>]*)>/i.exec(source)
  if (!root) return ''
  if (new RegExp(`\\b${FRAME_ATTR}\\s*=`, 'i').test(root[1])) return source
  const marked = `<html${root[1]} ${FRAME_ATTR}="1">`
  return source.slice(0, root.index) + marked + source.slice(root.index + root[0].length)
}

/**
 * 保存領域の実装は `lib/safeStorage.js` が唯一の定義（SPEC-COHERENCE-SWEEP-3 §3.5）。
 *
 * ここは既存の import 元（`apps/web/test/demoEmbed.test.js` など）を変えずに済ませるための
 * 再輸出だけを持つ。
 */
export { createMemoryStorage, safeStorage } from '../lib/safeStorage.js'

/**
 * `window.localStorage` / `window.sessionStorage` を安全な実装に差し替える（冪等）。
 *
 * アプリ側（`App.jsx` / `ChatPane.jsx` など）は `try` を付けずに `localStorage` を触るので、
 * サンドボックス iframe では**プロパティ参照の時点で**落ちる。デモの読み込み直後
 * （単一ファイル埋め込みでは `<head>` のインラインスクリプト）でここを通す。
 *
 * @param {Window} [win] 対象の window
 * @returns {boolean} 差し替えた（または既に安全だった）ら true
 */
export function installSafeStorage(win = globalThis.window) {
  if (!win) return false
  if (win.__hmSafeStorage) return true
  for (const kind of ['localStorage', 'sessionStorage']) {
    let native = null
    try {
      native = win[kind]
      if (native) {
        native.setItem('__hm_probe__', '1')
        native.removeItem('__hm_probe__')
      }
    } catch {
      native = null
    }
    if (native) continue
    const mem = createMemoryStorage()
    try {
      Object.defineProperty(win, kind, { configurable: true, get: () => mem })
    } catch {
      try {
        win[kind] = mem
      } catch {
        /* 差し替え不能なら呼び出し側の try に任せる */
      }
    }
  }
  try {
    Object.defineProperty(win, '__hmSafeStorage', { value: true, configurable: true })
  } catch {
    /* 印を立てられなくても動作に影響しない */
  }
  return true
}

/**
 * 保存する（保存できなくても見た目は変える）。
 *
 * @param {string} key キー
 * @param {string} value 値
 * @param {Window} [win] 対象の window
 */
function write(key, value, win = globalThis.window) {
  safeStorage('localStorage', win).setItem(key, value)
}


/**
 * 環境設定を 1 つずつ当てる（受け取った分だけ）。
 *
 * @param {{vibe?: string, sound?: boolean, theme?: string, lang?: string}} detail 設定
 * @param {Document} [doc] 対象の文書（テスト用）
 */
function applyDemoSettings(detail = {}, doc = globalThis.document) {
  if (!doc) return
  if (detail.vibe === 'dopamine' || detail.vibe === 'serotonin') {
    write(VIBE_KEY, detail.vibe)
    doc.documentElement.dataset.vibe = detail.vibe
    try {
      emitHmEvent(HM_EVENTS.VIBE, { vibe: detail.vibe })
    } catch {
      /* イベントが張れなくても属性は当たっている */
    }
  }
  if (typeof detail.sound === 'boolean') {
    write(SOUND_KEY, detail.sound ? '1' : '0')
    try {
      emitHmEvent(HM_EVENTS.SOUND, { enabled: detail.sound })
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
