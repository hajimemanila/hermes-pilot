import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { createRequire } from 'node:module'
import { loadConfig, VERSION } from './config.js'
import { createAuth } from './auth.js'
import { createHermesClient } from './hermes.js'
import { createKanban } from './kanban.js'
import { createAkapen } from './akapen.js'
import { createOps } from './ops.js'
import { listSnippets, normalizeCustom, CUSTOM_MAX } from './snippets.js'
import { listTermSnippets } from './term-snippets.js'
import { createGitInfo } from './gitinfo.js'
import { createDiscord } from './discord.js'
import { createSearch } from './search.js'
import { createTranscript } from './transcript.js'
import { createCapture } from './capture.js'
import { createUsage } from './usage.js'
import { createLive } from './live.js'
import { createInbox } from './inbox.js'

const require = createRequire(import.meta.url)
const pty = safeRequire('node-pty')

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
const auth = createAuth(cfg)
const hermes = createHermesClient(cfg)
const kanban = createKanban(cfg)
const akapen = createAkapen(cfg)
const ops = createOps(cfg, hermes, auth)
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
const capture = createCapture(cfg)
const usage = createUsage(cfg)
const live = createLive(cfg, kanban)
const inbox = createInbox(cfg, kanban)
// 起動時にコミットサマリを温める（初回のタスク一覧を待たせない）
gitinfo.warm().catch(() => {})

// スニペット（ユーザー定義は小さな JSON に保存する）
const snippetsPath = path.join(cfg.dataDir, 'snippets.json')
function readCustomSnippets() {
  try {
    const d = JSON.parse(fs.readFileSync(snippetsPath, 'utf8'))
    return normalizeCustom(d?.custom ?? [])
  } catch {
    return []
  }
}
function writeCustomSnippets(list) {
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  const normalized = normalizeCustom(list)
  const tmp = `${snippetsPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, custom: normalized }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, snippetsPath)
  return normalized
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

/** 読み取り系（検索）の簡易レート制限。書き込みとは枠を分ける。 */
const reads = []
function readAllowed(max = 240, windowMs = 60_000) {
  const now = Date.now()
  while (reads.length && now - reads[0] > windowMs) reads.shift()
  if (reads.length >= max) return false
  reads.push(now)
  return true
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Mobile — ログイン</title>
<style>body{background:#07171b;color:#e6f4f1;font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh}
form{background:#0d242a;padding:24px;border-radius:16px;border:1px solid #1d3a41;width:min(88vw,360px)}
h1{font-size:16px;margin:0 0 12px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #24515a;background:#081e23;color:#e6f4f1;font-size:15px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;background:#13807f;color:#fff;font-size:15px}
p{color:#7fa6a3;font-size:12px;margin:10px 0 0}</style>
<form method="get" action="/auth"><h1>Hermes Mobile</h1>
<input name="t" placeholder="アプリトークン" autocomplete="off" autocapitalize="off" spellcheck="false">
<button>入る</button>
<p>トークンは <code>~/.hermes/mobile-pwa/token</code> またはブリッジの起動ログにあります。</p></form>`

/** 静的配信（SPA フォールバック付き）。 */
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  const file = path.join(cfg.distDir, rel)
  if (!file.startsWith(cfg.distDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (path.extname(rel)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
      fs.readFile(path.join(cfg.distDir, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('UI 未ビルド（npm run build）')
          return
        }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(html)
      })
      return
    }
    const ext = path.extname(file)
    // キャッシュ方針:
    //  - manifest は no-cache（インストール時のアイコン解決に使われるため、必ず取り直させる）
    //  - アイコン等の固定名アセットは短命（名前を変えずに差し替えたときに古い画像が残らないように）
    //  - ハッシュ付きの /assets/ だけ長期キャッシュ
    const noCache = ext === '.html' || ext === '.webmanifest' || ext === '.json'
    const hashed = file.includes(`${path.sep}assets${path.sep}`)
    const cacheControl = noCache
      ? 'no-cache'
      : hashed
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, must-revalidate'
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': cacheControl,
    })
    res.end(buf)
  })
}

/** ログの末尾を返す。 */
function tailLog(name, lines = 200) {
  const safe = String(name ?? 'gateway').replace(/[^a-z0-9._-]/gi, '')
  const file = path.join(cfg.logDir, safe.endsWith('.log') ? safe : `${safe}.log`)
  if (!file.startsWith(cfg.logDir)) throw Object.assign(new Error('invalid log'), { statusCode: 400 })
  const text = fs.readFileSync(file, 'utf8')
  return text.split('\n').slice(-Math.min(lines, 1000)).join('\n')
}

/** API のルーティング。 */
async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const [, a, b, c, d, e] = seg

  if (a === 'me') return sendJson(res, 200, { ok: true, version: VERSION })

  if (a === 'overview') {
    const data = await ops.overview()
    // 実行中タスク数（アプリバッジ用）
    try {
      data.runningTasks = kanban
        .boards()
        .reduce((n, b) => n + Number(b.counts?.running ?? 0), 0)
    } catch {
      data.runningTasks = 0
    }
    // 緊急停止（ESTOP）の状態
    data.paused = ops.paused()
    return sendJson(res, 200, data)
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
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
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
      return sendJson(res, r.ok ? 201 : 400, r)
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
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
      }
      const body = await readJson(req)
      const out = await inbox.comment(b, d, body?.body ?? body?.text, String(body?.by ?? 'mobile'))
      auth.audit({ kind: 'kanban.comment', board: b, task: d, chars: String(body?.body ?? body?.text ?? '').length })
      return sendJson(res, 200, out)
    }
    if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
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
    return sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}` } })
  }


  // --- 赤ペン（akapen）------------------------------------------------------
  // /api/akapen                     … 一覧（review / ready / done）
  // /api/akapen/:id/sheet           … シート HTML（sandbox・生成物）
  // /api/akapen/:id/data            … sheet.json（PWA のネイティブフォーム用）
  // POST /api/akapen/:id/answer     … 回答を保存 → comment → unblock（冪等）
  // POST /api/akapen/:id/reopen     … 反映が違うとき review に戻す
  if (a === 'akapen') {
    if (!b) {
      return sendJson(res, 200, {
        board: akapen.board,
        workdir: akapen.workdir(),
        items: akapen.list(Number(url.searchParams.get('limit') ?? 80)),
      })
    }
    if (c === 'sheet' && req.method === 'GET') {
      const r = akapen.sheetHtml(b)
      if (!r.ok) return sendJson(res, r.code === 'NOT_FOUND' ? 404 : 409, { error: { code: r.code, message: r.message } })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "sandbox allow-scripts allow-forms; default-src 'none'; style-src 'unsafe-inline'; " +
          "img-src data: blob:; script-src 'unsafe-inline'; font-src data:",
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      return res.end(r.html)
    }
    if (c === 'thumb' && req.method === 'GET') {
      const rel = url.pathname.split('/').slice(5).join('/')
      const r = akapen.thumb(decodeURIComponent(rel))
      if (!r.ok) return sendJson(res, 404, { error: { code: r.code, message: r.message } })
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=600' })
      return res.end(r.data)
    }
    if (c === 'data' && req.method === 'GET') {
      const r = akapen.sheetData(b)
      return sendJson(res, r.ok ? 200 : 409, r.ok ? r : { error: { code: r.code, message: r.message } })
    }
    if (c === 'answer' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
      }
      const body = await readJson(req)
      const r = await akapen.answer(b, body || {})
      auth.audit({
        kind: 'akapen.answer',
        task: b,
        duplicate: Boolean(r.duplicate),
        choiceCount: Array.isArray(body?.answers) ? body.answers.length : 0,
        ok: Boolean(r.ok),
      })
      return sendJson(res, r.ok ? 200 : 400, r)
    }
    if (c === 'reopen' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
      }
      const body = await readJson(req)
      const r = await akapen.reopen(b, body?.reason)
      auth.audit({ kind: 'akapen.reopen', task: b, ok: Boolean(r.ok) })
      return sendJson(res, r.ok ? 200 : 400, r)
    }
    return sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}` } })
  }

  // --- 読み取り専用トランスクリプト ------------------------------------------
  // /api/sessions/:id/transcript  … カンバン作業ログなど resume できない会話
  if (a === 'sessions' && b && c === 'transcript' && req.method === 'GET') {
    if (!readAllowed(cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendJson(res, 429, { error: { message: '読み取りが多すぎます' } })
    }
    const profileName = url.searchParams.get('profile')
    const profiles = profileName ? await listProfiles() : []
    const r = transcript.read(decodeURIComponent(b), {
      limit: Number(url.searchParams.get('limit') ?? 80),
      before: Number(url.searchParams.get('before') ?? 0),
      dbPath: profileName ? stateDbFor(profiles, profileName) : undefined,
    })
    return sendJson(res, r.ok ? 200 : 404, r)
  }

  // --- ライブ進捗（実行中ターンと実行中タスク）--------------------------------
  // /api/live  … 5秒ポーリング前提。state.db のリースとカンバンを合成する
  if (a === 'live' && req.method === 'GET') {
    if (!readAllowed(cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendJson(res, 429, { error: { message: '読み取りが多すぎます' } })
    }
    const r = live.snapshot()
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
      const txt = fs.readFileSync(path.join(cfg.dataDir, 'asset-access.log'), 'utf8')
      lines = txt.trim().split('\n').slice(-n)
    } catch {
      lines = []
    }
    return sendJson(res, 200, { lines })
  }

  // --- 承認待ちインボックス --------------------------------------------------
  // /api/inbox  … ボード横断の blocked タスク（読む＋コメントで答える）
  if (a === 'inbox' && req.method === 'GET') {
    if (!readAllowed(cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendJson(res, 429, { error: { message: '読み取りが多すぎます' } })
    }
    return sendJson(res, 200, inbox.list())
  }

  // --- 使用量（コスト・トークン）----------------------------------------------
  // /api/usage?hours=24  … 合計とモデル別・上位セッション
  if (a === 'usage' && req.method === 'GET') {
    const r = usage.summary({ hours: Number(url.searchParams.get('hours') ?? 24) })
    return sendJson(res, r.ok ? 200 : 500, r)
  }

  // --- 横断検索 --------------------------------------------------------------
  // /api/search?q=&limit=&hours=  … 全セッションの発言から抜粋を返す（読み取り専用）
  if (a === 'search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') ?? '')
    if (!q.trim()) return sendJson(res, 400, { error: { message: 'q が必要です' } })
    if (!readAllowed(cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendJson(res, 429, { error: { message: '検索が多すぎます' } })
    }
    const r = search.search({
      q,
      limit: Number(url.searchParams.get('limit') ?? 30),
      hours: Number(url.searchParams.get('hours') ?? 0),
    })
    // 該当セッションが Discord 由来ならスレッドリンクも添える
    if (r.ok) {
      for (const h of r.hits) {
        const link = discord.forSession(h.sessionId)
        if (link) h.discordUrl = link.url
      }
    }
    return sendJson(res, r.ok ? 200 : 400, r)
  }

  // --- Discord ディープリンク ------------------------------------------------
  // /api/discord/session?session_id=...  … そのセッションの Discord スレッド
  if (a === 'discord' && b === 'session' && req.method === 'GET') {
    const sid = url.searchParams.get('session_id')
    const link = discord.forSession(sid)
    return sendJson(res, link ? 200 : 404, link ? { link } : { link: null })
  }

  if (a === 'gateway' && b && req.method === 'POST') {
    if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
    const body = await readJson(req)
    const by = String(body?.by ?? 'mobile')
    if (b === 'pause' || b === 'resume') {
      const expected = b.toUpperCase()
      if (String(body?.confirm ?? '').toUpperCase() !== expected) {
        return sendJson(res, 400, { error: { message: `確認語が一致しません（${expected}）` } })
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
  if (a === 'snippets' && b === 'term' && req.method === 'GET') {
    return sendJson(res, 200, { snippets: listTermSnippets() })
  }

  // --- 定型スニペット ------------------------------------------------------
  if (a === 'snippets') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { snippets: listSnippets(readCustomSnippets()), customMax: CUSTOM_MAX })
    }
    if (req.method === 'PUT') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendJson(res, 429, { error: { message: '操作が多すぎます' } })
      }
      const body = await readJson(req)
      const saved = writeCustomSnippets(body?.custom ?? [])
      auth.audit({ kind: 'snippets.save', count: saved.length })
      return sendJson(res, 200, { custom: saved, snippets: listSnippets(saved) })
    }
  }

  // --- 端末側の例外を受け取る（下部ナビ消失などの原因調査用）-------------
  if (a === 'client-error' && req.method === 'POST') {
    if (!writeAllowed(30, 60_000)) return sendJson(res, 429, { error: { message: 'too many' } })
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
      text = fs.readFileSync(cfg.auditPath, 'utf8')
    } catch {
      text = ''
    }
    const lines = text.split('\n').filter(Boolean).slice(-Number(url.searchParams.get('lines') ?? 100))
    return sendJson(res, 200, { lines: lines.map((l) => JSON.parse(l)) })
  }

  sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}` } })
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

  if (!isPublicPath(url.pathname) && !auth.authorized(req)) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: { message: 'unauthorized', code: 'AUTH_REQUIRED' } })
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_HTML)
    return
  }

  // 殻は公開、API は認証必須（殻の中の /api/* 呼び出しで 401 を受けたら UI がログインを出す）
  if (url.pathname.startsWith('/api/') && !auth.authorized(req)) {
    return sendJson(res, 401, { error: { message: 'unauthorized', code: 'AUTH_REQUIRED' } })
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return serveStatic(req, res, url.pathname)
  } catch (err) {
    const status = err?.statusCode ?? 500
    if (status >= 500) console.error('[api] 失敗:', err)
    sendJson(res, status, { error: { message: err?.message ?? 'internal error' } })
  }
})

// --- WebSocket -------------------------------------------------------------

const wssChat = new WebSocketServer({ noServer: true })
const wssTerm = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!auth.authorized(req) && url.searchParams.get('t') !== auth.token) {
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
  try {
    upstream = new WebSocket(await hermes.wsUrl('/api/ws'), { headers: { Origin: cfg.hermesBase } })
  } catch (err) {
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.error', payload: { message: String(err?.message ?? err) } } }))
    client.close(1011)
    return
  }
  /** @type {string[]} */
  const queue = []
  client.on('message', (raw) => {
    const text = raw.toString()
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text)
    else queue.push(text)
  })
  upstream.on('open', () => {
    for (const q of queue.splice(0)) upstream.send(q)
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge.ready', payload: {} } }))
    console.log(`[chat] upstream open (${Date.now() - started}ms)`)
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
        `lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN  →  launchctl kickstart -k gui/$(id -u)/ai.hermes.hermes-mobile`,
    )
    process.exit(75)
  }
  console.error('[bridge] サーバエラー:', err)
  process.exit(1)
})

server.listen(cfg.port, cfg.host, async () => {
  console.log(`[bridge] Hermes Mobile PWA: http://${cfg.host}:${cfg.port}`)
  console.log(`[bridge] 上流: ${cfg.hermesBase}`)
  console.log(`[bridge] 管理画面: http://${cfg.host}:${cfg.port}/auth?t=${auth.token}`)
  try {
    await hermes.ensureToken()
    console.log('[bridge] Hermes セッショントークン: 解決済み')
  } catch (err) {
    console.warn(`[bridge] トークン解決に失敗（ダッシュボード停止？）: ${err?.message}`)
  }
})
