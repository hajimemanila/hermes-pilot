/**
 * 仕様の種（seed）の整形・slug 提案・プロンプト組み立て。`architect.js` から分割。
 * 公開契約は `architect.js` の再エクスポートで維持する。
 */
import crypto from 'node:crypto'
import { DEFAULT_LANG } from '../lang.js'
import { isJaLang, languageRule } from '../language-rule.js'
import { safeList } from '../lib/safe.js'
import { BOARD_RE, DEFAULT_EXECUTION_POLICY, DEFAULT_REVIEW_BOARD, SEED_MAX, SEED_MIN, executionPolicyLines } from './labels.js'
import { batchIdPrefixForSlug } from './batch.js'

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
  return safeList('architect.recentSpecPaths', () => {
    const list = listSpecsFn(repoPath) ?? []
    return (Array.isArray(list) ? list : [])
      .filter((s) => s && s.path)
      .sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0) || String(a.path).localeCompare(String(b.path)))
      .slice(0, Math.max(1, Number(limit) || EXISTING_SPECS_MAX))
      .map((s) => String(s.path))
  })
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
export function round2Headings(lang) {
  return isJaLang(lang) ? ROUND2_HEADINGS.ja : ROUND2_HEADINGS.en
}
/**
 * 種テキストの安定ハッシュ先頭 8 桁（空白差を畳んだ `normalizeSeed()` を入力にする・D105）。
 * @param {unknown} seedText 種の本文
 * @returns {string} 8 桁の 16 進文字列
 */
export function seedHashOf(seedText) {
  const norm = normalizeSeed(seedText) || String(seedText ?? '').replace(/\s+/g, ' ').trim()
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8)
}

/**
 * ジョブ ID（`arch-<base36 時刻>-<種ハッシュ8>-<乱数 4>`・D105）。
 * @param {number} [ms] 時刻
 * @param {Function} [rand] 乱数（テスト用）
 * @param {string} [seedHash] 8 桁ハッシュまたは生の種文字列
 * @returns {string} ジョブ ID
 */
export function makeJobId(ms = Date.now(), rand = Math.random, seedHash = '') {
  const raw = String(seedHash ?? '').trim()
  const hash8 = /^[0-9a-f]{8}$/i.test(raw) ? raw.toLowerCase() : raw ? seedHashOf(raw) : '00000000'
  const tail = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `arch-${ms.toString(36)}-${hash8}-${tail}`
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
    'do NOT run full test or verification suites, and do NOT hand-write a long bespoke HTML sheet or launch',
    'a headless browser to screenshot mockups unless the question itself is',
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

