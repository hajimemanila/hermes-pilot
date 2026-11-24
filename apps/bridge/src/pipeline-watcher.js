import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readRuns, runsPathFor, writeRuns } from './specs.js'
import { summarizeTasks } from './telemetry.js'
import { analyzeCoherence, coherenceAlertFrom } from './coherence.js'
import { VERIFY_CONTRACT, VERIFY_CONTRACT_JA } from './contracts/verify.js'
import { writeJsonAtomic } from './lib/atomic.js'
import { safeList } from './lib/safe.js'
import { LEGACY_REVIEW_TAG } from './review/legacy-tags.js'

/**
 * パイプライン完走ウォッチャー（SPEC §3.2 / D20 / D21）。
 *
 * カンバン DB を**読み取り専用**で 10 秒ごとに見て、次の 2 種類の「波」が収束した瞬間に
 * 統合 Markdown レポートを 1 回だけ合成し、起票元チャットへ届ける。
 *
 *  - **A. Spec ラン単位**: 本文の `Spec: <rel>` 行（または `pipeline-runs.json` の `taskIds`）で
 *    同じ `(board, spec)` に属するタスク群
 *  - **B. ボードウェーブ単位**: `Spec:` を持たない通常タスク（チャット起票など）で、
 *    `[review]`（と移行前の旧タグ）は個別レビュー報告と重複するので除外する
 *
 * 大事な性質（review-watcher と同じ設計方針）:
 *  - **初回起動はベースライン確立のみ**（過去分を遡って通知しない。スパム防止）
 *  - **取りこぼし防止**: ティック間に起票→完了したタスクも `completed_at >= startedAtSec` で拾う
 *  - **重複通知なし**: `reportedKeys` に状態キー（Spec は最新完了時刻、ウェーブはタスク ID のハッシュ）
 *  - **`review/feed.jsonl` には書かない**（Review タブの通知を汚さない）。書く先は
 *    `review/chat-reports.jsonl`（`kind: 'pipeline'`）と `review/pipeline-reports.jsonl`
 *  - **アトミック**: 状態は `lib/atomic.js`（tmp → rename）。JSONL は 1 行完結の append
 *
 * @param {object} cfg ブリッジ設定（kanbanRoot / reviewDir / stateDb / hermesHome）
 * @param {{
 *   intervalMs?: number,
 *   now?: () => number,
 *   logger?: object,
 *   dbPaths?: Array<{board: string|null, path: string}>,
 *   stateDbs?: string[],
 *   boardWorkdir?: (board: string) => string|null,
 *   gitinfo?: {forTask: Function, diffSummary: Function},
 *   runsPath?: string,
 *   readRuns?: (file: string) => Array<object>,
 *   writeRuns?: (file: string, runs: Array<object>) => void,
 * }} [opts] 差し替え（テスト用）
 */

/** レポート種別（`chat-reports.jsonl` の `kind`）。 */
export const PIPELINE_KIND = 'pipeline'

/** 「まだ動いている」状態。これが 0 になったら収束。 */
const OPEN_STATUSES = new Set(['running', 'ready', 'todo'])

/** 個別レビュー報告と重複するタグ（ウェーブ集計から除外する）。 */
const REVIEW_TAGS = ['[review]', LEGACY_REVIEW_TAG]

/** 未実施・残課題として拾う語（英語・日本語の両方を 1 つの正規表現で）。 */
const NOISE_RE = /(TODO|FIXME|未実施|残課題|スキップ|blocked|skipped|failed|remaining|warning|⚠)/i

/** 抽出する課題行の上限。 */
const ISSUE_LIMIT = 8

/** 保持する状態キーの上限（育ちすぎないようにする）。 */
const REPORTED_KEYS_MAX = 200

/** 1 DB から読むタスク数（直近 300 件。古いタスクは完了検知の対象外）。 */
const TASKS_PER_DB = 300

/** `Spec:` 行。 */
const SPEC_LINE_RE = /^Spec:\s*(.+?)\s*$/m

/** `Chat:` 行。 */
const CHAT_LINE_RE = /^Chat:\s*(.+?)\s*$/m

/** チャット ID の書式（`specs.js` の `SPEC_CHAT_RE` と同じ規則）。 */
const CHAT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * パス比較用に正規化する（末尾の `/` を落とし、絶対パス化する）。
 * @param {unknown} p パス
 * @returns {string} 正規化後（空なら空文字）
 */
export function normalizePath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  return path.resolve(s).replace(/[\\/]+$/, '') || '/'
}

/**
 * 本文から `Spec: <rel>` を読む。
 * @param {unknown} body タスク本文
 * @returns {string|null} spec の相対パス（無ければ null）
 */
export function specRelFromBody(body) {
  const m = SPEC_LINE_RE.exec(String(body ?? ''))
  return m ? m[1].trim() : null
}

/**
 * 本文から `Chat: <session_id>` を読む（書式外は null）。
 * @param {unknown} body タスク本文
 * @returns {string|null} セッション ID
 */
export function chatFromBody(body) {
  const m = CHAT_LINE_RE.exec(String(body ?? ''))
  if (!m) return null
  const id = m[1].trim()
  return CHAT_ID_RE.test(id) ? id : null
}

/**
 * 個別レビュー報告の対象タスクか（`[review]` か移行前の旧タグを含む）。
 * @param {unknown} body タスク本文
 * @returns {boolean} レビュータスクなら true
 */
export function isReviewBody(body) {
  const text = String(body ?? '')
  return REVIEW_TAGS.some((tag) => text.includes(tag))
}

/** 1 行に潰す（長すぎる本文は切る）。 */
function oneLine(text, max = 220) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 状態ごとの件数。 */
function countStatuses(tasks) {
  const counts = { done: 0, blocked: 0, failed: 0, running: 0, ready: 0, todo: 0, other: 0, total: 0 }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const s = String(t?.status ?? '')
    counts.total += 1
    if (s in counts) counts[s] += 1
    else counts.other += 1
  }
  return counts
}

/** 経過時間の表示（`12m` / `1h 5m`）。 */
function elapsedLabel(fromMs, toMs) {
  const a = Number(fromMs)
  const b = Number(toMs)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= a) return ''
  const minutes = Math.max(1, Math.round((b - a) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * `task.result` と `blocked` / `failed` から未実施・発見課題を抽出する（純関数）。
 *
 * blocked / failed は**理由ごと優先表示**し、次に各 result の該当行を拾う
 * （`TODO` / `未実施` / `残課題` / `blocked` / `warning` / `⚠` など最大 8 件、重複除去）。
 *
 * @param {Array<{id: string, title?: string, status?: string, result?: string}>} tasks タスク
 * @param {{limit?: number}} [opts] 上限
 * @returns {Array<{taskId: string, title: string, kind: string, text: string}>} 課題
 */
export function extractIssuesAndRemaining(tasks, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || ISSUE_LIMIT)
  const out = []
  const seen = new Set()
  const push = (taskId, title, kind, text) => {
    const key = oneLine(text, 200).toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ taskId, title: oneLine(title, 90), kind, text: oneLine(text, 220) })
  }

  const list = Array.isArray(tasks) ? tasks : []
  // 1) 停止したタスク（理由が最も重要）
  for (const t of list) {
    const status = String(t?.status ?? '')
    if (status !== 'blocked' && status !== 'failed') continue
    // 理由の記録が無いときは言語非依存の記号にする（ja/en 両方の本文に載るため）
    const reason = oneLine(t.result) || '—'
    push(String(t.id), t.title, status, reason)
  }
  // 2) result 本文の残課題・警告行
  for (const t of list) {
    const lines = String(t?.result ?? '').split(/\r?\n/)
    for (const line of lines) {
      const text = line.replace(/^[\s>*+-]+/, '').trim()
      if (!text || text.length < 4) continue
      if (!NOISE_RE.test(text)) continue
      push(String(t.id), t.title, 'note', text)
      if (out.length >= limit) return out.slice(0, limit)
    }
  }
  return out.slice(0, limit)
}

/**
 * 予兆アラート 1 件を「次の一手」の 1 行にする（純関数・汎用表現）。
 *
 * D83: コマンドを決め打ちしない（`npm run …` を書かない）・自動起票もしない。
 * 対象スイープ名は `coherence.js` の `recommendedSweep` をそのまま使い、
 * 無いときは「対象スイープ」とだけ言う。
 *
 * @param {object} coherence `coherenceAlertFrom()` の出力（`alert: true`）
 * @param {{en?: boolean, board?: string}} [opts] 言語・ボード名
 * @returns {string} 次の一手 1 行
 */
export function coherenceNextStep(coherence, { en = false, board = '' } = {}) {
  const summary = coherence?.summary ?? {}
  const hardFailCount = Number(summary.hardFailCount ?? 0) || 0
  const softSignalCount = Number(summary.softSignalCount ?? 0) || 0
  const hotspotCount = Number(summary.hotspotCount ?? 0) || 0
  const sweep = String(coherence?.recommendedSweep ?? '').trim()
  const place = board ? `board: ${board}` : 'board'
  return en
    ? `Coherence signals: run ${sweep ? `the ${sweep} sweep` : 'the relevant sweep'} from Refactor & audit (${place} · ${hardFailCount} hard fail(s) / ${softSignalCount} soft signal(s) / ${hotspotCount} hotspot(s))`
    : `整合性の検証・改善: ${sweep ? `${sweep}` : '対象メニュー'}を「リファクタリング」から実行する（${place} · Hard Fail ${hardFailCount} / 予兆 ${softSignalCount} / ホットスポット ${hotspotCount}）`
}

/**
 * 状況に応じた推奨ネクストステップ（純関数・最大 3 件）。
 *
 * @param {{status: string, board?: string, specRelPath?: string|null, tasks?: Array<object>, issues?: Array<object>, counts?: object, coherence?: object|null}} input 入力
 * @returns {string[]} 次の一手
 */
export function buildNextSteps({
  status,
  board,
  specRelPath,
  tasks = [],
  issues = [],
  counts,
  lang = 'ja',
  coherence = null,
} = {}) {
  const c = counts ?? countStatuses(tasks)
  const en = lang === 'en'
  const out = []
  if (status === 'halted') {
    const stuck = c.blocked + c.failed
    out.push(en
      ? `⚠ Review the reasons for the ${stuck} blocked/failed task(s), then send instructions and resume (board: ${board})`
      : `⚠ ${stuck} 件の blocked/failed タスクの理由を確認し、指示を出して再開する（board: ${board}）`)
  }
  if (issues.length > 0) {
    out.push(en
      ? `Review the ${issues.length} extracted remaining item(s) and turn the actionable ones into the next tasks`
      : `抽出された残課題 ${issues.length} 件を確認し、着手可能なものを次のタスクにする`)
  }
  if (specRelPath) {
    out.push(en
      ? `Launch the remaining batches of ${specRelPath} from the Spec Launchpad (${board})`
      : `${specRelPath} の残バッチを Spec Launchpad から起動する（${board}）`)
  }
  if (status !== 'halted') {
    // D85: 検証コマンドを決め打ちしない（対象リポジトリの宣言＝SPEC Verify 欄・メモリへ委ねる）
    out.push(en
      ? `Run ${VERIFY_CONTRACT} and the final screen check, then decide on release`
      : `${VERIFY_CONTRACT_JA}と実機/画面の最終確認を行い、リリース判断をする`)
  }
  // 完走時の予兆検知（COH-5 / D83）: 該当スイープを促す 1 行。先頭寄りに置き、3 件枠で落とさない。
  if (coherence?.alert === true) {
    const line = coherenceNextStep(coherence, { en, board })
    if (status === 'halted' && out.length > 0) out.splice(1, 0, line)
    else out.unshift(line)
  }
  if (out.length < 2) {
    out.push(en
      ? `Review the changes and discuss the next step (board: ${board})`
      : `変更内容をレビューし、次の一手を相談する（board: ${board}）`)
  }
  return out.slice(0, 3)
}

/** Git 情報 1 行（`\`abc1234\`, +84/-12 · 4 files`）。 */
function gitLine(git) {
  if (!git) return ''
  const bits = []
  const sha = String(git.head ?? '').slice(0, 7)
  if (sha) bits.push(`\`${sha}\``)
  const add = Number(git.total?.add ?? 0)
  const del = Number(git.total?.del ?? 0)
  if (add || del) bits.push(`+${add}/-${del}`)
  const files = Array.isArray(git.files) ? git.files.length : 0
  if (files) bits.push(`${files} file${files === 1 ? '' : 's'}`)
  return bits.length ? ` (${bits.join(', ')})` : ''
}

/**
 * レポート本文のラベル（言語別）。`ja` は従来の文言と 1 文字も変えない。
 *
 * 統合レポートは「その時点の言語」で 1 回だけ保存されるため、保存後に UI 言語を
 * 変えると日本語が残る（実測: 英語 UI に「所要時間・使用量」「実稼働 … 14 分」）。
 * そこで本文を **両言語で生成**し、UI が `markdownEn` / `textEn` を選ぶ。
 */
const REPORT_LABELS = {
  ja: {
    headHalted: 'Action Required',
    headDone: 'Pipeline Completed',
    activeShort: '実稼働',
    wallShort: '経過',
    hTime: '所要時間・使用量 / Time & Usage',
    hDone: '完了タスク / Completed Tasks',
    hIssues: '未実施項目・発見課題 / Issues & Remaining Items',
    hNext: '次のステップ / Recommended Next Steps',
    activeLine: '実稼働（重複区間をマージ）',
    wallLine: '経過時間',
    callsLine: 'API コール数',
    tokensLine: 'トークン数',
    tokensValue: (t, i, o, c) => `${t}（入力 ${i} · 出力 ${o} · キャッシュ読取 ${c}）`,
    emptyDone: '（完了タスクなし）',
    emptyIssues: '無し（全項目クリーン完走）',
    hCoherence: '予兆シグナル / Coherence Signals',
    sweepLine: '推奨スイープ',
    cohCounts: (h, s, hs) => `Hard Fail ${h} · 予兆 ${s} · ホットスポット ${hs}`,
  },
  en: {
    headHalted: 'Action Required',
    headDone: 'Pipeline Completed',
    activeShort: 'active',
    wallShort: 'wall',
    hTime: 'Time & Usage',
    hDone: 'Completed Tasks',
    hIssues: 'Issues & Remaining Items',
    hNext: 'Recommended Next Steps',
    activeLine: 'Active time (overlapping spans merged)',
    wallLine: 'Wall time',
    callsLine: 'API calls',
    tokensLine: 'Tokens',
    tokensValue: (t, i, o, c) => `${t} (in ${i} · out ${o} · cache read ${c})`,
    emptyDone: '(no completed tasks)',
    emptyIssues: 'None (all items completed cleanly)',
    hCoherence: 'Coherence Signals',
    sweepLine: 'Recommended sweep',
    cohCounts: (h, s, hs) => `${h} hard fail(s) · ${s} soft signal(s) · ${hs} hotspot(s)`,
  },
}

/**
 * 分を「42 分」「1 時間 5 分」/ 英語なら「42m」「1h 5m」へ整形する（0 は null）。
 * @param {number|null|undefined} min 分
 * @param {'ja'|'en'} [lang] 表示言語
 * @returns {string|null} 表示文字列
 */
export function fmtDurationMin(min, lang = 'ja') {
  const n = Number(min)
  if (!Number.isFinite(n) || n <= 0) return null
  const h = Math.floor(n / 60)
  const m = Math.round(n % 60)
  if (lang === 'en') return n < 60 ? `${Math.round(n)}m` : `${h}h ${m}m`
  if (n < 60) return `${Math.round(n)} 分`
  return `${h} 時間 ${m} 分`
}

/**
 * トークン数を `950` / `480K` / `1.2M` へ整形する（レシート Canvas と同じ規則）。
 * @param {number|null|undefined} value トークン数
 * @returns {string|null} 表示文字列
 */
export function fmtTokenCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (n >= 1e6) return `${Math.round((n / 1e6) * 10) / 10}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(Math.round(n))
}

/**
 * 予兆検知の入力を `coherenceAlertFrom()` の形へ揃える（純関数・COH-5）。
 *
 * `analyzeCoherence()` の生レポートでも、`coherenceAlertFrom()` の出力でも受け、
 * `alert === true` のときだけ `{summary, recommendedSweep, highlights, layers}` を返す。
 * 予兆なし・壊れた入力は `null`（レポートには何も足さない）。
 *
 * @param {object|null|undefined} input 解析レポート or アラート
 * @returns {{alert: true, summary: object, recommendedSweep: string|null, highlights: string[], layers: object}|null} 正規化したアラート
 */
function normalizeCoherenceAlert(input) {
  if (!input || typeof input !== 'object') return null
  const alert = typeof input.alert === 'boolean' ? input : coherenceAlertFrom(input)
  if (!alert || alert.alert !== true) return null
  const summary = alert.summary ?? {}
  return {
    alert: true,
    summary: {
      hardFailCount: Number(summary.hardFailCount ?? 0) || 0,
      softSignalCount: Number(summary.softSignalCount ?? 0) || 0,
      hotspotCount: Number(summary.hotspotCount ?? 0) || 0,
    },
    recommendedSweep: alert.recommendedSweep ?? null,
    highlights: (Array.isArray(alert.highlights) ? alert.highlights : []).slice(0, 5).map((h) => String(h ?? '')),
    layers: alert.layers ?? { universal: true, repoConfig: false, repoChecker: false },
  }
}

/**
 * 統合 Markdown レポートを組み立てる（純関数）。
 *
 * 所要時間は `telemetry.js` の `summarizeTasks()` を共有し、並列タスクの重なりを
 * マージした **実稼働時間**（主指標）と単純経過時間を併記する。`usage` が渡された
 * ときは Spec / Run スコープの API コール数・トークン数も出力する。
 *
 * @param {{
 *   status: 'done'|'halted',
 *   label: string,
 *   board: string,
 *   specRelPath?: string|null,
 *   tasks?: Array<object>,
 *   gitMap?: Record<string, object>,
 *   startedAt?: number,
 *   now?: number,
 *   usage?: {apiCalls?: number|null, totalTokens?: number|null, totals?: object|null, scope?: object|null}|null,
 *   coherence?: object|null,
 * }} input 入力
 * @returns {{text: string, markdown: string, followUpPrompt: string, counts: object, issues: Array<object>, nextSteps: string[], timing: object}} レポート
 */
export function buildPipelineReport({
  status = 'done',
  label = '',
  board = '',
  specRelPath = null,
  tasks = [],
  gitMap = {},
  startedAt = 0,
  now: nowMs = Date.now(),
  usage = null,
  lang = 'ja',
  coherence = null,
} = {}) {
  const counts = countStatuses(tasks)
  const issues = extractIssuesAndRemaining(tasks)
  const cohAlert = normalizeCoherenceAlert(coherence)
  const title = String(label || board || specRelPath || 'pipeline')
  const halted = status === 'halted'

  // 時間は Spec / Run スコープのタスク区間から（重なりはマージして二重計上しない）
  const timing = summarizeTasks(tasks, { now: nowMs })
  const callsLabel = usage && Number.isFinite(Number(usage.apiCalls)) ? Number(usage.apiCalls) : null
  const tokensLabel = usage && Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : null

  /**
   * 本文を **指定言語で** 組み立てる。
   *
   * `ja` は従来と同一の文字列になる（既存の Discord 通知・保存済み行と互換）。
   * `en` は英語 UI 用で、UI 側が `markdownEn` / `textEn` を選ぶ。
   */
  const render = (l) => {
    const L = REPORT_LABELS[l] ?? REPORT_LABELS.ja
    const elapsed = elapsedLabel(startedAt, nowMs)
    const activeLabel = fmtDurationMin(timing.durationMin, l)
    const wallLabel = fmtDurationMin(timing.wallDurationMin, l)
    const nextSteps = buildNextSteps({ status, board, specRelPath, tasks, issues, counts, lang: l, coherence: cohAlert })

    const usageBits = [
      callsLabel === null ? null : `🔌 ${callsLabel} API`,
      tokensLabel === null ? null : `🪙 ${fmtTokenCount(tokensLabel)} tokens`,
    ].filter(Boolean)
    const timeBits = [
      activeLabel ? `⏱ ${L.activeShort} ${activeLabel}` : null,
      wallLabel ? `${L.wallShort} ${wallLabel}` : null,
    ].filter(Boolean)
    const summaryBits = [...timeBits, ...usageBits]

    const headBase = halted
      ? `### ⚠️ ${L.headHalted}: ${title} (${counts.done} done · ${counts.blocked} blocked` +
        `${counts.failed ? ` · ${counts.failed} failed` : ''}${elapsed ? ` · ${elapsed}` : ''})`
      : `### 🎉 ${L.headDone}: ${title} (${counts.done}/${counts.total} done${elapsed ? ` · ${elapsed}` : ''})`
    const head = summaryBits.length ? `${headBase} · ${summaryBits.join(' · ')}` : headBase

    const doneLines = []
    for (const t of tasks) {
      if (String(t?.status ?? '') !== 'done') continue
      const summary = oneLine(t.result, 200)
      doneLines.push(`- **${oneLine(t.title, 120)}**${gitLine(gitMap[String(t.id)])}`)
      if (summary) doneLines.push(`  - ${summary}`)
    }

    const issueLines = issues.length
      ? issues.map((i) => `- **[${i.kind}] ${i.title}** — ${i.text}`)
      : [`- **${L.emptyIssues}**`]

    const nextLines = nextSteps.map((s) => `- ${s}`)

    // 予兆シグナル（COH-5 / D83）: alert === true のときだけ 1 節を足す
    const cohLines = cohAlert
      ? [
          ...(cohAlert.recommendedSweep ? [`- ${L.sweepLine}: ${cohAlert.recommendedSweep}`] : []),
          `- ${L.cohCounts(cohAlert.summary.hardFailCount, cohAlert.summary.softSignalCount, cohAlert.summary.hotspotCount)}`,
          ...cohAlert.highlights.map((h) => `- ${h}`),
        ]
      : []

    const usageLines = [
      `- ${L.activeLine}: ${activeLabel ?? '—'}`,
      `- ${L.wallLine}: ${wallLabel ?? '—'}`,
      `- ${L.callsLine}: ${callsLabel === null ? '—' : String(callsLabel)}`,
      `- ${L.tokensLine}: ${tokensLabel === null ? '—' : L.tokensValue(
        fmtTokenCount(tokensLabel),
        fmtTokenCount(usage?.totals?.input ?? 0),
        fmtTokenCount(usage?.totals?.output ?? 0),
        fmtTokenCount(usage?.totals?.cacheRead ?? 0),
      )}`,
    ]

    const markdown = [
      head,
      '',
      `#### ⏱ ${L.hTime}`,
      ...usageLines,
      '',
      `#### ✅ ${L.hDone}`,
      ...(doneLines.length ? doneLines : [`- ${L.emptyDone}`]),
      '',
      `#### ⚠️ ${L.hIssues}`,
      ...issueLines,
      '',
      ...(cohLines.length ? [`#### 🧭 ${L.hCoherence}`, ...cohLines, ''] : []),
      `#### 🚀 ${L.hNext}`,
      ...nextLines,
    ].join('\n')

    const textBase = halted
      ? `⚠️ ${title} (${counts.done} done · ${counts.blocked} blocked)`
      : `🎉 ${title} (${counts.done}/${counts.total} done)`
    const text = summaryBits.length ? `${textBase} · ${summaryBits.join(' · ')}` : textBase

    return { markdown, text, nextSteps }
  }

  const ja = render('ja')
  // 既定（ja）以外の言語版。`lang: 'en'` のときは無駄な二重生成をしない。
  const en = lang === 'en' ? ja : render('en')

  const promptLines = [
    `先ほどのパイプライン「${title}」（board: ${board}${specRelPath ? ` / ${specRelPath}` : ''}）の結果を確認してください。`,
    `完了 ${counts.done} 件 / blocked ${counts.blocked} 件 / failed ${counts.failed} 件（全 ${counts.total} 件）。`,
    ...issues.slice(0, 3).map((i) => `- [${i.kind}] ${i.text}`),
    '次の一手（実装・検証・リリース判断）を一緒に決めたいです。具体的な手順とコマンドを提示してください。',
  ]

  return {
    text: ja.text,
    markdown: ja.markdown,
    // UI 言語で選ぶための英語版（ja の `text` / `markdown` は従来と同一）
    textEn: en.text,
    markdownEn: en.markdown,
    followUpPrompt: promptLines.join('\n').slice(0, 1200),
    /*
     * 相談文の**材料**（言語非依存）。UI 側が `chat.followUpPrompt` で組み立てる。
     * `followUpPrompt` は日本語の完成文で、旧クライアント/Discord 向けに残す。
     * これを渡さないと英語 UI でも日本語の相談文が入力欄に入る（実測）。
     */
    followUp: {
      title,
      board,
      spec: specRelPath || '',
      counts: { done: counts.done, blocked: counts.blocked, failed: counts.failed, total: counts.total },
      issues: issues.slice(0, 3).map((i) => ({ kind: i.kind, text: i.text })),
    },
    counts: {
      done: counts.done,
      blocked: counts.blocked,
      failed: counts.failed,
      total: counts.total,
    },
    issues,
    nextSteps: ja.nextSteps,
    /*
     * 完走時の汎用予兆検知（COH-5 / D83）。`alert === true` のときだけ形を返し、
     * 未超過・解析失敗では `null`（レポート本文も従来どおり）。
     */
    coherence_alert: cohAlert
      ? {
          summary: cohAlert.summary,
          recommendedSweep: cohAlert.recommendedSweep,
          highlights: cohAlert.highlights,
          layers: cohAlert.layers,
        }
      : null,
    timing: {
      activeDurationMin: timing.durationMin,
      wallDurationMin: timing.wallDurationMin,
      intervals: timing.intervalCount,
      durationCapped: timing.durationCapped,
    },
    usage: {
      apiCalls: callsLabel,
      totalTokens: tokensLabel,
      scope: usage?.scope ?? null,
    },
  }
}

/**
 * `pipeline-reports.jsonl` を読む（新しい順・ボードで絞れる）。API 用。
 *
 * @param {string} rootDir レビューディレクトリ（`review/`）
 * @param {{board?: string|null, limit?: number}} [opts] 絞り込み
 * @returns {Array<object>} レポート（`at` は epoch ms、camelCase）
 */
export function readPipelineReports(rootDir, opts = {}) {
  const file = path.join(String(rootDir ?? ''), 'pipeline-reports.jsonl')
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100)
  const board = String(opts.board ?? '').trim()
  if (!fs.existsSync(file)) return []
  const raw = safeList('pipelineWatcher.readReports', () => fs.readFileSync(file, 'utf8'), '')
  if (!raw) return []
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const at = Date.parse(String(j.at ?? ''))
      if (!Number.isFinite(at)) continue
      if (board && String(j.board ?? '') !== board) continue
      out.push({
        at,
        kind: String(j.kind ?? PIPELINE_KIND),
        status: String(j.status ?? ''),
        sessionId: String(j.session_id ?? ''),
        taskId: String(j.task_id ?? ''),
        label: j.label ?? null,
        board: j.board ?? null,
        spec: j.spec ?? null,
        repoPath: j.repo_path ?? null,
        text: String(j.text ?? ''),
        markdown: String(j.markdown ?? ''),
        textEn: String(j.text_en ?? ''),
        markdownEn: String(j.markdown_en ?? ''),
        followUpPrompt: String(j.follow_up_prompt ?? ''),
        counts: j.counts ?? null,
        coherence_alert: j.coherence_alert ?? null,
      })
    } catch {
      /* 書きかけ・壊れた行は捨てる（補助情報） */
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}

/** 1 行の末尾改行を保証して追記する（JSONL が連結しないように）。 */
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let prefix = ''
  try {
    const st = fs.statSync(file)
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(1)
      fs.readSync(fd, buf, 0, 1, st.size - 1)
      fs.closeSync(fd)
      if (buf.toString() !== '\n') prefix = '\n'
    }
  } catch {
    /* 無ければそのまま作る */
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(obj)}\n`)
}

/** タスク ID 群の短いハッシュ（ウェーブの状態キー）。 */
function waveHash(tasks) {
  const ids = (Array.isArray(tasks) ? tasks : []).map((t) => String(t?.id ?? '')).sort()
  return crypto.createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 10)
}

/**
 * `review/` のルート（`chat-reports.jsonl` などの置き場）。
 *
 * SPEC V5-3 の Architect（`architect.js`）も同じファイルへ `spec_ready` を書くため、
 * 解決規則をここ 1 箇所に寄せる。
 * @param {object} [cfg] 設定（`reviewDir` / `pluginDataDir` / `kanbanRoot`）
 * @returns {string} ディレクトリ
 */
export function reviewRootFor(cfg = {}) {
  return (
    cfg.reviewDir ??
    path.join(
      cfg.pluginDataDir ?? path.join(cfg.kanbanRoot ?? '.', '..', 'plugin-data', 'hermes-pilot'),
      'review',
    )
  )
}

/**
 * `chat-reports.jsonl` へ 1 行追記する（パイプライン完了と Architect の仕様完成が同じ列に並ぶ）。
 * @param {object} [cfg] 設定
 * @param {object} row 行（`kind` を持つ）
 * @returns {string} 書き込んだファイル
 */
export function appendChatReport(cfg = {}, row = {}) {
  const file = path.join(reviewRootFor(cfg), 'chat-reports.jsonl')
  appendJsonl(file, row)
  return file
}

export function createPipelineWatcher(cfg = {}, opts = {}) {
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || 10_000)
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const log = opts.logger ?? console
  const reviewRoot = reviewRootFor(cfg)
  const statePath = path.join(reviewRoot, 'pipeline-watcher-state.json')
  const chatReportsPath = path.join(reviewRoot, 'chat-reports.jsonl')
  const reportsPath = path.join(reviewRoot, 'pipeline-reports.jsonl')
  const feedPath = path.join(reviewRoot, 'feed.jsonl') // 触らない（テストで不変を確認する）
  const runsFile = opts.runsPath ?? runsPathFor(cfg)
  const readRunsFn = opts.readRuns ?? readRuns
  const writeRunsFn = opts.writeRuns ?? writeRuns

  let timer = null
  let running = false
  let ticks = 0
  let lastError = null

  /** 状態を読む（無ければ null = 初回起動）。壊れていても null 扱い（ベースラインからやり直す）。 */
  function readState() {
    try {
      const j = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (!j || typeof j !== 'object') return null
      if (typeof j.knownTaskIds !== 'object' || j.knownTaskIds === null) return null
      return {
        version: 1,
        startedAtSec: Number(j.startedAtSec) || 0,
        knownTaskIds: j.knownTaskIds,
        activeGroups: j.activeGroups && typeof j.activeGroups === 'object' ? j.activeGroups : {},
        reportedKeys: Array.isArray(j.reportedKeys) ? j.reportedKeys : [],
        updatedAt: j.updatedAt ?? null,
      }
    } catch {
      return null
    }
  }

  /** 状態を書く（`lib/atomic.js` が tmp → rename を持つ）。 */
  function writeState(state) {
    writeJsonAtomic(statePath, state)
  }

  /** 監視対象の DB（ボードごとの `kanban.db` ＋ ルート `kanban.db`）。 */
  function dbPaths() {
    if (Array.isArray(opts.dbPaths)) return opts.dbPaths
    const out = []
    const boardsDir = path.join(cfg.kanbanRoot, 'boards')
    try {
      for (const e of fs.readdirSync(boardsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = path.join(boardsDir, e.name, 'kanban.db')
        if (fs.existsSync(p)) out.push({ board: e.name, path: p })
      }
    } catch {
      /* boards が無い環境では何もしない */
    }
    const rootDb = path.join(cfg.kanbanRoot, 'kanban.db')
    if (fs.existsSync(rootDb)) out.push({ board: null, path: rootDb })
    return out
  }

  /** 1 つの DB から非アーカイブタスクを読む（読み取り専用・失敗は warn + 空）。 */
  function readTasks(dbPath) {
    const db = safeList('pipelineWatcher.openDb', () => new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 }), null)
    if (!db) return []
    try {
      const hasTasks = safeList('pipelineWatcher.hasTasks', () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()), false)
      if (!hasTasks) return []
      return safeList('pipelineWatcher.readTasks', () =>
        db.prepare(`SELECT id, title, body, status, result, created_at, started_at, completed_at, session_id
                      FROM tasks WHERE COALESCE(status, '') != 'archived'
                     ORDER BY COALESCE(completed_at, created_at) DESC LIMIT ${TASKS_PER_DB}`).all(),
      )
    } finally {
      try { db.close() } catch { /* noop */ }
    }
  }

  /** 全 DB のタスクを 1 本の配列にする（同じ ID は最初の 1 件）。 */
  function readAllTasks() {
    const out = []
    const seen = new Set()
    for (const { board, path: dbPath } of dbPaths()) {
      for (const t of readTasks(dbPath)) {
        const id = String(t.id ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push({ ...t, id, board: board ?? 'default' })
      }
    }
    return out
  }

  /** ボードの表示名（`board.json` の name。無ければ slug）。 */
  function boardLabel(board) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(cfg.kanbanRoot, 'boards', String(board), 'board.json'), 'utf8'),
      )
      return String(meta?.name ?? board)
    } catch {
      return String(board)
    }
  }

  /** ボードの作業ディレクトリ（`board.json` の `default_workdir`）。 */
  function boardWorkdir(board) {
    if (typeof opts.boardWorkdir === 'function') return opts.boardWorkdir(board)
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(cfg.kanbanRoot, 'boards', String(board), 'board.json'), 'utf8'),
      )
      return meta?.default_workdir ? String(meta.default_workdir) : null
    } catch {
      return null
    }
  }

  /** 宛先解決の候補になる `state.db`（既定 ＋ `profiles/<name>/state.db`）。 */
  function stateDbs() {
    if (Array.isArray(opts.stateDbs)) return opts.stateDbs
    const out = []
    if (cfg.stateDb) out.push(cfg.stateDb)
    const profilesDir = path.join(cfg.hermesHome ?? cfg.home ?? '.', 'profiles')
    try {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = path.join(profilesDir, e.name, 'state.db')
        if (fs.existsSync(p)) out.push(p)
      }
    } catch {
      /* profiles が無い環境では既定だけ */
    }
    return out
  }

  /** `state.db` から cwd 一致の最新通常セッション `{ id, at }` を 1 件返す。 */
  function latestSessionForCwd(dbPath, workdir) {
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 })
    } catch {
      return null
    }
    const want = normalizePath(workdir)
    try {
      const sql = (order) =>
        `SELECT id, cwd, ${order} AS ts FROM sessions
          WHERE cwd IS NOT NULL AND id NOT LIKE 'local-%'
          ORDER BY ${order} DESC LIMIT 300`
      let rows = []
      try {
        rows = db.prepare(sql('COALESCE(last_activity_at, started_at)')).all()
      } catch {
        rows = db.prepare(sql('started_at')).all()
      }
      for (const r of rows) {
        if (normalizePath(r.cwd) === want) {
          return { id: String(r.id), at: Number(r.ts) || 0 }
        }
      }
      return null
    } catch {
      return null
    } finally {
      try {
        db.close()
      } catch {
        /* noop */
      }
    }
  }

  /**
   * タスク群を「Spec ラン」と「ボードウェーブ」に分ける。
   *
   * @param {Array<object>} rows 全タスク
   * @param {Array<object>} runs ラン記録
   * @returns {Array<{base: string, board: string, spec: string|null, tasks: Array<object>, run: object|null}>} グループ
   */
  function groupTasks(rows, runs) {
    const specs = new Map()
    const waves = new Map()
    for (const row of rows) {
      const spec = specRelFromBody(row.body)
      if (spec) {
        const base = `spec:${row.board}:${spec}`
        if (!specs.has(base)) specs.set(base, { base, board: row.board, spec, tasks: [], run: null })
        specs.get(base).tasks.push(row)
        continue
      }
      if (isReviewBody(row.body)) continue // 個別レビュー報告と二重にしない
      if (!waves.has(row.board)) waves.set(row.board, { base: `wave:${row.board}`, board: row.board, spec: null, tasks: [], run: null })
      waves.get(row.board).tasks.push(row)
    }

    // ラン記録との紐付け（taskIds 一致を優先し、無ければ同一 board+spec の最新ラン）
    for (const g of [...specs.values(), ...waves.values()]) {
      if (!g.spec) {
        const ids = new Set(g.tasks.map((t) => String(t.id)))
        const hit = runs
          .filter((r) => Array.isArray(r.taskIds) && r.taskIds.some((id) => ids.has(String(id))))
          .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0]
        g.run = hit ?? null
        continue
      }
      const byTasks = runs
        .filter((r) => Array.isArray(r.taskIds) && r.taskIds.some((id) => g.tasks.some((t) => String(t.id) === String(id))))
        .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0]
      const byKey = runs
        .filter((r) => String(r.board ?? '') === String(g.board) && String(r.specRelPath ?? '') === String(g.spec))
        .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0]
      g.run = byTasks ?? byKey ?? null
    }

    return [...specs.values(), ...waves.values()]
  }

  /**
   * 宛先チャットの解決（D20②）。
   * `Chat:` → ランの `originSessionId` → `state.db` の cwd 一致最新 → `'__latest__'`。
   *
   * @param {object} group グループ
   * @returns {string} セッション ID
   */
  function resolveTargetSessionId(group) {
    for (const t of group.tasks) {
      const c = chatFromBody(t.body)
      if (c) return c
    }
    const origin = String(group.run?.originSessionId ?? '').trim()
    if (CHAT_ID_RE.test(origin)) return origin
    const workdir = boardWorkdir(group.board)
    if (workdir) {
      let best = null
      for (const dbPath of stateDbs()) {
        const hit = latestSessionForCwd(dbPath, workdir)
        if (hit && (!best || hit.at > best.at)) best = hit
      }
      if (best) return best.id
    }
    return '__latest__'
  }

  /** spec ファイルのタイトル（読めなければ null）。 */
  function specTitleFromFile(group) {
    const repo = group.run?.repoPath ?? boardWorkdir(group.board)
    if (!repo || !group.spec) return null
    try {
      const text = fs.readFileSync(path.resolve(String(repo), String(group.spec)), 'utf8')
      const m = /^#\s+(.+?)\s*$/m.exec(text)
      return m ? m[1] : null
    } catch {
      return null
    }
  }

  /** Git 情報を集める（gitinfo が無ければ空。失敗は握り潰す）。 */
  async function collectGit(tasks) {
    const out = {}
    const gitinfo = opts.gitinfo
    if (!gitinfo || typeof gitinfo.forTask !== 'function') return out
    for (const t of tasks) {
      try {
        const info = await gitinfo.forTask(String(t.id))
        if (!info) continue
        let diff = null
        if (typeof gitinfo.diffSummary === 'function') {
          diff = await gitinfo.diffSummary(String(t.id))
          if (diff && diff.ok === false) diff = null
        }
        out[String(t.id)] = {
          head: info.head ?? diff?.head ?? '',
          repo: info.repo ?? '',
          total: diff?.total ?? { add: 0, del: 0 },
          files: diff?.files ?? [],
          subject: diff?.subject ?? info.subject ?? '',
        }
      } catch {
        /* git が無い環境でもレポートは出す */
      }
    }
    return out
  }

  /**
   * Spec / Run グループの使用量（API コール数・トークン数）を `usage.js` のスコープ集計で取る。
   *
   * セッション ID がタスク・ランから取れればその群のみ、取れなければグループの実区間で
   * 時間窓フォールバックする（`telemetry.js` のレシートと同じ共通関数を使う）。
   *
   * @param {{tasks: Array<object>, run?: object|null}} group グループ
   * @param {number} nowMs 現在時刻（ms）
   * @returns {object|null} `usage.scoped()` の結果（未設定・失敗時は null）
   */
  function scopedUsage(group, nowMs) {
    const u = opts.usage
    if (!u || typeof u.scoped !== 'function') return null
    try {
      const sessionIds = [
        ...new Set(
          (Array.isArray(group?.tasks) ? group.tasks : [])
            .map((t) => String(t?.session_id ?? '').trim())
            .concat(String(group?.run?.originSessionId ?? '').trim())
            .filter((id) => id && id !== '__latest__'),
        ),
      ]
      const startSec = (Array.isArray(group?.tasks) ? group.tasks : []).reduce((acc, t) => {
        const v = Number(t?.started_at ?? t?.created_at ?? 0) || 0
        if (!v) return acc
        return acc === 0 ? v : Math.min(acc, v)
      }, 0)
      const r = u.scoped({
        sessionIds,
        sinceMs: startSec * 1000 || nowMs - 24 * 3600 * 1000,
        untilMs: nowMs,
        // state.db のパス一覧（usage.js は {profile, path} を受ける）
        dbs: stateDbs().map((p, i) => ({ profile: i === 0 ? 'default' : `profile${i}`, path: p })),
      })
      return r?.ok ? r : null
    } catch {
      return null
    }
  }

  /**
   * 完走した瞬間だけ走らせる汎用予兆検知（COH-5 / D55 / D83）。
   *
   * - `coherenceAnalyzer`（既定 `analyzeCoherence`）を **読み取り専用** で 1 回だけ呼ぶ
   * - 実ディレクトリが存在する `workdir`（ボード既定 → ランの repoPath）にだけ走らせる
   * - 失敗は `log.warn` のみ。レポート生成は止めない（非干渉）
   *
   * @param {{board: string, run?: object|null}} group グループ
   * @returns {Promise<object|null>} `normalizeCoherenceAlert()` 相当（予兆なしは null）
   */
  async function coherenceFor(group) {
    const analyzer = typeof opts.coherenceAnalyzer === 'function' ? opts.coherenceAnalyzer : analyzeCoherence
    const workdir = boardWorkdir(group?.board) ?? group?.run?.repoPath ?? null
    if (!workdir) return null
    try {
      if (!fs.statSync(String(workdir)).isDirectory()) return null
    } catch {
      return null // 実ディレクトリが無い workdir では走らせない
    }
    try {
      const thresholds = opts.coherenceThresholds && typeof opts.coherenceThresholds === 'object'
        ? opts.coherenceThresholds
        : {}
      const report = await analyzer(String(workdir), thresholds)
      const alert = coherenceAlertFrom(report)
      return alert?.alert === true ? alert : null
    } catch (err) {
      log.warn?.(`[pipeline-watcher] coherence analysis skipped: ${err?.message ?? err}`)
      return null
    }
  }

  /** 1 ティック分の走査。テストから直接 await できる。 */
  async function tick() {
    ticks += 1
    const stored = readState()
    const baseline = stored === null
    const nowMs = now()
    const state =
      stored ?? { version: 1, startedAtSec: 0, knownTaskIds: {}, activeGroups: {}, reportedKeys: [], updatedAt: null }
    let dirty = baseline

    const rows = readAllTasks()
    const runs = readRunsFn(runsFile)
    const groups = groupTasks(rows, runs)

    if (baseline) {
      // ベースライン: 既存の完了分は通知しない。稼働中の波だけ覚えて完了を待つ。
      state.startedAtSec = Math.floor(nowMs / 1000)
      for (const r of rows) state.knownTaskIds[String(r.id)] = { board: r.board, status: String(r.status ?? '') }
      for (const g of groups) {
        const open = g.tasks.filter((t) => OPEN_STATUSES.has(String(t.status ?? ''))).length
        if (open > 0) state.activeGroups[g.base] = true
      }
      state.updatedAt = new Date(nowMs).toISOString()
      writeState(state)
      return { baseline: true, groups: groups.length, reported: [], statePath }
    }

    const reported = []
    const touchedRuns = new Map()

    for (const g of groups) {
      const counts = countStatuses(g.tasks)
      const open = counts.running + counts.ready + counts.todo
      const settled = counts.done + counts.blocked + counts.failed

      if (open > 0) {
        if (!state.activeGroups[g.base]) {
          state.activeGroups[g.base] = true
          dirty = true
        }
        continue
      }
      const wasActive = Boolean(state.activeGroups[g.base])
      if (wasActive) {
        delete state.activeGroups[g.base]
        dirty = true
      }
      if (settled === 0) continue

      const latestCompletedAt = g.tasks.reduce((a, t) => Math.max(a, Number(t.completed_at ?? 0) || 0), 0)
      const key = g.spec
        ? `spec:${g.board}:${g.spec}:${latestCompletedAt}`
        : `wave:${g.board}:${waveHash(g.tasks)}`
      if (state.reportedKeys.includes(key)) continue

      // ティック間に起票→完了したタスクの取りこぼし防止
      const hasNew = g.tasks.some(
        (t) =>
          !state.knownTaskIds[String(t.id)] && Number(t.completed_at ?? 0) >= Number(state.startedAtSec ?? 0),
      )
      const runPending = Boolean(g.run && !g.run.reportedAt)
      if (!wasActive && !hasNew && !runPending) continue

      const status = counts.blocked + counts.failed > 0 ? 'halted' : 'done'
      const label = g.spec
        ? String(g.run?.title ?? specTitleFromFile(g) ?? g.spec)
        : boardLabel(g.board)
      const gitMap = await collectGit(g.tasks)
      const usageScope = scopedUsage(g, nowMs)
      // 収束して統合レポートを出す瞬間だけ予兆検知を走らせる（定期ポーリングでは走らせない）
      const coherence = await coherenceFor(g)
      const report = buildPipelineReport({
        status,
        label,
        board: g.board,
        specRelPath: g.spec,
        tasks: g.tasks,
        gitMap,
        usage: usageScope,
        coherence,
        startedAt: g.tasks.reduce((a, t) => {
          const v = Number(t.started_at ?? t.created_at ?? 0) || 0
          return a === 0 ? v : Math.min(a, v || a)
        }, 0) * 1000 || state.startedAtSec * 1000,
        now: nowMs,
      })
      const sessionId = resolveTargetSessionId(g)
      const at = new Date(nowMs).toISOString()
      const row = {
        at,
        kind: PIPELINE_KIND,
        status,
        session_id: sessionId,
        task_id: `pipeline:${g.board}:${g.run?.id ?? waveHash(g.tasks)}`,
        label,
        board: g.board,
        spec: g.spec,
        repo_path: boardWorkdir(g.board) ?? g.run?.repoPath ?? null,
        text: report.text,
        markdown: report.markdown,
        // UI 言語で選ぶための英語版（旧クライアントは markdown / text を使い続ける）
        text_en: report.textEn,
        markdown_en: report.markdownEn,
        follow_up_prompt: report.followUpPrompt,
        follow_up: report.followUp,
        counts: report.counts,
        // 予兆あり（alert === true）のときだけ付く（D83・自動起票はしない）
        ...(report.coherence_alert ? { coherence_alert: report.coherence_alert } : {}),
      }
      appendJsonl(chatReportsPath, row)
      appendJsonl(reportsPath, row)
      if (g.run && !g.run.reportedAt) {
        g.run.reportedAt = at
        touchedRuns.set(String(g.run.id), g.run)
      }
      state.reportedKeys.push(key)
      if (state.reportedKeys.length > REPORTED_KEYS_MAX) {
        state.reportedKeys = state.reportedKeys.slice(-REPORTED_KEYS_MAX)
      }
      dirty = true
      reported.push({ kind: PIPELINE_KIND, status, board: g.board, spec: g.spec, sessionId, taskId: row.task_id })
    }

    // 既知タスクを更新（次ティックで「新規」と誤認しない）
    for (const r of rows) {
      const id = String(r.id)
      const prev = state.knownTaskIds[id]
      if (!prev) {
        state.knownTaskIds[id] = { board: r.board, status: String(r.status ?? '') }
        dirty = true
        continue
      }
      if (prev.status !== String(r.status ?? '')) {
        prev.status = String(r.status ?? '')
        prev.board = r.board
        dirty = true
      }
    }

    if (touchedRuns.size > 0) {
      try {
        const fresh = readRunsFn(runsFile)
        const merged = fresh.map((r) => touchedRuns.get(String(r.id)) ?? r)
        writeRunsFn(runsFile, merged)
      } catch (err) {
        log.warn?.(`[pipeline-watcher] Failed to update run reportedAt: ${err?.message ?? err}`)
      }
    }

    if (dirty) {
      state.updatedAt = new Date(nowMs).toISOString()
      writeState(state)
    }
    return { baseline: false, groups: groups.length, reported, statePath }
  }

  /** 例外でプロセスを落とさないティック（定期実行用）。 */
  async function safeTick() {
    if (running) return null
    running = true
    try {
      const r = await tick()
      lastError = null
      return r
    } catch (err) {
      lastError = String(err?.message ?? err)
      log.warn?.(`[pipeline-watcher] ${lastError}`)
      return null
    } finally {
      running = false
    }
  }

  /** 監視を始める（初回は即ティック＝ベースライン確立）。 */
  function start() {
    if (timer) return
    safeTick()
    timer = setInterval(safeTick, intervalMs)
    // ブリッジの停止を妨げない（テストや CLI が終われなくなるため）
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return {
    intervalMs,
    statePath,
    chatReportsPath,
    reportsPath,
    feedPath,
    runsPath: runsFile,
    tick,
    start,
    stop,
    reports: (o = {}) => readPipelineReports(reviewRoot, o),
    status: () => ({ running: Boolean(timer), ticks, lastError, statePath }),
  }
}
