/**
 * デモの画像（外部ファイルゼロ: SVG 文字列 → data URL）。
 * `mockApi.js` から分割した（公開契約は `mockApi.js` の再エクスポートで維持）。
 */
import { DEMO_SNIPPETS, DEMO_TERM_SNIPPETS } from './snippets.js'

/* ------------------------------------------------------------------ *
 * 画像（外部ファイルゼロ: SVG 文字列 -> data URL）
 * ------------------------------------------------------------------ */

const SVG_INK = '#f4f7f8'
const SVG_CARD = '#ffffff'
const SVG_LINE = '#cfdde2'
const SVG_TEXT = '#5c7480'
const SVG_HEAD = '#0f766e'
const SVG_ACCENT = '#0d9488'
const SVG_WARN = '#d97706'
const SVG_BAD = '#b91c1c'

/**
 * 390x844 の擬似スクリーンショット（SVG 文字列）。
 *
 * `variant='before'` はトーストが下部ナビに重なった状態、`'after'` はナビの上へ退避した状態。
 * 画像は外部ファイルに置かず、ここで組み立てる（静的ホスティングでも 404 を出さない）。
 * 明るい配色にしてあるので、注釈（赤入れ）でどこが直ったかがひと目で分かる。
 *
 * @param {'before'|'after'} variant どちらの状態か
 * @returns {string} SVG 文字列
 */
export function mockShotSvg(variant = 'before') {
  const after = variant === 'after'
  // トーストの y 座標: before はナビ（y=760..844）に重なり、after はその上へ退避
  const toastY = after ? 688 : 772
  const rows = [0, 1, 2, 3, 4, 5]
    .map((i) => {
      const y = 150 + i * 84
      return `<g><rect x="24" y="${y}" width="342" height="64" rx="14" fill="${SVG_CARD}" stroke="${SVG_LINE}"/>
      <rect x="40" y="${y + 14}" width="164" height="11" rx="5" fill="${i < 2 ? SVG_TEXT : SVG_LINE}"/>
      <rect x="40" y="${y + 34}" width="104" height="9" rx="4" fill="${SVG_LINE}"/>
      <circle cx="334" cy="${y + 32}" r="12" fill="${i < 2 ? SVG_ACCENT : SVG_LINE}"/></g>`
    })
    .join('')
  const nav = [0, 1, 2, 3, 4]
    .map((i) => `<rect x="${30 + i * 70}" y="798" width="28" height="28" rx="8" fill="${i === 1 ? SVG_ACCENT : SVG_LINE}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
  <rect width="390" height="844" fill="${SVG_INK}"/>
  <rect x="0" y="0" width="390" height="100" fill="${SVG_CARD}"/>
  <rect x="0" y="99" width="390" height="1" fill="${SVG_LINE}"/>
  <text x="24" y="58" font-family="ui-sans-serif,system-ui" font-size="24" font-weight="700" fill="${SVG_HEAD}">Hermes Pilot</text>
  <circle cx="352" cy="50" r="9" fill="${SVG_ACCENT}"/>
  <text x="24" y="132" font-family="ui-sans-serif,system-ui" font-size="15" font-weight="700" fill="${
    after ? SVG_ACCENT : SVG_BAD
  }">${after ? 'AFTER - fixed' : 'BEFORE - reported'}</text>
  ${rows}
  <rect x="0" y="760" width="390" height="84" fill="${SVG_CARD}"/>
  <rect x="0" y="760" width="390" height="1" fill="${SVG_LINE}"/>
  ${nav}
  <g>
    <rect x="24" y="${toastY}" width="342" height="58" rx="14" fill="${after ? '#ecfdf5' : '#fef3c7'}" stroke="${
      after ? SVG_ACCENT : SVG_WARN
    }" stroke-width="2"/>
    <text x="44" y="${toastY + 36}" font-family="ui-sans-serif,system-ui" font-size="17" font-weight="700" fill="${
      after ? '#065f46' : '#7c2d12'
    }">${after ? 'Approved - above the nav' : 'Toast overlaps the nav'}</text>
  </g>
</svg>`
}

/** SVG 文字列をそのまま `<img src>` に渡せる data URL にする。 */
export function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(svg ?? ''))}`
}

/** 擬似スクリーンショットの data URL。 */
export function mockShotDataUrl(variant = 'before') {
  return svgToDataUrl(mockShotSvg(variant))
}

/**
 * `<img src="/api/review/...">` のような **fetch を通らない URL** を data URL に差し替える。
 *
 * 画面コンポーネントは本物のブリッジと同じ URL を書いているので、静的ホスティングでは
 * そのまま 404（コンソールエラー）になる。デモでは画像だけをここで解決する。
 *
 * @param {string} src 元の URL
 * @returns {string|null} 差し替え先（対象外なら null）
 */
export function demoImageFor(src) {
  const url = String(src ?? '')
  if (!url.startsWith('/api/review/')) {
    if (url.startsWith('/api/review/library/file')) return mockShotDataUrl('after')
    return null
  }
  if (url.includes('/thumb/')) return mockShotDataUrl('after')
  if (url.includes('/image')) return mockShotDataUrl(url.includes('compare=1') ? 'before' : 'after')
  if (url.includes('/sheet')) return mockShotDataUrl('after')
  return null
}

/**
 * デモ中だけ DOM の `<img>` と `new Image()` を見張って src を data URL に差し替える。
 *
 * - DOM に挿さる `<img>` は MutationObserver で拾う
 * - AnnotationEditor のように **JS で `img.src = ...` する**（DOM に挿さらない）ものは
 *   `HTMLImageElement.prototype.src` の setter を包んで拾う（デモ中だけ・冪等）
 *
 * 対象外の URL（data: や /assets/…）には触らない。
 *
 * @returns {() => void} 解除関数（テスト用）
 */
export function installDemoImageShim(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || typeof MutationObserver === 'undefined') return () => {}
  if (doc.__hmDemoImgShim) return doc.__hmDemoImgShim

  const fix = (img) => {
    const src = img.getAttribute('src')
    if (!src || img.dataset.demoFixed === '1') return
    const next = demoImageFor(src)
    if (!next) return
    img.dataset.demoFixed = '1'
    img.setAttribute('src', next)
  }
  const scan = (root) => {
    if (!root) return
    if (root.nodeType === 1 && root.tagName === 'IMG') fix(root)
    const list = root.querySelectorAll ? root.querySelectorAll('img[src^="/api/review/"]') : []
    for (const img of list) fix(img)
  }
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') {
        if (rec.target?.dataset?.demoFixed === '1') continue
        if (rec.target?.tagName === 'IMG') fix(rec.target)
        continue
      }
      for (const node of rec.addedNodes) scan(node)
    }
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  scan(doc.documentElement)

  // `new Image()` / `img.src = '/api/review/...'`（DOM に挿さらない画像）を拾う
  const view = doc.defaultView
  const Img = view?.HTMLImageElement
  const desc = Img ? Object.getOwnPropertyDescriptor(Img.prototype, 'src') : null
  let restoreSrc = () => {}
  if (desc?.set) {
    Object.defineProperty(Img.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        const next = demoImageFor(value)
        desc.set.call(this, next || value)
      },
    })
    restoreSrc = () => Object.defineProperty(Img.prototype, 'src', desc)
  }

  const off = () => {
    observer.disconnect()
    restoreSrc()
    delete doc.__hmDemoImgShim
  }
  doc.__hmDemoImgShim = off
  return off
}
