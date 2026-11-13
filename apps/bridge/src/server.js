import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WebSocketServer, WebSocket } from 'ws'
import { createRequire } from 'node:module'
import { loadConfig, VERSION } from './config.js'
import { createAuth, isAllowedWsOrigin } from './auth.js'
import { createHermesClient } from './hermes.js'
import { createKanban } from './kanban.js'
import { createReview, injectReviewBridge } from './review.js'
import { createReviewWatcher } from './review-watcher.js'
import { createOps } from './ops.js'
import {
  CUSTOM_MAX,
  HOT_LIMIT,
  allSnippets,
  readSnippetStore,
  writeSnippetStore,
  BUILTIN_IDS,
} from './snippets.js'
import { allTermSnippets, TERM_BUILTIN_IDS } from './term-snippets.js'
import { createGitInfo } from './gitinfo.js'
import { createDiscord } from './discord.js'
import { createSearch } from './search.js'
import { createTranscript } from './transcript.js'
import { createCapture } from './capture.js'
import { createUsage } from './usage.js'
import { createLive } from './live.js'
import { createInbox } from './inbox.js'
import { createRepos, normalizePath } from './repos.js'
import { createSpecs, listSpecs } from './specs.js'
import { createPairCodes } from './pair-codes.js'
import { getCapabilities } from './capabilities.js'
import { errorBody } from './api-errors.js'
import { resolveLang } from './lang.js'
import { checkFrame, rejectionFrame } from './chat-profile.js'
import { readTailText } from './tail.js'
import { collectPairing, qrPng, qrRows, qrSvg, tailscaleCommandCandidates } from './qr.js'

const require = createRequire(import.meta.url)
const pty = safeRequire('node-pty')

/**
 * `tailscale status --json` を 1 回だけ叩いて 60 秒キャッシュする。
 *
 * Tailscale が無い・ログインしていない環境では素直に null（LAN 候補だけ出す）。
 * ここで失敗してもペアリングは成立させる（QR が出ない理由にしない）。
 * @returns {Promise<string|null>} 生の JSON 文字列
 */
let tailscaleCache = { at: 0, json: null }
async function tailscaleStatusJson() {
  const now = Date.now()
  if (now - tailscaleCache.at < 60_000) return tailscaleCache.json
  const { execFile } = await import('node:child_process')
  let json = null
  for (const bin of tailscaleCommandCandidates()) {
    json = await new Promise((resolve) => {
      try {
        execFile(bin, ['status', '--json'], { timeout: 1500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
          resolve(err ? null : String(stdout)),
        )
      } catch {
        resolve(null)
      }
    })
    if (json) break
  }
  tailscaleCache = { at: now, json }
  return json
}

/**
 * node-pty はネイティブモジュール。無くても他は動かす。
 * @param {string} name モジュール名
 * @returns {any|null} モジュール
 */
function safeRequire(name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

const cfg = loadConfig()
const capabilities = getCapabilities()
// ワンタイム・ペアリングコード（QR を短くするため。SPEC §8.2 の one-time token）
const pairCodes = createPairCodes(cfg)
const auth = createAuth(cfg, { pairCodes })
const hermes = createHermesClient(cfg)
const kanban = createKanban(cfg)
// リポジトリ（作業ディレクトリ）↔ ボード。一覧は repos.json ＋ 1 階層スキャン
// ＋ ボードの default_workdir ＋ 直近セッション cwd の統合（SPEC §5.1）
const repos = createRepos(cfg, { boards: () => kanban.boards() })
// Spec Launchpad（`docs/SPEC-*.md` → バッチ → カンバン一括起票）。SPEC §5.4 / D15④
const specs = createSpecs(cfg, { tasks: (board) => kanban.tasks(board, { limit: 200 }), listSpecs })
const review = createReview(cfg, { targets: () => repos.targets() })
// 完了・ブロックの記録はブリッジ内蔵（D7）。外部 cron は要らない。
const reviewWatcher = createReviewWatcher(cfg, { review })
const ops = createOps(cfg, hermes, auth, { kanban })
const gitinfo = createGitInfo(cfg)
const discord = createDiscord(cfg)
const search = createSearch(cfg)
const transcript = createTranscript(cfg)

/**
 * プロファイル一覧（name と state.db の在処）。30秒キャッシュ。
 * チャット一覧をプロジェクト横断にするために使う。
 */
let profilesCache = { at: 0, list: [] }
async function listProfiles() {
  if (Date.now() - profilesCache.at < 30_000 && profilesCache.list.length) return profilesCache.list
  const r = await hermes.call('/api/profiles', { timeoutMs: 8000 })
  const list = r.status === 200 ? (r.data?.profiles ?? []) : []
  if (list.length) profilesCache = { at: Date.now(), list }
  return list
}

/** プロファイル名 → state.db のパス（不明なら既定）。 */
function stateDbFor(profiles, name) {
  const hit = profiles.find((p) => p.name === name)
  if (!hit?.path) return cfg.stateDb
  return path.join(hit.path, 'state.db')
}

/** 全プロファイルの state.db 一覧（重複除去・default フォールバック付き）。 */
async function listStateDbs() {
  const profiles = await listProfiles()
  const out = []
  const seen = new Set()
  for (const p of profiles) {
    if (!p?.name) continue
    const dbPath = p.path ? path.join(p.path, 'state.db') : cfg.stateDb
    if (seen.has(dbPath)) continue
    seen.add(dbPath)
    out.push({ profile: p.name, path: dbPath })
  }
  if (!seen.has(cfg.stateDb)) {
    out.unshift({ profile: 'default', path: cfg.stateDb })
  }
  return out
}
const capture = createCapture(cfg)
const usage = createUsage(cfg)
const live = createLive(cfg, kanban)
const inbox = createInbox(cfg, kanban)
// 起動時にコミットサマリを温める（初回のタスク一覧を待たせない）
gitinfo.warm().catch(() => {})

// スニペット（組み込みの Hot/Hidden 上書き + ユーザー定義を小さな JSON に保存する・SPEC §3.4）
const SNIPPET_STORE = {
  chat: { file: path.join(cfg.dataDir, 'snippets.json'), ids: BUILTIN_IDS, withRun: false },
  term: { file: path.join(cfg.dataDir, 'term-snippets.json'), ids: TERM_BUILTIN_IDS, withRun: true },
}

/**
 * スニペット設定を読む（version 1 は読取時に version 2 へ補完）。
 * @param {'chat'|'term'} kind 種類
 * @returns {{version: 2, overrides: Record<string, object>, custom: Array<object>}} 設定
 */
function loadSnippetStore(kind) {
  const s = SNIPPET_STORE[kind]
  return readSnippetStore(s.file, { ids: s.ids, withRun: s.withRun, max: CUSTOM_MAX })
}

/**
 * スニペット設定を保存する（`reset: true` で既定に戻す）。
 * @param {'chat'|'term'} kind 種類
 * @param {{custom?: unknown, overrides?: unknown, reset?: boolean}} [body] 変更内容
 * @returns {{version: 2, overrides: Record<string, object>, custom: Array<object>}} 保存した設定
 */
function saveSnippetStore(kind, body = {}) {
  const s = SNIPPET_STORE[kind]
  const prev = loadSnippetStore(kind)
  const reset = body?.reset === true
  const hasCustom = body != null && Object.prototype.hasOwnProperty.call(body, 'custom')
  const hasOverrides = body != null && Object.prototype.hasOwnProperty.call(body, 'overrides')
  return writeSnippetStore(
    s.file,
    {
      custom: reset ? [] : hasCustom ? body.custom : prev.custom,
      overrides: reset ? {} : hasOverrides ? body.overrides : prev.overrides,
    },
    { ids: s.ids, withRun: s.withRun, max: CUSTOM_MAX },
  )
}

/**
 * API 応答（`{snippets, allSnippets, overrides, custom, customMax, hotLimit, lang}`）。
 * @param {'chat'|'term'} kind 種類
 * @param {'en'|'ja'} lang 表示言語
 * @returns {Record<string, unknown>} 応答
 */
function snippetPayload(kind, lang) {
  const store = loadSnippetStore(kind)
  const all =
    kind === 'term'
      ? allTermSnippets(capabilities, lang, store.overrides, store.custom)
      : allSnippets(store.custom, lang, store.overrides)
  return {
    snippets: all.filter((s) => !s.hidden),
    allSnippets: all,
    overrides: store.overrides,
    custom: store.custom,
    customMax: CUSTOM_MAX,
    hotLimit: HOT_LIMIT,
    lang,
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/** @param {import('node:http').ServerResponse} res 応答 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * エラー応答（SPEC §6.3）。`{ok:false, code, error, params}` の形に統一する。
 * @param {import('node:http').ServerResponse} res 応答
 * @param {number} status HTTP ステータス
 * @param {string} code エラーコード
 * @param {Record<string, unknown>} [params] プレースホルダ値
 * @returns {void}
 */
function sendError(res, status, code, params) {
  sendJson(res, status, errorBody(code, params))
}

/**
 * 内部モジュールの `{ok:false, code?, error|message}` を §6.3 の形へ正規化して返す。
 * 元の説明文は `detail` に残す（英語既定だけでは原因が分からない時用）。
 * @param {import('node:http').ServerResponse} res 応答
 * @param {number} status HTTP ステータス
 * @param {{code?: string, error?: unknown, message?: unknown, params?: object, status?: unknown, reason?: unknown}} r 失敗結果
 * @returns {void}
 */
function sendFailure(res, status, r) {
  const fallback = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST'
  const code = r?.code ?? fallback
  const params = r?.params ?? (r?.status ? { status: r.status } : {})
  const body = errorBody(code, params)
  const detail = [r?.message, r?.error, r?.reason].find((v) => typeof v === 'string' && v.trim())
  if (detail && detail !== body.error) body.detail = String(detail)
  sendJson(res, status, body)
}

/**
 * リクエストの表示言語（`?lang=` → `Accept-Language` → en・SPEC §6.1）。
 * @param {import('node:http').IncomingMessage} req リクエスト
 * @param {URL} url URL
 * @returns {'en'|'ja'} 言語
 */
function langOf(req, url) {
  return resolveLang({ queryLang: url.searchParams.get('lang'), acceptLanguage: req.headers['accept-language'] })
}

/** 本文を JSON として読む（上限 1MB）。 */
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** 書き込み系の簡易レート制限。 */
const writes = []
function writeAllowed(max = 60, windowMs = 60_000) {
  const now = Date.now()
  while (writes.length && now - writes[0] > windowMs) writes.shift()
  if (writes.length >= max) return false
  writes.push(now)
  return true
}

/**
 * ペアリング（`POST /api/auth/login`）専用の簡易レート制限。
 * アプリの書き込み枠と混ぜない（混ぜると通常操作が 10 回で詰まる）。
 */
const loginAttempts = []
function loginAllowed(max = 12, windowMs = 60_000) {
  const now = Date.now()
  while (loginAttempts.length && now - loginAttempts[0] > windowMs) loginAttempts.shift()
  if (loginAttempts.length >= max) return false
  loginAttempts.push(now)
  return true
}

/** 読み取り系の簡易レート制限（機能別バケットで分離）。書き込みとは枠を分ける。 */
const readBuckets = new Map()
function readAllowed(bucket = 'default', max = 240, windowMs = 60_000) {
  const now = Date.now()
  let arr = readBuckets.get(bucket)
  if (!arr) {
    arr = []
    readBuckets.set(bucket, arr)
  }
  while (arr.length && now - arr[0] > windowMs) arr.shift()
  if (arr.length >= max) return false
  arr.push(now)
  return true
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Pilot — ログイン</title>
<style>body{background:#07171b;color:#e6f4f1;font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh}
form{background:#0d242a;padding:24px;border-radius:16px;border:1px solid #1d3a41;width:min(88vw,360px)}
h1{font-size:16px;margin:0 0 12px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #24515a;background:#081e23;color:#e6f4f1;font-size:15px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;background:#13807f;color:#fff;font-size:15px}
p{color:#7fa6a3;font-size:12px;margin:10px 0 0}</style>
<form method="get" action="/auth"><h1>Hermes Pilot</h1>
<input name="t" placeholder="アプリトークン" autocomplete="off" autocapitalize="off" spellcheck="false">
<button>入る</button>
<p>トークンは <code>~/.hermes/plugin-data/hermes-pilot/token</code> またはブリッジの起動ログにあります。</p></form>`

/**
 * 静的配信。`dist` が無い／ビルド途中なら直前の正常ビルド（`dist.prev`）で配る。
 *
 * 実測: 改修中にビルドが走っている間 `dist` が欠け、PWA が
 * 「ブリッジに接続できません」で使えなくなった。落とさないための保険。
 */
function distCandidates() {
  return [cfg.distDir, `${cfg.distDir}.prev`]
}

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
  const file = path.join(cfg.distDir, rel)
  if (!file.startsWith(cfg.distDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  const dirs = distCandidates()
  const hit = await readFirst(dirs.map((d) => path.join(d, rel)))
  if (hit) {
    res.writeHead(200, { 'content-type': MIME[path.extname(hit.file)] ?? 'application/octet-stream',
                         'cache-control': cacheControlFor(hit.file) })
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
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('UI 未ビルド（npm run build）')
    return
  }
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(index.buf)
}

/** ログの末尾を返す。 */
function tailLog(name, lines = 200) {
  const safe = String(name ?? 'gateway').replace(/[^a-z0-9._-]/gi, '')
  const file = path.join(cfg.logDir, safe.endsWith('.log') ? safe : `${safe}.log`)
  if (!file.startsWith(cfg.logDir)) throw Object.assign(new Error('invalid log'), { statusCode: 400 })
  const text = readTailText(file, 256 * 1024)
  return text.split('\n').slice(-Math.min(lines, 1000)).join('\n')
}

/**
 * Spec Launchpad の対象リポジトリを決める（SPEC §5.4）。
 *
 * `?repo=<repoId>` は repos の 1 件。`?board=<slug>`（未指定なら現在のボード）は
 * そのボードの `default_workdir` をリポジトリとして扱う。
 *
 * @param {{repoId?: string|null, boardSlug?: string|null}} q クエリ
 * @returns {{repo: string, label: string, path: string, board: string|null}|null} 対象
 */
function resolveSpecRepo({ repoId = null, boardSlug = null } = {}) {
  const list = repos.list()
  const want = String(repoId ?? '').trim()
  if (want) {
    const hit = list.find((r) => r.id === want)
    return hit
      ? { repo: hit.id, label: hit.label, path: hit.path, board: hit.boards?.[0]?.slug ?? null }
      : null
  }
  const boards = kanban.boards()
  const slug = String(boardSlug ?? '').trim() || boards.find((b) => b.current)?.slug || ''
  const board = boards.find((b) => b.slug === slug)
  if (!board?.workdir) return null
  const key = normalizePath(board.workdir)
  const hit = list.find((r) => normalizePath(r.path) === key)
  return {
    repo: hit?.id ?? board.slug,
    label: hit?.label ?? board.name ?? board.slug,
    path: board.workdir,
    board: board.slug,
  }
}

/** API のルーティング。 */

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const [, a, b, c, d, e] = seg

  if (a === 'me') return sendJson(res, 200, { ok: true, version: VERSION })

  if (a === 'overview') {
    const data = await ops.overview()
    // 実行中タスク数（アプリバッジ用）
    data.runningTasks = Number(data.kanban?.running ?? 0)
    // 緊急停止（ESTOP）の状態
    data.paused = ops.paused()
    return sendJson(res, 200, data)
  }

  // 実行環境の Capability（OS・サービス管理・CLI の有無）。SPEC §5.3
  if (a === 'capabilities') {
    return sendJson(res, 200, capabilities)
  }

  // ワンタップ QR ペアリング（SPEC §8.2）。認証済みセッションから 2 台目を迎える。
  // 接続先候補（Tailscale HTTPS / LAN / localhost）と QR(SVG) を返す。
  if (a === 'auth' && b === 'pairing' && req.method === 'GET') {
    const ts = await tailscaleStatusJson()
    // QR を短くするため、本トークンではなくワンタイムコードを URL に載せる（10 分・1 回限り）
    const minted = pairCodes.mint()
    const info = collectPairing({
      token: minted.code,
      port: cfg.port,
      tailscaleJson: ts,
      // 常駐から Tailscale CLI を叩けない環境の控え（config.json）
      dnsName: cfg.pairing?.tailscaleDns ?? null,
      tlsPort: cfg.pairing?.tlsPort ?? null,
    })
    auth.audit({ kind: 'auth.pairing', target: info.best?.kind ?? null })
    return sendJson(res, 200, {
      ok: true,
      port: cfg.port,
      tlsPort: cfg.pairing?.tlsPort ?? null,
      tailscale: Boolean(info.dnsName),
      dnsName: info.dnsName,
      lanIp: info.lanIp,
      targets: info.targets,
      // 有効期限（ミリ秒エポック）。画面に「あと何分」を出せるようにする
      expiresAt: minted.expiresAt,
      // フロントはこの行列を canvas に整数ピクセルで描く（SVG の CSS 縮小は半端な
      // ピクセルになり、スキャナが反応しないため）。`qrSvg` は後方互換で残す。
      qrRows: info.best ? qrRows(info.best.url) : null,
      qrMargin: 4,
      // 実画像（base64 PNG, 41 モジュール x 7px = 287px = 7px/モジュールの整数倍）。
      // <img> ならどのブラウザでも canvas と違って確実に合成される。
      qrPng: info.best ? `data:image/png;base64,${qrPng(info.best.url, { scale: 7 }).toString('base64')}` : null,
      qrSvg: info.best ? qrSvg(info.best.url) : null,
    })
  }

  // --- リポジトリ（作業ディレクトリ）とボード -------------------------------
  // GET    /api/repos            … 統合一覧 ＋ scanDirs
  // POST   /api/repos            … { path, label? } で追加 / { scanDirs } で走査先を更新
  // POST   /api/repos/scan       … 即時再スキャン（キャッシュ TTL 30 秒を飛ばす）
  // POST   /api/repos/:id/board  … 板が無いリポジトリにボードを 1 つ作る
  // DELETE /api/repos/:id        … custom から削除 / 自動検出は hidden へ
  if (a === 'repos') {
    if (!b && req.method === 'GET') {
      return sendJson(res, 200, { repos: repos.list(), scanDirs: repos.scanDirs() })
    }
    if (!b && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = Array.isArray(body?.scanDirs) ? repos.setScanDirs(body.scanDirs) : repos.add(body)
      auth.audit({ kind: 'repos.save', ok: Boolean(r.ok), path: body?.path ?? null })
      if (!r.ok) return sendFailure(res, 400, r)
      return sendJson(res, 201, { ...r, repos: repos.list({ force: true }), scanDirs: repos.scanDirs() })
    }
    if (b === 'scan' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = repos.scan()
      auth.audit({ kind: 'repos.scan', count: r.repos.length })
      return sendJson(res, 200, r)
    }
    if (b && c === 'board' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = await repos.createBoard(b)
      auth.audit({ kind: 'repos.board.create', repo: b, board: r.board?.slug ?? null, ok: Boolean(r.ok) })
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (b && req.method === 'DELETE') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = repos.remove(b)
      auth.audit({ kind: 'repos.remove', repo: b, hidden: r.hidden ?? null, ok: Boolean(r.ok) })
      if (!r.ok) return sendFailure(res, 400, r)
      return sendJson(res, 200, { ...r, repos: repos.list({ force: true }) })
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  // --- Spec Launchpad -------------------------------------------------------
  // GET  /api/specs?repo=<repoId> | ?board=<slug>       … SPEC とバッチ一覧（SPEC §5.4）
  // POST /api/specs/launch { repo?, board?, specRelPath, batchIds?, assignee? }
  //                                                      … バッチを一括起票（同一ボードの未完了はスキップ）
  if (a === 'specs') {
    if (!b && req.method === 'GET') {
      const target = resolveSpecRepo({
        repoId: url.searchParams.get('repo'),
        boardSlug: url.searchParams.get('board'),
      })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      return sendJson(res, 200, {
        ok: true,
        repo: target.repo,
        label: target.label,
        path: target.path,
        board: target.board,
        specs: specs.listSpecs(target.path),
      })
    }
    if (b === 'launch' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const target = resolveSpecRepo({ repoId: body?.repo, boardSlug: body?.board })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const board = String(body?.board ?? target.board ?? '').trim()
      const r = await specs.launchSpec({
        repoPath: target.path,
        board,
        specRelPath: body?.specRelPath,
        batchIds: body?.batchIds,
        assignee: String(body?.assignee ?? 'mobile').trim() || 'mobile',
        dryRun: Boolean(body?.dryRun),
      })
      auth.audit({
        kind: 'specs.launch',
        board,
        spec: String(body?.specRelPath ?? ''),
        created: r.created?.length ?? 0,
        skipped: r.skipped?.length ?? 0,
        failed: r.failed?.length ?? 0,
        ok: Boolean(r.ok),
      })
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  if (a === 'boards') {
    // /api/boards                                        … ボード一覧
    // /api/boards/:slug/tasks                            … タスク一覧（git / Discord 付き）
    // /api/boards/:slug/tasks/:id                        … タスク詳細
    // /api/boards/:slug/tasks/:id/diff                   … そのタスクのコミット差分
    // POST /api/boards/:slug/tasks/:id/abort             … 実行中タスクの中断
    if (!b) return sendJson(res, 200, { boards: kanban.boards() })
    // クイック起票（POST /api/boards/:slug/tasks）
    if (b && c === 'tasks' && !d && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await capture.create({ ...body, board: b })
      auth.audit({
        kind: 'kanban.create',
        board: b,
        task: r.task?.id ?? null,
        created: Boolean(r.created),
        ok: Boolean(r.ok),
      })
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (b && c === 'tasks' && !d) {
      const list = kanban.tasks(b, { limit: Number(url.searchParams.get('limit') ?? 60) })
      // 履歴（kanban-sop）に記録があるタスクだけ git / Discord を添える
      const enriched = await Promise.all(
        list.map(async (t) => {
          const entry = gitinfo.entryFor(t.id)
          if (!entry) return t
          const [g, dc] = await Promise.all([gitinfo.forTask(t.id), Promise.resolve(discord.forAnchor(entry.anchor))])
          return { ...t, git: g, discord: dc }
        }),
      )
      return sendJson(res, 200, { tasks: enriched })
    }
    if (b && c === 'tasks' && d && e === 'diff' && req.method === 'GET') {
      const file = url.searchParams.get('file')
      if (file) {
        const patch = await gitinfo.filePatch(d, String(file).slice(0, 400))
        return sendJson(res, patch.ok ? 200 : 404, patch)
      }
      const summary = await gitinfo.diffSummary(d)
      return sendJson(res, summary.ok ? 200 : 404, summary)
    }
    if (b && c === 'tasks' && d && e === 'comment' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.comment(b, d, body?.body ?? body?.text, String(body?.by ?? 'mobile'))
      auth.audit({ kind: 'kanban.comment', board: b, task: d, chars: String(body?.body ?? body?.text ?? '').length })
      return sendJson(res, 200, out)
    }
    if (b && c === 'tasks' && d && e === 'close' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.close(b, d, body?.action, body?.note ?? body?.reason ?? '', String(body?.by ?? 'mobile'))
      auth.audit({
        kind: 'kanban.close',
        board: b,
        task: d,
        action: body?.action ?? null,
        status: out.status,
        noop: Boolean(out.noop),
      })
      return sendJson(res, 200, out)
    }
    if (b && c === 'tasks' && d && e === 'unblock' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.unblock(b, d, body?.note ?? body?.reason ?? '', String(body?.by ?? 'mobile'))
      auth.audit({
        kind: 'kanban.unblock',
        board: b,
        task: d,
        status: out.status,
        noop: Boolean(out.noop),
      })
      return sendJson(res, 200, out)
    }
    if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const reason = String(body?.reason ?? 'mobile kill switch').slice(0, 200)
      const out = await kanban.abort(b, d, reason)
      auth.audit({ kind: 'kanban.abort', board: b, task: d, reason, result: out })
      return sendJson(res, 200, out)
    }
    if (b && c === 'tasks' && d) {
      const detail = kanban.task(b, d)
      const entry = gitinfo.entryFor(d)
      if (entry) {
        detail.git = await gitinfo.forTask(d)
        detail.discord = discord.forAnchor(entry.anchor)
      }
      return sendJson(res, 200, detail)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }


  // --- レビュー（review）------------------------------------------------------
  // 全ルートは SPEC §4.2。旧 `/api/akapen/*` は廃止し、ここに一本化する。
  // /api/review                     … 一覧（review / ready / done）
  // /api/review/:id/sheet           … シート HTML（sandbox・生成物）
  // /api/review/:id/data            … sheet.json（PWA のネイティブフォーム用）
  // POST /api/review/:id/answer     … 回答を保存 → comment → unblock（冪等）
  // POST /api/review/:id/reopen     … 反映が違うとき review に戻す
  if (a === 'review') {
    if (!b) {
      return sendJson(res, 200, {
        board: review.board,
        workdir: review.workdir(),
        items: review.list(Number(url.searchParams.get('limit') ?? 80)),
      })
    }
    // /api/review/feed?limit=&since= … 作業フィード（監視 cron が書く 1 行ログ）
    if (b === 'feed' && req.method === 'GET') {
      return sendJson(res, 200, {
        items: review.feed(
          Number(url.searchParams.get('limit') ?? 20),
          Number(url.searchParams.get('since') ?? 0),
        ),
      })
    }
    // /api/review/chat-reports?limit=&since= … 全会話ぶんの完了報告（未読の点を出すため）
    // 会話一覧の行と下部ナビのチャットタブは「どの会話に新着があるか」を 1 回で要る。
    if (b === 'chat-reports' && req.method === 'GET') {
      return sendJson(res, 200, {
        items: review.chatReports({
          limit: Number(url.searchParams.get('limit') ?? 200),
          since: Number(url.searchParams.get('since') ?? 0),
        }),
      })
    }
    // /api/review/chat-report?session_id=&limit=&since= … その会話に流す完了報告
    // （監視 cron が起票元の会話へ返す 1 行。端末はチャットタブが 15 秒ごとに読む）
    if (b === 'chat-report' && req.method === 'GET') {
      const sessionId = String(url.searchParams.get('session_id') || '')
      if (!sessionId) return sendError(res, 400, 'SESSION_REQUIRED')
      return sendJson(res, 200, {
        sessionId,
        items: review.chatReport(sessionId, {
          limit: Number(url.searchParams.get('limit') ?? 3),
          since: Number(url.searchParams.get('since') ?? 0),
        }),
      })
    }
    // /api/review/:id/session        … 実行ワーカーの session_id を解決する
    if (c === 'session' && req.method === 'GET') {
      const info = review.sessionId(b)
      if (!info) return sendError(res, 404, 'NO_SESSION')
      return sendJson(res, 200, { taskId: b, status: info.status, sessionId: info.sessionId })
    }
    if (c === 'worker' && req.method === 'GET') {
      // worker（profile mobile）の進行を読む。session.resume は通らないので state.db を直接読む
      const info = review.sessionId(b)
      if (!info) return sendError(res, 404, 'NO_SESSION')
      // セッションの DB はイベントが記録した実パスを優先（無ければ profiles/mobile）
      const profileDb =
        info.db || path.join(path.dirname(cfg.kanbanRoot || path.join(os.homedir(), '.hermes', 'kanban')), 'profiles', 'mobile', 'state.db')
      const feed = transcript.read(info.sessionId, {
        dbPath: profileDb,
        limit: Number(url.searchParams.get('limit') ?? 40),
        includeTools: true,
      })
      return sendJson(res, 200, { taskId: b, status: info.status, sessionId: info.sessionId, feed })
    }
    // /api/review/library            … 注釈の下地にできる画像（library + shots）
    // /api/review/library/file?path= … その画像
    // /api/review/from-image         … 画像から注釈タスクを1件作る
    if (b === 'targets') {
      return sendJson(res, 200, { targets: review.targets() })
    }
    if (b === 'library' && !c) {
      return sendJson(res, 200, { items: review.library(Number(url.searchParams.get('limit') ?? 60)) })
    }
    if (b === 'library' && c === 'file' && req.method === 'GET') {
      const r = review.libraryFile(String(url.searchParams.get('path') || ''))
      if (!r.ok) return sendFailure(res, 404, r)
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=600' })
      return res.end(r.data)
    }
    // POST /api/review/annotation/new … 画像から注釈タスクを1件作る（SPEC §4.2）
    // 旧 `/api/review/from-image` は、配信済み dist を掴んだ端末のために受け続ける。
    if (((b === 'annotation' && c === 'new') || b === 'from-image') && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req, 12_000_000)
      const r = await review.createFromImage(body || {})
      auth.audit({ kind: 'review.from_image', task: r.taskId ?? null, source: body?.source ?? 'upload', ok: Boolean(r.ok) })
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (c === 'image' && req.method === 'GET') {
      const r = review.image(b, {
        annotated: url.searchParams.get('annotated') === '1',
        // compare=1 … Before（前回の赤入れ／前ラウンド）画像。SPEC §5.2
        compare: url.searchParams.get('compare') === '1',
      })
      if (!r.ok) return sendFailure(res, 404, r)
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=120' })
      return res.end(r.data)
    }
    if (c === 'annotation' && req.method === 'GET') {
      const r = review.annotation(b)
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 404, r)
    }
    if (c === 'annotation' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      // 画像は base64 で来るので、この経路だけ上限を上げる（既定は 1MB）
      const body = await readJson(req, 12_000_000)
      const r = await review.saveAnnotation(b, body || {})
      auth.audit({
        kind: 'review.annotation',
        task: b,
        duplicate: Boolean(r.duplicate),
        marks: r.marks ?? 0,
        ok: Boolean(r.ok),
      })
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
    }
    if (c === 'sheet' && req.method === 'GET') {
      const r = review.sheetHtml(b)
      if (!r.ok) return sendFailure(res, r.code === 'NOT_FOUND' ? 404 : 409, r)
      // iframe で埋め込む時は sandbox（別オリジン）で隔離し、回答は postMessage で親へ。
      // 単体タブで開いた時は same-origin を許可して自分で API に POST できるようにする。
      const framed = String(req.headers['sec-fetch-dest'] || '') === 'iframe'
      const csp = framed
        ? "sandbox allow-scripts allow-forms; default-src 'none'; style-src 'unsafe-inline'; " +
          "img-src data: blob:; script-src 'unsafe-inline'; font-src data:"
        : "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'unsafe-inline'; " +
          "connect-src 'self'; font-src data:"
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': csp,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      return res.end(injectReviewBridge(r.html, b))
    }
    if (c === 'thumb' && req.method === 'GET') {
      const rel = url.pathname.split('/').slice(5).join('/')
      const r = review.thumb(decodeURIComponent(rel))
      if (!r.ok) return sendFailure(res, 404, r)
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=600' })
      return res.end(r.data)
    }
    if (c === 'data' && req.method === 'GET') {
      const r = review.sheetData(b)
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 409, r)
    }
    if (c === 'answer' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.answer(b, body || {})
      auth.audit({
        kind: 'review.answer',
        task: b,
        duplicate: Boolean(r.duplicate),
        choiceCount: Array.isArray(body?.answers) ? body.answers.length : 0,
        ok: Boolean(r.ok),
      })
      // レビュー待ち以外への送信は 409（状態の衝突）として返す。他の失敗は 400。
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, r.code === 'NOT_WAITING' ? 409 : 400, r)
    }
    if (c === 'reopen' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.reopen(b, body?.reason)
      auth.audit({ kind: 'review.reopen', task: b, ok: Boolean(r.ok) })
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
    }
    // POST /api/review/:id/approve … 赤入れせずに 1 タップ検収（SPEC §5.2.3）
    // コメント `Visual check passed` を残して done（作業済み）または unblock（未作業）へ進める。
    if (c === 'approve' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.approve(b, body || {})
      auth.audit({
        kind: 'review.approve',
        task: b,
        duplicate: Boolean(r.duplicate),
        moved: r.moved ?? null,
        ok: Boolean(r.ok),
      })
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, r.code === 'NOT_WAITING' ? 409 : 400, r)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  // --- 読み取り専用トランスクリプト ------------------------------------------
  // /api/sessions/:id/transcript  … カンバン作業ログなど resume できない会話
  if (a === 'sessions' && b && c === 'transcript' && req.method === 'GET') {
    if (!readAllowed('transcript', cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendError(res, 429, 'RATE_LIMITED')
    }
    const profileName = url.searchParams.get('profile')
    const profiles = profileName ? await listProfiles() : []
    const r = transcript.read(decodeURIComponent(b), {
      limit: Number(url.searchParams.get('limit') ?? 80),
      before: Number(url.searchParams.get('before') ?? 0),
      includeTools: url.searchParams.get('tools') === '1',
      dbPath: profileName ? stateDbFor(profiles, profileName) : undefined,
    })
    return r.ok ? sendJson(res, 200, r) : sendFailure(res, 404, r)
  }

  // --- ライブ進捗（実行中ターンと実行中タスク）--------------------------------
  // /api/live  … 5秒ポーリング前提。全プロファイルの state.db のリースとカンバンを合成する
  if (a === 'live' && req.method === 'GET') {
    if (!readAllowed('live', cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendError(res, 429, 'RATE_LIMITED')
    }
    const r = live.snapshot({ dbs: await listStateDbs() })
    // Discord 由来のターンにはスレッドリンクを添える
    for (const t of r.turns) {
      const link = discord.forSession(t.sessionId)
      if (link) t.discordUrl = link.url
    }
    return sendJson(res, 200, r)
  }

  // --- アイコン取得ログ（インストール時の実態確認）----------------------------
  if (a === 'asset-log' && req.method === 'GET') {
    const n = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 40), 1), 200)
    let lines = []
    try {
      const txt = readTailText(path.join(cfg.dataDir, 'asset-access.log'), 128 * 1024)
      lines = txt.trim().split('\n').slice(-n)
    } catch {
      lines = []
    }
    return sendJson(res, 200, { lines })
  }

  // --- 承認待ちインボックス --------------------------------------------------
  // /api/inbox  … ボード横断の blocked タスク（読む＋コメントで答える）
  if (a === 'inbox' && req.method === 'GET') {
    if (!readAllowed('inbox', cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendError(res, 429, 'RATE_LIMITED')
    }
    return sendJson(res, 200, inbox.list())
  }

  // --- 使用量（コスト・トークン）----------------------------------------------
  // /api/usage?hours=24  … 合計とモデル別・上位セッション（全プロファイル合算）
  if (a === 'usage' && req.method === 'GET') {
    const r = usage.summary({ hours: Number(url.searchParams.get('hours') ?? 24), dbs: await listStateDbs() })
    return r.ok ? sendJson(res, 200, r) : sendFailure(res, 500, r)
  }

  // --- 横断検索 --------------------------------------------------------------
  // /api/search?q=&limit=&hours=  … 全プロファイル・全セッションの発言から抜粋を返す（読み取り専用）
  if (a === 'search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') ?? '')
    if (!q.trim()) return sendError(res, 400, 'QUERY_REQUIRED')
    if (!readAllowed('search', cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendError(res, 429, 'RATE_LIMITED')
    }
    const r = search.search({
      q,
      limit: Number(url.searchParams.get('limit') ?? 30),
      hours: Number(url.searchParams.get('hours') ?? 0),
      dbs: await listStateDbs(),
    })
    // 該当セッションが Discord 由来ならスレッドリンクも添える
    if (r.ok) {
      for (const h of r.hits) {
        const link = discord.forSession(h.sessionId)
        if (link) h.discordUrl = link.url
      }
    }
    return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
  }

  // --- Discord ディープリンク ------------------------------------------------
  // /api/discord/session?session_id=...  … そのセッションの Discord スレッド
  if (a === 'discord' && b === 'session' && req.method === 'GET') {
    const sid = url.searchParams.get('session_id')
    const link = discord.forSession(sid)
    return sendJson(res, link ? 200 : 404, link ? { link } : { link: null })
  }

  if (a === 'gateway' && b && req.method === 'POST') {
    if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) return sendError(res, 429, 'RATE_LIMITED')
    const body = await readJson(req)
    const by = String(body?.by ?? 'mobile')
    if (b === 'pause' || b === 'resume') {
      const expected = b.toUpperCase()
      if (String(body?.confirm ?? '').toUpperCase() !== expected) {
        return sendError(res, 400, 'CONFIRM_MISMATCH', { expected })
      }
      const out = b === 'pause' ? await ops.pause(String(body?.reason ?? 'mobile'), by) : await ops.resume(by)
      return sendJson(res, 200, out)
    }
    const out = await ops.gateway(b, body?.confirm, by)
    return sendJson(res, 200, out)
  }

  if (a === 'sessions') {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    // タスクタブは全ボード横断なので、チャットも全プロファイル横断にする。
    // ダッシュボード API は ?profile= を受けるので、列挙して合成する。
    const profiles = await listProfiles()
    const names = profiles.length ? profiles.map((p) => p.name) : [null]
    const perProfile = await Promise.all(
      names.map(async (name) => {
        const qs = new URLSearchParams({ limit: String(limit) })
        if (name) qs.set('profile', name)
        const r = await hermes.call(`/api/sessions?${qs}`, { timeoutMs: 10000 })
        if (r.status !== 200) return []
        return (r.data?.sessions ?? []).map((s) => ({
          id: s.id,
          title: s.title ?? s.display_name ?? s.session_key ?? s.id,
          source: s.source,
          model: s.model,
          profile: name ?? 'default',
          active: Boolean(s.is_active),
          lastActivity: s.last_activity_description ?? null,
          lastActive: s.last_active ? Number(s.last_active) * 1000 : null,
          messages: s.message_count ?? 0,
          tools: s.tool_call_count ?? 0,
          cost: s.estimated_cost_usd ?? null,
          preview: s.preview ?? null,
        }))
      }),
    )
    const sessions = perProfile
      .flat()
      .sort((x, y) => (y.lastActive ?? 0) - (x.lastActive ?? 0))
      .slice(0, limit)
    return sendJson(res, 200, { sessions, profiles: names.filter(Boolean) })
  }

  // --- 端末の定型コマンド ---------------------------------------------------
  if (a === 'snippets' && b === 'term') {
    if (req.method === 'GET') return sendJson(res, 200, snippetPayload('term', langOf(req, url)))
    if (req.method === 'PUT') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const saved = saveSnippetStore('term', body ?? {})
      auth.audit({ kind: 'term_snippets.save', count: saved.custom.length, overrides: Object.keys(saved.overrides).length })
      return sendJson(res, 200, snippetPayload('term', langOf(req, url)))
    }
  }

  // --- 定型スニペット ------------------------------------------------------
  if (a === 'snippets') {
    if (req.method === 'GET') {
      return sendJson(res, 200, snippetPayload('chat', langOf(req, url)))
    }
    if (req.method === 'PUT') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const saved = saveSnippetStore('chat', body ?? {})
      auth.audit({ kind: 'snippets.save', count: saved.custom.length, overrides: Object.keys(saved.overrides).length })
      return sendJson(res, 200, snippetPayload('chat', langOf(req, url)))
    }
  }

  // --- 端末側の例外を受け取る（下部ナビ消失などの原因調査用）-------------
  if (a === 'client-error' && req.method === 'POST') {
    if (!writeAllowed(30, 60_000)) return sendError(res, 429, 'RATE_LIMITED')
    const body = await readJson(req, 200_000)
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true })
      fs.appendFileSync(
        path.join(cfg.dataDir, 'client-errors.log'),
        `${JSON.stringify({ at: new Date().toISOString(), ...body })}\n`,
      )
    } catch {
      /* 記録に失敗しても返すだけ */
    }
    return sendJson(res, 200, { ok: true })
  }

  if (a === 'logs') {
    const name = url.searchParams.get('file') ?? 'gateway'
    const lines = Number(url.searchParams.get('lines') ?? 200)
    return sendJson(res, 200, { file: name, text: tailLog(name, lines) })
  }

  if (a === 'audit') {
    let text = ''
    try {
      text = readTailText(cfg.auditPath, 128 * 1024)
    } catch {
      text = ''
    }
    const rawLines = text.split('\n').filter(Boolean).slice(-Number(url.searchParams.get('lines') ?? 100))
    const parsed = []
    for (const l of rawLines) {
      try {
        parsed.push(JSON.parse(l))
      } catch {
        /* 壊れた行は捨てる */
      }
    }
    return sendJson(res, 200, { lines: parsed })
  }

  sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
}

/**
 * 認証不要で配るパス（アプリの殻）。
 *
 * WebAPK の生成は **Google のサーバーが認証なしで** manifest / アイコン / start_url を
 * 取得するため、ここを Cookie の内側に置くと Android で
 * 「This app cannot be installed」になる（実測）。データ（/api, /ws）は必ず認証の内側。
 * @param {string} pathname パス
 * @returns {boolean} 公開してよいか
 */
function isPublicPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return true
  if (pathname === '/healthz' || pathname === '/auth') return true
  if (pathname === '/manifest.webmanifest' || pathname === '/sw.js' || pathname === '/favicon.ico') return true
  if (pathname.startsWith('/assets/')) return true
  if (/^\/icon(-[a-z0-9-]+)?\.(png|svg)$/i.test(pathname)) return true
  return false
}

/** アイコン/manifest の取得を記録する（インストール時に端末が何を取りに来たか確認するため）。 */
function logAssetAccess(cfg, req, url) {
  const p = url.pathname
  if (!/^\/(icon|manifest\.webmanifest|sw\.js|favicon)/.test(p)) return
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      p,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
      ref: String(req.headers.referer ?? '').slice(0, 120),
    })
    fs.appendFile(path.join(cfg.dataDir, 'asset-access.log'), `${line}\n`, () => {})
  } catch {
    /* noop */
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  logAssetAccess(cfg, req, url)

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION })

  // 認証（/auth はトークン交換のみ）
  if (url.pathname === '/auth') {
    const value = auth.exchange(url.searchParams.get('t'))
    if (!value) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_HTML)
      return
    }
    res.writeHead(302, { 'set-cookie': auth.cookieHeader(value), location: '/' }).end()
    return
  }

  // ワンタップ QR ペアリング: `?token=` を HttpOnly Cookie に交換する（SPEC §8.2）。
  // 殻（/ と /assets）は公開なので、未ログインでもこの 1 本だけは叩ける。
  // 照合は auth.exchange（定数時間比較）に任せ、成功時だけ Cookie を返す。
  if (url.pathname === '/api/auth/login') {
    if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED')
    if (!loginAllowed()) return sendError(res, 429, 'RATE_LIMITED')
    let body = {}
    try {
      body = await readJson(req, 4096)
    } catch {
      body = {}
    }
    const given = typeof body?.token === 'string' ? body.token : (url.searchParams.get('token') ?? '')
    const value = auth.exchange(given)
    if (!value) {
      auth.audit({ kind: 'auth.login', ok: false })
      return sendError(res, 401, 'AUTH_REQUIRED')
    }
    auth.audit({ kind: 'auth.login', ok: true })
    const payload = JSON.stringify({ ok: true })
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'set-cookie': auth.cookieHeader(value),
    })
    return res.end(payload)
  }

  if (!isPublicPath(url.pathname) && !auth.authorized(req)) {
    if (url.pathname.startsWith('/api/')) return sendError(res, 401, 'AUTH_REQUIRED')
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_HTML)
    return
  }

  // 殻は公開、API は認証必須（殻の中の /api/* 呼び出しで 401 を受けたら UI がログインを出す）
  if (url.pathname.startsWith('/api/') && !auth.authorized(req)) {
    return sendError(res, 401, 'AUTH_REQUIRED')
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return serveStatic(req, res, url.pathname)
  } catch (err) {
    const status = err?.statusCode ?? 500
    if (status >= 500) console.error('[api] 失敗:', err)
    sendError(res, status, status >= 500 ? 'INTERNAL' : 'BAD_REQUEST', { detail: String(err?.message ?? '') })
  }
})

// --- WebSocket -------------------------------------------------------------

const wssChat = new WebSocketServer({ noServer: true })
const wssTerm = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (!isAllowedWsOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!auth.authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  if (url.pathname === '/ws/chat') {
    wssChat.handleUpgrade(req, socket, head, (ws) => proxyChat(ws))
    return
  }
  if (url.pathname === '/ws/term') {
    wssTerm.handleUpgrade(req, socket, head, (ws) => openTerm(ws))
    return
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
  socket.destroy()
})

/**
 * チャット WS を Hermes の /api/ws へ中継する（プロトコルは素通し）。
 * 端末からは JSON-RPC がそのまま見えるので、探針テストと同じ経路になる。
 * @param {WebSocket} client 端末側
 */
async function proxyChat(client) {
  let upstream
  const started = Date.now()
  // この接続で送ってよいプロファイル名（serve 済み）。取れなければ default のみ。
  // **listener より先に await しない**: 待つ間に届いた端末フレームは listener が無いと捨てられる
  // （実測: 最初の session.list が消えて 20 秒タイムアウトした）。解決までは hold に溜める。
  let allowed = []
  let allowedReady = false
  const hold = []
  /** @type {string[]} */
  const queue = []
  listProfiles()
    .then((list) => {
      allowed = (list ?? []).map((p) => p.name).filter(Boolean)
    })
    .catch(() => {})
    .finally(() => {
      allowedReady = true
      for (const t of hold.splice(0)) forward(t)
    })

  /** 1 フレームを検証して上流へ流す（プロファイル検証はここだけ）。 */
  function forward(text) {
    const checked = checkFrame(text, allowed)
    if (!checked.ok) {
      // 上流には流さない。端末には JSON-RPC エラーとして返す（SPEC-PROFILE-CHAT 決定 D1）
      if (client.readyState === WebSocket.OPEN) client.send(rejectionFrame(checked.id, checked.message))
      auth.audit({ kind: 'chat.profile', method: checked.method, profile: checked.profile, blocked: true })
      return
    }
    if (checked.profile) auth.audit({ kind: 'chat.profile', method: checked.method, profile: checked.profile })
    const out = checked.text
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(out)
    else queue.push(out)
  }

  try {
    // 端末が繋ぐたびにトークンを取り直す（gateway 再起動後の 403 を自己回復）
    upstream = new WebSocket(await hermes.wsUrl('/api/ws', { fresh: true }), { headers: { Origin: cfg.hermesBase } })
  } catch (err) {
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.error', payload: { message: String(err?.message ?? err) } } }))
    client.close(1011)
    return
  }
  client.on('message', (raw) => {
    const text = raw.toString()
    if (!allowedReady) {
      hold.push(text)
      return
    }
    forward(text)
  })
  // 上流は無音で切ることがある（実測: code=1005 が散発）。25秒ごとに ping して
  // 「応答が来ないまま画面が止まる」を防ぐ。pong が90秒来なければ張り直す。
  let ka = null
  let lastPong = Date.now()

  upstream.on('open', () => {
    for (const q of queue.splice(0)) upstream.send(q)
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.ready', payload: {} } }))
    console.log(`[chat] upstream open (${Date.now() - started}ms)`)
    lastPong = Date.now()
    ka = setInterval(() => {
      if (upstream?.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPong > 90_000) {
        console.log('[chat] upstream silent 90s → close')
        try {
          upstream.terminate()
        } catch {}
        return
      }
      try {
        upstream.ping()
      } catch {}
    }, 25_000)
  })
  upstream.on('pong', () => {
    lastPong = Date.now()
  })
  upstream.on('message', (raw) => {
    if (client.readyState === WebSocket.OPEN) client.send(raw.toString())
  })
  const closeBoth = (code = 1000, reason = '') => {
    try {
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
    } catch {
      /* noop */
    }
    try {
      upstream.close()
    } catch {
      /* noop */
    }
  }
  upstream.on('close', (code) => {
    if (ka) clearInterval(ka)
    console.log(`[chat] upstream closed code=${code} after ${Date.now() - started}ms`)
    closeBoth(code === 1000 ? 1000 : 1011, `upstream ${code}`)
  })
  upstream.on('error', () => closeBoth(1011, 'upstream error'))
  client.on('close', () => {
    try {
      upstream.close()
    } catch {
      /* noop */
    }
  })
}

/**
 * 端末（実 PTY）。Hermes 側に汎用シェルの口が無いためブリッジが PTY を持つ。
 * @param {WebSocket} ws 端末
 */
function openTerm(ws) {
  if (!pty) {
    ws.send(JSON.stringify({ t: 'out', d: '\r\n[bridge] node-pty が読み込めません\r\n' }))
    ws.close(1011)
    return
  }
  const shell = process.env.SHELL || '/bin/zsh'
  /** @type {any} */
  let proc
  try {
    proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
  } catch (err) {
    // ここで例外を投げるとプロセスごと落ちる（実測: spawn-helper の実行権限欠落）
    auth.audit({ kind: 'term.error', message: String(err?.message ?? err) })
    ws.send(JSON.stringify({ t: 'out', d: `\r\n[bridge] PTY を起動できません: ${err?.message ?? err}\r\n` }))
    ws.close(1011)
    return
  }
  auth.audit({ kind: 'term.open', pid: proc.pid, shell })
  proc.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'out', d }))
  })
  proc.onExit(({ exitCode }) => {
    auth.audit({ kind: 'term.exit', pid: proc.pid, exitCode })
    try {
      ws.close(1000, 'exit')
    } catch {
      /* noop */
    }
  })
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      proc.write(raw.toString())
      return
    }
    if (msg?.t === 'in') proc.write(String(msg.d ?? ''))
    else if (msg?.t === 'resize') proc.resize(Math.max(20, Number(msg.c) || 80), Math.max(5, Number(msg.r) || 24))
  })
  ws.on('close', () => {
    auth.audit({ kind: 'term.close', pid: proc.pid })
    try {
      proc.kill()
    } catch {
      /* noop */
    }
  })
}

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `[bridge] ポート ${cfg.port} は使用中です。手動起動したプロセスが残っていませんか: ` +
        `lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN  →  hermes-pilot service restart（または launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot）`,
    )
    process.exit(75)
  }
  console.error('[bridge] サーバエラー:', err)
  process.exit(1)
})

server.listen(cfg.port, cfg.host, async () => {
  console.log(`[bridge] Hermes Pilot: http://${cfg.host}:${cfg.port}`)
  console.log(`[bridge] 上流: ${cfg.hermesBase}`)
  console.log(`[bridge] 管理画面: http://${cfg.host}:${cfg.port}/auth?t=${auth.token}`)
  // 内蔵ウォッチャー（D7）。初回はベースライン確立のみで過去分は通知しない。
  try {
    reviewWatcher.start()
  } catch (err) {
    console.warn(`[bridge] reviewWatcher を起動できません: ${err?.message}`)
  }
  try {
    await hermes.ensureToken()
    console.log('[bridge] Hermes セッショントークン: 解決済み')
  } catch (err) {
    console.warn(`[bridge] トークン解決に失敗（ダッシュボード停止？）: ${err?.message}`)
  }
})
