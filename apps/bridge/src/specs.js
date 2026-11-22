import fs from 'node:fs'
import path from 'node:path'
import { ApiError } from './api-errors.js'
import { outcomeOf, runHermes } from './lib/cli.js'
import { DEFAULT_LANG, normalizeLang } from './lang.js'
import { writeFileAtomic } from './lib/atomic.js'
import { CLOSED_STATUSES, extractExecutionMode, extractRecommendedRole } from './specs/mode.js'
import { buildTaskBody, buildTaskTitle, findOpenBatchTask, sanitizeSpecChat } from './specs/task-body.js'
import { appendRun, makeRunId } from './specs/runs.js'

/*
 * 分割したモジュールの再エクスポート。`./specs.js` からの import 契約は 1 つも変えない
 * （呼び出し側 = `server.js` / `architect.js` / テストは従来どおりこのファイルだけを見る）。
 */
export {
  ABSTRACT_ROLES,
  BODY_MAX,
  CLOSED_STATUSES,
  CONTRACT_HEADER,
  EXECUTION_MODE_RE,
  MODE_CONTRACTS,
  RECOMMENDED_ROLE_RE,
  buildExecutionContract,
  extractExecutionMode,
  extractRecommendedRole,
  normalizeExecutionMode,
  normalizeRecommendedRole,
} from './specs/mode.js'
export {
  SPEC_CHAT_RE,
  SPEC_MTIME_SLACK_MS,
  bodyHeadings,
  buildTaskBody,
  buildTaskTitle,
  extractTaskSpec,
  findOpenBatchTask,
  normalizeSpecRelPath,
  sanitizeSpecChat,
  taskStampMs,
} from './specs/task-body.js'
export {
  RUNS_MAX,
  appendRun,
  attachRunTaskIds,
  makeRunId,
  pruneRuns,
  readRuns,
  runTaskIdsForSpec,
  runsPathFor,
  writeRuns,
} from './specs/runs.js'

/**
 * Spec Launchpad — `docs/SPEC-*.md` を検出し、バッチ見出しをカンバンへ一括起票する。
 *
 * 読み取りは**プレーンなファイル走査だけ**（カンバン DB は触らない）。起票は
 * 正規コマンド `hermes kanban create` を実行する（カンバン DB に直接書かない。
 * 盤面のロック・イベント・通知の整合性は本体に任せる）。
 *
 * 冪等性: 同じボードに `[<BatchID>]` で始まる**未完了**タスクがあれば起票しない。
 * 二重タップ・再読み込み・再起動で同じバッチが積み上がらないようにするための規則。
 */

/** 走査するディレクトリ（リポジトリ直下・`docs/`・アーカイブ置き場）。 */
export const SPEC_DIRS = ['docs', 'docs/archive', '']

/** ファイル名の規則（`SPEC*.md`。大文字小文字は問わない）。 */
export const SPEC_FILE_RE = /^SPEC.*\.md$/i

/** バッチ ID の規則（英字始まり・16 文字まで）。`### 1.1 見出し` のような番号見出しを拾わない。 */
export const BATCH_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/

/**
 * SPEC のアーカイブ宣言（`- **Status**: archived` / `- **状態**: アーカイブ`）。
 * バックティック・大文字小文字・補足テキストを許容する。
 */
export const SPEC_ARCHIVED_RE = /^\s*[-*]?\s*\*\*\s*(?:Status|状態)\s*\*\*\s*[:：]\s*[`]?\s*(?:archived|アーカイブ)/i

/**
 * アーカイブ退避でメタデータ部へ挿入する 1 行（機械キーは ASCII のまま・D92 / D84）。
 * `extractSpecStatus()` が先頭 40 行で読む書式と 1:1 で対応させる。
 */
export const SPEC_ARCHIVE_LINE = '- **Status**: archived'
/** `### Batch <ID>: <Title>` / `### <ID>: <Title>`。 */
const BATCH_HEADING_RE = /^###\s+(?:Batch\s+)?([A-Za-z][A-Za-z0-9._-]{0,15})\s*[:：]\s*(.+?)\s*$/

/** セクションの終わり（レベル 1〜3 の見出し。`####` はバッチ内の小見出しなので含める）。 */
const SECTION_END_RE = /^#{1,3}\s/

/** 目的の行（`- **目的**: …` / `**Objective**: …`）。 */
const OBJECTIVE_RE = /^[-*]?\s*\*\*\s*(?:目的|Objective)\s*\*\*\s*[:：]\s*(.+)$/i
/** タイトル行（`# …`）。 */
const TITLE_RE = /^#\s+(.+?)\s*$/

/**
 * 仕様書 1 枚を解析してタイトルとバッチを返す（純粋関数）。
 *
 * @param {string} text Markdown
 * @returns {{title: string, batches: Array<{id: string, title: string, objective: string, section: string}>, valid: boolean}} 解析結果
 */
export function parseSpec(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let title = ''
  for (const line of lines) {
    const m = TITLE_RE.exec(line)
    if (m) {
      title = m[1]
      break
    }
  }

  /** @type {Array<{id: string, title: string, objective: string, section: string}>} */
  const batches = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = BATCH_HEADING_RE.exec(lines[i])
    if (!m || !BATCH_ID_RE.test(m[1])) continue
    // 同じ ID が 2 回出たら最初のものを採る（目次・参照の重複見出し対策）
    if (batches.some((b) => b.id === m[1])) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      if (SECTION_END_RE.test(lines[j])) {
        end = j
        break
      }
    }
    const body = lines.slice(i + 1, end)
    batches.push({
      id: m[1],
      title: m[2].trim(),
      objective: extractObjective(body),
      // 実行モード（未宣言の過去 SPEC は null＝後方互換）
      mode: extractExecutionMode(body),
      // 推奨ロール（未宣言は null。抽象ロール 4 つ以外も null に正規化する）
      recommendedRole: extractRecommendedRole(body),
      // 末尾の区切り線（`---`）は本文に含めない
      section: trimTrailingRule(body.join('\n')),
    })
  }

  return { title, batches, valid: Boolean(title) || batches.length > 0 }
}

/**
 * 抜粋から「目的」だけ取り出す。無ければ最初の意味のある行。
 * @param {string[]} lines セクションの行
 * @returns {string} 目的（無ければ空文字）
 */
function extractObjective(lines) {
  for (const line of lines) {
    const m = OBJECTIVE_RE.exec(line)
    if (m) return m[1].trim()
  }
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('|') || t === '---') continue
    return t.replace(/^[-*]\s*/, '').slice(0, 200)
  }
  return ''
}

/**
 * 末尾の区切り線と空行を落とす。
 * @param {string} text 本文
 * @returns {string} 整形後
 */
function trimTrailingRule(text) {
  const lines = String(text ?? '').split('\n')
  while (lines.length && (/^\s*$/.test(lines[lines.length - 1]) || /^\s*-{3,}\s*$/.test(lines[lines.length - 1]))) {
    lines.pop()
  }
  return lines.join('\n').trim()
}

/**
 * SPEC のアーカイブ宣言を読む（SPEC-COHERENCE §3.4 / D84）。
 *
 * 先頭 40 行の `- **Status**: archived` / `- **状態**: アーカイブ` を見る。本文の奥に書かれた
 * 過去の言及（「アーカイブ規約」等）を拾わないための行数制限。
 *
 * @param {string} text SPEC の全文
 * @returns {{archived: boolean, status: 'active'|'archived'}} 判定結果
 */
export function extractSpecStatus(text) {
  const head = String(text ?? '').split(/\r?\n/).slice(0, 40)
  const archived = head.some((line) => SPEC_ARCHIVED_RE.test(line))
  return { archived, status: archived ? 'archived' : 'active' }
}

/**
 * SPEC 一覧をアクティブ / アーカイブに分ける（Launchpad の `Show archived (N)` 用）。
 *
 * @param {Array<{archived?: boolean}>} list `listSpecs()` の戻り値
 * @returns {{active: Array<object>, archived: Array<object>}} 分割結果（順序は保つ）
 */
export function partitionSpecs(list) {
  const active = []
  const archived = []
  for (const spec of Array.isArray(list) ? list : []) {
    if (spec?.archived) archived.push(spec)
    else active.push(spec)
  }
  return { active, archived }
}

/**
 * リポジトリ内の SPEC を走査する。
 *
 * @param {string} repoPath リポジトリの絶対パス
 * @param {{readdir?: Function, stat?: Function, read?: Function}} [deps] 差し替え（テスト用）
 * @returns {Array<{path: string, title: string, mtime: number, batches: Array<object>, valid: boolean}>} mtime の新しい順
 */
export function listSpecs(repoPath, deps = {}) {
  const readdir = deps.readdir ?? ((dir) => fs.readdirSync(dir))
  const stat = deps.stat ?? ((file) => fs.statSync(file))
  const read = deps.read ?? ((file) => fs.readFileSync(file, 'utf8'))
  const root = path.resolve(String(repoPath ?? ''))
  if (!root) return []

  const out = []
  const seen = new Set()
  for (const dir of SPEC_DIRS) {
    const abs = dir ? path.join(root, dir) : root
    let names = []
    try {
      names = readdir(abs)
    } catch {
      continue
    }
    for (const name of names) {
      if (!SPEC_FILE_RE.test(name)) continue
      const file = path.join(abs, name)
      let st
      try {
        st = stat(file)
      } catch {
        continue
      }
      // ディレクトリ（`SPEC-dir.md/` のような変な名前）は無視する
      if (typeof st?.isFile === 'function' && !st.isFile()) continue
      const rel = path.relative(root, file).split(path.sep).join('/')
      if (seen.has(rel)) continue
      let text = ''
      try {
        text = String(read(file))
      } catch {
        continue
      }
      const parsed = parseSpec(text)
      seen.add(rel)
      // `docs/archive/` 配下は宣言なしでもアーカイブ（置き場を移すだけで完結する規約・D84）。
      const declared = extractSpecStatus(text)
      const status = rel.startsWith('docs/archive/') ? { archived: true, status: 'archived' } : declared
      out.push({
        path: rel,
        title: parsed.title || name.replace(/\.md$/i, ''),
        mtime: Number(st?.mtimeMs ?? st?.mtime ?? 0),
        archived: status.archived,
        status: status.status,
        batches: parsed.batches,
        valid: parsed.valid,
      })
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
}
/**
 * `repoPath` 配下に収まる形で相対パスを解決する（`../` で外へ出る指定は拒否）。
 *
 * @param {string} repoPath リポジトリの絶対パス
 * @param {string} relPath 相対パス
 * @returns {string} 絶対パス
 * @throws {Error} 不正なパス（statusCode 400）
 */
export function resolveSpecPath(repoPath, relPath) {
  const root = path.resolve(String(repoPath ?? ''))
  const rel = String(relPath ?? '').trim()
  if (!rel) throw new ApiError('SPEC_PATH_REQUIRED', {}, 400)
  if (path.isAbsolute(rel)) throw new ApiError('SPEC_PATH_NOT_RELATIVE', {}, 400)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ApiError('SPEC_PATH_OUTSIDE', {}, 400)
  }
  return abs
}

/** 本文取得の上限（256KB）。超えた分は切り詰め、`truncated: true` で知らせる。 */
export const SPEC_CONTENT_MAX = 256 * 1024

/** 本文として読める拡張子（`.md` のみ）。 */
const MARKDOWN_RE = /\.md$/i

/**
 * 1 枚の SPEC の全文を読む（リポジトリ境界内・`.md` のみ・256KB 上限）。
 *
 * パスの検証は `resolveSpecPath` に任せる（`../` や絶対パスは 400）。
 * 上限で切り詰めたときは `truncated: true` を立て、`markdown` は 256KB までに収める
 * （UTF-8 の途中で切れた 1 文字は落とす＝壊れた文字を混ぜない）。
 *
 * @param {string} repoPath リポジトリの絶対パス
 * @param {string} specRelPath リポジトリからの相対パス（`docs/SPEC-….md`）
 * @returns {{ok: true, path: string, title: string, mtime: number, batchCount: number, truncated: boolean, markdown: string, bytes: number}} 本文
 * @throws {ApiError} 不正パス（400）／非 `.md`（400）／未検出・読めない（404）
 */
export function readSpecContent(repoPath, specRelPath) {
  const rel = String(specRelPath ?? '').trim().split(path.sep).join('/')
  const abs = resolveSpecPath(repoPath, rel)
  if (!MARKDOWN_RE.test(abs)) throw new ApiError('SPEC_NOT_MARKDOWN', { path: rel }, 400)

  let st
  try {
    st = fs.statSync(abs)
  } catch {
    throw new ApiError('SPEC_READ_FAILED', { path: rel }, 404)
  }
  if (typeof st?.isFile === 'function' && !st.isFile()) {
    throw new ApiError('SPEC_READ_FAILED', { path: rel }, 404)
  }

  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    throw new ApiError('SPEC_READ_FAILED', { path: rel }, 404)
  }

  const truncated = buf.length > SPEC_CONTENT_MAX
  let markdown = (truncated ? buf.subarray(0, SPEC_CONTENT_MAX) : buf).toString('utf8')
  // 上限で切れた位置が UTF-8 の途中だと U+FFFD が末尾に残る。1 文字だけ落とす。
  if (truncated && markdown.endsWith('\uFFFD')) markdown = markdown.slice(0, -1)

  const parsed = parseSpec(markdown)
  const status = extractSpecStatus(markdown)
  return {
    ok: true,
    path: rel,
    title: parsed.title || path.basename(abs).replace(/\.md$/i, ''),
    mtime: Number(st?.mtimeMs ?? st?.mtime ?? 0),
    batchCount: parsed.batches.length,
    truncated,
    markdown,
    // 実際に返した本文のバイト数（PWA が「切り詰め」を出せるように）
    bytes: Buffer.byteLength(markdown, 'utf8'),
    // アーカイブ退避ボタンの表示判定（D92）。`docs/archive/` 配下も含めて宣言で判定する
    archived: status.archived,
    status: status.status,
  }
}

/**
 * SPEC を「ヘッダに `- **Status**: archived` を足す」だけで退避する（D92 / D84 互換）。
 *
 * ファイルは消さない・移動しない（パスを維持するので、起票済みタスクの `Spec:` 行も
 * 既存のリンクも壊れない）。書き込みは `.tmp` → `rename` のアトミック更新なので、
 * 途中で落ちても半端な SPEC が残らない。
 *
 * - 既にアーカイブ済み（先頭 40 行に宣言がある）なら `{ ok: true, noop: true }`（冪等）
 * - `../` などでリポジトリの外へ出る指定は 400、`SPEC*.md` 以外は 400
 *
 * @param {string} repoPath リポジトリの絶対パス
 * @param {string} specRelPath リポジトリからの相対パス（`docs/SPEC-….md`）
 * @returns {{ok: true, path: string, noop: boolean, archived: true, status: 'archived', insertedAt: number|null}} 結果
 * @throws {ApiError} 不正パス（400）／非 SPEC（400）／未検出・書けない（404・500）
 */
export function archiveSpec(repoPath, specRelPath) {
  const rel = String(specRelPath ?? '').trim().split(path.sep).join('/')
  const abs = resolveSpecPath(repoPath, rel)
  if (!SPEC_FILE_RE.test(path.basename(abs))) {
    throw new ApiError('SPEC_FILE_INVALID', { path: rel }, 400)
  }

  let st
  try {
    st = fs.statSync(abs)
  } catch {
    throw new ApiError('SPEC_READ_FAILED', { path: rel }, 404)
  }
  if (typeof st?.isFile === 'function' && !st.isFile()) {
    throw new ApiError('SPEC_READ_FAILED', { path: rel }, 404)
  }

  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    throw new ApiError('SPEC_READ_FAILED', { path: rel }, 404)
  }

  const declared = extractSpecStatus(text)
  if (declared.archived) {
    return { ok: true, path: rel, noop: true, archived: true, status: 'archived', insertedAt: null }
  }

  const lines = text.split(/\r?\n/)
  // 見出し（`# SPEC: …`）の直後へ入れる。見出しが無いファイルは先頭に入れる。
  // どちらも先頭 40 行の内側なので `extractSpecStatus()` が次回から読める。
  const headEnd = lines.findIndex((line, i) => i > 0 && line.trim() === '')
  const insertAt = lines.length && /^#\s/.test(lines[0]) ? Math.min(Math.max(headEnd + 1, 1), 39) : 0
  const next = [...lines.slice(0, insertAt), SPEC_ARCHIVE_LINE, ...lines.slice(insertAt)]

  try {
    writeFileAtomic(abs, next.join('\n'))
  } catch {
    throw new ApiError('SPEC_ARCHIVE_FAILED', { path: rel }, 500)
  }

  return { ok: true, path: rel, noop: false, archived: true, status: 'archived', insertedAt: insertAt }
}

/**
 * 起票の実行（既定は `hermes kanban create`、テストでは差し替え）。
 *
 * @param {object} cfg 設定（`hermesBin`）
 * @param {Function} [runner] 差し替え
 * @returns {Function} 実行関数
 */
function defaultRunner(cfg = {}, runner) {
  if (runner) return runner
  return (args) => runHermes(args, { bin: cfg.hermesBin, timeoutMs: 30_000, maxBuffer: 2_000_000 })
}

/**
 * `hermes kanban create` の出力からタスク ID を取り出す。
 * @param {string} stdout 標準出力
 * @returns {{id: string}|null} タスク（取れなければ null）
 */
export function parseCreatedTask(stdout) {
  const text = String(stdout ?? '')
  const at = text.indexOf('{')
  if (at >= 0) {
    try {
      const obj = JSON.parse(text.slice(at))
      if (obj?.id) return { id: String(obj.id), title: obj.title ?? null, status: obj.status ?? null }
    } catch {
      /* 下の正規表現へ */
    }
  }
  const m = /Created (t_[0-9a-zA-Z]+)/.exec(text)
  return m ? { id: m[1] } : null
}

/**
 * Spec Launchpad（読み取り ＋ 起票）。
 *
 * @param {object} cfg 設定（`hermesBin`）
 * @param {{
 *   runner?: Function,
 *   tasks?: (board: string) => Array<object>,
 *   listSpecs?: Function,
 *   recordRun?: (run: object) => void,
 *   now?: () => number,
 * }} [deps] 差し替え（テスト用）
 * @returns {{listSpecs: Function, launchSpec: Function, resolveSpecPath: Function, readSpecContent: Function}} 操作
 */
export function createSpecs(cfg = {}, deps = {}) {
  const runCli = defaultRunner(cfg, deps.runner)
  /** 注入された runner の戻り値も統一形へ揃える（旧 `{code,out}` を吸収・D102）。 */
  const run = async (args) => outcomeOf(await runCli(args))
  // 既存タスクの読み取り（サーバでは kanban.tasks を渡す。テストでは [] か一時 DB）
  const readTasks = deps.tasks ?? (() => [])
  const scan = deps.listSpecs ?? (() => [])
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  // ラン記録（既定は `review/pipeline-runs.json`。テストでは差し替え）。
  // 出力先が分からない cfg（テストの `{}` など）では何もしない（リポジトリを汚さない）。
  const canRecord = Boolean(cfg.reviewDir || cfg.pluginDataDir || cfg.kanbanRoot)
  const recordRun =
    deps.recordRun ?? (canRecord ? (r) => appendRun(cfg, r) : () => {})

  /**
   * バッチをカンバンへ一括起票する。
   *
   * @param {{
   *   repoPath: string,
   *   board: string,
   *   specRelPath: string,
   *   batchIds?: string[],
   *   assignee?: string,
   *   dryRun?: boolean,
   *   limit?: number,
   * }} input 入力
   * @returns {Promise<{ok: boolean, created: Array<object>, skipped: Array<object>, failed: Array<object>, spec?: string, board?: string, error?: string}>} 結果
   */
  async function launchSpec(input = {}) {
    const board = String(input.board ?? '').trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(board)) {
      return { ok: false, created: [], skipped: [], failed: [], code: 'BOARD_NAME_INVALID' }
    }
    const repoPath = String(input.repoPath ?? '').trim()
    if (!repoPath || !path.isAbsolute(repoPath)) {
      return { ok: false, created: [], skipped: [], failed: [], code: 'INVALID_REPO' }
    }
    const specRelPath = String(input.specRelPath ?? '').trim()
    let file = ''
    try {
      file = resolveSpecPath(repoPath, specRelPath)
    } catch (e) {
      return { ok: false, created: [], skipped: [], failed: [], code: e.code, params: e.params, error: e.message }
    }

    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return { ok: false, created: [], skipped: [], failed: [], code: 'SPEC_READ_FAILED', params: { path: specRelPath } }
    }
    // 無印レガシータスクの誤検知を避けるための基準時刻（D91）。
    let specMtime = 0
    try {
      specMtime = Number(fs.statSync(file).mtimeMs) || 0
    } catch {
      specMtime = 0
    }
    const parsed = parseSpec(text)
    if (!parsed.batches.length) {
      return { ok: false, created: [], skipped: [], failed: [], code: 'SPEC_BATCH_HEADING_MISSING' }
    }

    const wanted = Array.isArray(input.batchIds) ? new Set(input.batchIds.map((x) => String(x ?? '').trim())) : null
    const batches = parsed.batches.filter((b) => !wanted || wanted.size === 0 || wanted.has(b.id))
    if (!batches.length) {
      return { ok: false, created: [], skipped: [], failed: [], code: 'SPEC_BATCH_NOT_FOUND' }
    }

    const assignee = String(input.assignee ?? '').trim()
    const dryRun = Boolean(input.dryRun)
    // 起票元チャット（`Chat:` 行＋ラン記録の originSessionId）。書式外は黙って捨てる。
    const chat = sanitizeSpecChat(input.chat)
    // 本文の見出し言語（未指定は既定 `en`。§3.5）。散文だけが従い、機械キーは ASCII 固定。
    const lang = normalizeLang(input.lang) ?? DEFAULT_LANG

    let existing = []
    try {
      existing = readTasks(board) ?? []
    } catch {
      existing = []
    }

    const created = []
    const skipped = []
    const failed = []
    for (const batch of batches) {
      const open = findOpenBatchTask(existing, batch.id, specRelPath, { specMtime })
      if (open) {
        skipped.push({ id: batch.id, title: batch.title, reason: 'exists', taskId: open.id, status: open.status })
        continue
      }
      const title = buildTaskTitle(batch)
      const body = buildTaskBody({ specRelPath, repoPath, board, batch, chat, lang })
      if (dryRun) {
        created.push({ id: batch.id, title, taskId: null, dryRun: true })
        continue
      }
      const args = ['kanban', '--board', board, 'create', title, '--json', '--body', body]
      if (assignee) args.push('--assignee', assignee)
      const res = await run(args)
      if (res.code !== 0) {
        failed.push({
          id: batch.id,
          title,
          code: 'CREATE_FAILED',
          error: (res.stderr || res.stdout || '').trim().slice(0, 400),
        })
        continue
      }
      const task = parseCreatedTask(res.stdout)
      if (!task?.id) {
        failed.push({ id: batch.id, title, code: 'TASK_ID_MISSING' })
        continue
      }
      created.push({ id: batch.id, title, taskId: task.id, status: task.status ?? 'ready' })
      // 同じバッチを 2 回起票しないよう、今回作った分も既存扱いにする
      existing = [...existing, { id: task.id, title, status: task.status ?? 'ready' }]
    }

    const ok = failed.length === 0

    // ラン記録（1 件以上起票 or 既存へ紐づけできたときだけ）。記録失敗で起票を失敗させない。
    let runRecord = null
    if (!dryRun && (created.length > 0 || skipped.length > 0)) {
      const taskIds = [...created.map((c) => c.taskId), ...skipped.map((s) => s.taskId)].filter(Boolean)
      runRecord = {
        id: makeRunId(now()),
        board,
        repoPath,
        specRelPath,
        title: parsed.title || specRelPath,
        batchIds: batches.map((b) => b.id),
        taskIds: [...new Set(taskIds)],
        originSessionId: chat || null,
        createdAt: now(),
        reportedAt: null,
      }
      try {
        recordRun(runRecord)
      } catch {
        runRecord = null
      }
    }

    return {
      ok,
      spec: specRelPath,
      board,
      created,
      skipped,
      failed,
      runId: runRecord?.id ?? null,
      ...(ok ? {} : { error: failed.map((f) => `${f.id}: ${f.error}`).join(' / ') }),
    }
  }

  return { listSpecs: scan, launchSpec, resolveSpecPath, readSpecContent }
}
