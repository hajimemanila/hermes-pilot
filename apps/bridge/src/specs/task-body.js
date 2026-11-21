/**
 * タスク本文（タイトル・本文の組み立て・既起票の照合）。`specs.js` から分割。
 * 公開契約は `specs.js` の再エクスポートで維持する（呼び出し側の import は変えない）。
 */
import { DEFAULT_LANG, normalizeLang } from '../lang.js'
import { languageRule } from '../language-rule.js'
import { BODY_MAX, CLOSED_STATUSES, buildExecutionContract, normalizeExecutionMode } from './mode.js'

/**
 * 起票元チャット ID の書式（`Chat:` 行に載せる値）。
 * セッション ID・`local-…`・`__latest__` を通しつつ、改行や空白は弾く（本文を壊さない）。
 */
export const SPEC_CHAT_RE = /^[A-Za-z0-9_.:-]{1,128}$/
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
 * 起票するタスクのタイトル（`[<BatchID>] <BatchTitle>`）。
 * @param {{id: string, title: string}} batch バッチ
 * @returns {string} タイトル
 */
export function buildTaskTitle(batch) {
  return `[${batch?.id ?? ''}] ${batch?.title ?? ''}`.trim().slice(0, 200)
}

/**
 * タスク本文の見出し（`lang` ごと・キー集合は両言語で同一）。機械キーは ASCII のまま。
 * 読み取り側（`parseSpec` の `OBJECTIVE_RE` / `EXECUTION_MODE_RE`）は両言語を受ける。
 */
const BODY_HEADINGS = {
  en: {
    objective: '## Objective',
    excerpt: '## Excerpt (acceptance criteria + Verify)',
    objectiveFallback: '(see the excerpt of the batch body below)',
  },
  ja: {
    objective: '## 目的',
    excerpt: '## 抜粋（受入条件 / Verify を含む）',
    objectiveFallback: '（バッチ本文の抜粋を参照）',
  },
}

/**
 * タスク本文の見出し表を返す（未知・未指定は既定 `en`）。
 *
 * @param {unknown} lang 言語（`en` / `ja` / `ja-JP` など）
 * @returns {{objective: string, excerpt: string, objectiveFallback: string}} 見出し
 */
export function bodyHeadings(lang) {
  return BODY_HEADINGS[normalizeLang(lang) ?? DEFAULT_LANG] ?? BODY_HEADINGS[DEFAULT_LANG]
}

/**
 * 起票するタスクの本文（spec パス・target・抜粋・受入条件）。
 *
 * @param {{specRelPath: string, repoPath: string, board: string, batch: {id: string, title: string, objective: string, section: string}, chat?: string, lang?: string}} input 入力
 * @returns {string} 本文
 */
export function buildTaskBody({ specRelPath, repoPath, board, batch, chat, lang }) {
  const chatId = sanitizeSpecChat(chat)
  const mode = normalizeExecutionMode(batch?.mode)
  const h = bodyHeadings(lang)
  const head = [
    `Spec: ${specRelPath}`,
    `Target: ${repoPath}`,
    `Board: ${board}`,
    `Batch: ${batch?.id ?? ''} — ${batch?.title ?? ''}`,
    ...(chatId ? [`Chat: ${chatId}`] : []),
    ...(mode ? [`Mode: ${mode}`] : []),
    '',
    // 出力言語の規則（`language-rule.js` の 1 文をそのまま置く。スキル側と同じ文＝D2）。
    languageRule(lang),
    '',
    h.objective,
    '',
    batch?.objective || h.objectiveFallback,
    '',
    h.excerpt,
    '',
  ].join('\n')
  // 契約ブロックは**末尾に必ず残す**（抜粋だけを切り詰める）。6000 字上限で契約が消えると
  // 自走の保証が壊れるため、順序は「見出し → 抜粋 → 契約」で固定する。
  const contract = buildExecutionContract(mode, { recommendedRole: batch?.recommendedRole })
  const room = Math.max(0, BODY_MAX - head.length - contract.length)
  const section = String(batch?.section ?? '').slice(0, room)
  return `${head}${section}${contract}`.slice(0, BODY_MAX)
}

/** SPEC 相対パスを比較用に正規化する。 */
export function normalizeSpecRelPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  return s || null
}

/** タスクが属する SPEC パスを取り出す（`task.spec` 優先、無ければ本文の `Spec:` / 先頭 5 行）。 */
export function extractTaskSpec(task) {
  const direct = normalizeSpecRelPath(task?.spec)
  if (direct) return direct
  const body = String(task?.body ?? '')
  if (!body) return null
  const m = /^Spec:\s*(.+?)\s*$/m.exec(body)
  if (m) return normalizeSpecRelPath(m[1])
  const head = body.split(/\r?\n/).slice(0, 5).join('\n')
  const leg = /(?:docs\/)?SPEC[A-Za-z0-9._-]*\.md/i.exec(head)
  return leg ? normalizeSpecRelPath(leg[0]) : null
}

/**
 * タスクの時刻（作成・開始・完了のうち最も新しいもの）。カンバン API は ms・DB は秒なので
 * 1e12 未満は秒として扱う（`telemetry.toMs` と同じ規約）。
 *
 * @param {{createdAt?: unknown, startedAt?: unknown, completedAt?: unknown}} task タスク
 * @returns {number} epoch ms（不明は 0）
 */
export function taskStampMs(task) {
  const ms = (value) => {
    if (value === null || value === undefined || value === '') return 0
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n <= 0) {
      const parsed = Date.parse(String(value))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    }
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  }
  return Math.max(ms(task?.createdAt), ms(task?.startedAt), ms(task?.completedAt))
}

/** 無印タスクを拾ってよい猶予（ms）。SPEC の mtime とタスク時刻の丸め差を吸収する。 */
export const SPEC_MTIME_SLACK_MS = 5000

/**
 * 既存タスクの中に同じバッチの未完了タスクがあるか。
 *
 * `specRelPath` 指定時は別 SPEC に属する `[ID]` を無視する（異なる SPEC で同じ ID を使っても衝突しない）。
 * `opts.specMtime` を渡すと、**無印（Spec 行の無い）レガシータスク**は `specMtime - 猶予` 以降に
 * 触られたものだけを対象にする（過去の無印 `[C1]` が新規 SPEC の起票を塞がない。D91）。
 * `archived`（破棄済み）は完了扱いなので、同じバッチを再起票できる（D92）。
 *
 * @param {Array<{title?: string, status?: string, id?: string, spec?: string|null, body?: string}>} tasks 同じボードのタスク
 * @param {string} batchId バッチ ID
 * @param {string|null} [specRelPath] 対象の SPEC 相対パス
 * @param {{specMtime?: number|null, slackMs?: number}} [opts] 無印タスクの時刻ガード
 * @returns {{id: string, title: string, status: string}|null} 見つかった未完了タスク
 */
export function findOpenBatchTask(tasks, batchId, specRelPath = null, opts = {}) {
  const want = `[${String(batchId ?? '').trim()}]`
  if (!want || want === '[]') return null
  const wantSpec = normalizeSpecRelPath(specRelPath)
  const specMtime = Number(opts?.specMtime)
  const slack = Number.isFinite(Number(opts?.slackMs)) ? Number(opts.slackMs) : SPEC_MTIME_SLACK_MS
  const since = wantSpec && Number.isFinite(specMtime) && specMtime > 0 ? specMtime - slack : null
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t) continue
    if (CLOSED_STATUSES.has(String(t.status ?? ''))) continue
    if (!String(t.title ?? '').trim().startsWith(want)) continue
    if (wantSpec) {
      const ts = extractTaskSpec(t)
      if (ts && ts !== wantSpec) continue
      // 無印タスク: 対象 SPEC より前のものは別 SPEC の残骸（誤検知）として無視する。
      if (!ts && since !== null && !(taskStampMs(t) >= since)) continue
    }
    return { id: String(t.id ?? ''), title: String(t.title ?? ''), status: String(t.status ?? '') }
  }
  return null
}
