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

/**
 * 単一ファイル埋め込み（`dist-demo/google-sites-embed.html`）が立てる目印。
 *
 * この HTML は `<iframe srcdoc>` や Google Sites のサンドボックス枠に**そのまま**置かれる。
 * その環境では相対 URL が解決できず（`./?demo-frame=1` は 404）、`localStorage` の
 * プロパティ参照そのものが `SecurityError` になる。両方をここで吸収する。
 */
export const EMBED_FLAG = '__HM_DEMO_EMBED__'

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

/** メモリだけの Storage 代替（サンドボックスでも例外を投げない）。 */
export function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => {
      map.set(String(key), String(value))
    },
    removeItem: (key) => {
      map.delete(String(key))
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][Number(index)] ?? null,
    get length() {
      return map.size
    },
  }
}

/**
 * 保存領域を安全に取り出す（ネイティブが例外を投げる環境ではメモリ実装）。
 *
 * @param {'localStorage'|'sessionStorage'} [kind] 種類
 * @param {Window} [win] 対象の window
 * @returns {Storage|object} 使える保存領域
 */
export function safeStorage(kind = 'localStorage', win = globalThis.window) {
  const memKey = `__hmMem_${kind}`
  const fallback = () => {
    if (!win) return createMemoryStorage()
    if (!win[memKey]) {
      try {
        Object.defineProperty(win, memKey, { value: createMemoryStorage(), configurable: true })
      } catch {
        return createMemoryStorage()
      }
    }
    return win[memKey]
  }
  try {
    const native = win?.[kind]
    if (!native) return fallback()
    // 参照できても書き込みで落ちる環境（プライベートモードの quota 0）を弾く
    const probe = '__hm_probe__'
    native.setItem(probe, '1')
    native.removeItem(probe)
    return native
  } catch {
    return fallback()
  }
}

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
