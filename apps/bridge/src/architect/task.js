/**
 * `[ARCH]` タスクの組み立てと、ジョブ↔タスク／SPEC の照合。`architect.js` から分割。
 * 公開契約は `architect.js` の再エクスポートで維持する。
 */
import fs from 'node:fs'
import path from 'node:path'
import { taskStampMs } from '../specs.js'
import { parseReviewLine, sheetPaths } from '../review/parse.js'
import { DEFAULT_LANG } from '../lang.js'
import { isJaLang, languageRule } from '../language-rule.js'
import { DEFAULT_EXECUTION_POLICY, DEFAULT_REVIEW_BOARD, SPEC_MTIME_SLACK_MS, TERMINAL_TASK_STATUSES, executionPolicyLines, normalizeExecutionPolicy } from './labels.js'
import { round2Headings, suggestSpecSlug } from './seed.js'
import { batchIdPrefixForSlug, queueStateOf, reviewBoardsFor } from './batch.js'

/**
 * [`[ARCH]` タスクの本文]（spec-architect プロトコル＋実行契約）。
 *
 * カンバン起票に載せるので、ワーカーが**チャットを見なくても**完走できる内容にする。
 * `executionPolicy` は**生成する SPEC の各バッチ**に付す既定 Execution Mode を決める
 * （Architect 自身は止まらずに書き切るので、この本文の契約は常に zero-stop）。
 *
 * SPEC V11 D54: `suggestedSlug` / `existingSpecs` を渡すと、ファイル名の衝突回避と
 * Round 1 の探索コスト削減の指示が本文に入る。
 *
 * @param {{prompt: string, board: string, repoPath: string, jobId: string, executionPolicy?: string, suggestedSlug?: string, existingSpecs?: string[], usedBatchPrefixes?: string[], lang?: string}} input 入力
 * @returns {string} 本文
 */
export function buildArchitectTaskBody({
  prompt,
  board,
  repoPath,
  jobId,
  executionPolicy = DEFAULT_EXECUTION_POLICY,
  suggestedSlug,
  existingSpecs,
  usedBatchPrefixes,
  lang = DEFAULT_LANG,
}) {
  const policy = normalizeExecutionPolicy(executionPolicy)
  const slug = String(suggestedSlug ?? '').trim() || suggestSpecSlug(prompt, jobId)
  const specs = (Array.isArray(existingSpecs) ? existingSpecs : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const prefix = batchIdPrefixForSlug(slug)
  const prefixes = (Array.isArray(usedBatchPrefixes) ? usedBatchPrefixes : [])
    .map((p) => String(p ?? '').trim().toUpperCase())
    .filter(Boolean)
  const batchRule = [
    `Batch ID rule: every batch heading MUST read "### Batch ${prefix}-<n>: <Title>" — an UPPERCASE slug prefix`,
    `plus a number (e.g. "### Batch ${prefix}-1: ..."). A bare "### <ID>:" heading or a lowercase prefix is rejected.`,
  ].join(' ')
  const usedLine = prefixes.length
    ? `Batch ID prefixes already used by active SPECs: ${prefixes.join(', ')} (do not reuse one as-is; pick a distinct slug)`
    : `Batch ID prefixes already used by active SPECs: none (the ${prefix} prefix above is free)`
  return [
    `[hermes-pilot:architect job=${jobId}] Architect (Kanban native)`,
    '',
    prompt,
    '',
    '---',
    '[Hermes Pilot Execution Contract]',
    'Mode: zero-stop',
    `Execution Policy: ${policy} (applies to the batches of the SPEC you write)`,
    'Follow the `spec-architect` skill protocol for the seed above.',
    `Suggested slug: ${slug} (use it for review/sheets/spec-${slug}-1.json and docs/SPEC-<SLUG>.md unless it clearly clashes)`,
    specs.length
      ? `Existing specs: ${specs.join(', ')} (do not reuse these file names; pick a distinct slug)`
      : 'Existing specs: none in docs/ yet (the slug above is free)',
    batchRule,
    usedLine,
    'Round 1: write the Quick Review JSON sheet under review/sheets/',
    '(spec-<slug>-1.json, "mode": "standard", 2-5 decisions) and file it as a blocked `[review]` task',
    'whose machine line is `mode=standard sheet=sheets/spec-<slug>-1.json`. Do not wait in chat.',
    'Round 1 speed: locate only the relevant symbols (rg/grep), skip running full test/verification suites or a headless browser during Round 1, write the JSON sheet and block immediately.',
    'Round 1 speed: skip bespoke HTML sheets and headless browser screenshots unless',
    'the question itself is a visual UI layout comparison; the JSON alone renders the native form.',
    `Round 2: after the answers arrive, write \`docs/SPEC-<SLUG>.md\` with \`### Batch ${prefix}-<n>: <Title>\` sections`,
    round2Headings(lang).inline,
    `If Round 1 delegates Round 2 to a separate \`[review]\` task, include the \`### Batch ${prefix}-<n>: <Title>\` heading and per-batch \`- **Execution Mode**:\` requirement in that \`[review]\` task body and mark this \`[ARCH]\` task \`done\` once the \`[review]\` task is \`blocked\`.`,
    ...executionPolicyLines(policy),
    'Stay inside the official local CLI: the only runner is `hermes kanban create` (no external AI CLI is launched).',
    `Board: ${board}`,
    `Repository: ${repoPath}`,
  ].join('\n')
}

/**
 * `hermes kanban create` の引数（`specs.js` / `capture.js` と同じ正規ルート）。
 * @param {{board: string, title: string, body: string, assignee?: string}} input 入力
 * @returns {string[]} 引数
 */
export function buildKanbanCreateArgs({ board, title, body, assignee = 'mobile' }) {
  return ['kanban', '--board', String(board ?? ''), 'create', String(title ?? ''), '--json', '--body', String(body ?? ''), '--assignee', String(assignee ?? 'mobile')]
}

/**
 * 「[review] タスク」かどうか（タイトル・本文・ラベルを見る。読むだけ）。
 * @param {object} task タスク
 * @returns {boolean} review タスクなら true
 */
export function isReviewTask(task) {
  if (!task) return false
  const labels = [task.label, ...(Array.isArray(task.labels) ? task.labels : [])].filter(Boolean).map((l) => String(l))
  const text = [task.title, task.body].filter(Boolean).map((v) => String(v)).join('\n')
  return /\[review\]/i.test(text) || labels.some((l) => /^\[?review\]?$/i.test(l.trim()))
}

const ACTIVE_REVIEW_STATUSES = new Set(['ready', 'running', 'claimed', 'in_progress'])
const BLOCKED_REVIEW_STATUSES = new Set(['blocked'])
const TERMINAL_REVIEW_STATUSES = new Set(['done', 'archived', 'failed'])

/**
 * Round 1 シートが `reviewDir` 上に実在し、中身も読めるか確かめる（問題②）。
 * シートを書き始める前に blocked になったタスクで「Review に届きました」を誤表示しないため。
 *
 * @param {string|null|undefined} reviewDir レビューディレクトリ
 * @param {string|null|undefined} sheetRel `[review] sheet=...` の相対パス
 * @returns {boolean} 確認ボタンを出してよい状態なら true
 */
export function reviewSheetReady(reviewDir, sheetRel) {
  if (!reviewDir || !sheetRel) return false
  const root = path.resolve(String(reviewDir))
  const rel = String(sheetRel).trim()
  if (!rel || path.isAbsolute(rel) || rel.includes('..')) return false
  const { dataRel } = sheetPaths(rel)
  const abs = path.resolve(root, rel)
  const dataAbs = path.resolve(root, dataRel)
  if (!abs.startsWith(root + path.sep) || !dataAbs.startsWith(root + path.sep)) return false
  try {
    if (fs.existsSync(dataAbs) && fs.statSync(dataAbs).isFile()) {
      const parsed = JSON.parse(fs.readFileSync(dataAbs, 'utf8'))
      return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0)
    }
    if (/\.html?$/i.test(abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return fs.statSync(abs).size > 0
    }
  } catch {
    return false
  }
  return false
}

/**
 * ジョブに紐づく Quick Review タスクを指定ステータス集合で探す（純関数）。
 *
 * 条件: ① `job.taskId`（または `job.reviewTaskId`）と一致する、または `startedAt - 猶予` 以降に作成。
 * ② `[review]` の印を持ち、状態が `statuses` に含まれる。
 * ③ `[ARCH]` 自身のプロンプト文中の `[review]` 語には反応しない。
 * ④ `sheet=` 付き（annotation 以外）は、`reviewSheetReady`（`reviewDir` または `job.repoPath/review`）を満たすときだけ採用する。
 *
 * @param {{taskId?: string|null, reviewTaskId?: string|null, startedAt: number, repoPath?: string|null}} job ジョブ
 * @param {Array<object>} tasks ボードのタスク
 * @param {Set<string>} statuses 対象ステータス集合
 * @param {{slackMs?: number, reviewDir?: string|null, boardSlug?: string|null, reviewBoard?: string|null, checkSheet?: boolean}} [opts] 制約
 * @returns {{taskId: string, title: string, status: string}|null} 一致タスク（無ければ null）
 */
function matchJobReviewTask(
  job,
  tasks,
  statuses,
  { slackMs = SPEC_MTIME_SLACK_MS, reviewDir = null, checkSheet = false, excludeOwn = false } = {},
) {
  const since = Number(job?.startedAt ?? 0) - slackMs
  const ownId = job?.taskId ? String(job.taskId) : ''
  const revIds = new Set([job?.reviewTaskId, job?.lastReviewTaskId].filter(Boolean).map(String))
  const reviewDirs = [...new Set([reviewDir, job?.repoPath ? path.join(String(job.repoPath), 'review') : null].filter(Boolean))]
  const list = Array.isArray(tasks) ? tasks : []
  for (const task of list) {
    if (!task || !task.id) continue
    const id = String(task.id)
    if (excludeOwn && ownId && id === ownId) continue
    const same = (ownId && id === ownId) || revIds.has(id)
    const fresh = Number(task.createdAt ?? 0) >= since
    if (!same && !fresh) continue
    if (!isReviewTask(task)) continue
    const ak = parseReviewLine(task.body)
    if (id === ownId && String(task.body ?? '').includes('[hermes-pilot:architect') && !ak) continue
    const status = String(task.status ?? '').trim().toLowerCase()
    if (!statuses.has(status)) continue
    if (checkSheet && ak?.sheet && ak.mode !== 'annotation') {
      if (reviewDir && !reviewDirs.some((d) => reviewSheetReady(d, ak.sheet))) continue
    }
    return { taskId: id, title: String(task.title ?? ''), status, result: task.result ?? null }
  }
  return null
}

/**
 * ジョブが待っている Quick Review タスクを見つける（純関数）。
 *
 * 条件: ① `job.taskId` と一致するタスク、または `startedAt - 猶予` 以降に作られた `[review]` タスク。
 * ② そのタスクが `blocked` で、`[review]` の印を持つ（＝人の回答待ち）。
 *
 * @param {{taskId?: string|null, reviewTaskId?: string|null, startedAt: number}} job ジョブ
 * @param {Array<object>} tasks ボードのタスク
 * @param {{slackMs?: number, reviewDir?: string|null, boardSlug?: string|null, reviewBoard?: string|null}} [opts] 制約
 * @returns {{taskId: string, title: string, status: string}|null} 待機中タスク（無ければ null）
 */
export function findJobReviewTask(job, tasks, opts = {}) {
  return matchJobReviewTask(job, tasks, BLOCKED_REVIEW_STATUSES, { ...opts, checkSheet: true })
}

/**
 * Round 1 回答後に動き出した別タスクの `[review]`（ready / running 等）を見つける（純関数）。
 *
 * @param {{taskId?: string|null, reviewTaskId?: string|null, startedAt: number}} job ジョブ
 * @param {Array<object>} tasks ボードのタスク
 * @param {{slackMs?: number}} [opts] 制約
 * @returns {{taskId: string, title: string, status: string}|null} 進行中タスク（無ければ null）
 */
export function findActiveJobReviewTask(job, tasks, opts) {
  return matchJobReviewTask(job, tasks, ACTIVE_REVIEW_STATUSES, opts)
}

/**
 * 終端状態（done / archived / failed）になった子 `[review]` タスクを探す（親 `[ARCH]` 自体は除外）。
 * 親 `[ARCH]` が `blocked` で残置された場合でも Round 2 完了／失敗を検知するため。
 */
export function findTerminalJobReviewTask(job, tasks, opts = {}) {
  return matchJobReviewTask(job, tasks, TERMINAL_REVIEW_STATUSES, { ...opts, excludeOwn: true })
}
/**
 * ジョブが作ったと見なせる SPEC を 1 つ選ぶ。
 *
 * 条件: バッチを持つ / `startedAt` 以降に更新された（猶予あり） / 他のジョブが先に取っていない。
 * @param {{startedAt: number}} job ジョブ
 * @param {Array<{path: string, title: string, mtime: number, batches: Array<object>}>} specs SPEC 一覧
 * @param {{taken?: Set<string>, slackMs?: number}} [opts] 制約
 * @returns {object|null} SPEC（無ければ null）
 */
export function findJobSpec(job, specs, { taken = new Set(), slackMs = SPEC_MTIME_SLACK_MS } = {}) {
  const since = Number(job?.startedAt ?? 0) - slackMs
  const candidates = (Array.isArray(specs) ? specs : []).filter(
    (s) => s && (s.batches ?? []).length > 0 && Number(s.mtime ?? 0) >= since && !taken.has(String(s.path)),
  )
  if (!candidates.length) return null
  // 一番新しいもの（同じ秒に複数あればパス順で安定させる）
  return [...candidates].sort((a, b) => Number(b.mtime) - Number(a.mtime) || String(a.path).localeCompare(String(b.path)))[0]
}

/** タスク本文/フィールドから SPEC パスを読む（別 SPEC の同名バッチ ID 衝突を防ぐ）。 */
export function taskSpecPath(task) {
  const direct = String(task?.spec ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (direct) return direct
  const body = String(task?.body ?? '')
  if (!body) return null
  const m = /^Spec:\s*(.+?)\s*$/m.exec(body)
  if (m) return m[1].replace(/\\/g, '/').replace(/^\.\//, '').trim() || null
  const head = body.split(/\r?\n/).slice(0, 5).join('\n')
  const leg = /(?:docs\/)?SPEC[A-Za-z0-9._-]*\.md/i.exec(head)
  return leg ? leg[0].replace(/\\/g, '/').replace(/^\.\//, '').trim() : null
}

/**
 * 1 件の Architect ジョブをカンバン状態（`[ARCH]` / `[review]`）へ同期する。
 * @returns {boolean} 執筆・レビュー作業がまだ動いているとき true（SPEC フライング検知抑止用）
 */
export function syncJobFromKanban(job, { tasksOf, reviewDir, revBoard = DEFAULT_REVIEW_BOARD, at = Date.now() }) {
  if (!['running', 'awaiting_spec', 'awaiting_review'].includes(job.status)) return false
  const scanBoards = [...new Set([job.board, ...reviewBoardsFor(job.board), revBoard].filter(Boolean))]
  const tasks = tasksOf(job.board)
  const self = job.taskId ? tasks.find((t) => t && String(t.id) === String(job.taskId)) ?? null : null
  job.taskStatus = self?.status ? String(self.status) : null
  job.queueState = queueStateOf(job.taskStatus)
  if (job.spec) return false

  let review = null
  for (const slug of scanBoards) {
    const found = findJobReviewTask(job, tasksOf(slug), { reviewDir })
    if (found) {
      review = { ...found, board: slug }
      break
    }
  }
  if (review) {
    job.status = 'awaiting_review'
    job.reviewTaskId = review.taskId
    job.reviewTitle = review.title
    job.reviewBoard = review.board
    job.lastReviewTaskId = review.taskId
    job.lastReviewBoard = review.board
    job.reviewSeenOnce = true
    return true
  }

  const orderedBoards = job.lastReviewBoard ? [...new Set([job.lastReviewBoard, ...scanBoards])] : scanBoards
  if (job.reviewSeenOnce) {
    let activeReview = null
    for (const slug of orderedBoards) {
      const found = findActiveJobReviewTask(job, tasksOf(slug))
      if (found) {
        activeReview = { ...found, board: slug }
        break
      }
    }
    if (activeReview) {
      job.status = 'awaiting_spec'
      job.taskStatus = activeReview.status
      job.queueState = queueStateOf(activeReview.status)
      job.reviewTaskId = null
      job.reviewTitle = null
      job.reviewBoard = null
      return true
    }
    const selfLower = String(self?.status ?? '').toLowerCase()
    if (!self || TERMINAL_TASK_STATUSES.includes(String(self.status)) || selfLower === 'blocked') {
      let terminalReview = null
      for (const slug of orderedBoards) {
        const found = findTerminalJobReviewTask(job, tasksOf(slug))
        if (found) {
          terminalReview = { ...found, board: slug }
          break
        }
      }
      if (terminalReview) {
        job.reviewTaskId = null
        job.reviewTitle = null
        job.reviewBoard = null
        if (terminalReview.status === 'failed') {
          job.status = 'failed'
          job.queueState = null
          job.error = String(terminalReview.result || job.error || 'Review Round 2 task failed').slice(0, 600)
          return false
        }
        job.status = String(terminalReview.status)
        job.queueState = null
        job.finishedAt = job.finishedAt ?? at
        return false
      }
    }
  }

  if (self && TERMINAL_TASK_STATUSES.includes(String(self.status))) {
    job.status = String(self.status)
    job.queueState = null
    job.reviewTaskId = null
    job.reviewTitle = null
    job.reviewBoard = null
    job.finishedAt = job.finishedAt ?? at
    return false
  }
  if (self && self.status === 'failed') {
    job.status = 'failed'
    job.error = String(self.result || job.error || 'Architect task failed').slice(0, 600)
    return false
  }
  job.reviewTaskId = null
  job.reviewTitle = null
  job.reviewBoard = null
  if (job.status === 'awaiting_review') job.status = 'awaiting_spec'
  return Boolean(self && ['running', 'ready', 'claimed', 'in_progress'].includes(String(self.status).toLowerCase()))
}
