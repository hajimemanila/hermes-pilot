#!/usr/bin/env node
/**
 * 単一自己完結 HTML（`apps/web/dist-demo/google-sites-embed.html`）を作る（SPEC-PILOT-V6 D32）。
 *
 * `npm run build:demo` は 2 段構え:
 *   1. `vite build --outDir dist-demo --base ./` … 通常の静的サイト（URL 埋め込み用）
 *   2. `node scripts/build-demo-embed.mjs`     … この HTML（コード埋め込み用）
 *
 * Google Sites の「コード埋め込み」は **サンドボックス iframe / `srcdoc`** で動く。そこでは
 * - 相対 URL（`./assets/index-xxx.js`）が解決できず 404 する
 * - `localStorage` の参照そのものが `SecurityError` になる
 * - manifest / icon の取得も 404 になる
 * そのため `<script src>` と `<link rel="stylesheet">` を**中身ごと**埋め込み、PWA 用の
 * `<link>` を落とし、`localStorage` を安全な実装に差し替える小さなスクリプトを先頭に置く。
 *
 * 生成後にセルフチェック（外部参照が 1 つも残っていないこと）まで行い、残っていれば exit 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** リポジトリのルート（このスクリプトは `scripts/` の下）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** デモビルドの出力先。 */
export const DEMO_DIR = path.join(ROOT, 'apps', 'web', 'dist-demo')
/** 生成物。 */
export const EMBED_FILE = path.join(DEMO_DIR, 'google-sites-embed.html')

/**
 * `<head>` の先頭に差し込む小さなスクリプト。
 *
 * - `window.__HM_DEMO_EMBED__ = true` … アプリ側（`demo/frame.js` の `isEmbeddedSession`）が
 *   「iframe を張らない・相対 URL を作らない」と判断するための目印。`DemoStage` は
 *   これを見てデバイス筐体を出さず、この文書をそのまま全画面で使う。
 * - `localStorage` / `sessionStorage` … サンドボックスで参照に失敗したらメモリ実装に差し替える
 *   （`App.jsx` / `ChatPane.jsx` などは `try` 無しで触るため、ここで塞がないと起動直後に落ちる）。
 */
export const EMBED_BOOTSTRAP = `<script>(function(){
  try { window.__HM_DEMO_EMBED__ = true } catch (e) { /* noop */ }
  function mem() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null },
      setItem: function (k, v) { m[String(k)] = String(v) },
      removeItem: function (k) { delete m[String(k)] },
      clear: function () { m = {} },
      key: function (i) { return Object.keys(m)[Number(i)] || null },
      get length() { return Object.keys(m).length }
    };
  }
  function safe(name) {
    var native = null;
    try {
      native = window[name];
      if (native) { native.setItem('__hm_probe__', '1'); native.removeItem('__hm_probe__') }
    } catch (e) { native = null }
    if (native) return;
    var fallback = mem();
    try { Object.defineProperty(window, name, { configurable: true, get: function () { return fallback } }) }
    catch (e) { try { window[name] = fallback } catch (e2) { /* noop */ } }
  }
  safe('localStorage');
  safe('sessionStorage');
})();</script>`

/** `<link>` のうち、埋め込み先で 404 になるもの（PWA / アイコン）。 */
const DROP_LINK_RELS = new Set(['manifest', 'icon', 'apple-touch-icon', 'mask-icon', 'preload', 'modulepreload'])

/**
 * 1 枚の HTML から外部参照を消す（純関数・テストから直接叩ける）。
 *
 * @param {string} html `dist-demo/index.html` の中身
 * @param {(rel: string) => string} read 相対パスを読む関数（`./assets/x.js` を受ける）
 * @param {{bootstrap?: string}} [options] 差し込むスクリプト
 * @returns {{html: string, inlined: string[]}} 生成物とインライン化したファイル一覧
 */
export function inlineAssets(html, read, { bootstrap = EMBED_BOOTSTRAP } = {}) {
  const inlined = []
  let out = String(html ?? '')

  // 1) <link rel="stylesheet" href="..."> を <style> に置き換える
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (/rel\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '').trim().toLowerCase()
    const href = /href\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? ''
    if (rel === 'stylesheet' && href) {
      const css = read(href)
      inlined.push(href)
      return `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`
    }
    if (DROP_LINK_RELS.has(rel)) return ''
    return tag
  })

  // 2) <script src="..."> を中身ごと埋め込む（type="module" はそのまま維持する）
  out = out.replace(/<script\b([^>]*)\bsrc\s*=\s*"([^"]+)"([^>]*)><\/script>/gi, (_all, before, src, after) => {
    const attrs = `${before}${after}`
    const js = read(src)
    inlined.push(src)
    const type = /type\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ''
    const typeAttr = type ? ` type="${type}"` : ''
    // `</script` がコード内に現れると HTML パーサがタグを閉じてしまうので退避する
    const safe = js.replace(/<\/script/gi, '<\\/script')
    return `<script${typeAttr}>${safe}</script>`
  })

  // 3) 埋め込み用のブートストラップ（保存領域の安全化・埋め込みの目印）を先頭に置く
  if (bootstrap) {
    out = out.includes('<head>') ? out.replace('<head>', `<head>\n${bootstrap}`) : `${bootstrap}\n${out}`
  }
  return { html: out, inlined }
}

/**
 * 生成物に外部参照が残っていないか検査する。
 *
 * @param {string} html 生成した HTML
 * @returns {string[]} 問題（空なら合格）
 */
export function verifyEmbedHtml(html) {
  const problems = []
  const src = String(html ?? '')
  const scriptSrc = /<script\b[^>]*\bsrc\s*=\s*"[^"]*"/gi.exec(src)
  if (scriptSrc) problems.push(`script src remains: ${scriptSrc[0].slice(0, 120)}`)
  const linkHref = /<link\b[^>]*\bhref\s*=\s*"([^"]*)"/gi
  for (let m = linkHref.exec(src); m; m = linkHref.exec(src)) {
    if (!m[1].startsWith('data:')) problems.push(`link href remains: ${m[1]}`)
  }
  // インライン CSS が外部ファイル（フォント・画像）を参照していないか
  const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    const target = m[1].trim()
    if (target.startsWith('data:') || target.startsWith('#') || target.startsWith('var(')) continue
    problems.push(`css url() points outside the file: ${target}`)
  }
  // 画像の相対参照（`src="./..."`）
  const imgSrc = /<img\b[^>]*\bsrc\s*=\s*"(\.\/[^"]*)"/i.exec(src)
  if (imgSrc) problems.push(`img src remains relative: ${imgSrc[1]}`)
  return problems
}

/**
 * `dist-demo/index.html` から単一ファイルを作る。
 *
 * @param {{dir?: string, outFile?: string}} [options] 入出力
 * @returns {{file: string, bytes: number, inlined: string[]}} 結果
 */
export function buildEmbed({ dir = DEMO_DIR, outFile = EMBED_FILE } = {}) {
  const indexPath = path.join(dir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    throw new Error(`demo build not found: ${indexPath} (run vite build first)`)
  }
  const indexHtml = fs.readFileSync(indexPath, 'utf8')
  const read = (rel) => {
    const clean = String(rel).split('?')[0].split('#')[0]
    const file = path.resolve(dir, clean)
    if (!file.startsWith(path.resolve(dir))) throw new Error(`asset escapes dist-demo: ${rel}`)
    if (!fs.existsSync(file)) throw new Error(`asset not found: ${rel} (chunks must be inlined: check inlineDynamicImports)`)
    return fs.readFileSync(file, 'utf8')
  }
  const { html, inlined } = inlineAssets(indexHtml, read)
  const problems = verifyEmbedHtml(html)
  if (problems.length) {
    throw new Error(`embed self-check failed:\n- ${problems.join('\n- ')}`)
  }
  fs.writeFileSync(outFile, html)
  return { file: outFile, bytes: Buffer.byteLength(html), inlined }
}

/** CLI エントリ。 */
function main() {
  try {
    const r = buildEmbed()
    const rel = path.relative(ROOT, r.file)
    process.stdout.write(`embed: ${rel} (${(r.bytes / 1024).toFixed(1)} KiB, ${r.inlined.length} assets inlined)\n`)
    for (const f of r.inlined) process.stdout.write(`  - ${f}\n`)
  } catch (e) {
    process.stderr.write(`build-demo-embed: ${e?.message ?? e}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
