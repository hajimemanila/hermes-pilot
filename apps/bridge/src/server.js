import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { createRequire } from 'node:module'
import { loadConfig, readPilotProfile, writePilotProfile, VERSION } from './config.js'
import { createAuth, isAllowedWsOrigin } from './auth.js'
import { createHermesClient } from './hermes.js'
import { createKanban } from './kanban.js'
import { createReview, injectReviewBridge, reviewSheetHeaders, reviewViewHeaders, reviewViewHtml } from './review.js'
import { createReviewWatcher } from './review-watcher.js'
import { createPipelineWatcher, readPipelineReports } from './pipeline-watcher.js'
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
import { createWorkerFeed } from './workerFeed.js'
import { createCapture } from './capture.js'
import { createUsage } from './usage.js'
import { createTelemetry } from './telemetry.js'
import { createLive } from './live.js'
import { createInbox } from './inbox.js'
import { createRepos, normalizePath } from './repos.js'
import { archiveSpec, attachRunTaskIds, createSpecs, listSpecs, partitionSpecs, readRuns, readSpecContent, runsPathFor } from './specs.js'
import { analyzeCoherence } from './coherence.js'
import { createArchitect } from './architect.js'
import {
  DEFAULT_SKILLS_SRC,
  ensurePilotProfile,
  getOptimizeStatus,
  optimizeAgentSkills,
} from './pipeline-optimizer.js'
import { createPairCodes } from './pair-codes.js'
import { createMemosStore } from './memos.js'
import { getCapabilities } from './capabilities.js'
import { langOf, readJson, sendError, sendFailure, sendJson } from './http/respond.js'
import { errorBody } from './api-errors.js'
import { loginAllowed, readAllowed, writeAllowed } from './http/rate-limit.js'
import { loginPage } from './http/login-page.js'
import { createStaticFiles } from './http/static-files.js'
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
// 静的配信（dist → dist.prev フォールバック）は http/ へ切り出し済み
const distFiles = createStaticFiles({ distDir: cfg.distDir })
const getPilotProfile = () => readPilotProfile(cfg.configPath)
const capabilities = getCapabilities()
// ワンタイム・ペアリングコード（QR を短くするため。SPEC §8.2 の one-time token）
const pairCodes = createPairCodes(cfg)
const memos = createMemosStore(cfg.dataDir)
const auth = createAuth(cfg, { pairCodes })
const hermes = createHermesClient(cfg)
const kanban = createKanban(cfg)
// リポジトリ（作業ディレクトリ）↔ ボード。一覧は repos.json ＋ 1 階層スキャン
// ＋ ボードの default_workdir ＋ 直近セッション cwd の統合（SPEC §5.1）
const repos = createRepos(cfg, { boards: () => kanban.boards() })
// Spec Launchpad（`docs/SPEC-*.md` → バッチ → カンバン一括起票）。SPEC §5.4 / D15④
const specs = createSpecs(cfg, { tasks: (board) => kanban.tasks(board, { limit: 200 }), listSpecs })
// Architect（仕様の種 → SPEC / A2B）。ランナーは Hermes Native（`hermes kanban create`）だけ。
const architect = createArchitect(
  { ...cfg, pilotProfile: getPilotProfile },
  {
    listSpecs,
    readTasks: (board) => kanban.tasks(board, { limit: 200 }),
  },
)
const review = createReview(cfg, { targets: () => repos.targets(), assignee: getPilotProfile })
// 完了・ブロックの記録はブリッジ内蔵（D7）。外部 cron は要らない。
const reviewWatcher = createReviewWatcher(cfg, { review })
const ops = createOps(cfg, hermes, auth, { kanban, nudge: () => nudgeWatchers() })
const gitinfo = createGitInfo(cfg)
// 使用量（コスト・トークン・API コール）はテレメトリとパイプライン報告の双方が使う（V7-2）。
const usage = createUsage(cfg)
// パイプライン完走レポート（D20 / D21）。Spec ラン／ボードウェーブの収束を監視する。
// `usage` を渡すと報告に Spec スコープの API コール数・トークン数が入る。
const pipelineWatcher = createPipelineWatcher(cfg, { gitinfo, usage })

let watcherRefreshAt = 0
let watcherInFlight = null

/**
 * レビュー／パイプラインの両ウォッチャーを即時走査する（連打と並行実行を束ねる）。
 * 状態変更直後の「最大 10〜25 秒の通知ラグ」を消すための補助同期。
 * @param {number} [minIntervalMs] 前回走査からの最小経過時間
 * @returns {Promise<void>}
 */
function ensureWatchersFresh(minIntervalMs = 2000) {
  if (watcherInFlight) return watcherInFlight
  const nowMs = Date.now()
  if (minIntervalMs > 0 && nowMs - watcherRefreshAt < minIntervalMs) return Promise.resolve()
  watcherInFlight = (async () => {
    try {
      watcherRefreshAt = Date.now()
      try {
        reviewWatcher.tick()
      } catch {
        /* 補助同期の失敗で本線を止めない */
      }
      try {
        await pipelineWatcher.tick()
      } catch {
        /* 補助同期の失敗で本線を止めない */
      }
      watcherRefreshAt = Date.now()
    } finally {
      watcherInFlight = null
    }
  })()
  return watcherInFlight
}

/** 状態変更 API の成功後に背後でウォッチャーを即時回転させる。 */
function nudgeWatchers() {
  void ensureWatchersFresh(0)
}
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

/**
 * 実行ワーカーのトランスクリプトを読む（レビュー詳細とタスク詳細で共通）。
 *
 * セッションの DB はイベントが記録した実パス（`info.db`）を最優先。記録が無い／空でも
 * `/api/boards/:slug/tasks/:id` は任意のボードを扱うので、全プロファイルの state.db を
 * 横断して messages が 1 件以上あった DB を採用する（選択ロジックは `workerFeed.js`）。
 */
const readWorkerFeed = createWorkerFeed({
  listStateDbs,
  read: (sessionId, opts) => transcript.read(sessionId, opts),
})

const capture = createCapture(cfg)
// Zero-Typing 実行サマリ（完了レシート・SPEC-PILOT-V5 §3.3 ③ / D26③）。
// usage / 完走レポート / カンバン / audit.jsonl を読むだけで、書き込みはしない。
const telemetry = createTelemetry(cfg, {
  usage,
  reports: (opts) => readPipelineReports(cfg.reviewDir, opts),
  tasks: (board) => kanban.tasks(board, { limit: 200 }),
})
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

/** ログの末尾を返す。 */
function tailLog(name, lines = 200) {
  const safe = String(name ?? 'gateway').replace(/[^a-z0-9._-]/gi, '')
  const file = path.join(cfg.logDir, safe.endsWith('.log') ? safe : `${safe}.log`)
  if (!file.startsWith(cfg.logDir)) throw Object.assign(new Error('invalid log'), { statusCode: 400 })
  const text = readTailText(file, 256 * 1024)
  return text.split('\n').slice(-Math.min(lines, 1000)).join('\n')
}

/** コヒーレンス診断のキャッシュ（リポジトリごと・15 秒）。 */
const coherenceCache = new Map()

/** コヒーレンス診断のキャッシュ寿命（ms）。 */
const COHERENCE_TTL_MS = 15_000

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

/** 一括アーカイブで 1 回に受け付ける件数（D92）。UI 側の選択上限と揃える。 */
const BULK_ARCHIVE_MAX = 50

/** タスク ID の書式（`t_[0-9a-z]+`。カンバン本体・`inbox.js` と同じ規則）。 */
const TASK_ID_RE = /^t_[0-9a-z]+$/i

/**
 * 書き込み系の結果を返す（`ok === false` を HTTP 200 で返さない）。
 *
 * 内部モジュールが `{ok:false}` を返したのに 200 を付けると、画面は成功トーストを出し
 * 監査ログだけが失敗になる（サイレント失敗）。ここで 1 箇所に寄せる。
 *
 * @param {import('node:http').ServerResponse} res 応答
 * @param {{ok?: boolean, code?: string}} out 結果
 * @param {number} [okStatus] 成功時のステータス
 * @param {string} [failCode] 失敗時にコードが無い場合の既定コード
 * @returns {void}
 */
function sendOutcome(res, out, okStatus = 200, failCode = 'CLI_FAILED') {
  if (out && out.ok === false) {
    return sendJson(res, 502, { ...out, code: out.code ?? failCode })
  }
  return sendJson(res, okStatus, out)
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
      // 既定はアクティブ SPEC だけ（完了済みで Launchpad が埋まらないようにする。D84）。
      // `?includeArchived=1` で全件（`specs` にアーカイブも含める）。
      const all = attachRunTaskIds(specs.listSpecs(target.path), readRuns(runsPathFor(cfg)))
      const parts = partitionSpecs(all)
      const includeArchived = url.searchParams.get('includeArchived') === '1'
      return sendJson(res, 200, {
        ok: true,
        repo: target.repo,
        label: target.label,
        path: target.path,
        board: target.board,
        specs: includeArchived ? all : parts.active,
        archivedSpecs: parts.archived,
        archivedCount: parts.archived.length,
      })
    }
    // GET /api/specs/content?board=<slug>&repo=<id>&path=<rel>
    //   … 1 枚の SPEC の全文（リポジトリ境界内・`.md` のみ・256KB 上限）
    //   不正パス（`../` 等）は 400、未検出は 404（`readSpecContent` の ApiError を外側が拾う）
    if (b === 'content' && req.method === 'GET') {
      const target = resolveSpecRepo({
        repoId: url.searchParams.get('repo'),
        boardSlug: url.searchParams.get('board'),
      })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const content = readSpecContent(target.path, url.searchParams.get('path'))
      auth.audit({ kind: 'specs.content', repo: target.repo, path: content.path, bytes: content.bytes })
      return sendJson(res, 200, { ...content, repo: target.repo, label: target.label, board: target.board })
    }
    // GET /api/specs/reports?board=<slug>&limit=<n>  … 直近のパイプライン完走レポート（D20 / D21）
    if (b === 'reports' && req.method === 'GET') {
      await ensureWatchersFresh()
      const board = String(url.searchParams.get('board') ?? '').trim()
      const limit = Number(url.searchParams.get('limit')) || 20
      return sendJson(res, 200, {
        ok: true,
        board: board || null,
        reports: readPipelineReports(cfg.reviewDir, { board, limit }),
      })
    }
    // POST /api/specs/archive { board?, repo?, path }
    //   … SPEC のメタデータ部へ `- **Status**: archived` を追記して退避する（D92 / D84 互換）。
    //     ファイルは消さない・移動しない（パスを維持するので既存リンクは壊れない）。
    //     既にアーカイブ済みなら冪等 `{ ok: true, noop: true }`、`../` は 400。
    if (b === 'archive' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const target = resolveSpecRepo({ repoId: body?.repo, boardSlug: body?.board })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const out = archiveSpec(target.path, body?.path)
      auth.audit({
        kind: 'specs.archive',
        repo: target.repo,
        board: target.board ?? null,
        path: out.path,
        noop: Boolean(out.noop),
      })
      return sendJson(res, 200, { ...out, repo: target.repo, board: target.board ?? null })
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
        assignee: String(body?.assignee ?? getPilotProfile()).trim() || 'mobile',
        // 起票元チャット（`Chat:` 行 ＋ ラン記録の originSessionId）。書式外は specs 側で捨てる。
        chat: body?.chat,
        // 本文の見出し言語（`?lang=` → `Accept-Language` → en）。散文だけが従う。
        lang: langOf(req, url),
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
      if (r.ok && !body?.dryRun) nudgeWatchers()
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  // --- コヒーレンス診断（SPEC-COHERENCE §3.3.1 / D80・D83） --------------------
  // GET /api/coherence/report?board=<slug>&repo=<id>&fresh=1
  //   … 対象リポジトリの Layer 1（＋任意 Layer 2）診断を返す。15 秒キャッシュ（`fresh=1` で再計算）。
  //     `TasksPane` の提案バナーと `RefactorSheet` のバッジが読む。**読み取り専用**（起票しない）。
  if (a === 'coherence' && b === 'report' && req.method === 'GET') {
    const target = resolveSpecRepo({
      repoId: url.searchParams.get('repo'),
      boardSlug: url.searchParams.get('board'),
    })
    if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
    const fresh = url.searchParams.get('fresh') === '1'
    const key = `${target.repo}:${target.path}`
    const hit = coherenceCache.get(key)
    if (!fresh && hit && Date.now() - hit.at < COHERENCE_TTL_MS) {
      return sendJson(res, 200, { ...hit.report, cached: true })
    }
    let report
    try {
      report = await analyzeCoherence(target.path)
    } catch (e) {
      // 診断の失敗で UI を壊さない（バナーが出ないだけ）。
      return sendJson(res, 200, {
        ok: false,
        error: String(e?.message ?? e).slice(0, 200),
        repo: target.repo,
        board: target.board,
        generatedAt: new Date().toISOString(),
        layers: { universal: false, repoConfig: false, repoChecker: false },
        hardFails: [],
        softSignals: [],
        hotspots: [],
        summary: { hardFailCount: 0, softSignalCount: 0, hotspotCount: 0, activeSpecCount: 0, archivedSpecCount: 0, deprecatedRoutes: 0 },
        recommendedSweep: null,
      })
    }
    coherenceCache.set(key, { at: Date.now(), report })
    return sendJson(res, 200, { ...report, repo: target.repo, label: target.label, board: target.board, cached: false })
  }

  // --- A2B パイプライン最適化（第3段 / SPEC §3.2・D25③） ----------------------
  // GET  /api/pipeline/status                    … 適用済みか（中身は返さない）
  // POST /api/pipeline/optimize { soul?, skills? }
  //                                              … SOUL.md へ冪等追記＋スキル配置
  if (a === 'pipeline') {
    if (b === 'status' && req.method === 'GET') {
      return sendJson(
        res,
        200,
        getOptimizeStatus({
          hermesHome: cfg.hermesHome,
          home: cfg.home,
          skillsSrcDir: DEFAULT_SKILLS_SRC,
          pilotProfile: getPilotProfile(),
        }),
      )
    }
    if (b === 'profile' && (req.method === 'POST' || req.method === 'PUT')) {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const pilotProfile = writePilotProfile(cfg.configPath, body?.profile)
      let ensured = null
      if (body?.optimize !== false) {
        ensured = ensurePilotProfile({ hermesHome: cfg.hermesHome, profile: pilotProfile })
      }
      const ok = ensured ? ensured.ok : true
      auth.audit({
        kind: 'pipeline.profile',
        profile: pilotProfile,
        copiedConfig: Boolean(ensured?.copiedConfig),
        soulMode: ensured?.soul?.mode ?? null,
        ok,
      })
      return sendJson(res, ok ? 200 : 500, {
        ok,
        pilotProfile,
        ...(ensured ? { soul: ensured.soul, copiedConfig: ensured.copiedConfig } : {}),
        status: getOptimizeStatus({
          hermesHome: cfg.hermesHome,
          home: cfg.home,
          skillsSrcDir: DEFAULT_SKILLS_SRC,
          pilotProfile,
        }),
      })
    }
    if (b === 'optimize' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      if (typeof body?.profile === 'string' && body.profile.trim()) {
        writePilotProfile(cfg.configPath, body.profile)
      }
      const pilotProfile = getPilotProfile()
      // 既定は SOUL とスキル配置の両方。片方だけ試したいときは明示的に false を渡す。
      const doSoul = body?.soul !== false
      const doSkills = body?.skills !== false
      // 既定の専用プロファイル（`mobile`）のみに書き込み、普段使いの default SOUL は汚さない。
      const ensured = doSoul ? ensurePilotProfile({ hermesHome: cfg.hermesHome, profile: pilotProfile }) : null
      const soul = ensured ? ensured.soul : null
      const profiles = ensured ? { ok: ensured.ok, profiles: ensured.profiles } : null
      const skills = doSkills
        ? optimizeAgentSkills({ home: cfg.home, hermesHome: cfg.hermesHome, skillsSrcDir: DEFAULT_SKILLS_SRC })
        : null
      const ok = (soul?.ok ?? true) && (profiles?.ok ?? true) && (skills?.ok ?? true)
      auth.audit({
        kind: 'pipeline.optimize',
        profile: pilotProfile,
        soul: soul?.mode ?? null,
        soulChanged: Boolean(soul?.changed),
        profileTargets: profiles?.profiles?.length ?? 0,
        profileChanged: profiles?.profiles?.filter((p) => p.changed).length ?? 0,
        skillTargets: skills?.targets?.length ?? 0,
        ok,
      })
      return sendJson(res, ok ? 200 : 500, {
        ok,
        pilotProfile,
        soul,
        profiles,
        skills,
        status: getOptimizeStatus({
          hermesHome: cfg.hermesHome,
          home: cfg.home,
          skillsSrcDir: DEFAULT_SKILLS_SRC,
          pilotProfile,
        }),
      })
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  // --- Architect（仕様の種 → SPEC）／ハイブリッド A2B（SPEC V5 §3.2・§3.3① / D23・D25・D26①）--
  // POST /api/architect/seed { repo?, board?, seedText, runner?, autoStart?, executionPolicy?, chat?, lang? }
  //      … 202 で `{ok, jobId, status}` を即返し、Architect は背後で走る（画面を待たせない）
  // GET  /api/architect/jobs?board=<slug>&repo=<id>
  //      … ジョブ / 完成 SPEC（`spec_ready`）/ 未起票 SPEC（一括起票カードの材料）
  // POST /api/architect/jobs/:id/dismiss
  //      … ジョブ破棄をサーバー側に永続化する（再取得しても進行バーに出ない。SPEC V7 §3.1）
  // GET  /api/architect/config ・ PUT /api/architect/config { runner }
  //      … 実行ランナー（`hermes` 固定。他の値は INVALID_RUNNER = HTTP 400）
  if (a === 'architect') {
    if (b === 'config') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...architect.getConfig() })
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
          return sendError(res, 429, 'RATE_LIMITED')
        }
        const body = await readJson(req)
        // 正規化せずに渡す（未知のランナー名は INVALID_RUNNER で 400 にする）
        const r = architect.setConfig({ runner: body?.runner })
        auth.audit({ kind: 'architect.config', runner: r.runner ?? null, ok: Boolean(r.ok) })
        if (!r.ok) return sendFailure(res, r.code === 'INVALID_RUNNER' ? 400 : 409, r)
        return sendJson(res, 200, { ok: true, ...architect.getConfig() })
      }
      return sendError(res, 405, 'METHOD_NOT_ALLOWED')
    }

    if (b === 'seed' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const target = resolveSpecRepo({ repoId: body?.repo, boardSlug: body?.board })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const board = String(body?.board ?? target.board ?? '').trim()
      const r = await architect.seed({
        repoPath: target.path,
        board,
        seedText: body?.seedText,
        runner: body?.runner,
        autoStart: Boolean(body?.autoStart),
        executionPolicy: body?.executionPolicy,
        chat: body?.chat,
        lang: body?.lang,
      })
      auth.audit({
        kind: 'architect.seed',
        board,
        repo: target.repo,
        runner: r.runner ?? null,
        executionPolicy: r.executionPolicy ?? null,
        autoStart: Boolean(body?.autoStart),
        chars: String(body?.seedText ?? '').length,
        ok: Boolean(r.ok),
      })
      // 202: ジョブは動き出したが、SPEC はまだ無い（PWA は jobs をポーリングする）
      return r.ok ? sendJson(res, 202, r) : sendFailure(res, 400, r)
    }

    if (b === 'jobs' && c && d === 'dismiss' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = architect.dismiss(c)
      auth.audit({ kind: 'architect.dismiss', jobId: String(c), ok: Boolean(r.ok), persisted: Boolean(r.persisted) })
      if (!r.ok) return sendFailure(res, r.code === 'JOB_NOT_FOUND' ? 404 : 400, r)
      return sendJson(res, 200, { ok: true, jobId: r.jobId, persisted: Boolean(r.persisted) })
    }

    if (b === 'jobs' && !c && req.method === 'GET') {
      const board = String(url.searchParams.get('board') ?? '').trim()
      // D42: 既定はアクティブジョブをボード横断で返す。`?strictBoard=1` で V7 互換の厳密一致。
      const strictBoard = ['1', 'true', 'yes'].includes(String(url.searchParams.get('strictBoard') ?? '').trim().toLowerCase())
      const target = resolveSpecRepo({ repoId: url.searchParams.get('repo'), boardSlug: board || null })
      const snapshot = await architect.jobs({
        board,
        strictBoard,
        ...(target?.path ? { include: { repoPath: target.path, board: target.board ?? board } } : {}),
      })
      return sendJson(res, 200, snapshot)
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
      const assignee = String(body?.assignee ?? getPilotProfile()).trim() || 'mobile'
      const r = await capture.create({ ...body, board: b, assignee })
      auth.audit({
        kind: 'kanban.create',
        board: b,
        task: r.task?.id ?? null,
        assignee,
        created: Boolean(r.created),
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (b && c === 'tasks' && !d) {
      // 一覧は本文を載せない（1 件 1.5KB 平均 × 60 件で 90KB になり、モバイル回線で重い）。
      // 本文は詳細（/api/boards/:slug/tasks/:id）から取る。
      // `archivedCount` は一覧の LIMIT と独立に数える（「アーカイブ済み (N)」の N。D92）。
      const list = kanban.tasks(b, { limit: Number(url.searchParams.get('limit') ?? 60), withBody: false })
      const archivedCount = kanban.statusCounts(b).archivedCount
      // 履歴（kanban-sop）に記録があるタスクだけ git / Discord を添える
      const enriched = await Promise.all(
        list.map(async (t) => {
          const entry = gitinfo.entryFor(t.id)
          if (!entry) return t
          const [g, dc] = await Promise.all([gitinfo.forTask(t.id), Promise.resolve(discord.forAnchor(entry.anchor))])
          return { ...t, git: g, discord: dc }
        }),
      )
      return sendJson(res, 200, { tasks: enriched, archivedCount })
    }
    // POST /api/boards/:slug/tasks/bulk-archive { taskIds: [1..50], reason?, by? }
    //   … 「整理モード」の一括アーカイブ（D92）。実行中のタスクは**止めずに**スキップして返す。
    if (b && c === 'tasks' && d === 'bulk-archive' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const ids = Array.isArray(body?.taskIds)
        ? body.taskIds.map((x) => String(x ?? '').trim()).filter(Boolean)
        : []
      if (!ids.length || ids.length > BULK_ARCHIVE_MAX) {
        return sendError(res, 400, 'TASK_IDS_INVALID', { count: ids.length, max: BULK_ARCHIVE_MAX })
      }
      const bad = ids.filter((id) => !TASK_ID_RE.test(id))
      if (bad.length) return sendError(res, 400, 'TASK_ID_INVALID', { ids: bad.slice(0, 10) })
      const by = String(body?.by ?? 'mobile').slice(0, 40)
      const lang = langOf(req, url)
      const reason = String(
        body?.reason ?? (lang === 'ja' ? 'ゴミ整理（一括アーカイブ）' : 'Cleanup (bulk archive)'),
      ).slice(0, 200)
      const known = new Map(kanban.tasks(b, { limit: 200, withBody: false }).map((t) => [t.id, t.status]))
      const archived = []
      const skippedRunning = []
      const skippedArchived = []
      const failed = []
      for (const id of ids) {
        let status = known.get(id) ?? null
        if (status == null) {
          try {
            status = kanban.task(b, id).status
          } catch {
            failed.push({ id, code: 'TASK_NOT_FOUND' })
            continue
          }
        }
        if (status === 'running') {
          skippedRunning.push(id)
          continue
        }
        if (status === 'archived') {
          skippedArchived.push(id)
          continue
        }
        try {
          const out = await inbox.close(b, id, 'cancel', reason, by, lang)
          if (out?.status === 'archived') archived.push(id)
          else if (out?.noop) skippedArchived.push(id)
          else failed.push({ id, reason: 'not_closed' })
        } catch (err) {
          failed.push({ id, code: err?.code ?? 'CLOSE_FAILED' })
        }
      }
      auth.audit({
        kind: 'kanban.bulk_archive',
        board: b,
        requested: ids.length,
        archived: archived.length,
        skippedRunning: skippedRunning.length,
        skippedArchived: skippedArchived.length,
        failed: failed.length,
        by,
      })
      if (archived.length) nudgeWatchers()
      return sendJson(res, 200, { ok: true, board: b, archived, skippedRunning, skippedArchived, failed })
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
      return sendOutcome(res, out)
    }
    if (b && c === 'tasks' && d && e === 'close' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.close(b, d, body?.action, body?.note ?? body?.reason ?? '', String(body?.by ?? 'mobile'), langOf(req, url))
      auth.audit({
        kind: 'kanban.close',
        board: b,
        task: d,
        action: body?.action ?? null,
        status: out.status,
        noop: Boolean(out.noop),
      })
      if (!out?.noop) nudgeWatchers()
      return sendOutcome(res, out)
    }
    if (b && c === 'tasks' && d && e === 'unblock' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.unblock(b, d, body?.note ?? body?.reason ?? '', String(body?.by ?? 'mobile'), langOf(req, url))
      auth.audit({
        kind: 'kanban.unblock',
        board: b,
        task: d,
        status: out.status,
        noop: Boolean(out.noop),
      })
      if (!out?.noop) nudgeWatchers()
      return sendOutcome(res, out)
    }
    if (b && c === 'tasks' && d && e === 'worker' && req.method === 'GET') {
      // 任意のボードの実行中タスクでもワーカーのライブ進捗を読めるようにする（SPEC V8-B3）
      const info = kanban.taskSession(b, d)
      if (!info) return sendError(res, 404, 'NO_SESSION')
      const { feed, db, profile } = await readWorkerFeed(info.sessionId, info, Number(url.searchParams.get('limit') ?? 40))
      return sendJson(res, 200, {
        taskId: d,
        status: kanban.task(b, d).status,
        sessionId: info.sessionId,
        db,
        profile,
        feed,
      })
    }
    if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const reason = String(body?.reason ?? 'mobile kill switch').slice(0, 200)
      const out = await kanban.abort(b, d, reason, langOf(req, url))
      auth.audit({ kind: 'kanban.abort', board: b, task: d, reason, result: out })
      if (!out?.ok) {
        return sendJson(res, 502, {
          ...out,
          code: 'CLI_FAILED',
          error: out?.output || 'Failed to abort task',
        })
      }
      nudgeWatchers()
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
  // /api/review/:id/sheet           … シート HTML（常に sandbox・生成物）
  // /api/review/:id/view            … 単体タブ用ラッパー（sandbox iframe + postMessage 中継）
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
      await ensureWatchersFresh()
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
      await ensureWatchersFresh()
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
      await ensureWatchersFresh()
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
      const { feed, db, profile } = await readWorkerFeed(info.sessionId, info, Number(url.searchParams.get('limit') ?? 40))
      return sendJson(res, 200, { taskId: b, status: info.status, sessionId: info.sessionId, db, profile, feed })
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
      const r = await review.createFromImage(body || {}, langOf(req, url))
      auth.audit({ kind: 'review.from_image', task: r.taskId ?? null, source: body?.source ?? 'upload', ok: Boolean(r.ok) })
      if (r.ok) nudgeWatchers()
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
      const r = await review.saveAnnotation(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.annotation',
        task: b,
        duplicate: Boolean(r.duplicate),
        marks: r.marks ?? 0,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
    }
    if (c === 'sheet' && req.method === 'GET') {
      const lang = langOf(req, url)
      const r = review.sheetHtml(b, lang)
      if (!r.ok) return sendFailure(res, r.code === 'NOT_FOUND' ? 404 : 409, r)
      // D57: 埋め込みでも単体タブでも**同じ**厳格な CSP（sandbox = 不透明オリジン）で返す。
      // シート内のスクリプトは same-origin Cookie にも /ws/term にも /api/* にも届かない。
      // 回答は postMessage で親（PWA の iframe / :id/view ラッパー）へ渡し、親が POST する。
      res.writeHead(200, reviewSheetHeaders())
      return res.end(injectReviewBridge(r.html, b, lang))
    }
    // /api/review/:id/view … 単体タブ用のラッパー（D57）。
    // シートを sandbox iframe で囲み、postMessage を受けて same-origin で回答を POST する。
    // 存在判定は sheetHtml（.html が無くても .json から生成できる）に合わせる。
    if (c === 'view' && req.method === 'GET') {
      const lang = langOf(req, url)
      const r = review.sheetHtml(b, lang)
      if (!r.ok) return sendFailure(res, r.code === 'NOT_FOUND' ? 404 : 409, r)
      res.writeHead(200, reviewViewHeaders())
      return res.end(reviewViewHtml(b, lang))
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
      const r = await review.answer(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.answer',
        task: b,
        duplicate: Boolean(r.duplicate),
        choiceCount: Array.isArray(body?.answers) ? body.answers.length : 0,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      // レビュー待ち以外への送信は 409（状態の衝突）として返す。他の失敗は 400。
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, r.code === 'NOT_WAITING' ? 409 : 400, r)
    }
    if (c === 'reopen' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.reopen(b, body?.reason, langOf(req, url))
      auth.audit({ kind: 'review.reopen', task: b, ok: Boolean(r.ok) })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
    }
    // POST /api/review/:id/approve … 赤入れせずに 1 タップ検収（SPEC §5.2.3）
    // コメント `Visual check passed` を残して done（作業済み）または unblock（未作業）へ進める。
    if (c === 'approve' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.approve(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.approve',
        task: b,
        duplicate: Boolean(r.duplicate),
        moved: r.moved ?? null,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
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
      limit: Number(url.searchParams.get('limit') ?? 200),
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
    // Architect（仕様策定）は カンバンタスクを持たない Agy Opt-in ジョブも含めて
    // ボード横断で拾う（SPEC-PILOT-V9 §3.2）。取れなくても /api/live は返す。
    let archJobs = []
    try {
      const archSnap = await architect.jobs({ strictBoard: false })
      archJobs = Array.isArray(archSnap?.jobs) ? archSnap.jobs : []
    } catch {
      archJobs = []
    }
    const r = live.snapshot({ dbs: await listStateDbs(), architect: archJobs })
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

  // --- Zero-Typing 実行サマリ（完了レシート）-----------------------------------
  // /api/telemetry/receipt?board=<slug>&spec=<rel>&hours=24
  //   コスト / キャッシュ率 / 推定節約額 / 操作メトリクス（タップ・赤入れ・入力文字）を
  //   読み取り専用で集計する。欠損は 500 にせず、その項目を null ＋ missing で返す。
  if (a === 'telemetry' && b === 'receipt' && req.method === 'GET') {
    if (!readAllowed('telemetry', cfg.rate.maxReads ?? 240, cfg.rate.windowMs)) {
      return sendError(res, 429, 'RATE_LIMITED')
    }
    const r = telemetry.receipt({
      board: String(url.searchParams.get('board') ?? '').trim(),
      spec: String(url.searchParams.get('spec') ?? '').trim(),
      hours: Number(url.searchParams.get('hours') ?? 24),
      dbs: await listStateDbs(),
    })
    return sendJson(res, 200, r)
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

  // --- 緊急停止（カンバン一括）-----------------------------------------------
  // 暴走したワーカーを 1 操作で止める。ESTOP（新規停止）＋非アーカイブ全ボードの
  // 実行中タスク中断を 1 リクエストで行い、失敗は failed 配列で返す（200 で隠さない）。
  if (a === 'emergency' && b === 'stop-all' && req.method === 'POST') {
    if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) return sendError(res, 429, 'RATE_LIMITED')
    const body = await readJson(req)
    if (String(body?.confirm ?? '').toUpperCase() !== 'STOP_ALL') {
      return sendError(res, 400, 'CONFIRM_MISMATCH', { expected: 'STOP_ALL' })
    }
    const out = await ops.stopAll({
      reason: body?.reason ?? 'mobile',
      by: body?.by ?? 'mobile',
      lang: langOf(req, url),
    })
    nudgeWatchers()
    if (!out.ok) {
      // 中断が 1 件も通らず pause だけ失敗した場合は CLI_FAILED、それ以外は部分失敗。
      const failureCode = out.aborted === 0 && out.failed.some((f) => f.kind === 'pause')
        ? 'CLI_FAILED'
        : 'PARTIAL_FAILURE'
      const body = errorBody(failureCode, { aborted: out.aborted, failed: out.failed.length })
      return sendJson(res, 502, { ...out, ...body })
    }
    return sendJson(res, 200, out)
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
      return sendOutcome(res, out)
    }
    const out = await ops.gateway(b, body?.confirm, by)
    return sendOutcome(res, out)
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

  // --- メモ・ひらめき・受信箱 ----------------------------------------------
  if (a === 'memos' && !b) {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, memos: memos.list() })
    }
    if (req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const memo = memos.create(body ?? {})
      auth.audit({ kind: 'memos.create', id: memo.id, memoKind: memo.kind })
      return sendJson(res, 201, { ok: true, memo })
    }
  }
  if (a === 'memos' && b && !c) {
    if (req.method === 'PATCH') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const memo = memos.update(b, body ?? {})
      return sendJson(res, 200, { ok: true, memo })
    }
    if (req.method === 'DELETE') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const out = memos.remove(b)
      return sendOutcome(res, out)
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
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(req))
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
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(req))
    return
  }

  // 殻は公開、API は認証必須（殻の中の /api/* 呼び出しで 401 を受けたら UI がログインを出す）
  if (url.pathname.startsWith('/api/') && !auth.authorized(req)) {
    return sendError(res, 401, 'AUTH_REQUIRED')
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return distFiles.serveStatic(req, res, url.pathname)
  } catch (err) {
    const status = err?.statusCode ?? 500
    if (status >= 500) console.error('[api] failed:', err)
    // `ApiError` など `code` / `params` を持つ throw はそのコードで返す（SPEC-i18n-resp B1）。
    const code = typeof err?.code === 'string' && err.code ? err.code : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'
    sendFailure(res, status, { code, params: err?.params, message: String(err?.message ?? '') })
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
    ws.send(JSON.stringify({ t: 'out', d: '\r\n[bridge] node-pty failed to load\r\n' }))
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
    ws.send(JSON.stringify({ t: 'out', d: `\r\n[bridge] Failed to start PTY: ${err?.message ?? err}\r\n` }))
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
      `[bridge] Port ${cfg.port} is already in use. Check for leftover manual processes: ` +
        `lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN -> hermes-pilot service restart (or launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot)`,
    )
    process.exit(75)
  }
  console.error('[bridge] Server error:', err)
  process.exit(1)
})

server.listen(cfg.port, cfg.host, async () => {
  console.log(`[bridge] Hermes Pilot: http://${cfg.host}:${cfg.port}`)
  console.log(`[bridge] Upstream: ${cfg.hermesBase}`)
  console.log(`[bridge] Token file: ${cfg.tokenPath}`)
  console.log(`[bridge] Auth page: http://${cfg.host}:${cfg.port}/auth`)
  // 内蔵ウォッチャー（D7）。初回はベースライン確立のみで過去分は通知しない。
  try {
    reviewWatcher.start()
  } catch (err) {
    console.warn(`[bridge] Failed to start reviewWatcher: ${err?.message}`)
  }
  // パイプライン完走レポート（D20 / D21）。初回はベースライン確立のみ。
  try {
    pipelineWatcher.start()
  } catch (err) {
    console.warn(`[bridge] Failed to start pipelineWatcher: ${err?.message}`)
  }
  try {
    await hermes.ensureToken()
    console.log('[bridge] Hermes session token: resolved')
  } catch (err) {
    console.warn(`[bridge] Failed to resolve session token (is the dashboard stopped?): ${err?.message}`)
  }
})
