#!/usr/bin/env node
/**
 * 「ターミナルの Enter が PTY へ届く」ことを実ブラウザで測る（SPEC-enter-enter-discuss-next-ste Q4=A）。
 *
 * 単体テスト（`apps/web/test/termKey.test.js`）は**マッピングだけ**を固定するので、
 * 「DOM と xterm の間に何も届かない」という報告された症状は見えない。ここは実ブラウザで
 *
 *   1. タブに**戻ってきたとき** xterm の隠し textarea にフォーカスが戻っているか
 *      （タブは `visibility:hidden + inert` で生かしたまま隠れるので、ここが壊れても画面は同じに見える）
 *   2. 本物の `keydown`（CDP の `Input.dispatchKeyEvent`）1 回で `{t:'in',d:'\r'}` が
 *      **ちょうど 1 フレーム**出るか（xterm と自前ハンドラの二重送信が無いか）
 *
 * を測る。**フレームは送らずに記録だけする**（`WebSocket.prototype.send` を差し替え、`t:'in'` は
 * 握り潰す）ので、本番の PTY で空行が実行されることはない。
 *
 * 使い方: node scripts/check-term-enter.mjs [--url http://127.0.0.1:4097] [--token <t>]
 *
 * 次の 3 つは**測定不能**として 1 行出して 0（緑に見せない・黙らない）:
 *   - `skipped: chrome not found`      Chrome/Chromium が無い環境
 *   - `skipped: bridge not reachable`  ブリッジが落ちている
 *   - `skipped: no token`              アプリトークンが無い（認証画面を測っても意味がない）
 *
 * 終了コード: 違反 0 で 0、違反ありで 1。
 * 注意: 測るのは**配信中の dist**（`npm run build` / `npm run deploy` の後）。ソースを直しただけで
 * 走らせると旧バンドルを測るので、`npm run verify` の並びでは build の後に置いてある。
 */

import { Cdp, bridgeReachable, findChrome, launchChrome, resolveToken, sleep, waitFor } from './lib/cdp.mjs'

/** 既定の対象 URL（ローカル ブリッジ）。 */
const DEFAULT_URL = 'http://127.0.0.1:4097'

/** 下部ナビの `App.jsx` TABS と同じ並び（index 4 = term）。 */
const NAV_ITEM = '.nav .nav-item'
const TAB_TASKS = 0
const TAB_TERM = 4

/**
 * `WebSocket.prototype.send` を差し替えて送信フレームを記録する。
 * `{t:'in'}` は**送らない**（本番 PTY に空行を流さない）。既に差し替え済みなら何もしない。
 *
 * あわせて `WebSocket` を薄く包み、`/ws/term` の開閉（close コード）を控える。
 * 端末ソケットが開いた直後に閉じる症状（bridge の PTY 起動失敗）を、
 * 「フレームが 0 本」ではなく理由つきで報告するため。
 */
const PATCH_WS = `(() => {
  if (window.__hmTermProbe) return 'already'
  const orig = WebSocket.prototype.send
  window.__hmSent = []
  window.__hmTermSockets = []
  WebSocket.prototype.send = function (d) {
    try { window.__hmSent.push(String(d)) } catch (e) {}
    try { const m = JSON.parse(String(d)); if (m && m.t === 'in') return undefined } catch (e) {}
    return orig.call(this, d)
  }
  const Orig = window.WebSocket
  window.WebSocket = class extends Orig {
    constructor(...args) {
      super(...args)
      try {
        if (String(args[0] || '').indexOf('/ws/term') === -1) return
        const rec = { state: 'connecting', code: null, reason: '' }
        window.__hmTermSockets.push(rec)
        this.addEventListener('open', () => { rec.state = 'open' })
        this.addEventListener('error', () => { if (rec.state !== 'closed') rec.state = 'error' })
        this.addEventListener('close', (e) => { rec.state = 'closed'; rec.code = e.code; rec.reason = e.reason })
      } catch (e) {}
    }
  }
  window.__hmTermProbe = true
  return 'patched'
})()`

/** 端末の見えている行（bridge が書いたエラー行を報告に載せるため）。 */
const READ_SCREEN = `(() => {
  const rows = document.querySelectorAll('.term-host .xterm-rows > div')
  const text = [...rows].map((r) => r.textContent || '').map((t) => t.trimEnd()).filter((t) => t.trim()).slice(-4).join(' / ')
  return text.slice(0, 300)
})()`

/**
 * 下部ナビのタブを押す。要素が無ければ件数とラベルを返す（沈黙して落ちない）。
 * @returns {Promise<{ok: boolean, count: number, labels?: string[]}>}
 */
async function clickTab(cdp, sessionId, index) {
  return cdp.eval(
    `(() => {
      const items = document.querySelectorAll('${NAV_ITEM}')
      const el = items[${index}]
      if (!el) {
        return { ok: false, count: items.length, labels: [...items].map((n) => n.getAttribute('aria-label') || n.textContent || '').slice(0, 8) }
      }
      el.click()
      return { ok: true, count: items.length }
    })()`,
    sessionId,
  )
}

/** 引数を読む。 */
function parseArgs(argv) {
  const out = { url: DEFAULT_URL, token: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i]
    if (name === '--url' || name === '--token') {
      const value = argv[i + 1]
      if (!value) throw new Error(`${name} には値が要る`)
      if (name === '--url') out.url = value
      else out.token = value
      i += 1
    } else if (name === '--help' || name === '-h') {
      console.log('usage: node scripts/check-term-enter.mjs [--url <base>] [--token <t>]')
      process.exit(0)
    } else {
      throw new Error(`知らない引数: ${name}`)
    }
  }
  return out
}

/**
 * 実測する。
 * @returns {Promise<number>} 終了コード
 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = args.url.replace(/\/+$/, '')
  const chrome = findChrome()
  if (!chrome) {
    console.log('skipped: chrome not found')
    return 0
  }
  if (!(await bridgeReachable(base))) {
    console.log('skipped: bridge not reachable')
    return 0
  }
  const token = resolveToken(args.token)
  if (!token) {
    console.log('skipped: no token')
    return 0
  }

  const { wsUrl, cleanup } = await launchChrome(chrome)
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools に接続できない')), { once: true })
  })
  const cdp = new Cdp(socket)
  const close = async () => {
    try {
      await cdp.send('Target.closeTarget', { targetId })
    } catch {
      /* 終了処理の失敗は無視 */
    }
    try {
      socket.close()
    } catch {
      /* 同上 */
    }
    cleanup()
  }

  const violations = []
  const fail = (msg) => violations.push(msg)

  let targetId = ''
  try {
    ;({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }))
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    // スマホ（PWA の既定は 390x844）
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    )

    // 認証は 1 回だけ `/auth?t=…` を踏んで Cookie にする（トークンは出力しない）
    await cdp.send('Page.navigate', { url: `${base}/auth?t=${encodeURIComponent(token)}` }, sessionId)
    await waitFor(async () => (await cdp.eval('document.readyState', sessionId)) === 'complete', 10000)
    /*
     * Service Worker を外してから本体を開く。SW が新しい版へ切り替わると `controllerchange` で
     * 1 回 `location.reload()` するので（`main.jsx`）、その最中に測ると「nav 0 件」で落ちる
     * （実測: 同じスクリプトが回によって成功/失敗した）。この測定には SW は不要。
     */
    await cdp.eval(
      `(async () => {
        try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())) } catch (e) {}
        try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))) } catch (e) {}
        return true
      })()`,
      sessionId,
    )
    await cdp.send('Page.navigate', { url: `${base}/` }, sessionId)
    const booted = await waitFor(
      async () => Number(await cdp.eval(`document.querySelectorAll('${NAV_ITEM}').length`, sessionId)) >= 6,
      20000,
    )
    if (!booted) {
      fail('下部ナビ（6 タブ）が出ない — 認証（トークン）か配信中の dist を確認する')
      throw new Error('boot failed')
    }
    // 遅れて来る再読み込み（SW・チャンク再取得）を 1 回吸ってから測る
    await sleep(1200)
    const stillUp = await waitFor(
      async () => Number(await cdp.eval(`document.querySelectorAll('${NAV_ITEM}').length`, sessionId)) >= 6,
      10000,
    )
    if (!stillUp) {
      fail('計測中にアプリが再読み込みされ、下部ナビが戻らない')
      throw new Error('reloaded')
    }

    // 端末ペインがマウントする前に送信フレームの記録を仕込む
    const patched = await cdp.eval(PATCH_WS, sessionId)
    if (patched !== 'patched') fail(`WebSocket.send を差し替えられない（${patched}）`)

    // 1) ターミナルタブを開く（lazy マウントなので、ここで初めて WS が張られる）
    const termClick = await clickTab(cdp, sessionId, TAB_TERM)
    if (!termClick.ok) {
      fail(`ターミナルタブが見つからない（nav ${termClick.count} 件: ${(termClick.labels || []).join(' | ')}）`)
      throw new Error('nav missing')
    }
    const mounted = await waitFor(
      async () => Boolean(await cdp.eval(`Boolean(document.querySelector('.term-host .xterm-helper-textarea'))`, sessionId)),
      20000,
    )
    if (!mounted) {
      fail('ターミナルの xterm（隠し textarea）が出ない')
      throw new Error('no xterm')
    }
    const wsOpen = await waitFor(
      async () =>
        Boolean(
          await cdp.eval(
            `(window.__hmSent || []).some((d) => { try { return JSON.parse(d).t === 'resize' } catch (e) { return false } })`,
            sessionId,
          ),
        ),
      15000,
    )
    if (!wsOpen) fail('ターミナルの WebSocket が開かない（resize フレームが出ない）')
    else {
      // bridge が PTY を起動できないと open → resize 1 本 → close(**1011**) という
      // 「開いているように見える」失敗になる（実測: 枯渇時はまさにこれ）。コード 1011 だけを拾う
      // （1005/1006 はタブ切替の張り直しでも出るので違反にしない）。
      const sockets = JSON.parse(String(await cdp.eval('JSON.stringify(window.__hmTermSockets || [])', sessionId)))
      const refused = sockets.filter((s) => s.state === 'closed' && s.code === 1011)
      if (refused.length) {
        const screen = String((await cdp.eval(READ_SCREEN, sessionId)) || '')
        fail(
          `bridge が端末 WS を閉じた（code=1011・${refused.length} 回）= PTY を起動できていない` +
            `${screen ? ` / 端末の表示: ${screen}` : ''}`,
        )
      }
    }

    // 2) 別タブへ行って戻る = TabHost が blur → 戻ったときにフォーカスを繋ぎ直せるか
    const awayClick = await clickTab(cdp, sessionId, TAB_TASKS)
    if (!awayClick.ok) fail(`タスクタブが見つからない（nav ${awayClick.count} 件）`)
    await sleep(300)
    const awayFocus = String(await cdp.eval(`(document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || ''`, sessionId))
    const blurred = !awayFocus.includes('xterm-helper-textarea')
    if (!blurred) fail(`別タブへ移っても xterm の textarea にフォーカスが残っている（前提が崩れた: ${awayFocus}）`)

    const backClick = await clickTab(cdp, sessionId, TAB_TERM)
    if (!backClick.ok) fail(`ターミナルタブへ戻れない（nav ${backClick.count} 件）`)
    const focused = await waitFor(
      async () =>
        String(
          await cdp.eval(
            `(document.activeElement && document.activeElement.className) || ''`,
            sessionId,
          ),
        ).includes('xterm-helper-textarea'),
      3000,
    )
    if (!focused) {
      fail('タブに戻っても xterm にフォーカスが戻らない（キーボードが端末に繋がらない）')
      // それでもキー経路は測る（配線の不具合とフォーカスの不具合を切り分ける）
      await cdp.eval(`document.querySelector('.term-host .xterm-helper-textarea')?.focus()`, sessionId)
    }

    // 3) 本物の Enter を 1 回だけ撃ち、クライアントから出るフレームを見る
    const before = Number(await cdp.eval('(window.__hmSent || []).length', sessionId))
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
      },
      sessionId,
    )
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      sessionId,
    )
    await sleep(400)

    const raw = JSON.parse(
      String(await cdp.eval(`JSON.stringify((window.__hmSent || []).slice(${before}))`, sessionId)),
    )
    const frames = raw.map((d) => {
      try {
        return JSON.parse(d)
      } catch {
        return { raw: d }
      }
    })
    const writes = frames.filter((f) => f.t === 'in')
    if (writes.length !== 1) {
      fail(`Enter 1 回で {t:'in'} が ${writes.length} フレーム出た（1 が正。2 以上は二重送信、0 は未達）`)
    } else if (writes[0].d !== '\r') {
      fail(`Enter のフレームが CR でない: ${JSON.stringify(writes[0].d)}`)
    }
    if (!writes.length) {
      const shapes = frames.map((f) => (f.t ? f.t : Object.keys(f).join(','))).join(' / ')
      // 原因の切り分けに要る材料を一緒に出す（端末ソケットの生死と、画面に出ている行）
      const sockets = JSON.parse(String(await cdp.eval('JSON.stringify(window.__hmTermSockets || [])', sessionId)))
      const lastSocket = sockets[sockets.length - 1]
      const socketNote = lastSocket
        ? `端末 WS: ${lastSocket.state}${lastSocket.code != null ? ` code=${lastSocket.code}` : ''}`
        : '端末 WS: 記録なし'
      const screen = String(await cdp.eval(READ_SCREEN, sessionId) || '')
      fail(
        `Enter で何も送られていない（この回の送信フレーム: ${shapes || 'なし'} / ${socketNote}` +
          `${screen ? ` / 端末の表示: ${screen}` : ''}）`,
      )
    }

    // 4) IME 変換中の Enter（Q2=A: 確定 Enter でも実行する）
    //    CDP には composition 付きのキーが無いので、`isComposing: true` の合成 keydown を投げる
    //    （xterm 側は keyCode 0 の合成イベントを送らないので、ここで 1 フレーム出れば
    //     出どころはこちらのハンドラだけ = ハンドラを外すと 0 になる）
    const beforeIme = Number(await cdp.eval('(window.__hmSent || []).length', sessionId))
    const ime = await cdp.eval(
      `(() => {
        const el = document.querySelector('.term-host .xterm-helper-textarea')
        if (!el) return { ok: false }
        el.focus()
        const ev = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
        })
        const notCancelled = el.dispatchEvent(ev)
        return { ok: true, prevented: !notCancelled || ev.defaultPrevented }
      })()`,
      sessionId,
    )
    await sleep(300)
    const imeRaw = JSON.parse(
      String(await cdp.eval(`JSON.stringify((window.__hmSent || []).slice(${beforeIme}))`, sessionId)),
    )
    const imeWrites = imeRaw
      .map((d) => {
        try {
          return JSON.parse(d)
        } catch {
          return { raw: d }
        }
      })
      .filter((f) => f.t === 'in')
    if (!ime.ok) fail('IME 用のプローブ（隠し textarea）が見つからない')
    else if (imeWrites.length !== 1 || imeWrites[0].d !== '\r') {
      fail(`IME 変換中の Enter で {t:'in',d:'\\r'} が出ない（${imeWrites.length} フレーム）— Q2=A の契約が効いていない`)
    }

    if (!violations.length) {
      console.log(
        "check:term-enter: ok — 戻ったタブで xterm がフォーカスされ、実 Enter と IME 中の Enter がそれぞれ {t:'in',d:'\\r'} を 1 フレームだけ出した",
      )
    }
  } catch (err) {
    if (!violations.length) fail(`実測できなかった: ${err.message}`)
  }

  await close()
  if (violations.length) {
    for (const line of violations) console.log(`- ${line}`)
    console.error(`check:term-enter: ${violations.length} violation(s)`)
    return 1
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`check:term-enter: ${err?.message ?? err}`)
    process.exit(1)
  })
