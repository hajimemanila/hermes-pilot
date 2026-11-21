import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { buildAugmentedPath, resolveHermesBin } from './capabilities.js'

/**
 * リポジトリ（作業ディレクトリ）の自動検出と、カンバンボードとの対応。
 *
 * 旧来の個人プラグインの設定ファイルには**依存しない**。一覧は次の 4 ソースを
 * `normalizePath` で重複排除して統合する（SPEC §5.1 / D4）:
 *  1. ユーザー設定 `repos.json`（`custom`）＋ `scanDirs` 直下 1 階層の `.git` 自動スキャン
 *  2. カンバン各ボードの `default_workdir`
 *  3. `state.db` の直近セッション `cwd`
 *  4. 手動追加（`custom`）・非表示（`hidden`）・ピン留め（`pinned`）
 *
 * macOS は大文字小文字を区別しないので比較は小文字で行う（実測: `~/projects/...` と
 * `~/Projects/...` が混在している）。パスは**表示用に元の表記**を残す。
 */

/** 自動スキャンのキャッシュ TTL（SPEC §5.1: 30 秒）。 */
export const SCAN_TTL_MS = 30_000

/** `state.db` の cwd から拾う候補の上限。 */
const SESSION_LIMIT = 8

/** ホーム直下の探索候補（実在するものだけ使う）。 */
const DEFAULT_SCAN_DIRS = ['~/Projects', '~/projects']

/**
 * パス比較用の正規化（~ 展開・絶対化・小文字化・末尾スラッシュ落とし）。
 * @param {string} p パス
 * @param {string} [home] ホーム（テスト用）
 * @returns {string} 正規化済みパス
 */
export function normalizePath(p, home = os.homedir()) {
  const raw = String(p ?? '').trim()
  if (!raw) return ''
  const abs = path.resolve(expandHome(raw, home))
  const lower = abs.toLowerCase()
  return lower.length > 1 ? lower.replace(/[/\\]+$/, '') : lower
}

/**
 * `~` を展開して絶対パスにする（表記はそのまま）。
 * @param {string} p パス
 * @param {string} [home] ホーム
 * @returns {string} 絶対パス
 */
export function expandHome(p, home = os.homedir()) {
  const raw = String(p ?? '').trim()
  if (!raw) return ''
  if (raw === '~') return home
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2))
  return path.isAbsolute(raw) ? raw : path.resolve(home, raw)
}

/**
 * そのディレクトリが Git リポジトリか（`.git` はディレクトリでも worktree のファイルでもよい）。
 * @param {string} dir ディレクトリ
 * @returns {boolean} Git 管理下なら true
 */
export function isGitRepo(dir) {
  const abs = String(dir ?? '').trim()
  if (!abs) return false
  try {
    return fs.existsSync(path.join(abs, '.git'))
  } catch {
    return false
  }
}

/**
 * パスからボード名に使える id を作る（`[a-z0-9._-]` 以外は `-`）。
 * @param {string} dir パス
 * @returns {string} id
 */
export function repoIdFromPath(dir) {
  const base = path.basename(String(dir ?? '').trim()) || 'repo'
  const id = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return id || 'repo'
}

/**
 * 空の設定（初回起動時の既定）。`scanDirs` は実在する既定候補だけ。
 * @param {string} [home] ホーム
 * @returns {{scanDirs: string[], pinned: string[], hidden: string[], custom: Array<object>}} 設定
 */
export function defaultReposConfig(home = os.homedir()) {
  return {
    scanDirs: DEFAULT_SCAN_DIRS.filter((d) => {
      try {
        return fs.statSync(expandHome(d, home)).isDirectory()
      } catch {
        return false
      }
    }),
    pinned: [],
    hidden: [],
    custom: [],
  }
}

/**
 * 設定ファイルの内容を安全な形に整える（壊れた値は捨てる）。
 * @param {unknown} raw 読み込んだ値
 * @param {string} [home] ホーム
 * @returns {{scanDirs: string[], pinned: string[], hidden: string[], custom: Array<{id: string, label: string, path: string}>}} 設定
 */
export function normalizeReposConfig(raw, home = os.homedir()) {
  const base = defaultReposConfig(home)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const strList = (v, map) =>
    Array.isArray(v)
      ? [...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).map(map ?? ((x) => x)))]
      : []
  const custom = []
  if (Array.isArray(raw.custom)) {
    for (const c of raw.custom) {
      const abs = expandHome(String(c?.path ?? '').trim(), home)
      if (!abs || !path.isAbsolute(abs)) continue
      const id = repoIdFromPath(String(c?.id ?? '').trim() || abs)
      const label = String(c?.label ?? '').trim() || path.basename(abs)
      custom.push({ id, label, path: abs })
    }
  }
  return {
    scanDirs: Array.isArray(raw.scanDirs) ? strList(raw.scanDirs) : base.scanDirs,
    pinned: strList(raw.pinned),
    hidden: strList(raw.hidden, (x) => normalizePath(x, home)),
    custom,
  }
}

/**
 * `repos.json` を読む（無ければ既定・書かない）。
 * @param {string} file 設定ファイル
 * @param {string} [home] ホーム
 * @returns {object} 設定
 */
export function readReposConfig(file, home = os.homedir()) {
  try {
    return normalizeReposConfig(JSON.parse(fs.readFileSync(file, 'utf8')), home)
  } catch {
    return defaultReposConfig(home)
  }
}

/**
 * `repos.json` をアトミックに書く（0600・tmp → rename）。
 * @param {string} file 設定ファイル
 * @param {object} data 設定
 * @returns {object} 正規化後の設定
 */
export function writeReposConfig(file, data) {
  const normalized = normalizeReposConfig(data)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return normalized
}

/**
 * `scanDirs` の直下 **1 階層のみ** を走査して Git リポジトリを探す（深追いしない）。
 * @param {string[]} scanDirs 親ディレクトリ
 * @param {string} [home] ホーム
 * @returns {Array<{id: string, label: string, path: string, source: string}>} 見つかったリポジトリ
 */
export function scanGitDirs(scanDirs = [], home = os.homedir()) {
  const out = []
  const seen = new Set()
  for (const rawDir of scanDirs) {
    const dir = expandHome(String(rawDir ?? '').trim(), home)
    if (!dir || !path.isAbsolute(dir)) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue
      const abs = path.join(dir, ent.name)
      if (!isGitRepo(abs)) continue
      const key = normalizePath(abs, home)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: repoIdFromPath(abs), label: ent.name, path: abs, source: 'scan' })
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

/**
 * 4 ソースを統合する（重複パスは最初の 1 件・`hidden` は除外・`pinned` が先頭）。
 * @param {object} input 材料
 * @param {object} input.config 設定
 * @param {Array<object>} [input.scanned] 自動スキャン結果
 * @param {Array<object>} [input.boards] `kanban.boards()` の結果
 * @param {Array<string>} [input.cwds] 直近セッションの cwd
 * @param {string} [input.home] ホーム
 * @returns {Array<{id: string, label: string, path: string, source: string, pinned: boolean}>} 統合結果
 */
export function mergeRepos({ config = {}, scanned = [], boards = [], cwds = [], home = os.homedir() } = {}) {
  const hidden = new Set((config.hidden ?? []).map((p) => normalizePath(p, home)))
  const rows = []
  const seenPath = new Set()
  const seenId = new Set()
  const homeKey = normalizePath(home, home)

  const push = (raw, label, source) => {
    const abs = expandHome(String(raw ?? '').trim(), home)
    if (!abs || !path.isAbsolute(abs)) return
    const key = normalizePath(abs, home)
    if (!key || key === homeKey || key === '/' || seenPath.has(key) || hidden.has(key)) return
    if (!isGitRepo(abs)) return
    let id = repoIdFromPath(abs)
    if (seenId.has(id)) {
      let n = 2
      while (seenId.has(`${id}-${n}`)) n += 1
      id = `${id}-${n}`
    }
    seenId.add(id)
    seenPath.add(key)
    rows.push({ id, label: String(label ?? '').trim() || path.basename(abs), path: abs, source })
  }

  for (const c of config.custom ?? []) push(c.path, c.label || c.id, 'custom')
  for (const s of scanned) push(s.path, s.label || s.id, 'scan')
  for (const b of boards) {
    if (!b || b.archived) continue
    push(b.workdir, b.name || b.slug, 'board')
  }
  for (const cwd of cwds.slice(0, SESSION_LIMIT)) push(cwd, path.basename(String(cwd ?? '')), 'session')

  // ピン留めは id でもパスでも受ける（設定画面は id を書く）
  const pinnedRank = new Map()
  for (const [i, p] of (config.pinned ?? []).entries()) {
    const raw = String(p ?? '').trim()
    if (!raw) continue
    if (!pinnedRank.has(raw)) pinnedRank.set(raw, i)
    const key = normalizePath(raw, home)
    if (key && !pinnedRank.has(key)) pinnedRank.set(key, i)
  }
  for (const r of rows) {
    const rank = pinnedRank.has(r.id) ? pinnedRank.get(r.id) : pinnedRank.get(normalizePath(r.path, home))
    r.pinned = rank !== undefined
    r.rank = rank ?? Number.MAX_SAFE_INTEGER
  }
  rows.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
  for (const r of rows) delete r.rank
  return rows
}

/**
 * repo の path と workdir が一致するボード（アーカイブ済みは除く）。
 * @param {string} repoPath リポジトリの絶対パス
 * @param {Array<object>} boards `kanban.boards()` の結果
 * @returns {Array<{slug: string, name: string, current: boolean}>} ボード（複数ありうる）
 */
export function boardsForRepo(repoPath, boards = []) {
  const want = normalizePath(repoPath)
  if (!want) return []
  return boards
    .filter((b) => b && !b.archived && normalizePath(b.workdir) === want)
    .map((b) => ({ slug: String(b.slug), name: String(b.name ?? b.slug), current: Boolean(b.current) }))
}

/**
 * repos × boards を合成する。
 * @param {Array<{id: string, label: string, path: string}>} repos 統合済みリポジトリ
 * @param {Array<object>} boards
 * @returns {Array<{id: string, label: string, path: string, source: string, pinned: boolean, boards: Array<object>}>} 合成結果
 */
export function joinRepos(repos = [], boards = []) {
  const out = []
  const seen = new Set()
  for (const r of repos) {
    const id = String(r?.id ?? '').trim()
    const abs = String(r?.path ?? '').trim()
    if (!id || !abs || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: String(r.label ?? id),
      path: abs,
      source: String(r.source ?? 'custom'),
      pinned: Boolean(r.pinned),
      boards: boardsForRepo(abs, boards),
    })
  }
  return out
}

/**
 * ボード名（slug）として安全か。CLI と同じ規則に寄せる。
 * @param {unknown} slug 候補
 * @returns {boolean} 安全なら true
 */
export function isSafeBoardSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)
}

/**
 * `state.db` の直近セッション `cwd` を読む（読取専用・失敗しても空）。
 * @param {object} cfg 設定（`stateDb` / `kanbanRoot`）
 * @returns {string[]} cwd の新しい順
 */
export function readSessionCwds(cfg = {}) {
  const dbPath = String(cfg.stateDb ?? '')
  if (!dbPath) return []
  try {
    if (!fs.existsSync(dbPath)) return []
  } catch {
    return []
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare(
        `SELECT cwd, MAX(last_activity_at) AS t
           FROM sessions
          WHERE cwd IS NOT NULL AND cwd <> ''
          GROUP BY cwd
          ORDER BY t DESC
          LIMIT 64`,
      )
      .all()
    const kanbanRoot = String(cfg.kanbanRoot ?? '')
    const out = []
    for (const r of rows) {
      const cwd = String(r.cwd ?? '').trim()
      if (!cwd || !path.isAbsolute(cwd)) continue
      // ワーカーの workspace（worktree）は同じリポジトリの重複なので候補にしない
      if (kanbanRoot && cwd.startsWith(kanbanRoot)) continue
      if (!isGitRepo(cwd)) continue
      out.push(cwd)
      if (out.length >= SESSION_LIMIT) break
    }
    return out
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* noop */
    }
  }
}

/**
 * リポジトリ一覧の読み取り・自動スキャン・追加・非表示、板が無いリポジトリのボード作成。
 *
 * @param {object} cfg 設定（`reposPath` / `stateDb` / `kanbanRoot` / `hermesBin`）
 * @param {{boards?: Function, cwds?: Function, runner?: Function, configPath?: string, now?: Function}} [deps] 差し替え（テスト用）
 * @returns {object} 操作
 */
export function createRepos(cfg = {}, deps = {}) {
  const listBoards = deps.boards ?? (() => [])
  const readCwds = deps.cwds ?? (() => readSessionCwds(cfg))
  const now = deps.now ?? (() => Date.now())
  const configPath = deps.configPath ?? cfg.reposPath ?? ''
  const run =
    deps.runner ??
    ((args) =>
      new Promise((resolve) => {
        execFile(
          cfg.hermesBin ?? resolveHermesBin(),
          args,
          { timeout: 30_000, maxBuffer: 1_000_000, env: { ...process.env, PATH: buildAugmentedPath() } },
          (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          },
        )
      }))

  let cache = null

  /** 設定を読む（ファイルが無ければ既定）。 */
  function readConfig() {
    return configPath ? readReposConfig(configPath) : defaultReposConfig()
  }

  /** 設定を書く（`configPath` 未設定ならメモリのみ＝テスト用）。 */
  function writeConfig(data) {
    const normalized = configPath ? writeReposConfig(configPath, data) : normalizeReposConfig(data)
    cache = null
    return normalized
  }

  /** キャッシュを捨てる（`POST /api/repos/scan`）。 */
  function invalidate() {
    cache = null
  }

  /** 統合済みの候補（キャッシュ TTL 30 秒）。 */
  function candidates({ force = false } = {}) {
    if (!force && cache && now() - cache.at < SCAN_TTL_MS) return cache
    const config = readConfig()
    const scanned = scanGitDirs(config.scanDirs)
    const boards = listBoards()
    let cwds = []
    try {
      cwds = readCwds() ?? []
    } catch {
      cwds = []
    }
    const rows = mergeRepos({ config, scanned, boards, cwds })
    cache = { at: now(), rows, config }
    return cache
  }

  /** 一覧（ボード付き）。 */
  function list({ force = false } = {}) {
    const { rows } = candidates({ force })
    return joinRepos(rows, listBoards())
  }

  /** 現在の `scanDirs`。 */
  function scanDirs() {
    return candidates().config.scanDirs ?? []
  }

  /** `review` など他モジュール向けの最小形（`id` / `label` / `path`）。 */
  function targets() {
    return list().map(({ id, label, path }) => ({ id, label, path }))
  }

  /**
   * リポジトリを手動追加する（実在 ＋ `.git` ＋ ホーム直下でないことを確認）。
   * @param {{path: string, label?: string}} input 追加内容
   * @returns {{ok: boolean, repo?: object, error?: string}} 結果
   */
  function add(input = {}) {
    const raw = String(input?.path ?? '').trim()
    if (!raw) return { ok: false, code: 'REPO_PATH_REQUIRED' }
    if (raw === '~' || normalizePath(raw) === normalizePath(os.homedir())) {
      return { ok: false, code: 'REPO_PATH_FORBIDDEN' }
    }
    const abs = expandHome(raw)
    if (!path.isAbsolute(abs)) return { ok: false, code: 'REPO_PATH_INVALID' }
    if (!isGitRepo(abs)) return { ok: false, code: 'REPO_NOT_GIT' }
    const config = readConfig()
    const key = normalizePath(abs)
    const custom = config.custom.filter((c) => normalizePath(c.path) !== key)
    const id = String(input.id ?? '').trim() || repoIdFromPath(abs)
    custom.push({ id, label: String(input.label ?? '').trim() || path.basename(abs), path: abs })
    const next = writeConfig({
      ...config,
      custom,
      hidden: config.hidden.filter((p) => p !== key),
      pinned: config.pinned.filter((p) => p !== key),
    })
    const repo = list({ force: true }).find((r) => normalizePath(r.path) === key)
    return { ok: true, repo: repo ?? null, config: next }
  }

  /**
   * リポジトリを消す。手動追加は `custom` から、自動検出は `hidden` へ入れる。
   * @param {string} id リポジトリ id
   * @returns {{ok: boolean, hidden?: boolean, error?: string}} 結果
   */
  function remove(id) {
    const want = String(id ?? '').trim()
    if (!want) return { ok: false, code: 'REPO_ID_REQUIRED' }
    const repo = list().find((r) => r.id === want)
    if (!repo) return { ok: false, code: 'REPO_NOT_FOUND' }
    const config = readConfig()
    const key = normalizePath(repo.path)
    const wasCustom = config.custom.some((c) => normalizePath(c.path) === key)
    const next = wasCustom
      ? { ...config, custom: config.custom.filter((c) => normalizePath(c.path) !== key) }
      : { ...config, hidden: [...new Set([...(config.hidden ?? []), key])] }
    writeConfig({ ...next, pinned: (config.pinned ?? []).filter((p) => p !== want && p !== key) })
    return { ok: true, hidden: !wasCustom }
  }

  /**
   * `scanDirs` を更新する（実在するディレクトリのみ・ホーム直下と `/` は拒否）。
   * @param {string[]} dirs 親ディレクトリ
   * @returns {{ok: boolean, scanDirs?: string[], error?: string}} 結果
   */
  function setScanDirs(dirs) {
    if (!Array.isArray(dirs)) return { ok: false, code: 'SCAN_DIRS_INVALID' }
    const clean = []
    for (const raw of dirs) {
      const s = String(raw ?? '').trim()
      if (!s) continue
      const abs = expandHome(s)
      if (!path.isAbsolute(abs)) return { ok: false, code: 'SCAN_DIR_NOT_ABSOLUTE', params: { path: s } }
      if (normalizePath(abs) === normalizePath(os.homedir())) {
        return { ok: false, code: 'SCAN_DIR_FORBIDDEN' }
      }
      try {
        if (!fs.statSync(abs).isDirectory()) return { ok: false, code: 'SCAN_DIR_NOT_DIRECTORY', params: { path: s } }
      } catch {
        return { ok: false, code: 'SCAN_DIR_MISSING', params: { path: s } }
      }
      if (!clean.includes(s)) clean.push(s)
    }
    const config = readConfig()
    writeConfig({ ...config, scanDirs: clean })
    return { ok: true, scanDirs: clean }
  }

  /** 即時再スキャン（キャッシュを捨てて返す）。 */
  function scan() {
    const snap = candidates({ force: true })
    return { ok: true, repos: joinRepos(snap.rows, listBoards()), scanDirs: snap.config.scanDirs ?? [] }
  }

  /**
   * 板が無いリポジトリにボードを 1 つ作る（既に同じ workdir の板があればそれを返す）。
   * @param {string} repoId リポジトリ id（＝ボードの slug に使う）
   * @returns {Promise<{ok: boolean, board?: object, error?: string, created?: boolean}>} 結果
   */
  async function createBoard(repoId) {
    const repo = list().find((r) => r.id === String(repoId ?? ''))
    if (!repo) return { ok: false, code: 'REPO_NOT_FOUND' }
    if (repo.boards.length) {
      const hit = repo.boards.find((b) => b.current) ?? repo.boards[0]
      return { ok: true, created: false, board: hit }
    }
    if (!isSafeBoardSlug(repo.id)) return { ok: false, code: 'BOARD_NAME_INVALID' }
    const args = ['kanban', 'boards', 'create', repo.id, '--name', repo.label, '--default-workdir', repo.path]
    const res = await run(args)
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || '').trim().slice(0, 400)
      return { ok: false, code: 'CREATE_FAILED', error: msg }
    }
    invalidate()
    return { ok: true, created: true, board: { slug: repo.id, name: repo.label, current: false } }
  }

  return { list, scanDirs, targets, add, remove, setScanDirs, scan, createBoard, invalidate }
}
