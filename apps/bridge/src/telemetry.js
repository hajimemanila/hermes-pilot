import fs from 'node:fs'
import path from 'node:path'
import { readTailText } from './tail.js'
import { extractTaskSpec, readRuns, runsPathFor } from './specs.js'

/**
 * Zero-Typing 実行サマリ（完了レシート）の集計（SPEC-PILOT-V5 §3.3 ③ / D26③）。
 *
 * ここは **読み取り専用** の集計だけを行う:
 *  - `state.db`（usage.js 経由・全プロファイル合算）… コスト / キャッシュ率 / トークン / ツール回数
 *  - `kanban` … 完了タスク数と所要時間（Spec ラン or ボード）
 *  - `review/pipeline-reports.jsonl` … 直近の完走レポート（counts・Markdown・タスク result）
 *  - `audit.jsonl` … 人間のタップ数（レビュー回答 / 1 タップ検収 / 赤入れ）と手入力文字数
 *
 * 方針:
 *  - **ファイル欠損・DB ロック・スキーマ違いで 500 を返さない**。欠けた項目は `null` に落とし、
 *    どのソースが読めなかったかを `missing` に列挙する（UI 側で「データ無し」を出す）。
 *  - 金額の推定は**保守的**に。`savedUsd` は「キャッシュヒット分の入力単価差額」の概算で、
 *    UI 注記（`receipt.savedNote`）で概算である旨を必ず出す。
 */

/** 既定の集計窓（時間）。 */
const DEFAULT_HOURS = 24

/**
 * 手入力の「1 アクション」換算文字数。
 * ゼロタイピング度合い（`zeroTypingScore`）で、打鍵をタップと同列に比較するための粗い換算。
 */
export const TYPED_CHARS_PER_ACTION = 40

/**
 * キャッシュヒットによる割引率（概算）。cache read は入力単価の約 1/10（≒90% 引き）で、
 * その割引は **既に `cost` に反映済み**。よって節約見込額は実コストから逆算する
 * （トークン数×単価で積むと、state.db の単価仮定と二重計上になって実コストを大きく超える）。
 */
const CACHE_SAVINGS_RATIO = 0.9

/** 1 タップと数える audit 種別（既定 1 回、`choiceCount` があればその数）。 */
const TAP_KINDS = new Set(['review.answer', 'review.approve', 'review.annotation', 'kanban.close', 'kanban.unblock'])

/** 赤入れ（Annotation 送信）として数える audit 種別。 */
const REDLINE_KINDS = new Set(['review.annotation'])

/** 手入力文字数として数える audit 種別（`chars` フィールドを持つもの）。 */
const TYPED_KINDS = new Set(['kanban.comment', 'kanban.create', 'review.reopen'])

/** audit.jsonl から読む末尾バイト数。 */
const AUDIT_TAIL_BYTES = 512 * 1024

/** テスト合格件数を拾う正規表現（英語・日本語の両方）。 */
const TEST_PATTERNS = [
  /(\d+)\s*(?:tests?|テスト)\s*(?:green|passed|pass|ok|合格)/gi,
  /(?:tests?|テスト)\s*[=:：]?\s*(\d+)/gi,
  /(\d+)\s*件の?テスト/gi,
]

/** PWA チェック件数を拾う正規表現。 */
const PWA_PATTERNS = [/(?:checks?|チェック)\s*[=:：]?\s*(\d+)/gi, /pwa[^\n]{0,24}?(\d+)/gi]

/**
 * キャッシュヒット率（0〜1）。分母が 0 なら `null`。
 *
 * `usage.js` と同じ定義（`cacheRead / (input + cacheRead)`）を使う。
 * @param {{input?: number, cacheRead?: number}|null} totals 合計
 * @returns {number|null} 0〜1（算出不能なら null）
 */
export function cacheHitRate(totals) {
  if (!totals) return null
  const input = Math.max(0, Number(totals.input) || 0)
  const cacheRead = Math.max(0, Number(totals.cacheRead) || 0)
  const denom = input + cacheRead
  if (denom <= 0) return null
  return cacheRead / denom
}

/**
 * キャッシュ分の節約見込額（USD・概算）。
 *
 * `cost` に反映済みのキャッシュ割引を、キャッシュヒット率から保守的に逆算する:
 * `cost × cacheHitRate × ratio`。実コストを超えないので「盛った数字」にならない。
 *
 * @param {{cost?: number, input?: number, cacheRead?: number}|null} totals 合計
 * @param {{ratio?: number}} [opts] 割引率（テスト・将来の設定用）
 * @returns {number|null} USD（算出不能なら null）
 */
export function estimateSavedUsd(totals, opts = {}) {
  if (!totals) return null
  const cost = Math.max(0, Number(totals.cost) || 0)
  const rate = cacheHitRate(totals)
  if (!cost || rate === null || rate <= 0) return null
  const ratio = Number.isFinite(Number(opts.ratio)) ? Math.min(1, Math.max(0, Number(opts.ratio))) : CACHE_SAVINGS_RATIO
  // 4 桁で丸める（小口でも 0 に潰さない）
  return Math.round((cost * rate * ratio + Number.EPSILON) * 10000) / 10000
}

/**
 * ゼロタイピング度合い（0〜100 の整数・算出不能なら null）。
 *
 * タップ（人間の判断 1 回）と手入力を同じ土俵にするため、手入力は
 * `TYPED_CHARS_PER_ACTION` 文字で 1 アクションに換算する。
 * 例: タップ 20・赤入れ 2・入力 0 文字 → 100。
 *
 * @param {{humanTaps?: number, redlines?: number, typedChars?: number}} ops 操作メトリクス
 * @returns {number|null} 0〜100
 */
export function zeroTypingScore(ops = {}) {
  const taps = Math.max(0, Number(ops.humanTaps) || 0) + Math.max(0, Number(ops.redlines) || 0)
  const typed = Math.max(0, Number(ops.typedChars) || 0)
  const typedActions = Math.ceil(typed / TYPED_CHARS_PER_ACTION)
  const total = taps + typedActions
  if (total <= 0) return null
  return Math.round((taps / total) * 100)
}

/**
 * audit.jsonl の行から操作メトリクスを集計する。
 *
 * @param {Array<string|object>} lines JSONL の行（文字列 or パース済みオブジェクト）
 * @param {{since?: number}} [opts] この epoch ms より新しい行だけ数える
 * @returns {{humanTaps: number, redlines: number, typedChars: number, entries: number}} 集計
 */
export function summarizeAudit(lines, opts = {}) {
  const since = Number(opts.since) || 0
  const out = { humanTaps: 0, redlines: 0, typedChars: 0, entries: 0 }
  for (const line of Array.isArray(lines) ? lines : []) {
    let row = line
    if (typeof line === 'string') {
      if (!line.trim()) continue
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
    }
    if (!row || typeof row !== 'object') continue
    const kind = String(row.kind ?? '')
    if (!kind) continue
    const at = Date.parse(String(row.at ?? ''))
    if (since > 0 && Number.isFinite(at) && at <= since) continue
    out.entries += 1
    if (TAP_KINDS.has(kind)) {
      const n = Math.max(0, Number(row.choiceCount) || 0)
      out.humanTaps += Math.max(1, n)
    }
    if (REDLINE_KINDS.has(kind) && row.ok !== false) out.redlines += 1
    if (TYPED_KINDS.has(kind)) {
      const chars = Number(row.chars)
      if (Number.isFinite(chars) && chars > 0) out.typedChars += chars
    }
  }
  return out
}

/**
 * テキスト群からテスト合格件数・PWA チェック件数を拾う（最新の検証結果ヒント）。
 *
 * タスク `result` やレポート Markdown は自由文なので、**取れたら使う** 程度の扱い。
 * 拾えなければ `null`。
 *
 * @param {Array<string|null|undefined>} texts 対象テキスト
 * @returns {{tests: number|null, pwaChecks: number|null}} 件数
 */
export function extractTestCounts(texts) {
  const haystack = (Array.isArray(texts) ? texts : []).filter(Boolean).map(String).join('\n')
  const maxOf = (patterns) => {
    let best = null
    for (const re of patterns) {
      for (const m of haystack.matchAll(re)) {
        const n = Number(m[1])
        if (!Number.isFinite(n) || n <= 0) continue
        if (best === null || n > best) best = n
      }
    }
    return best
  }
  return { tests: maxOf(TEST_PATTERNS), pwaChecks: maxOf(PWA_PATTERNS) }
}

/**
 * Spec パスの照合（`docs/SPEC-V5.md` と絶対パス・`./` 付きを同一視する）。
 *
 * @param {string|null|undefined} a レポート側の spec
 * @param {string|null|undefined} b 要求側の spec
 * @returns {boolean} 一致するか（要求が空なら true）
 */
export function sameSpec(a, b) {
  const want = String(b ?? '').trim()
  if (!want) return true
  const got = String(a ?? '').trim()
  if (!got) return false
  const norm = (s) => s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const x = norm(got)
  const y = norm(want)
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

/**
 * 時刻値を epoch ms へ正規化する（epoch 秒・ms・ISO 文字列・不正値をすべて受ける）。
 *
 * カンバン DB は **秒**（`started_at`）、API 応答は **ms**（`startedAt`）なので、
 * 1e12 未満は秒として扱う。0 以下・解釈不能は `0`（＝区間なし）。
 *
 * @param {unknown} value 時刻
 * @returns {number} epoch ms（不明なら 0）
 */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const raw = String(value).trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return toMs(Number(raw))
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** タスクの ID（camel / snake 両対応）。 */
function taskIdOf(task) {
  return String(task?.id ?? task?.taskId ?? '').trim()
}

/** タスクの開始時刻（ms）。`startedAt` が無ければ `createdAt`。 */
function taskStartMs(task) {
  return toMs(task?.startedAt ?? task?.started_at) || toMs(task?.createdAt ?? task?.created_at)
}

/** タスクの完了時刻（ms）。未完了は 0。 */
function taskEndMs(task) {
  return toMs(task?.completedAt ?? task?.completed_at)
}

/**
 * タスクが持つ Spec パス（命名ゆれを吸収）。
 *
 * `specs.extractTaskSpec` と**同じ規約**（`spec` → 本文の `Spec:` 行 → 先頭 5 行の
 * `docs/SPEC-*.md`）に寄せ、集計・照合・起票判定で別々の解釈をしない（D91 ④）。
 *
 * @param {object} task タスク
 * @returns {string|null} SPEC 相対パス
 */
export function taskSpecOf(task) {
  const direct = String(task?.specRelPath ?? task?.specPath ?? task?.spec_path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
  return direct || extractTaskSpec(task)
}

/**
 * バッチ ID（タイトル先頭の `[ID]`、無ければ本文の `Batch: <id> — ...` 固定ヘッダ）。
 *
 * `specs.buildTaskBody` が書く `Batch:` 行を読むので、タイトルを変えたタスクでも
 * ID を見失わない（D91 ③）。
 *
 * @param {object} task タスク
 * @returns {string|null} バッチ ID
 */
export function batchIdOf(task) {
  const m = /^\s*\[([^\]]{1,32})\]/.exec(String(task?.title ?? ''))
  if (m && m[1].trim()) return m[1].trim()
  const header = /^Batch:\s*([A-Za-z][A-Za-z0-9._-]{0,15})\s*(?:—|–|-{1,2}|:)(?:\s|$)/m.exec(String(task?.body ?? ''))
  return header ? header[1] : null
}

/**
 * 重なり合う区間を 1 本にマージする（並列タスクの二重計上を消す）。
 *
 * 例: `[[0, 60], [30, 90], [200, 230]]` → `[[0, 90], [200, 230]]`（合計 120 分。
 * 単純な差分だと 150 分になる）。
 *
 * @param {Array<[number, number]>} intervals 区間（ms）
 * @returns {Array<[number, number]>} マージ済み（開始昇順・負区間は捨てる）
 */
export function mergeIntervals(intervals) {
  const list = (Array.isArray(intervals) ? intervals : [])
    .map((pair) => [Number(pair?.[0]) || 0, Number(pair?.[1]) || 0])
    .filter(([s, e]) => e > s && s >= 0)
    .sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of list) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/**
 * 対象 Spec / Run に属するタスクだけを残す（時間・バッチ計算の入口）。
 *
 * 優先順位:
 *  1. `opts.taskIds`（`pipeline-runs.json` のラン記録）との ID 一致
 *  2. タスク自身が持つ Spec パスと `opts.spec` の一致
 *  3. タイトル先頭の `[BatchID]` が `opts.batchIds` に含まれる
 *
 * どれも指定されていなければ **絞り込まない**（ボード全体の集計）。Spec を指定して
 * 1 件も一致しなければ空を返す（別タスクで補完しない）。
 *
 * @param {Array<object>} tasks タスク
 * @param {{spec?: string|null, taskIds?: Array<string>, batchIds?: Array<string>}} [opts] スコープ
 * @returns {{tasks: Array<object>, scoped: boolean, taskIds: Array<string>, batchIds: Array<string>}} 絞り込み結果
 */
export function selectSpecTasks(tasks, opts = {}) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : []
  const spec = String(opts.spec ?? '').trim()
  const taskIds = [...new Set((Array.isArray(opts.taskIds) ? opts.taskIds : []).map((v) => String(v)).filter(Boolean))]
  const batchIds = [...new Set((Array.isArray(opts.batchIds) ? opts.batchIds : []).map((v) => String(v)).filter(Boolean))]
  const idSet = new Set(taskIds)
  const batchSet = new Set(batchIds)
  if (!spec && !idSet.size && !batchSet.size) {
    return { tasks: list, scoped: false, taskIds: [], batchIds: [] }
  }
  const matched = list.filter((task) => {
    if (idSet.size && idSet.has(taskIdOf(task))) return true
    if (spec && sameSpec(taskSpecOf(task), spec)) return true
    const batch = batchIdOf(task)
    return Boolean(batch && batchSet.has(batch))
  })
  return { tasks: matched, scoped: true, taskIds, batchIds }
}

/**
 * `pipeline-runs.json` のラン記録から対象 Spec / ボードのランを選ぶ（最新優先）。
 *
 * @param {Array<object>} runs ラン記録
 * @param {{spec?: string|null, board?: string|null, tasks?: Array<object>}} [opts] 条件
 * @returns {object|null} ラン（無ければ null）
 */
export function pickSpecRun(runs, opts = {}) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r === 'object')
  if (!list.length) return null
  const spec = String(opts.spec ?? '').trim()
  const board = String(opts.board ?? '').trim()
  const onBoard = list.filter((r) => !board || !r.board || String(r.board) === board)
  const newest = (arr) =>
    arr.slice().sort((a, b) => (Number(b.createdAt ?? 0) || 0) - (Number(a.createdAt ?? 0) || 0))[0] ?? null
  if (spec) {
    const hit = onBoard.filter((r) => sameSpec(r.specRelPath ?? r.spec, spec))
    if (hit.length) return newest(hit)
  }
  const ids = new Set((Array.isArray(opts.tasks) ? opts.tasks : []).map(taskIdOf).filter(Boolean))
  if (ids.size) {
    const hit = onBoard.filter((r) => Array.isArray(r.taskIds) && r.taskIds.some((id) => ids.has(String(id))))
    if (hit.length) return newest(hit)
  }
  return null
}

/**
 * タスク群から status 件数と所要時間を出す。
 *
 * 所要時間は **並列区間をマージした実稼働時間**（`durationMin` = `activeDurationMin`）と
 * 単純経過時間（`wallDurationMin`）の 2 本立て:
 *  - 実稼働: 各タスクの `[start, end]` を昇順ソートし、重なり（`a2 <= b1`）をマージした合計
 *  - 経過: `min(start)` 〜 `max(end)`（参考値）
 *
 * 集計窓（`since`）より前に始まった区間は窓の開始へ切り上げ、`durationCapped` を立てる
 * （「33,000 分」のような数字を出さないための既存の安全弁）。実行中タスクの終端は
 * `opts.now` が渡されたときだけ `now` で閉じる（渡さないと際限なく伸びるため）。
 *
 * @param {Array<object>} tasks タスク（camel / snake 両対応）
 * @param {{since?: number, now?: number, spec?: string|null, taskIds?: Array<string>, batchIds?: Array<string>}} [opts] 条件
 * @returns {{
 *   batchesDone: number, batchesTotal: number, durationMin: number|null,
 *   activeDurationMin: number|null, wallDurationMin: number|null,
 *   durationCapped: boolean, intervalCount: number, startMs: number, endMs: number, scoped: boolean
 * }} 集計
 */
export function summarizeTasks(tasks, opts = {}) {
  const since = Number(opts.since) || 0
  const nowMs = Number(opts.now) || 0
  const scoped = selectSpecTasks(tasks, opts)
  const list = scoped.tasks
  const done = list.filter((t) => String(t?.status ?? '') === 'done').length
  const intervals = []
  let capped = false
  for (const task of list) {
    const start = taskStartMs(task)
    const end = taskEndMs(task)
    let s = 0
    let e = 0
    if (start > 0 && end > start) {
      s = start
      e = end
    } else if (start > 0 && end <= 0 && nowMs > start) {
      // 実行中（completedAt がまだ無い）: now が分かっているときだけ閉じる
      s = start
      e = nowMs
    } else {
      continue
    }
    if (since > 0 && s < since) {
      capped = true
      s = since
    }
    if (nowMs > 0 && e > nowMs) e = nowMs
    if (e > s) intervals.push([s, e])
  }
  const merged = mergeIntervals(intervals)
  const activeMs = merged.reduce((acc, [s, e]) => acc + (e - s), 0)
  const toMin = (ms) => (ms > 0 ? Math.max(1, Math.round(ms / 60000)) : null)
  const durationMin = toMin(activeMs)
  const first = merged.length ? merged[0][0] : 0
  const last = merged.length ? merged[merged.length - 1][1] : 0
  const batchesTotal = list.length || (Array.isArray(opts.batchIds) ? opts.batchIds.length : 0)
  return {
    batchesDone: done,
    batchesTotal,
    durationMin,
    activeDurationMin: durationMin,
    wallDurationMin: toMin(last - first),
    durationCapped: capped,
    intervalCount: merged.length,
    startMs: first,
    endMs: last,
    scoped: scoped.scoped,
  }
}

/**
 * `usage.scoped()` の結果から KPI 用の 2 値（API コール数・合計トークン数）を取り出す。
 *
 * 合計トークンは `input + output + cacheRead + cacheWrite`（`usage.js` と同じ定義）。
 * スコープ集計が失敗していれば `null`（＝「—」。0 と区別する）。
 *
 * @param {{ok?: boolean, apiCalls?: number, totalTokens?: number, totals?: object}|null} scope スコープ集計
 * @returns {{apiCalls: number|null, totalTokens: number|null, sessions: number|null}} KPI 値
 */
export function usageKpis(scope) {
  if (!scope) return { apiCalls: null, totalTokens: null, sessions: null }
  if (scope.ok === false) return { apiCalls: null, totalTokens: null, sessions: null }
  const totals = scope.totals ?? {}
  const num = (v) => Math.max(0, Number(v) || 0)
  const apiCalls = Number.isFinite(Number(scope.apiCalls)) ? num(scope.apiCalls) : num(totals.calls)
  const totalTokens = Number.isFinite(Number(scope.totalTokens))
    ? num(scope.totalTokens)
    : num(totals.input) + num(totals.output) + num(totals.cacheRead) + num(totals.cacheWrite)
  return { apiCalls, totalTokens, sessions: num(totals.sessions) }
}

/**
 * 集計済みの材料から Receipt データを組み立てる（純関数・テスト対象）。
 *
 * @param {{
 *   board?: string|null,
 *   spec?: string|null,
 *   label?: string|null,
 *   generatedAt?: number,
 *   hours?: number,
 *   taskIds?: Array<string>,
 *   batchIds?: Array<string>,
 *   usage?: {totals?: object, cacheHitRate?: number|null, models?: Array<object>}|null,
 *   usageScope?: {ok?: boolean, apiCalls?: number, totalTokens?: number, totals?: object, scope?: object}|null,
 *   report?: {status?: string, label?: string|null, markdown?: string, counts?: object|null, at?: number}|null,
 *   tasks?: Array<object>,
 *   ops?: {humanTaps?: number, redlines?: number, typedChars?: number}|null,
 *   missing?: Array<string>,
 * }} input 材料
 * @returns {object} `/api/telemetry/receipt` の応答
 */
export function buildReceipt(input = {}) {
  const generatedAt = Number(input.generatedAt) || Date.now()
  const hours = Math.min(Math.max(Number(input.hours) || DEFAULT_HOURS, 1), 24 * 30)
  const totals = input.usage?.totals ?? null
  const rate = Number.isFinite(Number(input.usage?.cacheHitRate)) ? Number(input.usage.cacheHitRate) : cacheHitRate(totals)
  const savedUsd = estimateSavedUsd(totals)
  const ops = {
    humanTaps: Math.max(0, Number(input.ops?.humanTaps) || 0),
    redlines: Math.max(0, Number(input.ops?.redlines) || 0),
    typedChars: Math.max(0, Number(input.ops?.typedChars) || 0),
  }
  // Spec / Run スコープに厳密に絞る（別タスクの startedAt〜completedAt を混ぜない）
  const taskSummary = summarizeTasks(input.tasks ?? [], {
    since: generatedAt - hours * 3600 * 1000,
    now: generatedAt,
    spec: input.spec,
    taskIds: input.taskIds,
    batchIds: input.batchIds,
  })
  // API コール数・トークン数は usage.js のスコープ集計（セッション群 or 時間窓）から取る
  const scoped = usageKpis(input.usageScope)
  const scopedOk = Boolean(input.usageScope && input.usageScope.ok !== false)
  const fallbackCalls = totals ? Math.max(0, Number(totals.calls) || 0) : null
  const fallbackTokens = totals
    ? Math.max(0, Number(totals.input) || 0) +
      Math.max(0, Number(totals.output) || 0) +
      Math.max(0, Number(totals.cacheRead) || 0) +
      Math.max(0, Number(totals.cacheWrite) || 0)
    : null
  const reportCounts = input.report?.counts && typeof input.report.counts === 'object' ? input.report.counts : null
  const tests = extractTestCounts([
    input.report?.markdown ?? '',
    ...(Array.isArray(input.tasks) ? input.tasks.map((t) => t?.result ?? '') : []),
  ])
  const missing = Array.isArray(input.missing) ? [...new Set(input.missing.filter(Boolean))] : []

  return {
    ok: true,
    generatedAt,
    board: input.board ? String(input.board) : null,
    spec: input.spec ? String(input.spec) : null,
    label: input.label ? String(input.label) : null,
    windowHours: hours,
    status: input.report?.status ? String(input.report.status) : null,
    scope: {
      // どのタスクが時間・バッチ計算に入ったか（監査用。数字の根拠を追えるようにする）
      scoped: taskSummary.scoped,
      taskIds: Array.isArray(input.taskIds) ? input.taskIds.map(String) : [],
      batchIds: Array.isArray(input.batchIds) ? input.batchIds.map(String) : [],
      tasks: taskSummary.batchesTotal,
      intervals: taskSummary.intervalCount,
      usage: input.usageScope?.scope ?? null,
      usageScoped: scopedOk,
    },
    kpi: {
      costUsd: totals ? Math.round((Number(totals.cost) || 0) * 10000) / 10000 : null,
      cacheHitRate: rate,
      cachePct: rate === null ? null : Math.round(rate * 100),
      savedUsd,
      savedRatio: CACHE_SAVINGS_RATIO,
      cacheReadTokens: totals ? Number(totals.cacheRead) || 0 : null,
      inputTokens: totals ? Number(totals.input) || 0 : null,
      outputTokens: totals ? Number(totals.output) || 0 : null,
      toolCalls: totals ? Number(totals.tools) || 0 : null,
      sessions: totals ? Number(totals.sessions) || 0 : null,
      humanTaps: ops.humanTaps,
      redlines: ops.redlines,
      typedChars: ops.typedChars,
      zeroTypingScore: zeroTypingScore(ops),
      batchesDone: reportCounts ? Number(reportCounts.done) || 0 : taskSummary.batchesDone,
      batchesTotal: reportCounts
        ? Number(reportCounts.total) || taskSummary.batchesTotal
        : taskSummary.batchesTotal || null,
      // 主指標は「重複区間をマージした実稼働時間」。経過時間は参考値として併記する
      durationMin: taskSummary.durationMin,
      activeDurationMin: taskSummary.activeDurationMin,
      wallDurationMin: taskSummary.wallDurationMin,
      durationCapped: taskSummary.durationCapped,
      apiCalls: scopedOk ? scoped.apiCalls : fallbackCalls,
      totalTokens: scopedOk ? scoped.totalTokens : fallbackTokens,
      tests: tests.tests,
      pwaChecks: tests.pwaChecks,
    },
    missing,
  }
}

/**
 * テレメトリ集計器を作る。
 *
 * @param {object} cfg ブリッジ設定（`reviewDir` / `auditPath` / `stateDb` / `pluginDataDir`）
 * @param {{
 *   usage?: {summary: Function, scoped?: Function},
 *   reports?: (opts: object) => Array<object>,
 *   tasks?: (board: string) => Array<object>,
 *   runs?: () => Array<object>,
 *   now?: () => number,
 * }} [deps] 差し替え（テスト用）
 * @returns {{receipt: Function}} 集計器
 */
export function createTelemetry(cfg = {}, deps = {}) {
  const reviewDir = String(cfg.reviewDir ?? '')
  const auditPath = String(cfg.auditPath ?? '')
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const readRunsFn = typeof deps.runs === 'function' ? deps.runs : () => readRuns(runsPathFor(cfg))

  /**
   * `GET /api/telemetry/receipt` の本体。ファイル欠損は握りつぶして `missing` に積む。
   *
   * Spec が指定されたときは `pipeline-runs.json` のラン（`taskIds` / `batchIds`）で
   * タスクを絞り、そのセッション群（取れなければ Run の時間窓）で `apiCalls` /
   * `totalTokens` を `usage.scoped()` から集計する。
   *
   * @param {{board?: string, spec?: string, hours?: number, dbs?: Array<object>}} [opts] 条件
   * @returns {object} Receipt データ
   */
  function receipt(opts = {}) {
    const hours = Math.min(Math.max(Number(opts.hours) || DEFAULT_HOURS, 1), 24 * 30)
    const board = String(opts.board ?? '').trim()
    const spec = String(opts.spec ?? '').trim()
    const generatedAt = now()
    const missing = []

    let usage = null
    try {
      const u = deps.usage?.summary?.({ hours, dbs: opts.dbs ?? [] })
      if (u?.ok) usage = u
      else missing.push('usage')
    } catch {
      missing.push('usage')
    }

    let report = null
    try {
      const rows = typeof deps.reports === 'function' ? deps.reports({ board, limit: 100 }) : []
      report = (Array.isArray(rows) ? rows : []).find((r) => sameSpec(r?.spec, spec)) ?? null
      if (!report) missing.push('report')
    } catch {
      missing.push('report')
    }

    let tasks = []
    if (board && typeof deps.tasks === 'function') {
      try {
        tasks = deps.tasks(board) ?? []
      } catch {
        missing.push('tasks')
      }
    } else {
      missing.push('tasks')
    }

    // ランレコード（Spec スコープの ID 群）→ 対象タスクの絞り込み。
    // Spec 未指定（ボード全体のレシート）ではランに寄せず、ボード全体をそのまま集計する。
    let runs = []
    try {
      const r = readRunsFn()
      runs = Array.isArray(r) ? r : []
    } catch {
      runs = []
    }
    const run = spec ? pickSpecRun(runs, { spec, board, tasks }) : null
    const taskIds = Array.isArray(run?.taskIds) ? run.taskIds.map(String) : []
    const batchIds = Array.isArray(run?.batchIds) ? run.batchIds.map(String) : []
    const scopedTasks = selectSpecTasks(tasks, { spec, taskIds, batchIds }).tasks

    const timing = summarizeTasks(scopedTasks, {
      since: generatedAt - hours * 3600 * 1000,
      now: generatedAt,
    })
    const sessionIds = [
      ...new Set(
        scopedTasks
          .map((t) => String(t?.sessionId ?? t?.session_id ?? t?.session ?? '').trim())
          .concat(String(run?.originSessionId ?? '').trim())
          .filter(Boolean),
      ),
    ]

    let usageScope = null
    if (typeof deps.usage?.scoped === 'function') {
      try {
        const r = deps.usage.scoped({
          sessionIds,
          // セッションが取れないときは Run の実区間（無ければ集計窓）で安全にフォールバックする
          sinceMs: timing.startMs || generatedAt - hours * 3600 * 1000,
          untilMs: timing.endMs || generatedAt,
          dbs: opts.dbs ?? [],
        })
        if (r?.ok) usageScope = r
        else missing.push('usageScope')
      } catch {
        missing.push('usageScope')
      }
    }

    let ops = { humanTaps: 0, redlines: 0, typedChars: 0 }
    try {
      const file = auditPath || path.join(String(cfg.dataDir ?? ''), 'audit.jsonl')
      if (!fs.existsSync(file)) throw new Error('missing')
      const raw = readTailText(file, AUDIT_TAIL_BYTES)
      ops = summarizeAudit(raw.split('\n'), { since: generatedAt - hours * 3600 * 1000 })
    } catch {
      missing.push('audit')
    }

    const built = buildReceipt({
      board,
      spec,
      label: report?.label ?? null,
      generatedAt,
      hours,
      taskIds,
      batchIds,
      usage,
      usageScope,
      report,
      tasks: scopedTasks,
      ops,
      missing,
    })
    // 同じファイル群を二重に読まないよう、レビューディレクトリは参照だけ持たせる（将来の拡張用）
    return { ...built, reviewDir: reviewDir || null }
  }

  return { receipt }
}
