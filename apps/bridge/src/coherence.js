import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  approveChecker,
  checkerSha256,
  defaultAllowlistPath,
  isCheckerApproved,
  revokeChecker,
} from './coherence/allowlist.js'

export { approveChecker, defaultAllowlistPath, isCheckerApproved, revokeChecker }

/**
 * コヒーレンス診断エンジン（SPEC-COHERENCE §3.3 / D80）。
 *
 * **2 層構成**:
 *  - **Layer 1（universal）**: 設定ゼロで全言語・全 Git リポジトリに効く 5 シグナル
 *    （`git-hotspot` / `file-bloat` / `spec-sprawl` / `debt-spike` / `duplicate-batch-id`）。
 *    Node / npm / `hm:*` / `mockApi` を一切仮定しない（Python / Go / Rust でも動く）。
 *  - **Layer 2（repo config）**: 対象リポジトリ直下の `.hermes-coherence.json` がある時だけ
 *    宣言型ルール（`ignoreGlobs` / `maxLines` / `hotspotDays` / `hotspotTouches` /
 *    `baselineFile` / `forbiddenPatterns`）と、境界検証付きのローカル `checker` を読む。
 *
 * **読み取り専用**（D55）: ファイルを書かず・カンバンも DB も触らない。`analyzeCoherence()` は
 * 何度呼んでも同じ結果を返す純粋な観測だけを行う。
 */

/** Layer 1 の既定値（設定ゼロで動く値）。 */
export const UNIVERSAL_DEFAULTS = {
  maxLines: 800,
  hotspotDays: 14,
  hotspotTouches: 5,
  specSprawlLimit: 6,
  debtSpikeLimit: 10,
  maxDepth: 12,
}

/** 走査しないディレクトリ（言語非依存の一般的な生成物・依存・VCS）。 */
const IGNORE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.venv',
  'venv',
  'env',
  'vendor',
  'target',
  'dist',
  'dist-demo',
  'dist.next',
  'dist.prev',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'coverage',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.worktrees',
  '.gradle',
  '.idea',
  'Pods',
])

/** 行数を数える対象（テキストのソースだけ。画像・lockfile は数えない）。 */
const SOURCE_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.ex',
  '.exs',
  '.dart',
  '.scala',
  '.sh',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.vue',
  '.svelte',
])

/** 設定ファイルの上限（64KB。これを超えるものは読まない）。 */
export const CONFIG_MAX_BYTES = 64 * 1024

/** `checker` 実行のタイムアウト（10 秒）。 */
const CHECKER_TIMEOUT_MS = 10_000

/** ファイル名の規則（`SPEC*.md`。`specs.js` と同じ規則）。 */
const SPEC_FILE_RE = /^SPEC.*\.md$/i

/** アーカイブ宣言（`- **Status**: archived` / `- **状態**: アーカイブ`）。 */
const ARCHIVED_RE = /^\s*[-*]?\s*\*\*\s*(?:Status|状態)\s*\*\*\s*[:：]\s*(?:archived|アーカイブ)/i

/** 負債マーカー（Layer 1 の `debt-spike`）。 */
const DEBT_RE = /\b(TODO|FIXME|HACK|XXX)\b/g

/** バッチ見出し（`### Batch <ID>: <title>` / `### <ID>: <title>` / `### <ID> — <title>`。`specs.js` と同じ規則）。 */
export const BATCH_HEADING_RE = /^###\s+(?:Batch\s+)?([A-Za-z][A-Za-z0-9._-]{0,15})(?:\s*[:：]\s*|\s+[—–-]\s+)(.+?)\s*$/

/** glob（`*` / `**` / `?`）をリポジトリ相対パスの正規表現へ変換する。 */
function globToRegExp(glob) {
  const src = String(glob ?? '')
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${src}$`)
}

/** ファイルを 1 行ずつ安全に読む（巨大ファイル・バイナリ・権限エラーは null）。 */
function readText(abs, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > maxBytes) return null
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 行数（末尾の改行は数えない）。 */
function countLines(text) {
  if (!text) return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * リポジトリ内のソースファイルを列挙する（同期・読み取り専用）。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @param {{ignoreGlobs?: string[], maxDepth?: number}} [opts] 除外 glob と深さ上限
 * @returns {Array<{rel: string, abs: string}>} 列挙結果（パス昇順）
 */
export function listSourceFiles(repoRoot, opts = {}) {
  const root = path.resolve(String(repoRoot ?? ''))
  const ignores = (opts.ignoreGlobs ?? []).map(globToRegExp)
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : UNIVERSAL_DEFAULTS.maxDepth
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        if (ignores.some((re) => re.test(rel))) continue
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (ignores.some((re) => re.test(rel))) continue
      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) continue
      out.push({ rel, abs })
    }
  }
  walk(root, 0)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 直近の整合性スイープ完了（`COHERENCE/` または `chore(coherence):` / `refactor(coherence):`）コミットの UNIX 秒を返す。
 *
 * リファクタ・分割を完了したスイープコミット以前の履歴が `git-hotspot` を 14 日間
 * 汚染し続けないためのチェックポイント（D80 / post-sweep clear）。
 * `docs(coherence):` のような SPEC ドラフトではリセットしない。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @param {number} days 観測期間（日）
 * @returns {Promise<number|null>} UNIX 秒または null
 */
function latestCoherenceSweepSec(repoRoot, days) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', `--since=${days}.days`, '-n', '1', '--extended-regexp', '--grep=(COHERENCE/|(chore|refactor)\\(coherence\\):)', '--format=%ct'],
      { cwd: repoRoot, timeout: 5_000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        const sec = Number.parseInt(String(stdout ?? '').trim(), 10)
        resolve(Number.isFinite(sec) && sec > 0 ? sec : null)
      },
    )
  })
}

/**
 * 直近 N 日の変更回数（`git-hotspot` の材料）。`.git` が無ければ空配列（安全スキップ）。
 *
 * 直近の `COHERENCE/` スイープ完了コミットがあれば、その 1 秒後から集計する。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @param {{days?: number, ignoreSweepCheckpoint?: boolean}} [opts] 観測期間
 * @returns {Promise<Array<{file: string, touches: number}>>} 変更回数の多い順
 */
export async function gitHotspots(repoRoot, opts = {}) {
  const days = Number.isFinite(opts.days) ? opts.days : UNIVERSAL_DEFAULTS.hotspotDays
  const sweepSec = opts.ignoreSweepCheckpoint === true ? null : await latestCoherenceSweepSec(repoRoot, days)
  const sinceArg = sweepSec ? `--since=${new Date((sweepSec + 1) * 1000).toISOString()}` : `--since=${days}.days`
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', sinceArg, '--name-only', '--pretty=format:'],
      { cwd: repoRoot, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        const counts = new Map()
        for (const raw of String(stdout ?? '').split('\n')) {
          const file = raw.trim()
          if (!file) continue
          if (IGNORE_DIRS.has(file.split('/')[0])) continue
          if (!SOURCE_EXT.has(path.extname(file).toLowerCase())) continue
          counts.set(file, (counts.get(file) ?? 0) + 1)
        }
        resolve(
          [...counts.entries()]
            .map(([file, touches]) => ({ file, touches }))
            .sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file)),
        )
      },
    )
  })
}

/**
 * SPEC のアーカイブ宣言を読む（`specs.js` と同じ規則。循環 import を避けてここに置く）。
 *
 * @param {string} text SPEC の全文
 * @returns {boolean} アーカイブ済みか
 */
export function isArchivedSpecText(text) {
  const head = String(text ?? '').split(/\r?\n/).slice(0, 40)
  return head.some((line) => ARCHIVED_RE.test(line))
}

/** リポジトリ内の SPEC を数える（`spec-sprawl` の材料）。 */
function countSpecs(repoRoot) {
  const dirs = [repoRoot, path.join(repoRoot, 'docs'), path.join(repoRoot, 'docs', 'archive')]
  let active = 0
  let archived = 0
  const seen = new Set()
  for (const dir of dirs) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!SPEC_FILE_RE.test(name)) continue
      const abs = path.join(dir, name)
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
      if (seen.has(rel)) continue
      seen.add(rel)
      const text = readText(abs, 1024 * 1024)
      const inArchiveDir = rel.startsWith('docs/archive/')
      if (inArchiveDir || isArchivedSpecText(text ?? '')) archived += 1
      else active += 1
    }
  }
  return { active, archived }
}

/**
 * アクティブ（非アーカイブ）な SPEC 間で重複しているバッチ ID を集める（Layer 1 / D91）。
 *
 * `docs/archive/` 配下と `- **Status**: archived` の SPEC は数えない（退避済みの履歴は
 * 衝突しても害が無い）。同じファイル内の重複（目次からの再掲）も 1 件として扱う。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @returns {Array<{batchId: string, files: string[]}>} 重複 ID（ファイル数の多い順・ID 昇順）
 */
export function duplicateBatchIds(repoRoot) {
  const dirs = [repoRoot, path.join(repoRoot, 'docs'), path.join(repoRoot, 'docs', 'archive')]
  const seen = new Set()
  /** @type {Map<string, Set<string>>} */
  const byId = new Map()
  for (const dir of dirs) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!SPEC_FILE_RE.test(name)) continue
      const abs = path.join(dir, name)
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
      if (seen.has(rel)) continue
      seen.add(rel)
      if (rel.startsWith('docs/archive/')) continue
      const text = readText(abs, 1024 * 1024)
      if (text === null || isArchivedSpecText(text)) continue
      const own = new Set()
      for (const line of text.split(/\r?\n/)) {
        const m = BATCH_HEADING_RE.exec(line)
        if (m && !own.has(m[1])) own.add(m[1])
      }
      for (const id of own) {
        if (!byId.has(id)) byId.set(id, new Set())
        byId.get(id).add(rel)
      }
    }
  }
  return [...byId.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([batchId, files]) => ({ batchId, files: [...files].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.batchId.localeCompare(b.batchId))
}

/**
 * `.hermes-coherence.json`（Layer 2）を読む。無ければ `null`（＝ Layer 2 無効）。
 *
 * **境界検証**: 64KB 超・JSON 不正・配列/オブジェクト以外は無効として扱い、
 * 例外は投げない（診断で本体を落とさない）。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @returns {{raw: object, ignoreGlobs: string[], maxLines: number|null, hotspotDays: number|null,
 *            hotspotTouches: number|null, baselineFile: string|null, forbiddenPatterns: Array<object>,
 *            checker: string|null} | null} 正規化した設定
 */
export function readRepoConfig(repoRoot) {
  const file = path.join(repoRoot, '.hermes-coherence.json')
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > CONFIG_MAX_BYTES) return null
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  return {
    raw,
    ignoreGlobs: Array.isArray(raw.ignoreGlobs) ? raw.ignoreGlobs.filter((g) => typeof g === 'string') : [],
    maxLines: num(raw.maxLines),
    hotspotDays: num(raw.hotspotDays),
    hotspotTouches: num(raw.hotspotTouches),
    baselineFile: typeof raw.baselineFile === 'string' ? raw.baselineFile : null,
    forbiddenPatterns: Array.isArray(raw.forbiddenPatterns) ? raw.forbiddenPatterns.filter((p) => p && typeof p === 'object') : [],
    checker: typeof raw.checker === 'string' ? raw.checker : null,
  }
}

/**
 * リポジトリ境界内の相対パスを解決する（`..`・絶対パス・リポジトリ外は拒否）。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @param {string} rel 設定に書かれた相対パス
 * @returns {string|null} 解決した絶対パス（不正は null）
 */
export function resolveInsideRepo(repoRoot, rel) {
  const value = String(rel ?? '').trim()
  if (!value || path.isAbsolute(value)) return null
  if (value.split(/[\\/]/).includes('..')) return null
  const root = path.resolve(repoRoot)
  const abs = path.resolve(root, value)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

/** ラチェット基準（`baselineFile`）を読む。無ければ空。 */
function readBaseline(repoRoot, baselineFile) {
  if (!baselineFile) return {}
  const abs = resolveInsideRepo(repoRoot, baselineFile)
  if (!abs) return {}
  const text = readText(abs, CONFIG_MAX_BYTES)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    const files = parsed?.files && typeof parsed.files === 'object' ? parsed.files : parsed
    const out = {}
    for (const [key, value] of Object.entries(files ?? {})) {
      if (Number.isFinite(Number(value))) out[key] = Number(value)
    }
    return out
  } catch {
    return {}
  }
}

/**
 * リポジトリ固有チェッカー（Layer 2）を安全に実行する。
 *
 * `execFile(process.execPath, [checker, '--json'], { cwd: repoRoot, shell: false })` のみ許可する。
 * 失敗・タイムアウト・JSON 不正は `softSignals` に落として本体を守る。
 *
 * D102 の対象外: これは node チェッカー自身の起動で、失敗は soft signal（`null` が仕様）として
 * 扱う。`lib/cli.js` の `ok` に寄せると「チェッカーが落ちた」と「違反がある」の区別が壊れるため、
 * ここだけは独自の戻り値（`{ok, hardFails, softSignals}`）を保つ。
 *
 * @param {string} repoRoot リポジトリの絶対パス
 * @param {string} rel 設定に書かれた相対パス
 * @returns {Promise<{ok: boolean, hardFails: object[], softSignals: object[]}>} 実行結果
 */
/** チェッカー起動時に渡す最小環境変数（ブリッジの環境変数を丸ごと渡さない）。 */
export function minimalCheckerEnv(baseEnv = process.env) {
  const out = {}
  for (const key of ['PATH', 'HOME', 'LANG']) {
    if (baseEnv?.[key] != null) out[key] = String(baseEnv[key])
  }
  return out
}

export function runRepoChecker(repoRoot, rel) {
  const abs = resolveInsideRepo(repoRoot, rel)
  const ext = abs ? path.extname(abs).toLowerCase() : ''
  const soft = (message) => ({ ok: false, hardFails: [], softSignals: [{ rule: 'repo-checker', severity: 'soft', message }] })
  if (!abs || !['.mjs', '.js', '.cjs'].includes(ext)) return Promise.resolve(soft(`checker must be a relative .mjs/.js file: ${rel}`))
  if (!fs.existsSync(abs)) return Promise.resolve(soft(`checker not found: ${rel}`))
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [abs, '--json'],
      { cwd: repoRoot, shell: false, env: minimalCheckerEnv(), timeout: CHECKER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(soft(`checker failed: ${String(err.message ?? err).slice(0, 200)}`))
        let parsed
        try {
          parsed = JSON.parse(String(stdout ?? ''))
        } catch {
          return resolve(soft('checker output is not valid JSON'))
        }
        const pick = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : [])
        resolve({ ok: true, hardFails: pick(parsed?.hardFails), softSignals: pick(parsed?.softSignals) })
      },
    )
  })
}

/** 推奨スイープ（`coherenceSweep.js` の 5 プリセット名）。 */
function recommendSweep({ hardFails, bloat, hotspots, sprawl }) {
  if (hardFails.length) return 'contracts'
  if (sprawl) return 'docs-specs'
  if (bloat.length || hotspots.length) return 'hotspots'
  return null
}

/**
 * コヒーレンス診断を実行する（読み取り専用）。
 *
 * @param {string} repoRoot 対象リポジトリの絶対パス
 * @param {{maxLines?: number, hotspotDays?: number, hotspotTouches?: number, specSprawlLimit?: number,
 *          debtSpikeLimit?: number, gitHotspots?: Function, now?: number, withRepoConfig?: boolean}} [opts]
 *        上書き（テストの差し替え用。`gitHotspots` は関数を注入できる）
 * @returns {Promise<object>} SPEC-COHERENCE §3.3.1 の出力契約
 */
export async function analyzeCoherence(repoRoot, opts = {}) {
  const root = path.resolve(String(repoRoot ?? '.'))
  const cfg = opts.withRepoConfig === false ? null : readRepoConfig(root)
  const maxLines = Number(opts.maxLines ?? cfg?.maxLines ?? UNIVERSAL_DEFAULTS.maxLines)
  const hotspotDays = Number(opts.hotspotDays ?? cfg?.hotspotDays ?? UNIVERSAL_DEFAULTS.hotspotDays)
  const hotspotTouches = Number(opts.hotspotTouches ?? cfg?.hotspotTouches ?? UNIVERSAL_DEFAULTS.hotspotTouches)
  const specSprawlLimit = Number(opts.specSprawlLimit ?? UNIVERSAL_DEFAULTS.specSprawlLimit)
  const debtSpikeLimit = Number(opts.debtSpikeLimit ?? UNIVERSAL_DEFAULTS.debtSpikeLimit)
  const baseline = readBaseline(root, cfg?.baselineFile)
  const ignoreGlobs = cfg?.ignoreGlobs ?? []
  const ignoreRes = ignoreGlobs.map(globToRegExp)

  /** @type {Array<object>} */
  const hardFails = []
  /** @type {Array<object>} */
  const softSignals = []

  /* --- Layer 1: file-bloat（言語非依存・ラチェット対応） --- */
  const files = listSourceFiles(root, { ignoreGlobs })
  const bloat = []
  for (const { rel, abs } of files) {
    const text = readText(abs)
    if (text === null) continue
    const lines = countLines(text)
    const limit = baseline[rel] ?? maxLines
    if (lines > limit) bloat.push({ file: rel, lines, limit })
  }
  bloat.sort((a, b) => b.lines - a.lines)
  for (const item of bloat.slice(0, 20)) {
    softSignals.push({
      rule: 'file-bloat',
      severity: 'soft',
      message: `${item.file} is ${item.lines} lines (limit ${item.limit})`,
      file: item.file,
      value: item.lines,
      limit: item.limit,
    })
  }

  /* --- Layer 1: git-hotspot（`.git` 不在は空配列で安全スキップ） --- */
  const gitFn = typeof opts.gitHotspots === 'function' ? opts.gitHotspots : gitHotspots
  let touchList = []
  try {
    touchList = await gitFn(root, { days: hotspotDays })
  } catch {
    touchList = []
  }
  const lineMap = new Map(files.map((f) => [f.rel, null]))
  const hotspots = []
  for (const item of Array.isArray(touchList) ? touchList : []) {
    const normRel = String(item?.file ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normRel || item.touches < hotspotTouches) continue
    if (ignoreRes.some((re) => re.test(normRel))) continue
    let lines = lineMap.get(normRel)
    if (lines === undefined) lines = null
    if (lines === null) {
      const text = readText(path.join(root, normRel))
      // Ignore deleted historical files so git-hotspot reflects live files only
      if (text === null) continue
      lines = countLines(text)
      lineMap.set(normRel, lines)
    }
    hotspots.push({ file: normRel, touches: item.touches, lines })
  }
  hotspots.sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file))
  for (const item of hotspots.slice(0, 20)) {
    softSignals.push({
      rule: 'git-hotspot',
      severity: 'soft',
      message: `${item.file} changed ${item.touches} times in ${hotspotDays} days`,
      file: item.file,
      value: item.touches,
      limit: hotspotTouches,
    })
  }

  /* --- Layer 1: spec-sprawl（アクティブ SPEC の数） --- */
  const specCounts = countSpecs(root)
  if (specCounts.active > specSprawlLimit) {
    softSignals.push({
      rule: 'spec-sprawl',
      severity: 'soft',
      message: `${specCounts.active} active SPEC files (limit ${specSprawlLimit}); archive finished specs`,
      value: specCounts.active,
      limit: specSprawlLimit,
    })
  }

  /* --- Layer 1: duplicate-batch-id（アクティブ SPEC 間の ID 衝突。D91） --- */
  const duplicateBatches = duplicateBatchIds(root)
  for (const dup of duplicateBatches.slice(0, 20)) {
    softSignals.push({
      rule: 'duplicate-batch-id',
      severity: 'soft',
      message: `batch id ${dup.batchId} is used by ${dup.files.length} active SPEC files (${dup.files.join(', ')}); give each spec its own uppercase slug prefix`,
      batchId: dup.batchId,
      files: dup.files,
      value: dup.files.length,
    })
  }

  /* --- Layer 1: debt-spike（直近変更ファイルの TODO/FIXME/HACK 集中） --- */
  const debtTargets = [...new Set([...hotspots.map((h) => h.file), ...bloat.slice(0, 5).map((b) => b.file)])]
  let debtTotal = 0
  const debtFiles = []
  for (const rel of debtTargets.slice(0, 20)) {
    const text = readText(path.join(root, rel))
    if (text === null) continue
    const count = (text.match(DEBT_RE) ?? []).length
    if (!count) continue
    debtTotal += count
    debtFiles.push({ file: rel, count })
  }
  if (debtTotal >= debtSpikeLimit) {
    softSignals.push({
      rule: 'debt-spike',
      severity: 'soft',
      message: `${debtTotal} TODO/FIXME/HACK markers in recently changed files (limit ${debtSpikeLimit})`,
      value: debtTotal,
      limit: debtSpikeLimit,
      files: debtFiles.slice(0, 10),
    })
  }

  /* --- Layer 2: forbiddenPatterns（宣言型・Hard Fail） --- */
  let repoChecker = false
  for (const entry of cfg?.forbiddenPatterns ?? []) {
    const pattern = String(entry.pattern ?? '')
    if (!pattern) continue
    let re
    try {
      re = new RegExp(pattern)
    } catch {
      softSignals.push({ rule: 'forbidden-pattern', severity: 'soft', message: `invalid pattern: ${pattern}` })
      continue
    }
    const globs = Array.isArray(entry.files) && entry.files.length ? entry.files.map(globToRegExp) : null
    const except = Array.isArray(entry.ignore) && entry.ignore.length ? entry.ignore.map(globToRegExp) : null
    const hits = []
    for (const { rel, abs } of files) {
      if (globs && !globs.some((g) => g.test(rel))) continue
      if (except && except.some((g) => g.test(rel))) continue
      const text = readText(abs)
      if (text === null) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          hits.push({ file: rel, line: i + 1 })
          break
        }
      }
    }
    if (hits.length) {
      hardFails.push({
        rule: 'forbidden-pattern',
        severity: 'hard',
        message: entry.message ? String(entry.message) : `forbidden pattern "${pattern}" found in ${hits.length} file(s)`,
        pattern,
        files: hits.slice(0, 10),
      })
    }
  }

  /* --- Layer 2: repo checker（相対 .mjs/.js のみ・境界検証 + プラグイン管理の許可リスト必須） --- */
  let checkerApproval = { required: false, approved: false, checker: null, sha256: null }
  if (cfg?.checker) {
    const abs = resolveInsideRepo(root, cfg.checker)
    const ext = abs ? path.extname(abs).toLowerCase() : ''
    if (!abs || !['.mjs', '.js', '.cjs'].includes(ext) || !fs.existsSync(abs)) {
      const result = await runRepoChecker(root, cfg.checker)
      repoChecker = result.ok
      for (const issue of result.softSignals) softSignals.push({ ...issue, severity: 'soft' })
    } else {
      const sha256 = checkerSha256(abs)
      const allowlistPath = defaultAllowlistPath(opts)
      const approved = isCheckerApproved({ allowlistPath, repoRoot: root, rel: cfg.checker, sha256 })
      checkerApproval = { required: true, approved, checker: cfg.checker, sha256 }
      if (approved) {
        const result = await runRepoChecker(root, cfg.checker)
        repoChecker = result.ok
        for (const issue of result.hardFails) hardFails.push({ ...issue, severity: 'hard' })
        for (const issue of result.softSignals) softSignals.push({ ...issue, severity: 'soft' })
      } else {
        repoChecker = false
        softSignals.push({
          rule: 'repo-checker-approval',
          severity: 'soft',
          message: `repo checker "${cfg.checker}" requires explicit user approval before running`,
          checker: cfg.checker,
          sha256,
        })
      }
    }
  }

  return {
    ok: hardFails.length === 0,
    generatedAt: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString(),
    repoRoot: root,
    layers: { universal: true, repoConfig: Boolean(cfg), repoChecker },
    checkerApproval,
    hardFails,
    softSignals,
    hotspots: hotspots.slice(0, 20),
    summary: {
      hardFailCount: hardFails.length,
      softSignalCount: softSignals.length,
      hotspotCount: hotspots.length,
      activeSpecCount: specCounts.active,
      archivedSpecCount: specCounts.archived,
      duplicateBatchIdCount: duplicateBatches.length,
      deprecatedRoutes: 0,
    },
    recommendedSweep: recommendSweep({ hardFails, bloat, hotspots, sprawl: specCounts.active > specSprawlLimit }),
  }
}

/**
 * 予兆アラートの閾値判定（SPEC-COHERENCE §3.5 / D83）。自動起票はしない。
 *
 * @param {object} report `analyzeCoherence()` の出力
 * @returns {{alert: boolean, summary: object, highlights: string[], recommendedSweep: string|null, layers: object}}
 */
export function coherenceAlertFrom(report) {
  const summary = report?.summary ?? {}
  const hardFailCount = Number(summary.hardFailCount ?? 0)
  const softSignalCount = Number(summary.softSignalCount ?? 0)
  const hotspotCount = Number(summary.hotspotCount ?? 0)
  const alert = hardFailCount > 0 || hotspotCount >= 1 || softSignalCount >= 3
  const highlights = [...(report?.hardFails ?? []), ...(report?.softSignals ?? [])]
    .slice(0, 5)
    .map((issue) => String(issue?.message ?? issue?.rule ?? ''))
    .filter(Boolean)
  return {
    alert,
    summary: { hardFailCount, softSignalCount, hotspotCount },
    highlights,
    recommendedSweep: report?.recommendedSweep ?? null,
    layers: report?.layers ?? { universal: true, repoConfig: false, repoChecker: false },
  }
}
