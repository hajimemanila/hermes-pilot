/**
 * Architect ランナー（SPEC V5 §3.2 / D23・D25・D26①）— 「仕様の種」から仕様書まで。
 *
 * 役割は 4 つだけ。どれも**観測できる状態**を返し、PWA が固まらないように即答する。
 *  1. `seed()`   … 1 行メモ（または音声の書き起こし）を受けて Architect を**背後で**起動し、
 *                 `202` で `jobId` を返す（タイムアウト待ちで画面を固めない）
 *  2. `jobs()`   … ジョブの進み具合と、**完成した新しい SPEC** を返す（A2B の「仕様書の準備が完了」）
 *  3. `jobs()`   … 未起票の SPEC を数えて返す（1 タップ一括起票カードの材料）
 *  4. `autoStart` … ON のジョブだけ、完成 SPEC の未起票バッチを**1 回だけ**起票する（冪等）
 *
 * ## スタックしないための終端判定（SPEC V7 §3.1）
 *
 * - 親 `[ARCH]` タスクが `done` / `archived` になったら、SPEC 未検知でもジョブは終端にして
 *   進行バー（`jobs`）から落とす。落とさないと「仕様書を書いています…」が残り続ける。
 * - `dismiss(jobId)` は破棄を**データストアに永続化**する（リロード・再起動で復活しない）。
 *   `jobs()` は破棄済みを既定で除外する（`includeDismissed: true` は監査・テスト用）。
 * - `queueState`（`queued` / `running`）で「キュー待ち」と「実行中」を区別できる形で返す。
 *
 * ## 実行ランナー
 *
 * ランナーは **`Hermes Native` の 1 本だけ**（`RUNNERS = ['hermes']`）。`hermes kanban create` で
 * `[ARCH]` タスクを起票する**公式ルート**を子プロセスで 1 回だけ呼び、あとはカンバンの
 * 自走ワーカーが仕様書を書く。外部 AI CLI の検出・パス解決・子プロセス起動は
 * SPEC V11 D50 で**完全に削除**した（サードパーティの CLI をラップ起動してサブスク枠を
 * 消費させる行為は規約違反＝BAN 対象）。`scripts/check-oauth-boundary.mjs` が再混入を機械検査する。
 * 旧 Opt-in ランナー名を指定された場合は `INVALID_RUNNER`（HTTP 400）で弾く。
 *
 * ## ステータス遷移
 *
 * `running`（CLI 実行中）→ `awaiting_spec`（CLI 正常終了・SPEC 待ち）→ `spec_ready`（完成検知）
 * → `launched`（autoStart で起票済み）/ `failed`（CLI 異常終了）
 *
 * ## 終了時の扱い（SPEC V9 D41 の決定を維持）
 *
 * ランナー（`hermes kanban create`）が非 0 終了したら `failed` に理由を残すだけで、
 * 裏で勝手に別経路の起票へ切り替えたりはしない（二重稼働・重複起票の根絶）。
 * 再試行は UI の明示操作（1 タップ再試行）だけ。
 *
 * ## ボード横断の Review 検知とフェーズ（SPEC V9 D42）
 *
 * `[review]` は `job.board` に加えて `mobile` ボードも走査する（`reviewBoardsFor`）。
 * `review/sheets/spec-*.json` の中間シートを `sheetPath` として観測し、
 * `phase`（`spawning`〜`failed`）と `stalled`（3 分無進展）を `publicJob()` で返す。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { listSpecs as scanSpecs, parseCreatedTask, taskStampMs } from './specs.js'
import { appendChatReport } from './pipeline-watcher.js'
import { buildAugmentedPath, resolveHermesBin } from './capabilities.js'
import { DEFAULT_LANG } from './lang.js'
import { isJaLang, languageRule } from './language-rule.js'

/** `chat-reports.jsonl` の行種別（仕様書が完成した）。 */
export const SPEC_READY_KIND = 'spec_ready'
/** `chat-reports.jsonl` の行種別（autoStart がバッチを起票した）。 */
export const SPEC_LAUNCH_KIND = 'spec_launch'

/**
 * 選べるランナー。**`Hermes Native` の 1 本だけ**（SPEC V11 D50）。
 *
 * 外部 AI CLI をラップ起動するランナーは規約違反（サブスク枠の消費）なので、
 * 検出もパス解決も子プロセス起動もこのファイルには置かない。
 */
export const RUNNERS = ['hermes']

/**
 * 実行方針（生成する SPEC 各バッチの既定 Execution Mode）。SPEC V7 §3.1 / D35。
 *
 * どちらの方針でも Round 1 の Quick Review インタビューは必ず行い、
 * 変わるのは「各バッチを止まらずに完走させるか・要所で視覚確認を挟むか」だけ。
 */
export const EXECUTION_POLICIES = ['zero-stop', 'visual-gate']
/** 実行方針の既定値（未指定・不正値はこれへ正規化する）。 */
export const DEFAULT_EXECUTION_POLICY = 'zero-stop'

/** 親 `[ARCH]` タスクがこの状態になったらジョブは終端（進行バーに残さない）。 */
export const TERMINAL_TASK_STATUSES = ['done', 'archived']

/**
 * Quick Review（`[review]`）が撒かれる既定ボード（SPEC V9 D42）。
 *
 * 種は `hermes-pilot` などリポジトリ固有ボードで撒かれても、Round 1 のシートは `mobile` に届く。
 * 走査対象を `[job.board, DEFAULT_REVIEW_BOARD]` に広げないと `awaiting_review` を取りこぼす。
 */
export const DEFAULT_REVIEW_BOARD = 'mobile'

/** 進行バーに残す「アクティブ」状態（ボード横断で返す対象。`failed` も人が気づくまで残す）。 */
export const ACTIVE_JOB_STATUSES = ['running', 'awaiting_spec', 'awaiting_review', 'failed']

/** `publicJob().phase` が返すフェーズ（SPEC V9 D42）。 */
export const ARCHITECT_PHASES = [
  'spawning',
  'round1_sheet',
  'awaiting_review',
  'round2_spec',
  'spec_ready',
  'launched',
  'failed',
]

/** 進展が無いままこの時間を超えたら `stalled`（3 分。SPEC V9 D42/D43）。 */
export const STALLED_AFTER_MS = 180_000
/** 破棄したジョブ ID を保持する上限（古いものから落とす）。 */
export const DISMISSED_MAX = 500

/** 0 行の種はインタビューにならない。長すぎる種はプロンプトを壊す。 */
export const SEED_MIN = 1
/** 種の最大文字数。 */
export const SEED_MAX = 4000
/** 保持するジョブ数（古いものから落とす）。 */
export const JOBS_MAX = 40
/** 「このジョブが作った SPEC」と見なす mtime の猶予（秒ズレ対策）。 */
export const SPEC_MTIME_SLACK_MS = 5000
/** ランナーの既定タイムアウト（ミリ秒）。 */
export const RUNNER_TIMEOUT_MS = 15 * 60 * 1000
/** ボード名の書式（`specs.launchSpec` と同じ）。 */
export const BOARD_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** ランナーの表示名（ランナーは 1 本だけ）。 */
export const RUNNER_LABELS = {
  hermes: 'Hermes Native',
}

/** ランナー名として受け付ける値（空・未指定は Hermes Native へ倒す）。 */
export const DEFAULT_RUNNER = 'hermes'

/**
 * ランナー ID を正規化する（**常に `hermes`**。SPEC V11 D50）。
 *
 * 受け付ける値は `hermes` だけだが、`sanitizeRunner()` は表示用の緩い正規化なので
 * 未知の値も既定へ倒す。API 入力の可否判定は `isSupportedRunner()` で行う。
 * @param {unknown} value 入力
 * @returns {'hermes'} ランナー
 */
export function sanitizeRunner(value) {
  return DEFAULT_RUNNER
}

/**
 * 明示されたランナーが受け付けられるか（`''` / 未指定は既定として許す）。
 * @param {unknown} value 入力
 * @returns {boolean} `hermes` か未指定なら true
 */
export function isSupportedRunner(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  return text === '' || text === DEFAULT_RUNNER
}

/**
 * ランナーの表示名。
 * @param {unknown} value 入力
 * @returns {string} 表示名
 */
export function runnerLabel(value) {
  return RUNNER_LABELS[sanitizeRunner(value)]
}

/**
 * 実行方針を正規化する（未指定・不正値は `zero-stop`）。
 * @param {unknown} value 入力
 * @returns {'zero-stop'|'visual-gate'} 実行方針
 */
export function normalizeExecutionPolicy(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  return EXECUTION_POLICIES.includes(text) ? text : DEFAULT_EXECUTION_POLICY
}

/**
 * 実行方針に対応する SPEC バッチの `Execution Mode` 表記。
 * @param {unknown} value 実行方針
 * @returns {string} `[Mode: Zero-Stop]` / `[Mode: Visual Gate]`
 */
export function executionModeLabel(value) {
  return normalizeExecutionPolicy(value) === 'visual-gate' ? '[Mode: Visual Gate]' : '[Mode: Zero-Stop]'
}

/**
 * プロンプトへ差し込む実行方針の指示（両方針共通で Quick Review は必須）。
 * @param {unknown} value 実行方針
 * @returns {string[]} 行
 */
function executionPolicyLines(value) {
  const policy = normalizeExecutionPolicy(value)
  const mode = executionModeLabel(policy)
  const intent =
    policy === 'visual-gate'
      ? 'pause at the visual checkpoints and wait for approval before going further'
      : 'do not stop for approval: run every batch autonomously to done'
  return [
    `- Round 1 Quick Review interview is mandatory under both policies: still write the sheet and stop.`,
    `- Execution policy chosen by the user: \`${policy}\`. Every batch in the generated SPEC must default to`,
    `  **Execution Mode**: \`${mode}\` : ${intent}.`,
  ]
}

/**
 * [`[ARCH]` タスクのタイトル]（カンバン起票に載る 1 行）。
 * @param {{seedText?: string, prompt?: string}} input 入力
 * @returns {string} タイトル
 */
export function buildArchitectTaskTitle({ seedText, prompt } = {}) {
  const line = String(seedText ?? prompt ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean)
  return `[ARCH] ${String(line ?? 'Spec seed').slice(0, 80)}`
}

/** 推奨スラッグの最大長（`docs/SPEC-<SLUG>.md` のファイル名が長くなりすぎないように）。 */
export const SPEC_SLUG_MAX = 28
/** プロンプトへ注入する既存 SPEC の最大件数（探索ターンとトークンの節約）。 */
export const EXISTING_SPECS_MAX = 6

/**
 * 種から「推奨スラッグ」を作る（純関数。SPEC V11 D54）。
 *
 * Round 1 のシート名（`review/sheets/spec-<slug>-1.json`）と Round 2 の SPEC 名
 * （`docs/SPEC-<SLUG>.md`）が、種を撒くたびに違う名前になるのを防ぐための**目安**。
 * 先頭付近の ASCII 英数字（`[A-Za-z0-9]`）を小文字ハイフン区切りにし、最大 28 文字。
 * ASCII が 1 つも無ければ `jobId` の末尾セグメントを使う。
 *
 * @param {unknown} seedText 種の本文
 * @param {unknown} jobId ジョブ ID（`arch-<base36>-<tail>`）
 * @returns {string} スラッグ（空にはならない）
 */
export function suggestSpecSlug(seedText, jobId) {
  /** @type {string[]} */
  const words = []
  for (const line of String(seedText ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)) {
    for (const token of line.match(/[A-Za-z0-9]+/g) ?? []) words.push(token)
    if (words.length >= 4) break
  }
  const shape = (text) =>
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  let slug = shape(words.join('-'))
  if (!slug) {
    const tail = String(jobId ?? '')
      .trim()
      .split('-')
      .filter(Boolean)
      .pop()
    slug = shape(tail)
  }
  if (!slug) return 'spec'
  const clipped = slug.slice(0, SPEC_SLUG_MAX).replace(/-+$/g, '')
  return clipped || slug.slice(0, SPEC_SLUG_MAX)
}

/**
 * 既存 `docs/SPEC-*.md` の相対パスを「直近 N 件」で返す（SPEC V11 D54）。
 *
 * 名前の衝突と全量探索を減らすためにプロンプトへ注入する。走査に失敗しても
 * 起票は止めない（空配列を返す）。
 * @param {Function} listSpecsFn SPEC 走査（`specs.listSpecs`）
 * @param {string} repoPath リポジトリ
 * @param {number} [limit] 最大件数
 * @returns {string[]} 相対パス（mtime の新しい順）
 */
export function recentSpecPaths(listSpecsFn, repoPath, limit = EXISTING_SPECS_MAX) {
  try {
    const list = listSpecsFn(repoPath) ?? []
    return (Array.isArray(list) ? list : [])
      .filter((s) => s && s.path)
      .sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0) || String(a.path).localeCompare(String(b.path)))
      .slice(0, Math.max(1, Number(limit) || EXISTING_SPECS_MAX))
      .map((s) => String(s.path))
  } catch {
    return []
  }
}

/**
 * Round 2 で SPEC の各バッチに要求する見出し（`lang` ごと・SPEC-i18n-gen D3）。
 *
 * 機械キー（`**Execution Mode**`）は ASCII 固定、人が読む見出しだけを言語に追従させる。
 * パーサ（`specs.js` の `OBJECTIVE_RE` / `EXECUTION_MODE_RE`）は両言語を受けるので、
 * ここを切り替えても読み取りは壊れない。
 */
const ROUND2_HEADINGS = {
  en: {
    inline: 'each carrying **Execution Mode** / **Objective** / **Files** / **Verify**.',
    lines: [
      '  - **Execution Mode**: [Mode: Zero-Stop | Fast-Track Review | Visual Gate]',
      '  - **Objective**: one paragraph of intent',
      '  - **Files**: the exact paths to touch',
      '  - **Verify**: the command that proves it works',
    ],
  },
  ja: {
    inline: 'each carrying **Execution Mode** / **目的** / **変更・新規ファイル** / **受入条件（Verify）**.',
    lines: [
      '  - **Execution Mode**: [Mode: Zero-Stop | Fast-Track Review | Visual Gate]',
      '  - **目的**: one paragraph of intent',
      '  - **変更・新規ファイル**: the exact paths to touch',
      '  - **受入条件（Verify）**: the command that proves it works',
    ],
  },
}

/**
 * 言語に合った Round 2 の見出しを返す（未知・未指定は既定 `en`）。
 *
 * @param {unknown} [lang] 言語
 * @returns {{inline: string, lines: string[]}} 見出し（1 行要約と箇条書き）
 */
function round2Headings(lang) {
  return isJaLang(lang) ? ROUND2_HEADINGS.ja : ROUND2_HEADINGS.en
}

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
    'Round 1 speed: locate only the relevant symbols (rg/grep), skip running npm test / npm run verify / browser_exec during Round 1, write the JSON sheet and block immediately.',
    'Round 1 speed: skip bespoke HTML sheets and browser mockups (browser_exec screenshots) unless',
    'the question itself is a visual UI layout comparison; the JSON alone renders the native form.',
    `Round 2: after the answers arrive, write \`docs/SPEC-<SLUG>.md\` with \`### Batch ${prefix}-<n>: <Title>\` sections`,
    round2Headings(lang).inline,
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

/**
 * ジョブに紐づく Quick Review タスクを指定ステータス集合で探す（純関数）。
 *
 * 条件: ① `job.taskId`（または `job.reviewTaskId`）と一致する、または `startedAt - 猶予` 以降に作成。
 * ② `[review]` の印を持ち、状態が `statuses` に含まれる。
 *
 * @param {{taskId?: string|null, reviewTaskId?: string|null, startedAt: number}} job ジョブ
 * @param {Array<object>} tasks ボードのタスク
 * @param {Set<string>} statuses 対象ステータス集合
 * @param {{slackMs?: number}} [opts] 制約
 * @returns {{taskId: string, title: string, status: string}|null} 一致タスク（無ければ null）
 */
function matchJobReviewTask(job, tasks, statuses, { slackMs = SPEC_MTIME_SLACK_MS } = {}) {
  const since = Number(job?.startedAt ?? 0) - slackMs
  const ownId = job?.taskId ? String(job.taskId) : ''
  const revId = job?.reviewTaskId ? String(job.reviewTaskId) : ''
  const list = Array.isArray(tasks) ? tasks : []
  for (const task of list) {
    if (!task || !task.id) continue
    const id = String(task.id)
    const same = (ownId && id === ownId) || (revId && id === revId)
    const fresh = Number(task.createdAt ?? 0) >= since
    if (!same && !fresh) continue
    if (!isReviewTask(task)) continue
    const status = String(task.status ?? '').trim().toLowerCase()
    if (!statuses.has(status)) continue
    return { taskId: id, title: String(task.title ?? ''), status }
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
 * @param {{slackMs?: number}} [opts] 制約
 * @returns {{taskId: string, title: string, status: string}|null} 待機中タスク（無ければ null）
 */
export function findJobReviewTask(job, tasks, opts) {
  return matchJobReviewTask(job, tasks, BLOCKED_REVIEW_STATUSES, opts)
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
 * ジョブ ID（`arch-<base36 時刻>-<乱数 4>`）。
 * @param {number} [ms] 時刻
 * @param {Function} [rand] 乱数（テスト用）
 * @returns {string} ジョブ ID
 */
export function makeJobId(ms = Date.now(), rand = Math.random) {
  const tail = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `arch-${ms.toString(36)}-${tail}`
}

/**
 * 種の本文を整える（前後の空白だけ落とし、改行は保つ）。
 * @param {unknown} value 入力
 * @returns {string} 本文（不正なら空文字）
 */
export function normalizeSeed(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (text.length < SEED_MIN) return ''
  return text.slice(0, SEED_MAX)
}

/**
 * Architect へ渡すプロンプト（`spec-architect` プロトコル）。
 *
 * 長文の質問を並べるのではなく、Quick Review シート → 1 タップ承認 → SPEC 生成、の順を固定する。
 * `executionPolicy` は**生成する SPEC の各バッチ**の既定 Execution Mode を決める（D35）。
 * SPEC V11 D54: 推奨スラッグと既存 SPEC 一覧を先に渡し、Round 1 の探索と名前衝突を減らす。
 * @param {{jobId: string, seedText: string, board: string, repoPath: string, autoStart?: boolean, executionPolicy?: string, lang?: string, suggestedSlug?: string, existingSpecs?: string[], usedBatchPrefixes?: string[]}} input 入力
 * @returns {string} プロンプト
 */
export function buildSeedPrompt({
  jobId,
  seedText,
  board,
  repoPath,
  autoStart = false,
  executionPolicy = DEFAULT_EXECUTION_POLICY,
  lang = DEFAULT_LANG,
  suggestedSlug,
  existingSpecs,
  usedBatchPrefixes,
}) {
  const auto = autoStart
    ? 'The PWA will file the batches automatically as soon as this SPEC appears, so do not file them yourself.'
    : 'Do not file anything yet: the user taps "File batches & start" once the SPEC is ready.'
  const slug = String(suggestedSlug ?? '').trim() || suggestSpecSlug(seedText, jobId)
  const specs = (Array.isArray(existingSpecs) ? existingSpecs : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  // バッチ ID は「大文字スラッグ接頭辞 + 連番」を必須にし、使用済み接頭辞を渡して衝突を防ぐ（D91）。
  const prefix = batchIdPrefixForSlug(slug)
  const prefixes = (Array.isArray(usedBatchPrefixes) ? usedBatchPrefixes : [])
    .map((p) => String(p ?? '').trim().toUpperCase())
    .filter(Boolean)
  const batchRule = `Batch ID rule: every batch heading MUST read "### Batch ${prefix}-<n>: <Title>" with an UPPERCASE slug prefix and a number (e.g. "### Batch ${prefix}-1: ...").`
  const usedLine = prefixes.length
    ? `Batch ID prefixes already used by active SPECs: ${prefixes.join(', ')} (do not reuse one as-is; pick a distinct slug)`
    : `Batch ID prefixes already used by active SPECs: none (the ${prefix} prefix above is free)`
  return [
    `[hermes-pilot:architect job=${jobId}]`,
    'You are the spec-architect. Follow the `spec-architect` skill protocol (Round 1 → Round 2).',
    '',
    'Seed (the user dictation, verbatim):',
    '"""',
    seedText,
    '"""',
    '',
    `Repository: ${repoPath}`,
    `Board: ${board}`,
    `UI language: ${lang}`,
    // 「その言語で書け」の規則本体（3 スキルと同じ 1 文・SPEC-i18n-gen §3.4 D2）
    languageRule(lang),
    `Suggested slug: ${slug}`,
    specs.length
      ? `Existing specs: ${specs.join(', ')}`
      : 'Existing specs: none in docs/ yet (the suggested slug is free)',
    batchRule,
    usedLine,
    '',
    'Round 1 — instead of a wall of chat questions, write ONE structured sheet as JSON:',
    `\`review/sheets/spec-${slug}-1.json\` with \`"mode": "standard"\` and 2-5 design decisions`,
    '(each option marked `recommended: true` for the best one), then file it as a blocked [review]',
    'kanban task whose machine line reads',
    `\`[review] label=spec-${slug} round=1 mode=standard sheet=sheets/spec-${slug}-1.json target=<repo>\``,
    'so the phone renders the native 1-tap form. Stop there.',
    'Do not reuse a file name from Existing specs above: pick a distinct slug if it would clash.',
    '',
    'Round 1 speed rule — the JSON is the deliverable. Locate only the relevant symbols (rg/grep);',
    'do NOT run npm test / npm run verify, and do NOT hand-write a long bespoke HTML sheet or launch',
    'a headless browser (browser_exec or similar) to screenshot mockups unless the question itself is',
    'a visual UI-layout comparison (placement, density, colour) that words cannot settle; even then it',
    'is optional and comes after the JSON. For spec, logic, string, API and data questions just check',
    'the cited file:line, write the sheet and block immediately.',
    `Round 2 — after the answers arrive, write docs/SPEC-<SLUG>.md. Every batch heading`,
    `\`### Batch ${prefix}-<n>: <Title>\` must be followed by:`,
    '  - **Execution Mode**: [Mode: Zero-Stop | Fast-Track Review | Visual Gate]',
    ...round2Headings(lang).lines.slice(1),
    '',
    'Execution policy for the batches you generate:',
    ...executionPolicyLines(executionPolicy),
    '',
    auto,
  ].join('\n')
}

/**
 * 既定のランナー実行（公式 CLI の子プロセス。シェルは介さない）。
 *
 * `hermes kanban --board <b> create "[ARCH] …" --assignee mobile --json --body …` という
 * **正規ルート**でカンバンに Architect タスクを起票する（自走ワーカーが着火する）。
 * 外部 AI CLI のラッパー起動は SPEC V11 D50 で廃止した（`RUNNERS = ['hermes']` の 1 本だけ）。
 * `PATH` は `buildAugmentedPath()` で補う（`launchd` の狭い PATH 対策）。
 * @param {object} [cfg] 設定（`hermesBin`）
 * @returns {Function} `({runnerId, prompt, repoPath, board, seedText, jobId, executionPolicy, suggestedSlug, existingSpecs, timeoutMs}) => Promise<{code,stdout,stderr}>`
 */
export function createCliRunner(cfg = {}) {
  return ({
    runnerId,
    prompt,
    repoPath,
    board = '',
    seedText = '',
    jobId = '',
    executionPolicy = DEFAULT_EXECUTION_POLICY,
    lang = DEFAULT_LANG,
    suggestedSlug,
    existingSpecs,
    usedBatchPrefixes,
    timeoutMs = RUNNER_TIMEOUT_MS,
  }) =>
    new Promise((resolve) => {
      const bin = cfg.hermesBin ?? resolveHermesBin()
      const slug = String(suggestedSlug ?? '').trim() || suggestSpecSlug(seedText || prompt, jobId)
      const title = buildArchitectTaskTitle({ seedText: seedText || prompt })
      const body = buildArchitectTaskBody({
        prompt,
        board,
        repoPath,
        jobId,
        executionPolicy,
        suggestedSlug: slug,
        existingSpecs,
        usedBatchPrefixes,
        lang,
      })
      const rawAssignee = typeof cfg?.pilotProfile === 'function' ? cfg.pilotProfile() : cfg?.pilotProfile
      const assignee = String(rawAssignee ?? '').trim() || 'mobile'
      const args = buildKanbanCreateArgs({ board, title, body, assignee })
      execFile(
        bin,
        args,
        { cwd: repoPath, timeout: timeoutMs, maxBuffer: 4_000_000, env: { ...process.env, PATH: buildAugmentedPath() } },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), bin, args })
        },
      )
    })
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
function taskSpecPath(task) {
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
 * slug から推奨バッチ ID 接頭辞を作る（大文字・短く保つ。`specs.BATCH_ID_RE` の 16 文字制限内）。
 *
 * `reliability-guard` → `RG` / `coherence` → `COH` / `v5` → `V5`
 *
 * @param {unknown} slug スラッグ
 * @returns {string} 接頭辞（読めなければ `B`）
 */
export function batchIdPrefixForSlug(slug) {
  const parts = String(slug ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (!parts.length) return 'B'
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase()
  return parts
    .slice(0, 4)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
}

/**
 * バッチ ID の接頭辞（`RG-1` → `RG`、`C1` → `C`）。大文字化して返す（D91 の衝突防止）。
 * @param {unknown} batchId バッチ ID
 * @returns {string} 接頭辞（読めなければ空文字）
 */
export function batchIdPrefixOf(batchId) {
  const s = String(batchId ?? '').trim().toUpperCase()
  if (!s) return ''
  const dash = s.indexOf('-')
  if (dash > 0) return s.slice(0, dash)
  const m = /^[A-Z]+/.exec(s)
  return m ? m[0] : ''
}

/**
 * アクティブ SPEC 群で使用済みのバッチ ID 接頭辞（Architect へ渡して衝突を防ぐ）。
 *
 * @param {Array<{archived?: boolean, batches?: Array<{id?: string}>}>} specs `listSpecs()` の結果
 * @returns {string[]} 接頭辞（昇順・重複なし）
 */
export function usedBatchIdPrefixes(specs) {
  const out = new Set()
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (!spec || spec.archived) continue
    for (const batch of Array.isArray(spec.batches) ? spec.batches : []) {
      const prefix = batchIdPrefixOf(batch?.id)
      if (prefix) out.add(prefix)
    }
  }
  return [...out].sort()
}

/**
 * 指定 SPEC に結びついた「起票済みバッチ ID」を集める（別 SPEC に属する `[ID]` は除外）。
 *
 * - `opts.specMtime` を渡すと、無印（Spec 行の無い）レガシータスクは `specMtime - 猶予` 以降の
 *   ものだけを数える（過去の無印 `[C1]` が新規 SPEC を「起票済み」に見せない。D91）。
 * - `archived`（破棄済み）は**起票済みに数えない**（再起票できる。D92）。
 *
 * @param {Array<{title?: string, status?: string, spec?: string|null, body?: string}>} tasks ボードのタスク
 * @param {string|null} specRelPath SPEC 相対パス
 * @param {{specMtime?: number|null, slackMs?: number}} [opts] 無印タスクの時刻ガード
 * @returns {Set<string>} バッチ ID
 */
export function filedBatchIdsForSpec(tasks, specRelPath = null, opts = {}) {
  const wantSpec = String(specRelPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim() || null
  const specMtime = Number(opts?.specMtime)
  const slack = Number.isFinite(Number(opts?.slackMs)) ? Number(opts.slackMs) : SPEC_MTIME_SLACK_MS
  const since = wantSpec && Number.isFinite(specMtime) && specMtime > 0 ? specMtime - slack : null
  const out = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task) continue
    if (String(task.status ?? '').trim().toLowerCase() === 'archived') continue
    const m = /^\[([^\]]+)\]/.exec(String(task?.title ?? '').trim())
    if (!m || !m[1].trim()) continue
    if (wantSpec) {
      const ts = taskSpecPath(task)
      if (ts && ts !== wantSpec) continue
      if (!ts && since !== null && !(taskStampMs(task) >= since)) continue
    }
    out.add(m[1].trim())
  }
  return out
}

/**
 * タスク一覧から「起票済みのバッチ ID」を集める（`done` は起票済み・`archived` は未起票）。
 *
 * 完了済み（`done`）を未起票と数えると、バナーが「起票して開始」を出して
 * 同じバッチをもう一度起票してしまう（`specs.launchSpec` がスキップするのは
 * **未完了**の重複だけ）。ここは「タスクが 1 つでもあるか」で数える。
 * ただし `archived`（破棄済み）は再起票できるので数えない（D92）。
 *
 * @param {Array<{title?: string, status?: string}>} tasks ボードのタスク
 * @returns {Set<string>} バッチ ID
 */
export function filedBatchIds(tasks) {
  return filedBatchIdsForSpec(tasks, null)
}

/**
 * 未起票の SPEC を数える（A2B の 1 タップ一括起票カード用）。
 * @param {Array<object>} specs `specs.listSpecs` の結果
 * @param {Array<{id: string, title: string, status?: string, spec?: string|null, body?: string}>} tasks ボードのタスク
 * @returns {Array<{path: string, title: string, batchCount: number, pendingCount: number, pending: string[], mtime: number}>} 未起票ありの SPEC
 */
export function pendingSpecs(specs, tasks) {
  const out = []
  for (const spec of Array.isArray(specs) ? specs : []) {
    const batches = (spec?.batches ?? []).filter((b) => b?.id)
    if (!batches.length) continue
    const filed = filedBatchIdsForSpec(tasks, spec.path, { specMtime: Number(spec.mtime ?? 0) })
    const pending = batches.filter((b) => !filed.has(String(b.id))).map((b) => b.id)
    if (!pending.length) continue
    out.push({
      path: String(spec.path),
      title: String(spec.title ?? spec.path),
      batchCount: batches.length,
      pendingCount: pending.length,
      pending,
      mtime: Number(spec.mtime ?? 0),
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
}

/**
 * 親タスクの状態から「キュー待ち（queued）」と「実行中（running）」を判別する（SPEC V7 §3.1）。
 *
 * `ready` は着手中ではない＝キュー待ち。`running` / `claimed` は実行中。
 * 判定できない状態（`blocked` など）は `null`（UI は従来の表示にフォールバック）。
 *
 * @param {unknown} taskStatus 親 `[ARCH]` タスクの status
 * @returns {'queued'|'running'|null} キュー状態
 */
export function queueStateOf(taskStatus) {
  const s = String(taskStatus ?? '')
    .trim()
    .toLowerCase()
  if (['running', 'claimed', 'in_progress'].includes(s)) return 'running'
  if (['ready', 'todo', 'scheduled', 'blocked'].includes(s)) return 'queued'
  return null
}

/**
 * `[review]` を探すボード（`[job.board, 'mobile']`・重複除去・空文字除外）。SPEC V9 D42。
 * @param {unknown} jobBoard ジョブのボード
 * @returns {string[]} 走査するボード（先頭がジョブ自身のボード）
 */
export function reviewBoardsFor(jobBoard) {
  const own = String(jobBoard ?? '').trim()
  return [...new Set([own, DEFAULT_REVIEW_BOARD].filter(Boolean))]
}

/**
 * `reviewDir/sheets/` の中で「このジョブが書いた」Round 1 シートを 1 枚選ぶ（SPEC V9 D42）。
 *
 * `spec-<slug>-1.json` のような JSON シートだけを見る（HTML は対象外）。
 * `mtime >= job.startedAt - 猶予` の最新 1 枚を `sheets/<name>` の相対パスで返す。
 *
 * @param {string|null|undefined} reviewDir レビューディレクトリ（`sheets/` の親）
 * @param {{startedAt?: number}} job ジョブ
 * @param {{slackMs?: number}} [opts] 猶予（秒ズレ対策）
 * @returns {string|null} 相対パス（無ければ null）
 */
export function findRecentSheet(reviewDir, job, { slackMs = SPEC_MTIME_SLACK_MS } = {}) {
  const dir = reviewDir ? path.join(String(reviewDir), 'sheets') : ''
  if (!dir) return null
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null // ディレクトリが無い環境では無害に null
  }
  const since = Number(job?.startedAt ?? 0) - Number(slackMs)
  let best = null
  for (const entry of entries) {
    if (!entry?.isFile?.()) continue
    const name = String(entry.name ?? '')
    if (!/^spec-.+\.json$/i.test(name)) continue
    let mtime = 0
    try {
      mtime = Number(fs.statSync(path.join(dir, name)).mtimeMs)
    } catch {
      continue
    }
    if (mtime < since) continue
    if (!best || mtime > best.mtime) best = { name, mtime }
  }
  return best ? `sheets/${best.name}` : null
}

/**
 * ジョブの現在フェーズ（SPEC V9 D42）。`publicJob().phase` の実体。
 * @param {object} job ジョブ
 * @returns {'spawning'|'round1_sheet'|'awaiting_review'|'round2_spec'|'spec_ready'|'launched'|'failed'} フェーズ
 */
export function computePhase(job) {
  const status = String(job?.status ?? '').trim()
  if (status === 'failed') return 'failed'
  if (status === 'launched') return 'launched'
  if (status === 'spec_ready') return 'spec_ready'
  if (status === 'awaiting_review') return 'awaiting_review'
  // 一度 Review を通過して回答後に `awaiting_spec` へ戻った = Round 2（SPEC 執筆中）
  if (job?.reviewSeenOnce) return 'round2_spec'
  if (job?.sheetPath) return 'round1_sheet'
  return 'spawning'
}

/**
 * ジョブが停滞しているか（SPEC V9 D42）。
 *
 * Hermes Native は起票後にカンバンタスクが動くので、`running` / `awaiting_spec` のまま
 * `STALLED_AFTER_MS` を超えたら停滞とみなす（`queued` は人が着火待ちなので対象外）。
 *
 * @param {object} job ジョブ
 * @param {number} [at] 現在時刻（ミリ秒）
 * @returns {boolean} 停滞なら true
 */
export function isJobStalled(job, at = Date.now()) {
  const status = String(job?.status ?? '').trim()
  if (!['running', 'awaiting_spec'].includes(status)) return false
  if (String(job?.queueState ?? '').trim() === 'queued') return false
  const since = Number(job?.startedAt ?? job?.createdAt ?? 0)
  if (!Number.isFinite(since) || since <= 0) return false
  const elapsed = Number(at) - since
  return Number.isFinite(elapsed) && elapsed >= STALLED_AFTER_MS
}

/**
 * 保存するジョブの形（機密を持たない。種は先頭 400 字だけ）。
 * @param {object} job 内部ジョブ
 * @param {{at?: number}} [opts] 現在時刻（`stalled` の算出に使う）
 * @returns {object} 公開用
 */
export function publicJob(job, { at = Date.now() } = {}) {
  return {
    id: job.id,
    board: job.board,
    status: job.status,
    stage: job.stage ?? job.status,
    runner: job.runner,
    runnerLabel: runnerLabel(job.runner),
    requestedRunner: job.requestedRunner ?? job.runner ?? null,
    fallbackFrom: job.fallbackFrom ?? null,
    fallbackReason: job.fallbackReason ?? null,
    taskId: job.taskId ?? null,
    taskStatus: job.taskStatus ?? null,
    queueState: job.queueState ?? queueStateOf(job.taskStatus),
    executionPolicy: normalizeExecutionPolicy(job.executionPolicy),
    dismissed: Boolean(job.dismissed),
    reviewTaskId: job.reviewTaskId ?? null,
    reviewTitle: job.reviewTitle ?? null,
    reviewBoard: job.reviewBoard ?? null,
    phase: computePhase(job),
    stalled: isJobStalled(job, at),
    sheetPath: job.sheetPath ?? null,
    autoStart: Boolean(job.autoStart),
    seed: String(job.seedText ?? '').slice(0, 400),
    lang: job.lang,
    chat: job.chat ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    spec: job.spec ?? null,
    completedSpec: job.completedSpec ?? null,
    launched: job.launched ?? null,
    error: job.error ?? null,
  }
}

/**
 * Architect を作る。
 *
 * @param {object} [cfg] 設定（`reviewDir` / `pluginDataDir` / `hermesBin` / `dataDir`）
 * @param {object} [deps] 差し替え（テスト用）
 * @param {Function} [deps.runner] ランナー（`createCliRunner` の形）
 * @param {Function} [deps.listSpecs] SPEC 走査（既定 `specs.listSpecs`）
 * @param {Function} [deps.readTasks] ボードのタスク読み取り
 * @param {Function} [deps.launchSpec] 一括起票（既定 `specs.createSpecs().launchSpec`）
 * @param {Function} [deps.appendReport] `chat-reports.jsonl` 追記
 * @param {Function} [deps.now] 時刻
 * @param {Function} [deps.statSync] ディレクトリ確認
 * @returns {{seed: Function, jobs: Function, getConfig: Function, setConfig: Function, reset: Function}} 操作
 */
export function createArchitect(cfg = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const runner = deps.runner ?? createCliRunner(cfg)
  const listSpecsFn = deps.listSpecs ?? ((repoPath) => scanSpecs(repoPath))
  const readTasks = deps.readTasks ?? (() => [])
  const statSync = deps.statSync ?? ((p) => fs.statSync(p))
  const report =
    deps.appendReport ??
    ((row) => {
      try {
        return appendChatReport(cfg, row)
      } catch {
        return null // 記録に失敗しても起票や検知は止めない
      }
    })

  // 一括起票は specs.js の実装を使う（起票・スキップ判定・ラン記録を二重実装しない）
  let launchSpec = deps.launchSpec ?? null

  /** @type {Map<string, object>} */
  const jobs = new Map()

  const configPath = cfg.dataDir ? path.join(cfg.dataDir, 'architect-config.json') : null

  // 破棄したジョブ（リロード・再起動で復活させない）。SPEC V7 §3.1②
  const dismissedPath = cfg.dataDir ? path.join(cfg.dataDir, 'architect-dismissed.json') : null
  /** @type {Set<string>} */
  const dismissedIds = loadDismissed()

  /**
   * 破棄済みジョブ ID を読む（壊れた JSON・不在は空集合）。
   * @returns {Set<string>} ID 集合
   */
  function loadDismissed() {
    if (!dismissedPath) return new Set()
    try {
      const raw = JSON.parse(fs.readFileSync(dismissedPath, 'utf8'))
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.ids) ? raw.ids : []
      return new Set(list.map((v) => String(v ?? '').trim()).filter(Boolean))
    } catch {
      return new Set()
    }
  }

  /**
   * 破棄済みジョブ ID を保存する（最新 `DISMISSED_MAX` 件）。
   * @returns {boolean} 保存できたら true（`dataDir` 未設定ならファイルを持たないので true）
   */
  function saveDismissed() {
    if (!dismissedPath) return true
    const ids = [...dismissedIds].slice(-DISMISSED_MAX)
    try {
      fs.mkdirSync(path.dirname(dismissedPath), { recursive: true })
      fs.writeFileSync(dismissedPath, `${JSON.stringify({ ids }, null, 2)}\n`, { mode: 0o600 })
      return true
    } catch {
      return false // 保存に失敗してもジョブはメモリ上で破棄済みにする（再取得で戻るのは次善）
    }
  }

  /** ジョブが破棄済みか。 */
  function isDismissed(job) {
    return Boolean(job?.dismissed) || dismissedIds.has(String(job?.id ?? ''))
  }

  /** ジョブが終端（親 [ARCH] が done / archived）か。 */
  function isTerminal(job) {
    return TERMINAL_TASK_STATUSES.includes(String(job?.status ?? ''))
  }

  /**
   * 設定（既定 `{runner:'hermes'}`）。壊れた JSON も未知の値も既定へ戻す。
   * @returns {{runner: 'hermes'}} 設定
   */
  function getConfig() {
    if (!configPath) return { runner: DEFAULT_RUNNER }
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return { runner: sanitizeRunner(raw?.runner) }
    } catch {
      return { runner: DEFAULT_RUNNER }
    }
  }

  /**
   * ランナーを保存する（**`hermes` 以外は受け付けない**。SPEC V11 D50）。
   * @param {unknown} value ランナー
   * @returns {{ok: boolean, runner?: string, code?: string, error?: string}} 結果
   */
  function setConfig(value) {
    const raw = value?.runner ?? value
    if (!isSupportedRunner(raw)) {
      return { ok: false, code: 'INVALID_RUNNER', error: 'Only the Hermes Native runner is supported' }
    }
    if (configPath) {
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, `${JSON.stringify({ runner: DEFAULT_RUNNER }, null, 2)}\n`, { mode: 0o600 })
      } catch (e) {
        return { ok: false, code: 'WRITE_FAILED', error: e.message }
      }
    }
    return { ok: true, runner: DEFAULT_RUNNER }
  }

  /**
   * 仕様の種を撒く（202 で即答し、ランナーは背後で走る）。
   * @param {object} input `{repoPath, board, seedText, runner?, autoStart?, executionPolicy?, chat?, lang?}`
   * @returns {Promise<object>} `{ok, jobId, status, runner, executionPolicy, autoStart}` または `{ok:false, code, error}`
   */
  async function seed(input = {}) {
    const seedText = normalizeSeed(input.seedText)
    if (!seedText) return { ok: false, code: 'INVALID_SEED', error: 'seedText is required' }

    const board = String(input.board ?? '').trim()
    if (!BOARD_RE.test(board)) return { ok: false, code: 'INVALID_BOARD', error: 'board is invalid' }

    const repoPath = String(input.repoPath ?? '').trim()
    if (!repoPath || !path.isAbsolute(repoPath)) {
      return { ok: false, code: 'INVALID_REPO', error: 'repoPath must be an absolute path' }
    }
    try {
      if (!statSync(repoPath)?.isDirectory?.()) {
        return { ok: false, code: 'INVALID_REPO', error: 'repoPath is not a directory' }
      }
    } catch {
      return { ok: false, code: 'INVALID_REPO', error: 'repoPath does not exist' }
    }

    if (!isSupportedRunner(input.runner ?? getConfig().runner)) {
      return { ok: false, code: 'INVALID_RUNNER', error: 'Only the Hermes Native runner is supported' }
    }
    const runnerId = DEFAULT_RUNNER

    const startedAt = now()
    const executionPolicy = normalizeExecutionPolicy(input.executionPolicy)
    const job = {
      id: makeJobId(startedAt),
      board,
      repoPath,
      status: 'running',
      runner: runnerId,
      requestedRunner: runnerId,
      fallbackFrom: null,
      fallbackReason: null,
      taskId: null,
      taskStatus: null,
      queueState: null,
      executionPolicy,
      dismissed: false,
      reviewTaskId: null,
      reviewTitle: null,
      mode: 'kanban',
      prompt: '',
      autoStart: Boolean(input.autoStart),
      seedText,
      lang: input.lang === 'en' ? 'en' : 'ja',
      chat: input.chat ? String(input.chat).slice(0, 128) : null,
      createdAt: startedAt,
      startedAt,
      finishedAt: null,
      spec: null,
      completedSpec: null,
      launched: null,
      launchStarted: false,
      error: null,
    }
    jobs.set(job.id, job)
    trimJobs()

    // SPEC V11 D54: 推奨スラッグと既存 SPEC 一覧を先に決めてプロンプトへ入れる
    // （Round 1 の探索ターンとファイル名衝突を減らす）。
    // D91: アクティブ SPEC で使用済みのバッチ ID 接頭辞も渡し、ID の衝突を防ぐ。
    const suggestedSlug = suggestSpecSlug(seedText, job.id)
    let specScan = []
    try {
      specScan = listSpecsFn(repoPath) ?? []
    } catch {
      specScan = []
    }
    const existingSpecs = recentSpecPaths(() => specScan, repoPath)
    const usedBatchPrefixes = usedBatchIdPrefixes(specScan)
    job.suggestedSlug = suggestedSlug

    const prompt = buildSeedPrompt({
      jobId: job.id,
      seedText,
      board,
      repoPath,
      autoStart: job.autoStart,
      executionPolicy,
      lang: job.lang,
      suggestedSlug,
      existingSpecs,
      usedBatchPrefixes,
    })
    job.prompt = prompt

    // 背後の実行。落ちてもジョブに理由を残すだけで、呼び出し元は待たない。
    void Promise.resolve()
      .then(() =>
        runner({
          runnerId,
          prompt,
          repoPath,
          board,
          seedText,
          jobId: job.id,
          executionPolicy,
          lang: job.lang,
          suggestedSlug,
          existingSpecs,
          usedBatchPrefixes,
        }),
      )
      .then(async (res) => {
        job.finishedAt = now()
        const code = typeof res?.code === 'number' ? res.code : 0
        const taskId = res?.taskId ?? parseCreatedTask(res?.stdout)?.id ?? null
        if (code !== 0) {
          // 失敗しても自動で別経路の起票へ切り替えない（二重稼働・重複起票を根絶）。
          // 再試行は UI の明示操作（1 タップ再試行）だけ。
          const reason = String(res?.stderr || res?.stdout || `runner exited with ${code}`).trim()
          job.status = 'failed'
          job.error = reason.slice(0, 600)
          return
        }
        if (taskId) job.taskId = taskId
        job.status = 'awaiting_spec'
      })
      .catch((e) => {
        job.finishedAt = now()
        job.status = 'failed'
        job.error = String(e?.message ?? e).slice(0, 600)
      })

    return {
      ok: true,
      jobId: job.id,
      status: job.status,
      runner: runnerId,
      executionPolicy,
      autoStart: job.autoStart,
    }
  }

  /** 古いジョブを落とす（メモリだけの保持）。 */
  function trimJobs() {
    if (jobs.size <= JOBS_MAX) return
    const ordered = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
    while (ordered.length > JOBS_MAX) {
      const old = ordered.shift()
      jobs.delete(old.id)
    }
  }

  /**
   * ジョブの進み具合と、完成 SPEC・未起票 SPEC を返す。
   * @param {{board?: string, repoPath?: string, include?: {repoPath?: string, board?: string}, includeDismissed?: boolean, strictBoard?: boolean}} [query] 絞り込み
   *   `include` はジョブが 1 つも無いボードでも「未起票 SPEC」を数えるための追加走査先
   *   `includeDismissed` は破棄済みジョブも返す（監査・テスト用。既定は除外）
   *   `strictBoard` は選択中ボードと完全一致するジョブだけに絞る（V7 互換。既定はボード横断）
   * @returns {Promise<object>} `{ok, board, runner, capabilities, jobs, specReady, pending}`
   */
  async function jobsFor(query = {}) {
    const board = String(query.board ?? '').trim()
    const at = now()
    // D42: 既定は「アクティブで未破棄なジョブ」をボード・リポジトリ横断で返す。
    // 別ボードで撒いた種でも進行バーが消えないようにするため（`strictBoard: true` で V7 互換）。
    const mine = [...jobs.values()]
      .filter((j) => {
        const sameBoard = !board || j.board === board
        const sameRepo = !query.repoPath || j.repoPath === query.repoPath
        if (query.strictBoard === true) return sameBoard && sameRepo
        if (sameBoard && sameRepo) return true
        if (query.includeDismissed) return true
        return !isDismissed(j) && !isTerminal(j) && ACTIVE_JOB_STATUSES.includes(String(j.status ?? '').trim())
      })
      .sort((a, b) => b.createdAt - a.createdAt)

    // リポジトリごとに 1 回だけ SPEC を走査する
    const specsByRepo = new Map()
    const specsOf = (repoPath) => {
      if (!specsByRepo.has(repoPath)) {
        let list = []
        try {
          list = listSpecsFn(repoPath) ?? []
        } catch {
          list = []
        }
        specsByRepo.set(repoPath, Array.isArray(list) ? list : [])
      }
      return specsByRepo.get(repoPath)
    }

    // 先に「他のジョブが取った SPEC」を集める（新しいジョブが横取りしない）
    const taken = new Set()
    for (const job of [...mine].reverse()) {
      if (job.spec) taken.add(String(job.spec))
    }

    for (const job of [...mine].reverse()) {
      if (!['awaiting_spec', 'awaiting_review', 'running'].includes(job.status) || job.spec) continue
      const found = findJobSpec(job, specsOf(job.repoPath), { taken })
      if (!found) continue
      taken.add(String(found.path))
      job.spec = found.path
      job.status = 'spec_ready'
      job.completedSpec = {
        path: found.path,
        title: found.title,
        batchCount: (found.batches ?? []).length,
        batches: (found.batches ?? []).map((b) => ({ id: b.id, title: b.title, mode: b.mode ?? null })),
      }
      report({
        kind: SPEC_READY_KIND,
        board: job.board,
        jobId: job.id,
        spec: found.path,
        title: found.title,
        batchCount: job.completedSpec.batchCount,
        autoStart: job.autoStart,
        originSessionId: job.chat,
        at: now(),
      })
    }

    // カンバンのタスク状態をジョブへ写す（`awaiting_review` 検知・failed 同期。SPEC V6 §3.2）
    const tasksByBoard = new Map()
    const tasksOf = (slug) => {
      const key = String(slug ?? '')
      if (!tasksByBoard.has(key)) {
        let list = []
        try {
          list = readTasks(key) ?? []
        } catch {
          list = []
        }
        tasksByBoard.set(key, Array.isArray(list) ? list : [])
      }
      return tasksByBoard.get(key)
    }

    // D42: Round 1 の中間シート（review/sheets/spec-*.json）を観測する（phase / sheetPath の材料）。
    // 早期フェーズのジョブだけ見る（毎ポーリングで全ジョブ分の readdir をしない）。
    if (cfg.reviewDir) {
      for (const job of mine) {
        if (job.sheetPath) continue
        if (!['running', 'awaiting_spec', 'awaiting_review'].includes(job.status)) continue
        try {
          job.sheetPath = findRecentSheet(cfg.reviewDir, job)
        } catch {
          job.sheetPath = null
        }
      }
    }

    for (const job of mine) {
      if (!['running', 'awaiting_spec', 'awaiting_review'].includes(job.status)) continue
      const tasks = tasksOf(job.board)
      const self = job.taskId ? tasks.find((t) => t && String(t.id) === String(job.taskId)) ?? null : null
      job.taskStatus = self?.status ? String(self.status) : null
      job.queueState = queueStateOf(job.taskStatus)
      if (job.spec) continue // 完成 SPEC を検知済み（spec_ready / launched）
      // D42: `[review]` は job.board に加えて `mobile` ボードも探す（他ボード起点の種まき対策）
      // 親 `[ARCH]` が先に done になっても、別タスクの `[review]` が blocked の間は終端に落とさず待つ。
      let review = null
      for (const slug of reviewBoardsFor(job.board)) {
        const found = findJobReviewTask(job, tasksOf(slug))
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
        // 一度でも回答待ちを観測した = 以降は Round 2（SPEC 執筆中）として扱う
        job.reviewSeenOnce = true
        continue
      }
      // 親 [ARCH] が終端（done / archived）なら、SPEC 未検知でもジョブを終端にする。
      // ただし Round 1 を通過した `[review]` タスクが別タスクとして ready / running で進行中なら、
      // 親が閉じていても Round 2（`awaiting_spec`）として追い続ける。
      if (self && TERMINAL_TASK_STATUSES.includes(String(self.status))) {
        let activeReview = null
        if (job.reviewSeenOnce) {
          for (const slug of reviewBoardsFor(job.board)) {
            const found = findActiveJobReviewTask(job, tasksOf(slug))
            if (found) {
              activeReview = { ...found, board: slug }
              break
            }
          }
        }
        if (activeReview) {
          job.status = 'awaiting_spec'
          job.taskStatus = activeReview.status
          job.queueState = queueStateOf(activeReview.status)
          job.reviewTaskId = null
          job.reviewTitle = null
          job.reviewBoard = null
          continue
        }
        job.status = String(self.status)
        job.queueState = null
        job.reviewTaskId = null
        job.reviewTitle = null
        job.reviewBoard = null
        job.finishedAt = job.finishedAt ?? now()
        continue
      }
      if (self && self.status === 'failed') {
        job.status = 'failed'
        job.error = String(self.result || job.error || 'Architect task failed').slice(0, 600)
        continue
      }
      // 回答が返ってレビューが blocked でなくなったら「仕様書執筆中」へ戻す
      job.reviewTaskId = null
      job.reviewTitle = null
      job.reviewBoard = null
      if (job.status === 'awaiting_review') job.status = 'awaiting_spec'
    }

    // 公開表現の `stage`（カンバンタスクが動いている間は running として見せる）
    for (const job of mine) {
      job.stage =
        job.status === 'awaiting_spec' && ['running', 'claimed'].includes(String(job.taskStatus ?? ''))
          ? 'running'
          : job.status
    }

    // 進行バーに出すジョブ（破棄済み・終端は既定で落とす）。SPEC V7 §3.1②
    const visible = mine.filter((job) => !isTerminal(job) && (query.includeDismissed || !isDismissed(job)))

    // autoStart: 完成 SPEC の未起票バッチを 1 回だけ起票する
    for (const job of visible) {
      if (!job.autoStart || job.status !== 'spec_ready' || job.launchStarted) continue
      job.launchStarted = true
      let tasks = []
      try {
        tasks = readTasks(job.board) ?? []
      } catch {
        tasks = []
      }
      const spec = specsOf(job.repoPath).find((s) => s.path === job.spec) ?? null
      const pending = spec ? pendingSpecs([spec], tasks) : []
      if (!spec || !pending.length) {
        // 既に起票済み（別経路で人が起票した）なら成功と同じ扱いで閉じる
        job.status = 'launched'
        job.launched = { ok: true, created: [], skipped: [], failed: [], reason: 'nothing-pending' }
        continue
      }
      try {
        if (!launchSpec) {
          const { createSpecs } = await import('./specs.js')
          launchSpec = createSpecs(cfg, { tasks: readTasks }).launchSpec
        }
        const res = await launchSpec({
          repoPath: job.repoPath,
          board: job.board,
          specRelPath: job.spec,
          batchIds: pending[0].pending,
          chat: job.chat ?? undefined,
          lang: job.lang,
        })
        job.status = 'launched'
        job.launched = {
          ok: Boolean(res?.ok),
          runId: res?.runId ?? null,
          created: (res?.created ?? []).map((c) => ({ id: c.id, taskId: c.taskId ?? null })),
          skipped: (res?.skipped ?? []).map((s) => ({ id: s.id, taskId: s.taskId ?? null })),
          failed: res?.failed ?? [],
          error: res?.error ?? null,
        }
        report({
          kind: SPEC_LAUNCH_KIND,
          board: job.board,
          jobId: job.id,
          spec: job.spec,
          created: job.launched.created.length,
          skipped: job.launched.skipped.length,
          failed: job.launched.failed.length,
          autoStart: true,
          originSessionId: job.chat,
          at: now(),
        })
      } catch (e) {
        job.status = 'spec_ready'
        job.launched = { ok: false, created: [], skipped: [], failed: [], error: String(e?.message ?? e).slice(0, 400) }
      }
    }

    // 未起票の SPEC（Seed と関係なくても、新しく置かれた SPEC を拾う）
    const pending = []
    const seenRepo = new Set()
    const scans = visible.map((job) => ({ repoPath: job.repoPath, board: job.board }))
    if (query.include?.repoPath) scans.push({ repoPath: query.include.repoPath, board: query.include.board ?? board })
    for (const scan of scans) {
      if (seenRepo.has(scan.repoPath)) continue
      seenRepo.add(scan.repoPath)
      let tasks = []
      try {
        tasks = readTasks(scan.board) ?? []
      } catch {
        tasks = []
      }
      for (const row of pendingSpecs(specsOf(scan.repoPath), tasks)) {
        pending.push({ ...row, board: scan.board, repoPath: scan.repoPath })
      }
    }

    const specReady = visible
      .filter((j) => j.completedSpec && (j.status === 'spec_ready' || j.status === 'launched'))
      .map((j) => ({
        jobId: j.id,
        board: j.board,
        repoPath: j.repoPath,
        spec: j.completedSpec.path,
        title: j.completedSpec.title,
        batchCount: j.completedSpec.batchCount,
        batches: j.completedSpec.batches,
        autoStart: j.autoStart,
        launched: j.status === 'launched',
        launchedCount: j.launched?.created?.length ?? 0,
      }))

    return {
      ok: true,
      board: board || null,
      runner: getConfig().runner,
      jobs: visible.map((job) => publicJob(job, { at })),
      specReady,
      pending,
    }
  }

  /**
   * ジョブを破棄する（サーバー側に永続化し、リロード・再起動で復活させない）。SPEC V7 §3.1②。
   *
   * 破棄は**監査のための記録**であってタスクの削除ではない（カンバン側は触らない）。
   * @param {unknown} jobId ジョブ ID
   * @returns {{ok: boolean, jobId?: string, persisted?: boolean, code?: string, error?: string}} 結果
   */
  function dismiss(jobId) {
    const id = String(jobId ?? '').trim()
    if (!id) return { ok: false, code: 'INVALID_JOB_ID', error: 'jobId is required' }
    const job = jobs.get(id) ?? null
    if (!job && !dismissedIds.has(id)) return { ok: false, code: 'JOB_NOT_FOUND', error: 'job not found' }
    if (job) {
      job.dismissed = true
      job.dismissedAt = now()
    }
    dismissedIds.add(id)
    trimDismissed()
    const persisted = saveDismissed() && dismissedPath !== null
    return { ok: true, jobId: id, persisted }
  }

  /** 破棄 ID の保持数を上限へ丸める（古いものから落とす）。 */
  function trimDismissed() {
    while (dismissedIds.size > DISMISSED_MAX) {
      const oldest = dismissedIds.values().next().value
      if (oldest == null) break
      dismissedIds.delete(oldest)
    }
  }

  /** テスト用にジョブを捨てる。 */
  function reset() {
    jobs.clear()
    dismissedIds.clear()
  }

  return { seed, jobs: jobsFor, dismiss, getConfig, setConfig, reset }
}
