import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import { I18nProvider } from './i18n/index.js'
import { initTheme } from './lib/theme.js'
import './styles.css'

// 最初の描画より前にテーマを当てる（React の effect を待つと Dark が一瞬見える）
initTheme()

/**
 * デモビルド（`npm run build:demo` / `VITE_DEMO_MODE=1`）かどうか。
 *
 * Vite は `import.meta.env.VITE_DEMO_MODE` をビルド時に文字列へ置き換えるので、通常ビルド
 * （`npm run build`）ではこの定数は `false` になり、下の分岐（`import('./demo/…')` を含む）ごと
 * バンドルから消える。= 本番 PWA にモックやツアー用フィクスチャは 1 バイトも入らない
 * （SPEC-PILOT-V5 §3.4 ① の受入条件。ビルド後の `dist/` を grep して確認する）。
 */
const DEMO = import.meta.env.VITE_DEMO_MODE === '1'

/**
 * 筐体（iframe）の中身として開かれたか。
 *
 * PC では `DemoStage` が `?demo-frame=1` の iframe にこのアプリを読み込み、その中身が
 * デバイスのビューポート（390/820）になる。ここでは筐体バーを描かず、ガイドバー＋アプリだけを出す
 * （親から来る環境設定は `demo/frame.js` が受ける）。
 */
const FRAME = DEMO && new URLSearchParams(globalThis.location?.search ?? '').get('demo-frame') === '1'

async function mount() {
  const root = createRoot(document.getElementById('root'))
  if (DEMO) {
    // バックエンド無しで A2B の 4 ステップを体験するデモ（SPEC-PILOT-V5 §3.4）
    const mock = await import('./demo/mockApi.js')
    globalThis.__hmDemoFetch = mock.demoFetch
    globalThis.__hmDemoSocket = mock.demoSocket
    // 画像（`/api/review/...`）は data URL に差し替える（静的ホスティングで 404 を出さない）
    mock.installDemoImageShim()

    const { DemoBanner } = await import('./demo/DemoBanner.jsx')

    if (FRAME) {
      const { announceReady, listenDemoSettings } = await import('./demo/frame.js')
      listenDemoSettings()
      root.render(
        <I18nProvider>
          <div className="demo-mobile">
            <DemoBanner />
            <App />
          </div>
        </I18nProvider>,
      )
      // 描画が終わってから親（筐体バー）へ知らせる = 初期設定が流れ込む
      setTimeout(announceReady, 0)
      return
    }

    const { DemoStage } = await import('./demo/DemoStage.jsx')
    root.render(
      <I18nProvider>
        <DemoStage>
          <DemoBanner />
          <App />
        </DemoStage>
      </I18nProvider>,
    )
    return
  }
  root.render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  )
}

mount()

// デモは静的ホスティング（GitHub Pages 等）なので Service Worker を登録しない
// （残すと `/sw.js` が 404 になりコンソールエラーになる）
if (!DEMO && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
  /*
   * 更新の反映: 新しい Service Worker が制御を取ったら**一度だけ**再読み込みする。
   * これを入れないと、ホーム画面から起動したままの PWA は古いバンドルのまま動き続け、
   * 「直したはずの UI が反映されない」状態になる（実測: 端末で旧レイアウトが残った）。
   * ループ防止に sessionStorage のフラグを使い、読み込み後に消す。
   */
  const RELOAD_KEY = 'hm.swReload'
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === '1') sessionStorage.removeItem(RELOAD_KEY)
  } catch {
    /* noop */
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === '1') return
      sessionStorage.setItem(RELOAD_KEY, '1')
    } catch {
      /* sessionStorage が使えなくても 1 回だけ再読み込みする */
    }
    window.location.reload()
  })
}
