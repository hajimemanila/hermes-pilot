/**
 * ブリッジの補助関数（ウォッチャー同期・プロファイル探索・スニペット保存・コヒーレンス解決）。
 * `server.js` から分割（挙動は変えない）。依存は `ctx` で受け取る。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readTailText } from '../tail.js'
import { BUILTIN_IDS, CUSTOM_MAX, HOT_LIMIT, allSnippets, readSnippetStore, writeSnippetStore } from '../snippets.js'
import { normalizePath } from '../repos.js'
import { TERM_BUILTIN_IDS, allTermSnippets } from '../term-snippets.js'
import { tailscaleCommandCandidates } from '../qr.js'

export function createServerHelpers(ctx = {}) {
  const { cfg, hermes, kanban, repos, capabilities, reviewWatcher, pipelineWatcher, sendJson } = ctx


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

/**
 * プロファイル一覧（name と state.db の在処）。30秒キャッシュ。
 * チャット一覧をプロジェクト横断にするために使う。
 */
let profilesCache = { at: 0, list: [] }
function invalidateProfilesCache() {
  profilesCache = { at: 0, list: [] }
}
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

  /**
   * `tailscale status --json` を 1 回だけ叩いて 60 秒キャッシュする。
   *
   * Tailscale が無い・ログインしていない環境では素直に null（LAN 候補だけ出す）。
   * ここで失敗してもペアリングは成立させる（QR が出ない理由にしない）。
   *
   * D102 の対象外: best-effort なプローブで、失敗は `null` が仕様（`lib/cli.js` の `ok` に
   * 寄せると「未ログイン」と「timeout」を区別する必要が生まれ、ペアリングの分岐が増える）。
   *
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

  return {
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
  }
}
