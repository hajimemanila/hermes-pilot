import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

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

/** 走査するディレクトリ（リポジトリ直下と `docs/`）。 */
export const SPEC_DIRS = ['docs', '']

/** ファイル名の規則（`SPEC*.md`。大文字小文字は問わない）。 */
export const SPEC_FILE_RE = /^SPEC.*\.md$/i

/** バッチ ID の規則（英字始まり・16 文字まで）。`### 1.1 見出し` のような番号見出しを拾わない。 */
export const BATCH_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/

/** 完了してよい状態（これ以外を「未完了」とみなして重複起票を止める）。 */
export const CLOSED_STATUSES = new Set(['done', 'archived'])

/** タスク本文の上限（カンバン側の実用上限に合わせる）。 */
export const BODY_MAX = 6000

/**
 * 起票元チャット ID の書式（`Chat:` 行に載せる値）。
 * セッション ID・`local-…`・`__latest__` を通しつつ、改行や空白は弾く（本文を壊さない）。
 */
export const SPEC_CHAT_RE = /^[A-Za-z0-9_.:-]{1,128}$/

/** `pipeline-runs.json` に保持するランの上限（古い完了分から剪定する）。 */
export const RUNS_MAX = 50

/** `### Batch <ID>: <Title>` / `### <ID>: <Title>`。 */
const BATCH_HEADING_RE = /^###\s+(?:Batch\s+)?([A-Za-z][A-Za-z0-9._-]{0,15})\s*[:：]\s*(.+?)\s*$/

/** セクションの終わり（レベル 1〜3 の見出し。`####` はバッチ内の小見出しなので含める）。 */
const SECTION_END_RE = /^#{1,3}\s/

/** 目的の行（`- **目的**: …` / `**Objective**: …`）。 */
const OBJECTIVE_RE = /^[-*]?\s*\*\*\s*(?:目的|Objective)\s*\*\*\s*[:：]\s*(.+)$/i

/**
 * 実行モード宣言の行（`- **Execution Mode**: `[Mode: Zero-Stop]`` / `- **実行モード**: [Mode: …]`）。
 * バックティック・角括弧・`Mode:` 前置・大小文字をすべて許容する。
 */
export const EXECUTION_MODE_RE =
  /^[-*]?\s*\*\*\s*(?:Execution\s*Mode|実行モード)\s*\*\*\s*[:：]\s*[`\s]*\[?\s*(?:Mode\s*[:：]\s*)?(Zero-Stop|Fast-Track\s*Review|Visual\s*Gate)/im

/** 正規化した実行モード（`batch.mode` に入る値）。 */
export const EXECUTION_MODES = ['zero-stop', 'fast-track-review', 'visual-gate']

/**
 * 実行モード表記を正規化する（未知の値・未宣言は `null`）。
 *
 * @param {unknown} raw `Zero-Stop` / `[Mode: Visual Gate]` / `visual-gate` など
 * @returns {'zero-stop'|'fast-track-review'|'visual-gate'|null} 正規化したモード
 */
export function normalizeExecutionMode(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    // `[Mode: Visual Gate]` のような生の宣言もそのまま受けられるように前置を落とす
    .replace(/mode\s*[:：]/g, ' ')
    .replace(/[^a-z-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!s) return null
  if (s === 'zero-stop' || s === 'zerostop' || s === 'zero') return 'zero-stop'
  if (s === 'fast-track-review' || s === 'fast-track' || s === 'fasttrack-review') return 'fast-track-review'
  if (s === 'visual-gate' || s === 'visualgate' || s === 'visual') return 'visual-gate'
  return null
}

/**
 * バッチ本文から実行モードを読む（未宣言は `null`＝後方互換）。
 *
 * @param {string[]|string} section バッチ本文の行（または本文）
 * @returns {'zero-stop'|'fast-track-review'|'visual-gate'|null} モード
 */
export function extractExecutionMode(section) {
  const text = Array.isArray(section) ? section.join('\n') : String(section ?? '')
  const m = EXECUTION_MODE_RE.exec(text)
  return m ? normalizeExecutionMode(m[1]) : null
}

/** 行動契約ブロックの見出し（本文中で一意）。 */
export const CONTRACT_HEADER = '[Hermes Pilot Execution Contract]'

/** モード別の行動契約（`buildTaskBody` が本文末尾へ注入する）。 */
export const MODE_CONTRACTS = {
  'zero-stop': [
    '- Do not ask confirmation questions in chat.',
    '- Repair autonomously until `npm run verify` (tests, build, checks) passes, then mark the task done.',
    '- Only when a design contradiction is unresolvable, file a `quick-review` sheet and block on it.',
  ],
  'fast-track-review': [
    '- If the change forces a choice between options, file a `quick-review` sheet (each question with `recommended: true`) before implementing, and wait for the 1-tap approval.',
    '- Everything else proceeds without asking: implement, run `npm run verify`, then mark the task done.',
  ],
  'visual-gate': [
    '- After implementing, run `npm run deploy` and verify the real screen at `390×844` and `820×1180`; capture the screenshots.',
    '- If the rendered result differs from the intent, file an `annotation` review (screenshot + marks) and wait for it.',
    '- `npm run verify` must pass before you mark the task done.',
  ],
}

/**
 * モード別の行動契約ブロック（`[Hermes Pilot Execution Contract]`）を組み立てる。
 *
 * @param {string} mode 正規化済みモード
 * @returns {string} 本文末尾に足すブロック（未知モードは空文字）
 */
export function buildExecutionContract(mode) {
  const key = normalizeExecutionMode(mode)
  if (!key) return ''
  const rules = MODE_CONTRACTS[key] ?? []
  return [
    '',
    CONTRACT_HEADER,
    '',
    `Mode: ${key}`,
    '',
    'This task was filed by the Hermes Pilot Spec Launchpad. The contract below overrides any habit of asking first.',
    ...rules,
    '- Finish with a short report: what changed, the verification command and its exit code, and what is still unverified.',
  ].join('\n')
}

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
      out.push({
        path: rel,
        title: parsed.title || name.replace(/\.md$/i, ''),
        mtime: Number(st?.mtimeMs ?? st?.mtime ?? 0),
        batches: parsed.batches,
        valid: parsed.valid,
      })
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
}

/**
 * 起票するタスクのタイトル（`[<BatchID>] <BatchTitle>`）。
 * @param {{id: string, title: string}} batch バッチ
 * @returns {string} タイトル
 */
export function buildTaskTitle(batch) {
  return `[${batch?.id ?? ''}] ${batch?.title ?? ''}`.trim().slice(0, 200)
}

/**
 * 起票するタスクの本文（spec パス・target・抜粋・受入条件）。
 *
 * @param {{specRelPath: string, repoPath: string, board: string, batch: {id: string, title: string, objective: string, section: string}, chat?: string}} input 入力
 * @returns {string} 本文
 */
export function buildTaskBody({ specRelPath, repoPath, board, batch, chat }) {
  const chatId = sanitizeSpecChat(chat)
  const mode = normalizeExecutionMode(batch?.mode)
  const head = [
    `Spec: ${specRelPath}`,
    `Target: ${repoPath}`,
    `Board: ${board}`,
    `Batch: ${batch?.id ?? ''} — ${batch?.title ?? ''}`,
    ...(chatId ? [`Chat: ${chatId}`] : []),
    ...(mode ? [`Mode: ${mode}`] : []),
    '',
    '## 目的',
    '',
    batch?.objective || '（バッチ本文の抜粋を参照）',
    '',
    '## 抜粋（受入条件 / Verify を含む）',
    '',
  ].join('\n')
  // 契約ブロックは**末尾に必ず残す**（抜粋だけを切り詰める）。6000 字上限で契約が消えると
  // 自走の保証が壊れるため、順序は「見出し → 抜粋 → 契約」で固定する。
  const contract = buildExecutionContract(mode)
  const room = Math.max(0, BODY_MAX - head.length - contract.length)
  const section = String(batch?.section ?? '').slice(0, room)
  return `${head}${section}${contract}`.slice(0, BODY_MAX)
}

/**
 * 既存タスクの中に同じバッチの未完了タスクがあるか。
 *
 * @param {Array<{title?: string, status?: string, id?: string}>} tasks 同じボードのタスク
 * @param {string} batchId バッチ ID
 * @returns {{id: string, title: string, status: string}|null} 見つかった未完了タスク
 */
export function findOpenBatchTask(tasks, batchId) {
  const want = `[${String(batchId ?? '').trim()}]`
  if (!want || want === '[]') return null
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t) continue
    if (CLOSED_STATUSES.has(String(t.status ?? ''))) continue
    if (!String(t.title ?? '').trim().startsWith(want)) continue
    return { id: String(t.id ?? ''), title: String(t.title ?? ''), status: String(t.status ?? '') }
  }
  return null
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
  if (!rel) throw Object.assign(new Error('spec のパスがありません'), { statusCode: 400 })
  if (path.isAbsolute(rel)) throw Object.assign(new Error('spec はリポジトリからの相対パスで指定してください'), { statusCode: 400 })
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error('spec がリポジトリの外を指しています'), { statusCode: 400 })
  }
  return abs
}

/**
 * 起票元チャット ID をサニタイズする（書式に合わなければ空＝`Chat:` 行を書かない）。
 *
 * @param {unknown} raw 入力（セッション ID 等）
 * @returns {string} 安全な ID（無効なら空文字）
 */
export function sanitizeSpecChat(raw) {
  const s = String(raw ?? '').trim()
  return SPEC_CHAT_RE.test(s) ? s : ''
}

/**
 * `pipeline-runs.json` のパス（レビューディレクトリ配下。`review-watcher` と同じ解決規則）。
 *
 * @param {object} cfg ブリッジ設定（`reviewDir` / `pluginDataDir` / `kanbanRoot`）
 * @returns {string} 絶対パス
 */
export function runsPathFor(cfg = {}) {
  const root =
    cfg.reviewDir ??
    path.join(
      cfg.pluginDataDir ?? path.join(cfg.kanbanRoot ?? '.', '..', 'plugin-data', 'hermes-pilot'),
      'review',
    )
  return path.join(root, 'pipeline-runs.json')
}

/**
 * ラン記録を読む（壊れていても空。補助情報なので落とさない）。
 *
 * @param {string} file パス
 * @returns {Array<object>} ラン（新しい順は保証しない）
 */
export function readRuns(file) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const j = JSON.parse(raw)
    const list = Array.isArray(j) ? j : j?.runs
    if (!Array.isArray(list)) return []
    return list.filter((r) => r && typeof r === 'object' && String(r.id ?? '').trim())
  } catch {
    return []
  }
}

/**
 * 上限まで剪定する（**古い完了分から**落とす。未報告ランは最後まで残す）。
 *
 * @param {Array<object>} runs ラン
 * @param {number} [max] 上限（既定 50）
 * @returns {Array<object>} 剪定後（元の順序を保つ）
 */
export function pruneRuns(runs, max = RUNS_MAX) {
  const list = Array.isArray(runs) ? runs.slice() : []
  let over = list.length - Math.max(0, Number(max) || 0)
  if (over <= 0) return list
  const byAge = list.slice().sort((a, b) => Number(a?.createdAt ?? 0) - Number(b?.createdAt ?? 0))
  const drop = new Set()
  for (const r of byAge) {
    if (over <= 0) break
    if (!r?.reportedAt) continue
    drop.add(r)
    over -= 1
  }
  for (const r of byAge) {
    if (over <= 0) break
    if (drop.has(r)) continue
    drop.add(r)
    over -= 1
  }
  return list.filter((r) => !drop.has(r))
}

/**
 * ラン記録を `.tmp` → `renameSync` でアトミックに書く。
 *
 * @param {string} file パス
 * @param {Array<object>} runs ラン
 * @returns {void}
 */
export function writeRuns(file, runs) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: pruneRuns(runs) }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * ランを 1 件追記する（同じ ID は置き換え）。
 *
 * @param {object} cfg ブリッジ設定
 * @param {object} run ラン
 * @returns {Array<object>} 書いた内容
 */
export function appendRun(cfg, run) {
  const file = runsPathFor(cfg)
  const runs = readRuns(file)
  const next = [...runs.filter((r) => r.id !== run.id), run]
  writeRuns(file, next)
  return pruneRuns(next)
}

/**
 * ランの ID（`run_<UTC 秒>_<乱数 4>`）。同じ秒に 2 回落としても衝突しない。
 * @param {number} [ms] epoch ms
 * @returns {string} ID
 */
export function makeRunId(ms = Date.now()) {
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const tail = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `run_${stamp}_${tail}`
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
  return (args) =>
    new Promise((resolve) => {
      execFile(
        cfg.hermesBin ?? 'hermes',
        args,
        { timeout: 30_000, maxBuffer: 2_000_000, env: { ...process.env } },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    })
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
 * @returns {{listSpecs: Function, launchSpec: Function, resolveSpecPath: Function}} 操作
 */
export function createSpecs(cfg = {}, deps = {}) {
  const run = defaultRunner(cfg, deps.runner)
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
      return { ok: false, created: [], skipped: [], failed: [], error: 'ボード名が不正です' }
    }
    const repoPath = String(input.repoPath ?? '').trim()
    if (!repoPath || !path.isAbsolute(repoPath)) {
      return { ok: false, created: [], skipped: [], failed: [], error: 'リポジトリのパスが不正です' }
    }
    const specRelPath = String(input.specRelPath ?? '').trim()
    let file = ''
    try {
      file = resolveSpecPath(repoPath, specRelPath)
    } catch (e) {
      return { ok: false, created: [], skipped: [], failed: [], error: e.message }
    }

    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return { ok: false, created: [], skipped: [], failed: [], error: `spec を読めません: ${specRelPath}` }
    }
    const parsed = parseSpec(text)
    if (!parsed.batches.length) {
      return { ok: false, created: [], skipped: [], failed: [], error: 'バッチ見出し（### Batch <ID>: <Title>）が見つかりません' }
    }

    const wanted = Array.isArray(input.batchIds) ? new Set(input.batchIds.map((x) => String(x ?? '').trim())) : null
    const batches = parsed.batches.filter((b) => !wanted || wanted.size === 0 || wanted.has(b.id))
    if (!batches.length) {
      return { ok: false, created: [], skipped: [], failed: [], error: '選択したバッチが spec にありません' }
    }

    const assignee = String(input.assignee ?? '').trim()
    const dryRun = Boolean(input.dryRun)
    // 起票元チャット（`Chat:` 行＋ラン記録の originSessionId）。書式外は黙って捨てる。
    const chat = sanitizeSpecChat(input.chat)

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
      const open = findOpenBatchTask(existing, batch.id)
      if (open) {
        skipped.push({ id: batch.id, title: batch.title, reason: 'exists', taskId: open.id, status: open.status })
        continue
      }
      const title = buildTaskTitle(batch)
      const body = buildTaskBody({ specRelPath, repoPath, board, batch, chat })
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
          error: (res.stderr || res.stdout || 'kanban create に失敗しました').trim().slice(0, 400),
        })
        continue
      }
      const task = parseCreatedTask(res.stdout)
      if (!task?.id) {
        failed.push({ id: batch.id, title, error: 'タスクIDを取得できませんでした' })
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

  return { listSpecs: scan, launchSpec, resolveSpecPath }
}
