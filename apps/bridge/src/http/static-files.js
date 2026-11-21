/**
 * 静的配信（`server.js` から切り出し）。SPA の `dist` を配るだけの層。
 *
 * `dist` が無い／ビルド途中なら直前の正常ビルド（`dist.prev`）で配る。
 * 実測: 改修中にビルドが走っている間 `dist` が欠け、PWA が
 * 「ブリッジに接続できません」で使えなくなった。落とさないための保険。
 */

import fs from 'node:fs'
import path from 'node:path'

import { MIME } from './respond.js'

/**
 * @param {{distDir: string}} options 設定
 * @returns {{serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => Promise<void>, cacheControlFor: (file: string) => string, distCandidates: () => string[]}} 配信関数
 */
export function createStaticFiles({ distDir }) {
  /** 候補ディレクトリ（現行ビルド → 直前の正常ビルド）。 */
  const distCandidates = () => [distDir, `${distDir}.prev`]

  /** キャッシュ方針（html/manifest/json は no-cache、/assets/ のハッシュ付きは長期）。 */
  function cacheControlFor(file) {
    const ext = path.extname(file)
    if (ext === '.html' || ext === '.webmanifest' || ext === '.json') return 'no-cache'
    if (file.includes(`${path.sep}assets${path.sep}`)) return 'public, max-age=31536000, immutable'
    return 'public, max-age=3600, must-revalidate'
  }

  const readOrNull = (file) =>
    new Promise((resolve) => fs.readFile(file, (err, buf) => resolve(err ? null : { buf, file })))

  /** 候補ディレクトリを順に試し、最初に見つかった {buf,file} を返す。 */
  async function readFirst(files) {
    for (const file of files) {
      const hit = await readOrNull(file)
      if (hit) return hit
    }
    return null
  }

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname
    const file = path.join(distDir, rel)
    if (!file.startsWith(distDir)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const dirs = distCandidates()
    const hit = await readFirst(dirs.map((d) => path.join(d, rel)))
    if (hit) {
      res.writeHead(200, {
        'content-type': MIME[path.extname(hit.file)] ?? 'application/octet-stream',
        'cache-control': cacheControlFor(hit.file),
      })
      res.end(hit.buf)
      return
    }
    if (path.extname(rel)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    // SPA フォールバック
    const index = await readFirst(dirs.map((d) => path.join(d, 'index.html')))
    if (!index) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('UI not built (run npm run build)')
      return
    }
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(index.buf)
  }

  return { serveStatic, cacheControlFor, distCandidates }
}
