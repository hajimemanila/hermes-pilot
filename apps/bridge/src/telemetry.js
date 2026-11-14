import fs from 'node:fs'
import path from 'node:path'
import { readTailText } from './tail.js'

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
export const DEFAULT_HOURS = 24

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
export const CACHE_SAVINGS_RATIO = 0.9

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
 * タスク群から status 件数と所要時間（分）を出す。
 *
 * 所要時間は **集計窓の内側** に丸める: 窓内に完了したタスクの「最短開始 〜 最遅完了」で、
 * 開始が窓より前なら窓の開始に切り上げる。古いタスク 1 件で「33,000 分」のような
 * 意味のない数字が出るのを防ぐ。
 *
 * @param {Array<{status?: string, createdAt?: number|null, startedAt?: number|null, completedAt?: number|null}>} tasks タスク
 * @param {{since?: number}} [opts] 集計窓の開始（epoch ms）
 * @returns {{batchesDone: number, batchesTotal: number, durationMin: number|null, durationCapped: boolean}} 集計
 */
export function summarizeTasks(tasks, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const since = Number(opts.since) || 0
  const done = list.filter((t) => String(t?.status ?? '') === 'done').length
  const finished = list.filter((t) => {
    if (String(t?.status ?? '') !== 'done') return false
    const e = Number(t?.completedAt) || 0
    return e > 0 && (since <= 0 || e >= since)
  })
  let start = null
  let end = null
  let capped = false
  for (const t of finished) {
    const s = Number(t?.startedAt ?? t?.createdAt ?? 0) || 0
    const e = Number(t?.completedAt) || 0
    const bounded = since > 0 ? Math.max(s, since) : s
    if (since > 0 && s > 0 && s < since) capped = true
    if (bounded > 0 && (start === null || bounded < start)) start = bounded
    if (e > 0 && (end === null || e > end)) end = e
  }
  const durationMin = start && end && end >= start ? Math.max(1, Math.round((end - start) / 60000)) : null
  return { batchesDone: done, batchesTotal: list.length, durationMin, durationCapped: capped }
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
 *   usage?: {totals?: object, cacheHitRate?: number|null, models?: Array<object>}|null,
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
  const taskSummary = summarizeTasks(input.tasks ?? [], { since: generatedAt - hours * 3600 * 1000 })
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
      durationMin: taskSummary.durationMin,
      durationCapped: taskSummary.durationCapped,
      tests: tests.tests,
      pwaChecks: tests.pwaChecks,
    },
    missing,
  }
}

/**
 * テレメトリ集計器を作る。
 *
 * @param {object} cfg ブリッジ設定（`reviewDir` / `auditPath`）
 * @param {{
 *   usage?: {summary: Function},
 *   reports?: (opts: object) => Array<object>,
 *   tasks?: (board: string) => Array<object>,
 *   now?: () => number,
 * }} [deps] 差し替え（テスト用）
 * @returns {{receipt: Function}} 集計器
 */
export function createTelemetry(cfg = {}, deps = {}) {
  const reviewDir = String(cfg.reviewDir ?? '')
  const auditPath = String(cfg.auditPath ?? '')
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  /**
   * `GET /api/telemetry/receipt` の本体。ファイル欠損は握りつぶして `missing` に積む。
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
      usage,
      report,
      tasks,
      ops,
      missing,
    })
    // 同じファイル群を二重に読まないよう、レビューディレクトリは参照だけ持たせる（将来の拡張用）
    return { ...built, reviewDir: reviewDir || null }
  }

  return { receipt }
}
