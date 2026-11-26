/**
 * ビルド済み Web 成果物の自動検出と同一オリジン配信（preview.js）。
 *
 * 127.0.0.1 や一時的な LAN IP（192.168.x.x:4173）をそのまま返さず、
 * Hermes Pilot ブリッジの認証済み同一オリジン `/api/boards/:board/preview-files/` から
 * 静的 HTML / JS / CSS / 画像を安全に配信する。
 */
import fs from 'node:fs'
import path from 'node:path'

const STATIC_ENTRY_CANDIDATES = [
  'dist/index.html',
  'build/index.html',
  'out/index.html',
  'public/index.html',
  'docs/index.html',
  'index.html',
  'web/dist/index.html',
  'frontend/dist/index.html',
]

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

function findStaticEntryRel(repoAbs) {
  for (const rel of STATIC_ENTRY_CANDIDATES) {
    const abs = path.join(repoAbs, rel)
    try {
      if (fs.statSync(abs).isFile()) return rel
    } catch {
      /* continue */
    }
  }
  // 1 階層下の apps/*/dist/index.html も探す
  try {
    const appsDir = path.join(repoAbs, 'apps')
    if (fs.existsSync(appsDir) && fs.statSync(appsDir).isDirectory()) {
      for (const name of fs.readdirSync(appsDir)) {
        const rel = path.posix.join('apps', name, 'dist/index.html')
        const abs = path.join(repoAbs, rel)
        try {
          if (fs.statSync(abs).isFile()) return rel
        } catch {
          /* continue */
        }
      }
    }
  } catch {
    /* noop */
  }
  return null
}

function inferLaunchCommand(repoAbs) {
  const pkgPath = path.join(repoAbs, 'package.json')
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const scripts = pkg?.scripts || {}
      if (scripts.preview) return 'npm run preview'
      if (scripts.dev) return 'npm run dev'
      if (scripts.start) return 'npm start'
    }
  } catch {
    /* noop */
  }
  for (const py of ['app.py', 'main.py', 'server.py']) {
    if (fs.existsSync(path.join(repoAbs, py))) return `python3 ${py}`
  }
  return null
}

/**
 * リポジトリ内のプレビュー可能な成果物（静的サイト / アプリ起動コマンド）を検出する。
 * @param {string|null|undefined} repoPath
 * @param {string} boardSlug
 */
export function detectProjectPreview(repoPath, boardSlug) {
  const board = String(boardSlug || '').trim()
  const launchCmdBase = repoPath && fs.existsSync(repoPath) ? inferLaunchCommand(path.resolve(repoPath)) : null
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { ok: true, kind: 'none', board, url: null, entry: null, rootRel: null, updatedAt: null, launchCmd: null }
  }
  const repoAbs = fs.resolve ? path.resolve(repoPath) : path.resolve(repoPath)
  const entry = findStaticEntryRel(repoAbs)
  if (entry) {
    const rootRel = path.posix.dirname(entry)
    let updatedAt = null
    try {
      updatedAt = Math.round(fs.statSync(path.join(repoAbs, entry)).mtimeMs)
    } catch {
      /* noop */
    }
    return {
      ok: true,
      kind: 'static',
      board,
      url: `/api/boards/${encodeURIComponent(board)}/preview-files/`,
      entry,
      rootRel: rootRel === '.' ? '' : rootRel,
      updatedAt,
      launchCmd: launchCmdBase,
    }
  }
  return {
    ok: true,
    kind: launchCmdBase ? 'app' : 'none',
    board,
    url: null,
    entry: null,
    rootRel: null,
    updatedAt: null,
    launchCmd: launchCmdBase,
  }
}

/**
 * Vite 等の root-absolute パス（`/assets/...`）を `/api/boards/:board/preview-files/...` へ書き換え、
 * `<base href="...">` を注入してサブパス配下でもそのまま動作させる。
 */
export function rewritePreviewHtml(html, boardSlug) {
  const prefix = `/api/boards/${encodeURIComponent(String(boardSlug || ''))}/preview-files/`
  let out = String(html ?? '')
  // `/api/` や `//` 以外の先頭 `/` 参照をプレビュー配下へ寄せる
  out = out.replace(/(href|src)=(["'])\/(?!\/|api\/)/gi, `$1=$2${prefix}`)
  if (!/<base\b/i.test(out)) {
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${prefix}">`)
    } else {
      out = `<base href="${prefix}">\n${out}`
    }
  }
  return out
}

/**
 * ボードの静的プレビュー配下から 1 ファイルを安全に読む（realpath 監獄付き）。
 * @param {string|null|undefined} repoPath
 * @param {string} boardSlug
 * @param {string} [relPath]
 */
export function readPreviewFile(repoPath, boardSlug, relPath = '') {
  const info = detectProjectPreview(repoPath, boardSlug)
  if (info.kind !== 'static') return { ok: false, code: 'NOT_FOUND' }

  const repoAbs = path.resolve(repoPath)
  const rootDir = info.rootRel ? path.resolve(repoAbs, info.rootRel) : repoAbs
  const raw = String(relPath ?? '').replace(/^\/+/, '')
  const targetRel = !raw || raw.endsWith('/') ? path.posix.join(raw, 'index.html') : raw
  if (targetRel.includes('\0') || targetRel.split(/[\\/]/).includes('..')) {
    return { ok: false, code: 'BAD_REQUEST' }
  }

  try {
    const realRoot = fs.realpathSync(rootDir)
    const candidate = path.resolve(realRoot, targetRel)
    const relCheck = path.relative(realRoot, candidate)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return { ok: false, code: 'NOT_FOUND' }
    const realFile = fs.realpathSync(candidate)
    const relReal = path.relative(realRoot, realFile)
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) return { ok: false, code: 'NOT_FOUND' }
    if (!fs.statSync(realFile).isFile()) return { ok: false, code: 'NOT_FOUND' }

    const ext = path.extname(realFile).toLowerCase()
    const type = MIME_BY_EXT[ext] || 'application/octet-stream'
    let data = fs.readFileSync(realFile)
    if (ext === '.html' || ext === '.htm') {
      data = Buffer.from(rewritePreviewHtml(data.toString('utf8'), boardSlug), 'utf8')
    }
    return {
      ok: true,
      data,
      type,
      headers: {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "frame-ancestors 'self'",
      },
    }
  } catch {
    return { ok: false, code: 'NOT_FOUND' }
  }
}
