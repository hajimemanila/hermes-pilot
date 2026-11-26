/**
 * Review のパース（機械可読行・回答本文・パス安全判定・候補比較）。`review.js` から分割。
 * 公開契約は `review.js` の再エクスポートで維持する。
 */
import crypto from 'node:crypto'
import path from 'node:path'
import {
  ANNOTATIONS_LABEL_RE,
  GLOBAL_LABEL_RE,
  LABEL_RE,
  LINE_RE,
  REPLY_HEAD_RE,
  REPLY_MARK_SOURCE,
  UNSELECTED_RE,
  replyTextOf,
} from './text.js'

export function parseReviewLine(body) {
  const m = LINE_RE.exec(String(body || ''))
  if (!m) return null
  const out = {}
  for (const token of m[1].trim().split(/\s+/)) {
    const idx = token.indexOf('=')
    if (idx > 0) out[token.slice(0, idx)] = token.slice(idx + 1)
  }
  // シートは `sheet=` が正だが、`image=<....html>` と書かれた実例がある（NO_SHEET になった）。
  // html を指しているときだけ別名として受ける。
  if (!out.sheet && out.image && /\.html?$/i.test(out.image)) out.sheet = out.image
  if (!out.sheet && !out.label) return null
  if (out.sheet && !isSafeRel(out.sheet)) return null
  return out
}

/** 相対パスとして妥当か（親ディレクトリ・絶対パスを弾く）。 */
export function isSafeRel(rel) {
  const s = String(rel || '')
  if (!s || s.startsWith('/') || s.includes('..') || s.includes('\0')) return false
  return /^[A-Za-z0-9._/-]+$/.test(s)
}

/** `visualMock.shot` / `visualMock.html` 用: `thumbs/`・`shots/`・`sheets/` 配下のみ許可する。 */
export function isSafeVisualMockRel(rel) {
  const s = String(rel || '')
  if (!isSafeRel(s)) return false
  return /^(?:thumbs|shots|sheets)\//.test(s)
}

/** `visualMock` オブジェクトの安全化（不正パスを除去し、非破壊に返す）。 */
export function sanitizeVisualMock(vm) {
  if (!vm || typeof vm !== 'object' || Array.isArray(vm)) return null
  const out = { ...vm }
  if (out.shot !== undefined) out.shot = isSafeVisualMockRel(out.shot) ? String(out.shot) : null
  if (out.html !== undefined) out.html = isSafeVisualMockRel(out.html) ? String(out.html) : null
  return out
}

/** シート全体・設問ごと・選択肢ごとの `visualMock` パスを安全化する（未指定時は無変更）。 */
export function sanitizeSheetVisualMocks(rawData) {
  if (!rawData || typeof rawData !== 'object') return rawData
  const hasTop = rawData.visualMock !== undefined
  const qs = Array.isArray(rawData.questions) ? rawData.questions : null
  const optHasVm = (q) => Array.isArray(q?.options) && q.options.some((o) => o?.visualMock !== undefined)
  const hasQ = Boolean(qs && qs.some((q) => q?.visualMock !== undefined || optHasVm(q)))
  if (!hasTop && !hasQ) return rawData
  const out = { ...rawData }
  if (hasTop) out.visualMock = sanitizeVisualMock(rawData.visualMock)
  if (hasQ) {
    out.questions = qs.map((q) => {
      if (!q || (q.visualMock === undefined && !optHasVm(q))) return q
      const nextQ = { ...q }
      if (q.visualMock !== undefined) nextQ.visualMock = sanitizeVisualMock(q.visualMock)
      if (optHasVm(q)) {
        nextQ.options = q.options.map((o) =>
          o && o.visualMock !== undefined ? { ...o, visualMock: sanitizeVisualMock(o.visualMock) } : o,
        )
      }
      return nextQ
    })
  }
  return out
}

/**
 * シートパスから「設問 JSON」と「回答 JSON」のパスを作る。
 *
 * `mode=sheet`（.html シート）と `mode=standard`（.json シート）の両方で、
 * 回答が**設問ファイルを上書きしない**ようにする。以前は `.html` だけを置換して
 * いたため、`.json` シートでは `replace` が効かず、回答が設問 JSON にそのまま
 * 書き込まれて設問構造が失われていた（実測: p5-fasttrack-01-1.json が回答文に置換）。
 * @param {string} sheetRel `sheets/<label>-<round>.html|.json`
 * @returns {{dataRel: string, answerRel: string}} 設問と回答の相対パス
 */
export function sheetPaths(sheetRel) {
  const rel = String(sheetRel || '')
  const dataRel = rel.replace(/\.html?$/i, '.json')
  const answerRel = dataRel.replace(/\.json$/i, '.answer.json')
  return { dataRel, answerRel }
}

/**
 * レビュー項目（設問シート / 注釈・検収）の回答・検収日時を読む（無ければ null）。
 *
 * @param {object} ak `parseReviewLine()` の結果
 * @param {(rel: string) => (string|null)} resolveInside パス解決
 * @param {(abs: string) => (object|null)} readJsonIfExists JSON 読取
 * @param {string} [taskId] タスク ID（画像パス再利用時の誤爆防止）
 * @returns {string|null} ISO 日時
 */
export function answeredAtForReview(ak, resolveInside, readJsonIfExists, taskId = '') {
  if (ak?.sheet) {
    const abs = resolveInside(sheetPaths(ak.sheet).answerRel)
    const answered = abs ? readJsonIfExists(abs) : null
    if (answered?.answered_at) return answered.answered_at
  }
  if (ak?.image) {
    for (const suffix of ['.annotation.json', '.approval.json']) {
      const rel = String(ak.image).replace(/\.(png|jpe?g|webp)$/i, suffix)
      if (rel === ak.image) continue
      const abs = resolveInside(rel)
      const rec = abs ? readJsonIfExists(abs) : null
      if (!rec) continue
      if (taskId && rec.task_id && String(rec.task_id) !== String(taskId)) continue
      if (rec.annotated_at) return rec.annotated_at
      if (rec.approved_at) return rec.approved_at
    }
  }
  return null
}

/**
 * 比較用（Before）画像の候補パスを優先順に返す（存在確認はしない純粋関数）。
 *
 * After = いまの下地画像（最新のスクショ）。Before = 前回の赤入れ／前ラウンドの画像。
 * 実測の命名は `<label>-<stamp>-<round>[.<kind>].png`（例 `1385.jpg-202611131208-1.jpg`）で
 * round はほぼ常に 1。比較相手は 3 通りで見つかる:
 *  1. 同名 `.before`（`shots/x-1.before.png` / `x-1.after.png` → `x-1.before.png`）
 *  2. 同じ命名の前ラウンド（末尾の `-<round>` を 1 つ戻す。round >= 2 のときだけ）
 *  3. 同一 label の別タスク（前回のレビュー）の `.annotated`、無ければその元画像
 *
 * 3 は「前ラウンドのタスクは archived のことが多い」（実測）ので status では絞らない。
 *
 * @param {{image?: string, round?: number, others?: Array<{image: string, round?: number}>}} input
 *   `others` は同一 label の他タスクの画像（新しい順）。**このタスク自身は含めない**
 * @returns {string[]} 相対パスの候補（優先順・重複なし）
 */
export function compareCandidates({ image, round = 1, others = [] } = {}) {
  const out = []
  const rel = String(image ?? '').trim()
  if (!rel) return out
  const ext = path.extname(rel)
  if (!/\.(png|jpe?g|webp)$/i.test(ext)) return out
  const noExt = rel.slice(0, -ext.length)
  const push = (p) => {
    if (p && p !== rel && !out.includes(p)) out.push(p)
  }

  // 1) 同名 .before（いまの画像の 1 つ前を撮ったもの）
  push(`${noExt}.before${ext}`)
  if (/\.after$/i.test(noExt)) push(`${noExt.replace(/\.after$/i, '')}.before${ext}`)

  // 2) 前ラウンド（`shots/x-2.png` → `shots/x-1.png`）
  const current = Math.max(1, Number(round) || 1)
  const m = /^(.*-)(\d+)$/.exec(noExt.replace(/\.(after|before)$/i, ''))
  if (m && Number(m[2]) >= 2) {
    const prev = `${m[1]}${Number(m[2]) - 1}`
    push(`${prev}${ext}`)
    push(`${prev}.after${ext}`)
  }

  // 3) 同一 label の前ラウンドタスク（近い順）。赤入れ済みを優先する
  for (const o of Array.isArray(others) ? others : []) {
    const r = String(o?.image ?? '').trim()
    if (!r) continue
    if (Number(o?.round ?? 1) > current) continue
    const e = path.extname(r)
    const base = r.slice(0, -e.length)
    push(`${base}.annotated${e}`)
    push(r)
  }
  return out
}

/** 回答の安定ハッシュ（キー順を固定して二重投稿を検出する）。 */
export function answerHash({ answers = [], global = '', annotations = [] }) {
  const norm = {
    answers: [...answers]
      .map((a) => ({ id: String(a.id ?? ''), choice: a.choice ?? null, note: String(a.note ?? '') }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    global: String(global ?? ''),
    annotations: [...annotations].map((a) => {
      const base = { region: a?.region ?? null, note: String(a?.note ?? '') }
      if (a?.questionId != null) base.questionId = String(a.questionId)
      if (a?.shot != null) base.shot = String(a.shot)
      if (a?.marks !== undefined) base.marks = Array.isArray(a.marks) ? a.marks : null
      return base
    }),
  }
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex')
}

/**
 * 回答テキストを構造化する（シートが直接送ってきた場合に使う）。
 *
 * EN 見出し（`[Review Answer]` / `Overall Note:` / `note:` / `(unselected`）と JA 見出し
 * （`【レビュー回答】` / `全体へのレビュー:` / `補足:` / `(未選択`）、および旧
 * `【赤ペン回答】` / `全体への赤ペン:` を受理する（SPEC §4.1 / SPEC-i18n-gen §3.3）。
 * 履歴が言語混在なので、**片方だけに寄せない**のが契約。
 */
export function parseReplyText(text) {
  const out = { answers: [], global: '' }
  const lines = String(text || '').split(/\r?\n/)
  let inGlobal = false
  for (const line of lines) {
    if (line.trim() === '---') break
    const q = /^Q(\d+)\.\s*(.*?):\s*(.*)$/.exec(line)
    if (q) {
      const rest = q[3]
      const m = /^(.*?)(?:\s*\/\s*(?:補足|[Nn]ote):\s*(.*))?$/.exec(rest)
      const choice = (m?.[1] || '').trim()
      out.answers.push({
        id: `q${q[1]}`,
        choice: UNSELECTED_RE.test(choice) ? null : choice,
        note: (m?.[2] || '').trim(),
      })
      inGlobal = false
      continue
    }
    const g = GLOBAL_LABEL_RE.exec(line)
    if (g) {
      out.global = g[1] || ''
      inGlobal = true
      continue
    }
    if (ANNOTATIONS_LABEL_RE.test(line)) {
      inGlobal = false
      continue
    }
    if (inGlobal) out.global += `\n${line}`
  }
  out.global = out.global.trim()
  return out
}

/**
 * 回答を貼り戻し用テキストにする（`parseReplyText` と往復できる形）。
 *
 * @param {string} label ラベル
 * @param {Array<{id: string, choice: string|null, note?: string}>} answers 回答
 * @param {string} global 全体コメント
 * @param {Array<{id: string, text?: string}>} [questions] 設問（見出しに使う）
 * @param {'ja'|'en'} [lang] 見出しの言語（既定は `en`・SPEC-i18n-gen D4）
 */
export function toReplyText(label, answers, global, questions = [], lang = 'en', annotations = []) {
  const title = new Map(questions.map((q) => [String(q.id), String(q.text ?? '')]))
  const t = replyTextOf(lang)
  const lines = [`${t.head}${label}`]
  for (const a of answers) {
    const q = title.get(String(a.id)) || String(a.id)
    const choice = a.choice === null || a.choice === undefined ? t.unselected : String(a.choice)
    const note = a.note ? ` / ${t.noteMark} ${String(a.note).replace(/\n/g, ' ')}` : ''
    lines.push(`Q${String(a.id).replace(/^q/i, '')}. ${q}: ${choice}${note}`)
  }
  lines.push(`${t.globalLabel}: ${String(global ?? '').replace(/\r/g, '')}`)
  if (Array.isArray(annotations) && annotations.length > 0) {
    lines.push(`${t.annotationsLabel}:`)
    for (const ann of annotations) {
      const qid = String(ann?.questionId ?? 'card')
      const shot = ann?.shot && isSafeVisualMockRel(ann.shot) ? ` (${ann.shot})` : ''
      const marks = Array.isArray(ann?.marks) && ann.marks.length > 0 ? ` [${ann.marks.length} marks]` : ''
      const note = String(ann?.note ?? '').replace(/\r?\n/g, ' ').trim()
      lines.push(`- [${qid}]${shot}${marks}${note ? ` ${note}` : ''}`)
    }
  }
  lines.push('---')
  lines.push(t.tail)
  return `${lines.join('\n')}\n`
}

/**
 * HTML のテキストとして安全な文字列にする（`&` `<` `>` `"` `'`）。
 *
 * JSON シート（外部から来る `title` / 設問文 / 選択肢）を HTML に埋め込む前に必ず通す。
 * `&` を最初に置換しないと二重エスケープになるので順序は固定。
 *
 * @param {unknown} value 任意の値
 * @returns {string} エスケープ済み文字列
 */
