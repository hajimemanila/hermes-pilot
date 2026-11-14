#!/usr/bin/env node
/**
 * レスポンシブ実測監査（SPEC-i18n-resp §2 B5・決定 Q4=A）。
 *
 * 目視では「甘い」部分（境界の外側・横向き・狭い 2 ペイン）を毎回の機械測定にする。
 * **npm 依存を足さない**: Chrome を `--headless=new --remote-debugging-port=0` で起動し、
 * stderr の `DevTools listening on ws://…` を読んで Node 22 標準の `WebSocket` で CDP 接続する。
 *
 * 測るもの（<viewport> <lang> <tab> <kind> <detail> の 1 行 1 違反）:
 *  - `h-overflow`  `documentElement.scrollWidth > clientWidth`（ページの横溢れ）→ 常に違反
 *  - `clip`        `scrollWidth > clientWidth + 1` の可視要素（文字切れ）→ baseline 外だけ違反
 *  - `tap`         タップ対象（`button` / `a[href]` / `input` / `[role=button]` …）の
 *                 **実効の当たり判定**が 44px 未満 → baseline 外だけ違反
 *                 （見た目の箱に加えて、透明な `::before` / `::after` で広げた当たり判定も数える）
 *  - `console`     その組み合わせを見ている間の `console.error` / `console.warn` → 常に違反
 *  - `pageerror`   捕捉されなかった例外 → 常に違反
 *
 * **44px 未満のタップ対象と文字切れは baseline 方式**: `scripts/audit-responsive.baseline.json` に
 * 受理済みのパターン（`tag.class1.class2`）を列挙し、**新しく増えたものだけ**落とす（ラチェット）。
 * 現行デザインには意図的に細いピル・チップ・リンクが多数あり、初日から全部赤にすると監査が
 * 読まれなくなるため。baseline から消えた項目（stale）も違反にするので、修正したら項目も消える。
 * 再生成は `--update-baseline`（差分をレビューすること）。
 *
 * 使い方:
 *   node scripts/audit-responsive.mjs [--url http://127.0.0.1:4097] [--token <app token>]
 *                                     [--viewport 390x844]... [--lang en]... [--tab tasks]...
 *                                     [--update-baseline]
 *   `--viewport` / `--lang` / `--tab` は繰り返し指定で対象を絞れる（既定は全組み合わせ）。
 *   `AUDIT_DEBUG=1` で進捗を stderr に出す。
 *
 * 終了コード: 違反 0 で 0、違反ありで 1。次の 3 つは**測定不能**として 1 行出して 0（可視化して緑）:
 *  - `skipped: chrome not found`      Chrome/Chromium が無い環境
 *  - `skipped: bridge not reachable`  ブリッジが落ちている
 *  - `skipped: no token`              アプリトークンが無い（認証画面を測っても意味がない）
 *
 * トークンの探索順: `--token` → 環境変数 `HERMES_PILOT_TOKEN` →
 * `~/.hermes/plugin-data/hermes-pilot/token` → `~/.hermes/mobile-pwa/token`。
 * 値は決して出力しない（`/auth?t=…` は CDP の中だけで使う）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 既定の対象 URL（ローカル ブリッジ）。 */
const DEFAULT_URL = 'http://127.0.0.1:4097'

/** Chrome の探索候補（macOS の既定インストール先 → Linux のよくあるパス）。 */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** viewport（SPEC §2 B5 の 7 通り）。iPad mini 縦・横向き・スマホ横向きを含む。 */
const VIEWPORTS = ['390x844', '744x1024', '768x1024', '820x1180', '1180x820', '844x390', '640x960']

/** 言語（`localStorage['hm.lang']` に書いてから読み直す）。 */
const LANGS = ['en', 'ja']

/** 下部ナビのタブ id（`App.jsx` の `TABS` と同じ並び）。 */
const TABS = ['tasks', 'review', 'chat', 'term', 'settings']

/**
 * 既知の「44px 未満のタップ対象」「文字切れ」の受理リスト（baseline）。
 *
 * 44px 未満の細い UI（ピル・チップ・リンク）はこのアプリの現行デザインで意図的に使われており、
 * 監査を「毎回赤」にすると誰も見なくなる。そこで **パターン（`tag.class1.class2`）で明示的に受理**し、
 * 新しい小さいタップ対象が増えたときだけ落とす（ラチェット）。行番号・文字列・サイズに依存しないので
 * 文言や並びが変わっても壊れない。`--update-baseline` で再生成し、差分をレビューする。
 */
const BASELINE_PATH = path.join(import.meta.dirname, 'audit-responsive.baseline.json')

/** baseline ファイル先頭に書く説明（人が読む）。 */
const BASELINE_NOTE =
  'acceptance baseline: 44px 未満のタップ対象と文字切れの受理済みパターン。新顔は違反、消えた項目は stale。生成: node scripts/audit-responsive.mjs --update-baseline'

/**
 * タップ対象とみなすセレクタは `measureInPage()` の中に直書きしている
 * （関数を文字列化してブラウザ側で評価するため、モジュール定数を参照できない）。
 * 変更するときは `measureInPage` の `querySelectorAll` とこの 1 行を揃える:
 * `button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch]`
 */

/** アプリ起動（下部ナビが出るまで）の待ち上限。 */
const BOOT_TIMEOUT_MS = 15000

/** `AUDIT_DEBUG=1` のときだけ進捗を stderr に出す（既定は無言）。 */
const debug = process.env.AUDIT_DEBUG ? (msg) => console.error(`[audit] ${msg}`) : () => {}

/** タブ切り替え後にレイアウトが落ち着くのを待つ時間。 */
const TAB_SETTLE_MS = 900

/**
 * コマンドライン引数を読む。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{url: string, token: string, viewports: string[], langs: string[], tabs: string[]}}
 */
function parseArgs(argv) {
  const out = { url: DEFAULT_URL, token: '', viewports: [], langs: [], tabs: [], updateBaseline: false }
  const take = (i, inline) => {
    if (inline !== undefined) return [inline, i]
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} に値が無い`)
    return [argv[i + 1], i + 1]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    if (name === '--url' || name === '--token') {
      const [value, next] = take(i, inline)
      out[name.slice(2)] = value
      i = next
    } else if (name === '--viewport' || name === '--lang' || name === '--tab') {
      const [value, next] = take(i, inline)
      out[`${name.slice(2)}s`].push(value)
      i = next
    } else if (name === '--update-baseline') {
      out.updateBaseline = true
    } else if (name === '--help' || name === '-h') {
      console.log(
        'usage: node scripts/audit-responsive.mjs [--url <base>] [--token <t>] [--viewport WxH]... [--lang en|ja]... [--tab tasks|review|chat|term|settings]... [--update-baseline]',
      )
      process.exit(0)
    } else {
      throw new Error(`未知の引数: ${arg}`)
    }
  }
  if (!out.viewports.length) out.viewports = [...VIEWPORTS]
  if (!out.langs.length) out.langs = [...LANGS]
  if (!out.tabs.length) out.tabs = [...TABS]
  return out
}

/**
 * アプリトークンを探す（値は出力しない）。
 * @param {string} explicit `--token` の値
 * @returns {string} トークン（無ければ空文字）
 */
function resolveToken(explicit) {
  if (explicit) return explicit.trim()
  if (process.env.HERMES_PILOT_TOKEN) return String(process.env.HERMES_PILOT_TOKEN).trim()
  const home = os.homedir()
  const files = [
    path.join(home, '.hermes', 'plugin-data', 'hermes-pilot', 'token'),
    path.join(home, '.hermes', 'mobile-pwa', 'token'),
  ]
  for (const file of files) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      if (value) return value
    } catch {
      /* 無ければ次 */
    }
  }
  return ''
}

/**
 * Chrome/Chromium の実行ファイルを探す。
 * @returns {string} パス（無ければ空文字）
 */
function findChrome() {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? ''
}

/**
 * baseline を読む（無ければ空）。
 * @returns {{tap: string[], clip: string[], _note?: string}} 受理済みパターン
 */
function readBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    return {
      _note: raw._note,
      tap: Array.isArray(raw.tap) ? raw.tap : [],
      clip: Array.isArray(raw.clip) ? raw.clip : [],
    }
  } catch {
    return { tap: [], clip: [] }
  }
}

/**
 * ブリッジが応答するか（TCP/HTTP の疎通だけ見る）。
 * @param {string} base 基点 URL
 * @returns {Promise<boolean>} 到達できたか
 */
async function bridgeReachable(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(3000) })
    return res.status > 0
  } catch {
    return false
  }
}

/**
 * 最小の CDP クライアント（Node 標準 `WebSocket` のみ）。
 *
 * フラットセッション（`Target.attachToTarget { flatten: true }`）を使うので、
 * ページ系コマンドは `sessionId` 付きで送る。イベントは `sessionId` を見て振り分ける。
 */
class Cdp {
  /**
   * @param {WebSocket} socket ブラウザの DevTools WebSocket
   */
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    socket.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
        return
      }
      if (msg.method) for (const fn of this.listeners) fn(msg)
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP が切断された'))
      this.pending.clear()
    })
  }

  /**
   * コマンドを送る。
   * @param {string} method CDP メソッド
   * @param {Record<string, unknown>} [params] 引数
   * @param {string} [sessionId] フラットセッション id
   * @returns {Promise<any>} 結果
   */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP が切断された'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify(payload))
    })
  }

  /**
   * イベントを購読する。
   * @param {(msg: {method: string, params: any, sessionId?: string}) => void} fn ハンドラ
   * @returns {() => void} 解除
   */
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/**
 * 指定ミリ秒待つ。
 * @param {number} ms ミリ秒
 * @returns {Promise<void>} 待機
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 条件が満たされるまで待つ。
 * @param {() => Promise<boolean>} check 判定
 * @param {number} timeoutMs 上限
 * @param {number} [stepMs] 間隔
 * @returns {Promise<boolean>} 満たされたか
 */
async function waitFor(check, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

/**
 * ページ内で測定を実行する式（戻り値は JSON）。
 *
 * 例外の切り分けは「その要素が本来スクロールする箱か」で行う:
 * `overflow-x: auto|scroll` の要素は意図的なスクロール領域なので `clip` から外す。
 * `44px` 未満の判定は「見えている要素」だけを対象にし、`display:none` の子要素や
 * `visibility:hidden` は数えない（隠れた大きな要素で誤魔化さないため）。
 *
 * @returns {object} 測定結果
 */
async function measureInPage() {
  const out = { doc: { scrollWidth: 0, clientWidth: 0 }, clip: [], tap: [], tabCount: 0 }
  const de = document.documentElement
  out.doc.scrollWidth = de.scrollWidth
  out.doc.clientWidth = de.clientWidth
  out.tabCount = document.querySelectorAll('nav .nav-item').length
  /**
   * baseline（`scripts/audit-responsive.baseline.json`）用のキー。`tag.cls1.cls2`（クラスは整列）。
   * 文字・サイズ・DOM 順に依存させないので、行がずれても baseline が壊れない。
   * クラスを持たない要素は親の `tag.classes` を添えて、`div` のような広すぎるキーにしない。
   */
  const clsKey = (el) => {
    const own = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).sort() : []
    const tag = el.tagName.toLowerCase()
    if (own.length) return `${tag}.${own.join('.')}`
    const parent = el.parentElement
    if (parent) return `${tag}>${clsKey(parent)}`
    return tag
  }

  /** 要素を 1 行で表す（セレクタ風の短い説明）。 */
  const describe = (el) => {
    const own = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    const cls = own.length ? `.${own.join('.')}` : ''
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ''}`
  }

  const visible = (el) => {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return false
    // タブを切り替えても React はペインをマウントしたまま `.pane-host.is-hidden`
    // （visibility: hidden）に退避させる。見えない・タップできない要素は数えない。
    return getComputedStyle(el).visibility === 'visible'
  }

  // 文字切れ: 「テキストだけを持つ葉」の箱より中身（文字）が広い要素。
  // 子要素を持つ箱（アイコンのバッジ等）は中身が意図的に重なるので対象外。
  //
  // **文字の実寸（Range の矩形）で測る**: `scrollWidth` は当たり判定を広げる透明な
  // 疑似要素（`::before`）でも膨らむので、それを「文字切れ」と誤検出してしまう。
  const textWidth = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    let widest = 0
    for (const r of range.getClientRects()) if (r.width > widest) widest = r.width
    return widest
  }
  const clipSeen = new Map()
  for (const el of document.querySelectorAll('body *')) {
    if (clipSeen.size >= 12) break
    if (el.childElementCount > 0) continue
    if (!(el.textContent || '').trim()) continue
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue
    if (cs.textOverflow === 'ellipsis') continue
    // インライン要素は clientWidth を持たない（0）ので箱の比較ができない（元の scrollWidth 判定も同じ）
    if (cs.display === 'inline') continue
    if (textWidth(el) > el.clientWidth + 1) {
      const key = clsKey(el)
      if (clipSeen.has(key)) continue
      clipSeen.set(key, el)
    }
  }

  // タップ対象: 実効の当たり判定が 44px 未満なら違反（WCAG 2.5.5 の目安）。
  //
  // 見た目の箱は小さいまま、透明な `::before` で当たり判定だけ 44px に広げている要素がある
  // （styles.css の「タップ対象 44px」節）。getBoundingClientRect() は疑似要素を含まないので、
  // 疑似要素の computed width/height も読んで**大きいほう**を当たり判定とする。
  // `content: none`（規則なし）と `pointer-events: none`（当たらない）は数えない。
  // 幅・高さが `auto` の疑似要素は実寸が取れないため無視する（固定値で書く決まり）。
  //
  // **広げた分が本当に当たるかを確かめる**: 疑似要素は中央に置く決まりなので、広げた端の
  // 中点を `elementFromPoint` で叩き、自分（か子孫）が返らなければ広げていないものとして扱う
  // （`overflow-x: auto` の親に縦を切られている場合など、computed 上は 44px でも実際は
  // 30px しか当たらない）。次の 3 つは叩かずに computed の寸法を使う:
  //  - 要素自身が `overflow: hidden`（自分の箱で疑似要素を切っている）
  //  - スクロールで一部しか見えていない（箱が祖先のクリップ領域からはみ出している）
  //  - 画面外（叩けない）
  // 固定された下部ナビに覆われているだけの点は「スクロールすれば当たる」ので通す。
  const hitBox = (el, r) => {
    let width = r.width
    let height = r.height
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo)
      if (!cs) continue
      const content = cs.content
      if (!content || content === 'none' || content === 'normal') continue
      if (cs.display === 'none' || cs.pointerEvents === 'none') continue
      const pw = Number.parseFloat(cs.width)
      const ph = Number.parseFloat(cs.height)
      if (Number.isFinite(pw) && pw > width) width = pw
      if (Number.isFinite(ph) && ph > height) height = ph
    }
    if (width === r.width && height === r.height) return { width, height }

    const own = getComputedStyle(el)
    if (own.overflowX !== 'visible') width = r.width
    if (own.overflowY !== 'visible') height = r.height

    // 祖先のクリップ領域（スクロール領域）を積む
    let clipL = -Infinity
    let clipT = -Infinity
    let clipR = Infinity
    let clipB = Infinity
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const pr = p.getBoundingClientRect()
      if (cs.overflowX !== 'visible') {
        clipL = Math.max(clipL, pr.left + p.clientLeft)
        clipR = Math.min(clipR, pr.left + p.clientLeft + p.clientWidth)
      }
      if (cs.overflowY !== 'visible') {
        clipT = Math.max(clipT, pr.top + p.clientTop)
        clipB = Math.min(clipB, pr.top + p.clientTop + p.clientHeight)
      }
    }
    const boxVisible = r.left >= clipL - 0.5 && r.right <= clipR + 0.5 && r.top >= clipT - 0.5 && r.bottom <= clipB + 0.5
    if (!boxVisible) return { width, height }

    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const onScreen = (x, y) => x >= 0 && y >= 0 && x <= window.innerWidth - 1 && y <= window.innerHeight - 1
    // 固定された下部ナビ等に覆われているだけなら、スクロールすれば当たるので違反にしない。
    // 隣のボタンが食っている（同じスクロール面の兄弟）場合は本当に押せないので違反にする。
    const underFixed = (node) => {
      for (let p = node; p; p = p.parentElement) {
        const pos = getComputedStyle(p).position
        if (pos === 'fixed' || pos === 'sticky') return true
      }
      return false
    }
    const taps = (x, y) => {
      const hit = document.elementFromPoint(x, y)
      if (!hit) return true
      if (hit === el || el.contains(hit)) return true
      return underFixed(hit)
    }
    const [left, right, top, bottom] = [
      [cx - width / 2 + 1, cy],
      [cx + width / 2 - 1, cy],
      [cx, cy - height / 2 + 1],
      [cx, cy + height / 2 - 1],
    ]
    if (onScreen(left[0], left[1]) && onScreen(right[0], right[1]) && !(taps(...left) && taps(...right))) width = r.width
    if (onScreen(top[0], top[1]) && onScreen(bottom[0], bottom[1]) && !(taps(...top) && taps(...bottom))) height = r.height
    return { width, height }
  }

  const tapSeen = new Map()
  for (const el of document.querySelectorAll(
    'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch]',
  )) {
    if (tapSeen.size >= 12) break
    if (!visible(el)) continue
    if (el.disabled) continue
    // xterm が文字入力を受けるための不可視の textarea（見た目のタップ対象ではない）
    if (el.classList.contains('xterm-helper-textarea')) continue
    // チェックボックス・ラジオは <label> で行ごと包んで当たり判定にしている。
    // 実効のタップ対象は label なので、label の当たり判定で測る。
    const isToggle = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')
    const target = (isToggle && el.closest('label')) || el
    const hit = hitBox(target, target.getBoundingClientRect())
    if (hit.width >= 44 && hit.height >= 44) continue
    const key = clsKey(target)
    if (tapSeen.has(key)) continue
    tapSeen.set(key, target)
  }

  // 読み込み直後の過渡状態（フェードイン途中・データ到着前）で一瞬だけ崩れる要素を
  // 違反にしないため、250ms 後にもう一度測って**まだ崩れているものだけ**残す。
  await new Promise((resolve) => setTimeout(resolve, 250))

  out.clip = [...clipSeen].filter(([, el]) => el.isConnected && textWidth(el) > el.clientWidth + 1).map(([key, el]) => ({
    key,
    detail: `${describe(el)} textWidth=${Math.round(textWidth(el))} clientWidth=${el.clientWidth}`,
  }))
  out.tap = [...tapSeen]
    .filter(([, el]) => {
      if (!el.isConnected) return false
      const hit = hitBox(el, el.getBoundingClientRect())
      return hit.width < 44 || hit.height < 44
    })
    .map(([key, el]) => {
      const r = el.getBoundingClientRect()
      const hit = hitBox(el, r)
      const box = `${Math.round(r.width)}x${Math.round(r.height)}`
      const target = `${Math.round(hit.width)}x${Math.round(hit.height)}`
      return { key, detail: `${describe(el)} ${box}${target === box ? '' : ` (hit ${target})`}` }
    })
  return out
}

/**
 * 1 組み合わせ分の違反を集める。
 * @param {Cdp} cdp CDP クライアント
 * @param {string} sessionId ページセッション
 * @param {string} base 基点 URL
 * @param {string} token アプリトークン
 * @param {string} viewport `WxH`
 * @param {string} lang `en` | `ja`
 * @param {string[]} tabs タブ id の並び
 * @param {Map<string, Set<string>>} noise 組み合わせごとの console/pageerror 集約
 * @param {{tap: Map<string, {detail: string, where: string}>, clip: Map<string, {detail: string, where: string}>}} found
 *    44px 未満のタップ対象と文字切れの集約（key → 最初に見た詳細）
 * @returns {Promise<string[]>} `lang tab kind detail` 形式の違反行
 */
async function auditCombo(cdp, sessionId, base, token, viewport, lang, tabs, noise, found) {
  const [w, h] = viewport.split('x').map(Number)
  const violations = []
  const errors = []
  const started = Date.now()
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails
      const text = d?.exception?.description ?? d?.text ?? 'exception'
      errors.push(`pageerror ${String(text).split('\n')[0].slice(0, 160)}`)
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params?.type)) {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 160)
      errors.push(`console.${msg.params.type} ${text}`)
    }
  })

  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 2, mobile: w < 1000, screenWidth: w, screenHeight: h },
      sessionId,
    )
    // 言語は localStorage。読み直してから測る（辞書の切り替えで幅が変わる）
    await cdp.send(
      'Runtime.evaluate',
      { expression: `localStorage.setItem('hm.lang', ${JSON.stringify(lang)})`, returnByValue: true },
      sessionId,
    )
    await cdp.send('Page.navigate', { url: `${base}/?audit=${viewport}-${lang}` }, sessionId)
    debug(`navigate ${viewport} ${lang} (t=${Date.now() - started}ms)`)
    const booted = await waitFor(async () => {
      const r = await cdp.send(
        'Runtime.evaluate',
        {
          expression: 'document.querySelectorAll("nav .nav-item").length === 5 && document.readyState === "complete"',
          returnByValue: true,
        },
        sessionId,
      )
      return r.result?.value === true
    }, BOOT_TIMEOUT_MS)
    if (!booted) {
      violations.push(`${lang} - boot-timeout 下部ナビ（5 タブ）が出ない`)
      return violations
    }
    debug(`booted ${viewport} ${lang} (t=${Date.now() - started}ms)`)
    await sleep(TAB_SETTLE_MS)

    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i]
      if (i > 0) {
        const clicked = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => { const b = document.querySelectorAll('nav .nav-item')[${TABS.indexOf(tab)}]; if (!b) return false; b.click(); return true })()`,
            returnByValue: true,
          },
          sessionId,
        )
        if (clicked.result?.value !== true) {
          violations.push(`${lang} ${tab} nav-missing タブボタンが押せない`)
          continue
        }
        await sleep(TAB_SETTLE_MS)
      }
      const before = errors.length
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression: `(${measureInPage.toString()})()`, returnByValue: true, awaitPromise: true },
        sessionId,
      )
      if (res.exceptionDetails) {
        violations.push(`${lang} ${tab} measure-error ${String(res.exceptionDetails.text).slice(0, 120)}`)
        continue
      }
      const m = res.result?.value
      if (!m) {
        violations.push(`${lang} ${tab} measure-empty 測定結果が空`)
        continue
      }
      const overflow = m.doc.scrollWidth - m.doc.clientWidth
      if (overflow > 0) {
        violations.push(`${lang} ${tab} h-overflow scrollWidth=${m.doc.scrollWidth} clientWidth=${m.doc.clientWidth}`)
      }
      for (const detail of m.clip) {
        if (!found.clip.has(detail.key))
          found.clip.set(detail.key, { detail: detail.detail, where: `${viewport} ${lang} ${tab}` })
      }
      for (const detail of m.tap) {
        if (!found.tap.has(detail.key))
          found.tap.set(detail.key, { detail: detail.detail, where: `${viewport} ${lang} ${tab}` })
      }
      // 待つ間に増えた console/pageerror を集計（同じ文は 1 回だけ）
      for (const line of errors.slice(before)) noise.get(`${lang} ${tab}`).add(line)
      debug(`tab ${tab} done (t=${Date.now() - started}ms)`)
    }
  } finally {
    off()
  }
  return violations
}

/**
 * 監査を実行する。
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-audit-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let wsUrl = ''
  const cleanup = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 既に終了 */
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 消せなくても致命的ではない */
    }
  }
  process.on('exit', cleanup)

  const browserWs = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome の DevTools エンドポイントが出ない（10 秒）')), 10000)
    const onData = (chunk) => {
      const text = String(chunk)
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(text)
      if (m) {
        wsUrl = m[1]
        clearTimeout(timer)
        child.stderr.off('data', onData)
        resolve(wsUrl)
      }
    }
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!wsUrl) reject(new Error(`Chrome が起動直後に終了した (exit ${code})`))
    })
  })
  if (!wsUrl) throw new Error('DevTools エンドポイントを取得できなかった')

  const socket = new WebSocket(browserWs)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools に接続できない')), { once: true })
  })
  const cdp = new Cdp(socket)

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  debug(`target ${targetId}`)
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  debug(`session ${sessionId}`)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  debug('page session enabled')

  // 認証: 一度だけ `/auth?t=…` を踏んで Cookie にする（トークンは出力しない）
  debug('auth navigate')
  await cdp.send('Page.navigate', { url: `${base}/auth?t=${encodeURIComponent(token)}` }, sessionId)
  await waitFor(async () => {
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId)
    return r.result?.value === 'complete'
  }, 10000)

  const violations = []
  const noise = new Map()
  const found = { tap: new Map(), clip: new Map() }
  let combos = 0
  for (const viewport of args.viewports) {
    for (const lang of args.langs) {
      combos += 1
      debug(`combo ${viewport} ${lang}`)
      for (const tab of args.tabs) noise.set(`${lang} ${tab}`, new Set())
      const rows = await auditCombo(cdp, sessionId, base, token, viewport, lang, args.tabs, noise, found)
      for (const row of rows) violations.push(`${viewport} ${row}`)
    }
  }
  // console / pageerror は「組 × タブ」で 1 行にまとめる
  for (const [key, set] of noise) {
    for (const line of set) violations.push(`- ${key} ${line.replace(/\s+$/, '')}`)
  }

  // タップ対象・文字切れは baseline と突き合わせる（新顔だけ落とす）
  const baseline = readBaseline()
  if (args.updateBaseline) {
    const next = {
      _note: BASELINE_NOTE,
      tap: [...found.tap.keys()].sort(),
      clip: [...found.clip.keys()].sort(),
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
    for (const line of violations) console.log(line)
    for (const [kind, map] of Object.entries(found)) {
      for (const [key, info] of map) console.log(`measured ${kind} ${key} — ${info.where} ${info.detail}`)
    }
    console.log(`audit:responsive: baseline を更新した（tap ${next.tap.length} / clip ${next.clip.length}）`)
    cleanup()
    process.exit(0)
  }
  for (const kind of ['clip', 'tap']) {
    const accepted = new Set(baseline[kind] ?? [])
    for (const [key, info] of found[kind]) {
      if (!accepted.has(key)) violations.push(`- ${info.where} ${kind} ${info.detail} [key=${key}]`)
    }
    for (const key of accepted) {
      if (!found[kind].has(key)) violations.push(`- baseline-stale ${kind} ${key}（もう測れないので baseline から消す）`)
    }
  }
  const acceptedCount = (baseline.tap?.length ?? 0) + (baseline.clip?.length ?? 0)

  try {
    await cdp.send('Target.closeTarget', { targetId })
    socket.close()
  } catch {
    /* 終了処理の失敗は無視 */
  }

  if (violations.length) {
    for (const line of violations) console.log(line)
    console.error(`audit:responsive: ${violations.length} violation(s) / ${combos} combination(s)`)
  } else {
    console.log(
      `audit:responsive: ok — ${combos} combination(s) = ${args.viewports.length} viewport x ${args.langs.length} lang x ${args.tabs.length} tab, 0 violation(s), ${acceptedCount} accepted (baseline)`,
    )
  }
  // Chrome と WebSocket が残ると Node が終了しないので、後始末してから確実に落とす
  const code = violations.length ? 1 : 0
  cleanup()
  process.exit(code)
}

main().catch((err) => {
  console.error(`audit:responsive: ${err?.message ?? err}`)
  process.exit(1)
})
