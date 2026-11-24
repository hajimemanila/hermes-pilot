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
import { createBoardTick } from './board-tick.js'
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
import { createBoardsApi } from './server/api-boards.js'
import { createSpecsApi } from './server/api-specs.js'
import { createWsHandlers } from './server/ws-handlers.js'
import { createServerHelpers } from './server/helpers.js'

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
/*
 * 盤面ティック（D110）。`kanban.db` を 10 秒ごとに **1 回だけ**読み、
 * スナップショット（行＋差分）を両ウォッチャーへ配る。タイマーはここ 1 本。
 */
const boardTick = createBoardTick(cfg)
// 完了・ブロックの記録はブリッジ内蔵（D7）。外部 cron は要らない。
const reviewWatcher = createReviewWatcher(cfg, { review, boardTick })
const ops = createOps(cfg, hermes, auth, { kanban, nudge: () => nudgeWatchers() })
const gitinfo = createGitInfo(cfg, { kanban })
// 使用量（コスト・トークン・API コール）はテレメトリとパイプライン報告の双方が使う（V7-2）。
const usage = createUsage(cfg)
// パイプライン完走レポート（D20 / D21）。Spec ラン／ボードウェーブの収束を監視する。
// `usage` を渡すと報告に Spec スコープの API コール数・トークン数が入る。
const pipelineWatcher = createPipelineWatcher(cfg, { gitinfo, usage, boardTick })
/*
 * 補助関数（ウォッチャー同期・プロファイル探索・スニペット保存・コヒーレンス解決・sendOutcome）は
 * `server/helpers.js` へ分割した。ここで 1 回だけ束ねて受け取る。
 */
const helpers = createServerHelpers({ cfg, hermes, kanban, repos, capabilities, boardTick, sendJson })
const {
  ensureWatchersFresh,
  tailscaleStatusJson,
  nudgeWatchers,
  invalidateProfilesCache,
  listProfiles,
  stateDbFor,
  listStateDbs,
  SNIPPET_STORE,
  loadSnippetStore,
  saveSnippetStore,
  snippetPayload,
  tailLog,
  coherenceCache,
  COHERENCE_TTL_MS,
  resolveSpecRepo,
  BULK_ARCHIVE_MAX,
  TASK_ID_RE,
  sendOutcome,
} = helpers

// これらは起動時に 1 度だけ作るシングルトン（補助関数群からは ctx 経由で見せる）。
const discord = createDiscord(cfg)
const search = createSearch(cfg)
const transcript = createTranscript(cfg)

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


/** API のルーティング。 */

/*
 * API ハンドラは `server/` 配下のモジュールへ分割した（`handleApi` のルート条件・応答形・404 の位置は
 * 変えない）。依存はここで 1 回だけ束ねて渡す。
 */
const apiCtx = {
  cfg,
  auth,
  kanban,
  repos,
  specs,
  architect,
  review,
  reviewWatcher,
  ops,
  gitinfo,
  usage,
  boardTick,
  pipelineWatcher,
  readPipelineReports,
  capabilities,
  getPilotProfile,
  writePilotProfile,
  ensurePilotProfile,
  DEFAULT_SKILLS_SRC,
  getOptimizeStatus,
  optimizeAgentSkills,
  memos,
  capture,
  pairCodes,
  discord,
  live,
  inbox,
  search,
  transcript,
  readWorkerFeed,
  stateDbFor,
  listProfiles,
  invalidateProfilesCache,
  listStateDbs,
  loadSnippetStore,
  saveSnippetStore,
  snippetPayload,
  SNIPPET_STORE,
  tailLog,
  sendJson,
  sendError,
  sendFailure,
  readJson,
  langOf,
  readAllowed,
  writeAllowed,
  errorBody,
  normalizePath,
  listSpecs,
  archiveSpec,
  partitionSpecs,
  readRuns,
  attachRunTaskIds,
  readSpecContent,
  runsPathFor,
  analyzeCoherence,
  resolveSpecRepo,
  coherenceCache,
  COHERENCE_TTL_MS,
  BULK_ARCHIVE_MAX,
  TASK_ID_RE,
  sendOutcome,
  ensureWatchersFresh,
  tailscaleStatusJson,
  nudgeWatchers,
  VERSION,
}
const apiBoards = createBoardsApi(apiCtx)
const apiSpecs = createSpecsApi(apiCtx)

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
  // --- リポジトリ / SPEC / コヒーレンス / パイプライン / Architect / ボード / レビュー --------
  // 実体は `server/api-specs.js`（repos・specs・coherence・pipeline・architect）と
  // `server/api-boards.js`（boards・review）。ルート条件と応答形は分割前と同一。
  if (a === 'repos') return apiSpecs.handleRepos(req, res, url, seg)
  if (a === 'specs') return apiSpecs.handleSpecs(req, res, url, seg)
  if (a === 'coherence' && (b === 'report' || b === 'approve' || b === 'revoke')) return apiSpecs.handleCoherence(req, res, url, seg)
  if (a === 'pipeline') return apiSpecs.handlePipeline(req, res, url, seg)
  if (a === 'architect') return apiSpecs.handleArchitect(req, res, url, seg)
  if (a === 'boards') return apiBoards.handleBoards(req, res, url, seg)
  if (a === 'review') return apiBoards.handleReview(req, res, url, seg)


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

/* WS ハンドラは `server/ws-handlers.js` へ分割（アップグレード判定と wss の生成はここに残す）。 */
const wsHandlers = createWsHandlers({ cfg, hermes, auth, pty, listProfiles, checkFrame, rejectionFrame })
const { proxyChat, openTerm } = wsHandlers
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
  // 盤面の走査は 1 本（`boardTick`）で、review / pipeline の 2 ウォッチャーは購読者（D110）。
  try {
    boardTick.start()
  } catch (err) {
    console.warn(`[bridge] Failed to start boardTick: ${err?.message}`)
  }
  try {
    await hermes.ensureToken()
    console.log('[bridge] Hermes session token: resolved')
  } catch (err) {
    console.warn(`[bridge] Failed to resolve session token (is the dashboard stopped?): ${err?.message}`)
  }
})
