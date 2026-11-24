
/**
 * レビュー（review）パイプラインのブリッジ側。
 *
 * 契約は `docs/REVIEW-VIEW.md` と `docs/SPEC-PUBLIC-PLUGIN.md` §4。カンバン（board `mobile`）が唯一の真実で、
 * シートはボードの default_workdir 配下に置かれる。ここは**読み取り + 回答の書き込み**だけを行い、
 * 実装判断はしない（生成も反映も worker の仕事）。
 *
 * パスの解決規則:
 *  - シートの場所はタスク本文の `[review] ... sheet=...` 行から取る（リクエストのパスは使わない）
 *  - 解決後 realpath が workdir 配下でなければ拒否する（allowlist）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readTailText } from './tail.js'
import { outcomeOf, outputOf, runHermes } from './lib/cli.js'
import { writeJsonAtomic, writePairAtomic } from './lib/atomic.js'
import { safeList } from './lib/safe.js'
import { opsText, reopenTextOf, replyTextOf } from './review/text.js'
import {
  answerHash,
  answeredAtForReview,
  compareCandidates,
  isSafeRel,
  parseReplyText,
  parseReviewLine,
  sheetPaths,
  toReplyText,
} from './review/parse.js'
import {
  escapeHtmlText,
  htmlText,
  renderSheetHtmlFromData,
  reviewSheetHeaders,
  reviewViewHeaders,
  reviewViewHtml,
} from './review/sheet-html.js'
import { createReviewMedia } from './review/media.js'
import { createReviewFeeds } from './review/feeds.js'
import { createReviewTransitions } from './review/transitions.js'
import {
  expandHome,
  findTaskBoard,
  listBoardDbs,
  queryLastEvents,
  queryReviewBodies,
  queryReviewRows,
  querySessionId,
  querySiblingIndex,
  readBoardMeta,
  resolveCreateBoard,
  shotWriteRoot,
} from './review/boards.js'

/*
 * 分割したモジュールの再エクスポート。`./review.js` からの import 契約は 1 つも変えない。
 */
export {
  answerHash,
  answeredAtForReview,
  compareCandidates,
  isSafeRel,
  parseReplyText,
  parseReviewLine,
  sheetPaths,
  toReplyText,
} from './review/parse.js'
export {
  HTML_TEXT,
  REVIEW_SHEET_CSP,
  REVIEW_VIEW_CSP,
  escapeHtmlText,
  htmlText,
  injectReviewBridge,
  renderSheetHtmlFromData,
  reviewSheetHeaders,
  reviewViewHeaders,
  reviewViewHtml,
} from './review/sheet-html.js'
export { opsText, reopenTextOf, replyTextOf } from './review/text.js'

export function createReview(cfg, opts = {}) {
  const explicitBoard = opts.board || process.env.REVIEW_BOARD || null
  const board = explicitBoard || 'mobile'
  const boardDir = path.join(cfg.kanbanRoot, 'boards', board)
  const dbPath = path.join(boardDir, 'kanban.db')
  const taskBoardCache = new Map()

  function homeDir() {
    return path.dirname(cfg.kanbanRoot || path.join(os.homedir(), '.hermes', 'kanban'))
  }

  /**
   * データの根（D1 / §3.2）。`~/.hermes/plugin-data/hermes-pilot/` に一本化する。
   * 旧名のデータ根（`plugin-data/<旧名>` と `~/Projects/<旧名>`）は参照しない（移行スクリプトが物理コピーする）。
   */
  function dataRoot() {
    if (cfg.pluginDataDir) return cfg.pluginDataDir
    return path.join(homeDir(), 'plugin-data', 'hermes-pilot')
  }

  /** レビューのワークスペース（sheets / shots / library / *.jsonl）。 */
  function reviewRoot() {
    return path.join(dataRoot(), 'review')
  }

  function sanitizeChatId(raw) {
    return String(raw ?? '')
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 128)
  }

  function taskChatsFile() {
    return path.join(reviewRoot(), 'task-chats.json')
  }

  function readTaskChats() {
    const obj = readJsonIfExists(taskChatsFile())
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      const c = sanitizeChatId(v)
      if (k && c) out[k] = c
    }
    return out
  }

  function rememberTaskChat(taskId, rawChat) {
    const id = String(taskId ?? '').trim()
    const chat = sanitizeChatId(rawChat)
    if (!id || !chat) return
    try {
      const file = taskChatsFile()
      const cur = readTaskChats()
      cur[id] = chat
      const keys = Object.keys(cur)
      if (keys.length > 500) {
        for (const k of keys.slice(0, keys.length - 500)) delete cur[k]
      }
      writeJsonAtomic(file, cur)
    } catch {
      /* 補助情報なので失敗しても本処理を止めない */
    }
  }

  /** 既定のワークスペース（opts.root → 非 Git の default_workdir → reviewRoot）。 */
  function workdir() {
    if (opts.root) return path.resolve(expandHome(opts.root))
    const meta = readBoardMeta(boardDir)
    if (meta.workdir && !fs.existsSync(path.join(meta.workdir, '.git'))) return meta.workdir
    return reviewRoot()
  }

  function openDb() {
    return new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 })
  }

  function rows(limit = 80) {
    return queryReviewRows(cfg.kanbanRoot, board, explicitBoard, limit)
  }

  function lastEvents(ids) {
    return queryLastEvents(cfg.kanbanRoot, board, explicitBoard, ids)
  }

  function bodyOf(id) {
    const hit = findTaskBoard(cfg.kanbanRoot, id, board, explicitBoard)
    if (!hit) return null
    taskBoardCache.set(id, { board: hit.board, workdir: hit.workdir })
    return { ...hit.row, board: hit.board, workdir: hit.workdir }
  }

  function boardOf(id) {
    if (!id) return board
    if (taskBoardCache.has(id)) return taskBoardCache.get(id).board
    const hit = findTaskBoard(cfg.kanbanRoot, id, board, explicitBoard)
    if (hit) {
      taskBoardCache.set(id, { board: hit.board, workdir: hit.workdir })
      return hit.board
    }
    return board
  }

  function siblingIndex() {
    return querySiblingIndex(cfg.kanbanRoot, board, explicitBoard, parseReviewLine)
  }

  function compareRelOf(id, ak, index, extraRoots = []) {
    if (!ak?.image) return null
    const others = (index?.get(ak.label) || []).filter((o) => o.id !== id)
    const cands = compareCandidates({ image: ak.image, round: Number(ak.round ?? 1), others })
    for (const rel of cands) {
      if (resolveInside(rel, extraRoots)) return rel
    }
    return null
  }

  function sessionId(id) {
    return querySessionId(cfg.kanbanRoot, board, explicitBoard, id)
  }

  /** 相対パスが許可ルート配下に実在することを realpath で確かめ、`{ abs, root }` を返す。 */
  function resolveInsideWithRoot(rel, extraRoots = []) {
    if (!isSafeRel(rel)) return null
    const cands = [opts.root ? path.resolve(expandHome(opts.root)) : null, reviewRoot()]
    for (const r of extraRoots) {
      if (!r) continue
      const absR = path.resolve(expandHome(r))
      cands.push(absR, path.join(absR, 'review'))
    }
    cands.push(workdir())
    for (const e of listBoardDbs(cfg.kanbanRoot, board, explicitBoard)) {
      if (e.workdir) cands.push(e.workdir, path.join(e.workdir, 'review'))
    }
    const seen = new Set()
    for (const root of cands) {
      if (!root) continue
      const normRoot = path.resolve(root)
      if (seen.has(normRoot)) continue
      seen.add(normRoot)
      const abs = path.resolve(normRoot, rel)
      const relToRoot = path.relative(normRoot, abs)
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) continue
      try {
        const realRoot = fs.realpathSync(normRoot)
        const realAbs = fs.realpathSync(abs)
        const relReal = path.relative(realRoot, realAbs)
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) continue
        return { abs: realAbs, root: normRoot }
      } catch {
        /* try next root */
      }
    }
    return null
  }

  function resolveInside(rel, extraRoots = []) {
    return resolveInsideWithRoot(rel, extraRoots)?.abs ?? null
  }

  function writeRootFor(rel, row) {
    const extras = row?.workdir ? [row.workdir] : []
    const hit = rel ? resolveInsideWithRoot(rel, extras) : null
    if (hit) return hit.root
    return shotWriteRoot({ preferredRoot: opts.root, boardWorkdir: row?.workdir ?? workdir(), reviewRoot: reviewRoot() })
  }

  function readJsonIfExists(abs) {
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'))
    } catch {
      return null
    }
  }

  /** 一覧（PWA のレビュータブ）。 */
  function list(limit = 80) {
    const out = []
    const base = rows(limit)
    const events = lastEvents(base.map((r) => r.id))
    const taskChats = readTaskChats()
    const siblings = siblingIndex()
    for (const r of base) {
      const ak = parseReviewLine(r.body)
      if (!ak) continue
      const extras = r._workdir ? [r._workdir] : []
      const res = (p) => resolveInside(p, extras)
      const sheetAbs = ak.sheet ? res(ak.sheet) : null
      const paths = ak.sheet ? sheetPaths(ak.sheet) : null
      const dataAbs = paths?.dataRel ? res(paths.dataRel) : null
      const sheet = dataAbs ? readJsonIfExists(dataAbs) : null
      const answeredAt = answeredAtForReview(ak, res, readJsonIfExists, r.id)
      out.push({
        id: r.id,
        board: r._board || board,
        title: r.title,
        status: r.status,
        assignee: r.assignee,
        createdAt: Number(r.created_at ?? 0) * 1000,
        completedAt: r.completed_at ? Number(r.completed_at) * 1000 : null,
        result: r.result ? String(r.result).slice(0, 400) : null,
        progress: {
          lastEvent: events[r.id]?.kind ?? null,
          lastEventAt: events[r.id]?.at ?? null,
          heartbeatAt: r.last_heartbeat_at ? Number(r.last_heartbeat_at) * 1000 : null,
          startedAt: r.started_at ? Number(r.started_at) * 1000 : null,
        },
        review: {
          label: ak.label ?? null,
          image: ak.image ?? null,
          // 比較用（Before=前回の赤入れ）画像があるか。UI はこれでトグルを出す
          hasCompare: Boolean(compareRelOf(r.id, ak, siblings, extras)),
          target: ak.target ?? null,
          repo: repoForTarget(ak.target),
          chat: sanitizeChatId(ak.chat) || taskChats[r.id] || null,
          mode: ak.mode ?? 'standard',
          round: Number(ak.round ?? 1),
          sheet: ak.sheet ?? null,
          exists: Boolean(sheetAbs || dataAbs),
          title: sheet?.title ?? null,
          topic: sheet?.topic ?? null,
          questions: Array.isArray(sheet?.questions) ? sheet.questions.length : 0,
          answeredAt,
        },
      })
    }
    return out
  }

  /**
   * シート HTML（認可は呼び出し側）。
   *
   * `.html` があればそれをそのまま返す（後方互換）。無い（または `.json` を指している）
   * ときは同じ場所の `.json` から閲覧用 HTML を動的生成して返す — JSON ファーストで
   * 起票されたシートでも「シート全体を開く ↗」が常に動くようにするため（D38）。
   *
   * @param {string} id タスク id
   * @param {'en'|'ja'} [lang] 文言の言語（既定 `en`・`?lang=` は呼び出し側が解決する）
   */
  function sheetHtml(id, lang = 'en') {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }
    const extras = b.workdir ? [b.workdir] : []
    const abs = resolveInside(ak.sheet, extras)
    const isJson = Boolean(abs && /\.json$/i.test(abs))
    if (abs && !isJson) return { ok: true, html: fs.readFileSync(abs, 'utf8'), path: abs }
    const dataAbs = isJson ? abs : resolveInside(sheetPaths(ak.sheet).dataRel, extras)
    const data = dataAbs ? readJsonIfExists(dataAbs) : null
    if (!data) return { ok: false, code: 'SHEET_MISSING' }
    return { ok: true, html: renderSheetHtmlFromData(data, ak, lang), path: dataAbs, generated: true }
  }

  /** シートの構造化データ（PWA のネイティブフォーム用）。 */
  function sheetData(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }
    const extras = b.workdir ? [b.workdir] : []
    const abs = resolveInside(sheetPaths(ak.sheet).dataRel, extras)
    const data = abs ? readJsonIfExists(abs) : null
    if (!data) return { ok: false, code: 'DATA_MISSING' }
    // 回答の履歴（完了した項目を「なぜこの設計か」まで辿れるようにする）。
    // 回答は無いことがある（回答前に片付けた等）ので、無ければ null。
    const answer = readJsonIfExists(resolveInside(sheetPaths(ak.sheet).answerRel, extras) || '\0')
    return { ok: true, data, answer: answer || null, taskId: id, status: b.status }
  }

  /**
   * 回答後にタスクへ付ける担当プロファイル。
   * 未指定なら `HP_REVIEW_ASSIGNEE` → `opts.assignee`（文字列または関数）→ `'mobile'`。
   * @returns {string} プロファイル名
   */
  const reviewAssignee = () => {
    const rawOpt = typeof opts.assignee === 'function' ? opts.assignee() : opts.assignee
    return String(process.env.HP_REVIEW_ASSIGNEE ?? rawOpt ?? '').trim() || 'mobile'
  }

  /** 指定ボードに対して CLI（またはテスト差し替え）を呼ぶ。 */
  const runKanbanOn = async (targetBoard, args) => {
    const b = targetBoard || board
    const raw = opts.runKanban
      ? await opts.runKanban(args, b)
      : await runHermes(['kanban', '--board', b, ...args], {
          bin: opts.hermesBin,
          timeoutMs: 30_000,
          maxBuffer: 1_000_000,
        })
    return outcomeOf(raw)
  }
  const idVerbs = new Set(['comment', 'block', 'unblock', 'complete', 'assign', 'archive'])
  const runKanban = (args) => {
    const id = idVerbs.has(args?.[0]) ? String(args?.[1] ?? '') : ''
    return runKanbanOn(id ? boardOf(id) : board, args)
  }

  /**
   * blocked からの遷移の正本（D99 / `review/transitions.js`）。
   *
   * 回答・回答の再送・検収・注釈・注釈の再送はすべてここを通す。判断は表 1 つ、実行は
   * `apply()` 1 つ。テストから `approved_at` を固定したいときは `opts.now` を渡す。
   */
  const transitions = createReviewTransitions({
    runKanban,
    bodyOf,
    now: opts.now,
  })

  /**
   * 回答を保存して状態を進める（冪等）。
   *
   * @param {string} id タスク ID
   * @param {{answers: Array, global?: string, annotations?: Array, by?: string}} payload
   * @param {'ja'|'en'} [lang] 運用 1 行の言語（`answer.txt` の見出しも同じ・既定 en）
   */
  async function answer(id, payload, lang = 'en') {
    const ops = opsText(lang)
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.sheet) return { ok: false, code: 'NO_SHEET' }

    const { dataRel, answerRel } = sheetPaths(ak.sheet)
    const extras = b.workdir ? [b.workdir] : []
    const dataAbs = resolveInside(dataRel, extras)
    const data = dataAbs ? readJsonIfExists(dataAbs) : null
    const questions = Array.isArray(data?.questions) ? data.questions : []

    // シート HTML がそのまま送ってきた【レビュー回答】も受ける
    const fromText =
      payload?.text && !(Array.isArray(payload?.answers) && payload.answers.length)
        ? parseReplyText(payload.text)
        : null
    const answers = fromText ? fromText.answers : Array.isArray(payload?.answers) ? payload.answers : []
    const global = fromText ? fromText.global : String(payload?.global ?? '')
    const annotations = Array.isArray(payload?.annotations) ? payload.annotations : []
    const hash = answerHash({ answers, global, annotations })

    const targetRoot = writeRootFor(dataAbs ? dataRel : ak.sheet, b)
    const answerFile = path.resolve(targetRoot, answerRel)
    const textFile = answerFile.replace(/\.answer\.json$/, '.answer.txt')

    if (payload?.chat) rememberTaskChat(id, payload.chat)
    const existing = readJsonIfExists(answerFile)
    if (existing && existing.sha256 === hash) {
      // 回答は保存済み。遷移だけ未了なら（再送で）ここで進める — 冪等の本体はこの分岐
      const moved = await transitions.apply('answer.again', { id, reason: ops.answeredAgain })
      const status = moved.code === 0 ? moved.status || b.status : b.status
      return {
        ok: moved.code === 0,
        duplicate: true,
        sha256: hash,
        status,
        moved: status,
        code: 'REVIEW_ALREADY_ANSWERED',
        output: moved.out.slice(0, 400),
      }
    }
    // 回答は「レビュー待ち（blocked）」のときだけ受け付ける（状態表 D104 で判定）。
    if (!transitions.canApply('answer.fresh', b.status)) {
      return {
        ok: false,
        code: 'NOT_WAITING',
        status: b.status,
        params: { status: b.status },
      }
    }

    const record = {
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      task_id: id,
      answered_at: new Date().toISOString(),
      answers: answers.map((a) => ({
        id: String(a?.id ?? ''),
        choice: a?.choice ?? null,
        note: String(a?.note ?? ''),
      })),
      global,
      annotations,
      sha256: hash,
    }
    // 正本 `answer.json` → 派生 `answer.txt` の順（D101）。正本（failedAt===0）が落ちたら中断し unblock しない。
    const writePair = opts.writePairAtomic ?? writePairAtomic
    const pair = writePair([
      [answerFile, record, { json: true }],
      [textFile, toReplyText(ak.label ?? id, record.answers, global, questions, lang)],
    ])
    if (pair.failedAt === 0) throw pair.error
    if (pair.failedAt !== null) {
      const reason = String(pair.error?.message ?? pair.error).slice(0, 200)
      console.warn(`[review.answer] write failed at ${pair.written.length + 1}: ${reason}`)
    }

    const summary = ops.answerSummary(
      questions.length || answers.length,
      answers.filter((a) => a?.choice).length,
      answers.filter((a) => !a?.choice).length,
      answerRel,
    )
    const comment = await runKanban(['comment', id, summary, '--author', String(payload?.by ?? 'mobile')])
    const moved = await transitions.apply('answer.fresh', { id, reason: ops.answered })
    let status = moved.code === 0 ? moved.status || b.status : b.status
    /*
     * 回答を受けたタスクに担当が無いと、ready になっても**誰も走らない**
     * （「回答済みだが自律ワーカー起動待ち」で止まる・実測）。未割当ならここで付ける。
     */
    let assigned = null
    let out = moved.out
    if (status === 'ready' && !String(b.assignee ?? '').trim()) {
      const who = String(reviewAssignee() ?? '').trim()
      if (who) {
        const r = await runKanban(['assign', id, who])
        if (r.code === 0) {
          assigned = who
          out = `${out}\n${outputOf(r)}`.trim()
        }
      }
    }
    return {
      ok: comment.code === 0 && moved.code === 0,
      duplicate: false,
      assigned,
      sha256: hash,
      files: { answer: answerRel, text: path.relative(targetRoot, textFile) },
      status,
      moved: status,
      output: `${outputOf(comment)}\n${out}`.trim().slice(0, 800),
    }
  }

  /**
   * 反映が違うとき review に戻す。
   * @param {string} id タスク ID
   * @param {string} [reason] 変更要求の理由（省略時は言語別の既定文）
   * @param {'ja'|'en'} [lang] 既定理由の言語（既定 en・SPEC-EN-ZERO-LEAK D73）
   * @returns {Promise<{ok: boolean, status: string, output: string} | {ok: false, code: string}>} 結果
   */
  async function reopen(id, reason, lang = 'en') {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const out = await runKanban(['request-changes', id, String(reason || reopenTextOf(lang).defaultReason)])
    return { ok: out.code === 0, status: b.status, output: outputOf(out).slice(0, 800) }
  }

  /**
   * 検収（1 タップ合格）の状態遷移。
   *
   * 「✅ Looks Good」の意味は **合格＝完了**（SPEC §5.2.3 / D15②）。実体は
   * `review/transitions.js` の `approve`（complete-then-unblock）で、まず `complete` を試し、
   * それが通らない（ワーカーが抱えたまま等）ときだけ `unblock` に落とす — どちらでも
   * ワーカーは止まらず、人間の判断は失われない。
   *
   * ここは**互換シム**（D99）: `b` は読まない（遷移モジュールが `bodyOf` で status を読み直す）。
   * 戻り値の形 `{ code, out, status, moved }` は従来どおりで、呼び出し側は変えていない。
   *
   * @param {string} id タスク ID
   * @param {{status: string}} b `bodyOf()` の行（互換のため受けるだけ）
   * @param {string} reason unblock に落ちたときの理由
   * @returns {Promise<{code: number, out: string, status: string, moved: string|null}>}
   */
  async function approveAdvance(id, b, reason) {
    return transitions.apply('approve', { id, reason })
  }

  /**
   * 赤入れせずに 1 タップ検収（SPEC §5.2.3 / D15②）。
   *
   * `answer()` と同じ方針:
   *  - 注釈待ち（blocked）のときだけ受け付ける（それ以外は NOT_WAITING）
   *  - 同じ検収の再送は `duplicate` を返し、コメントを二重に付けず遷移だけ補完する
   *
   * 記録は `<image>.approval.json`（注釈の `.annotation.json` と同じ場所）。
   *
   * @param {string} id タスク ID
   * @param {{note?: string, by?: string, chat?: string}} [payload]
   * @param {'ja'|'en'} [lang] unblock 理由の言語（既定 en）
   */
  async function approve(id, payload = {}, lang = 'en') {
    const ops = opsText(lang)
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    if (payload?.chat) rememberTaskChat(id, payload.chat)

    const note = String(payload?.note ?? '').slice(0, 400)
    const by = String(payload?.by ?? 'mobile').slice(0, 40)
    const rel = ak.image.replace(/\.(png|jpe?g|webp)$/i, '.approval.json')
    const abs = path.resolve(writeRootFor(ak.image, b), rel)
    const reason = ops.approved(note, false)

    const existing = readJsonIfExists(abs)
    if (existing) {
      // 冪等: 記録済みならコメントは増やさない（遷移だけ補完）
      const adv = await approveAdvance(id, b, ops.approved(note, true))
      return {
        ok: adv.code === 0,
        duplicate: true,
        status: adv.status,
        moved: adv.moved,
        files: { approval: rel },
        code: 'APPROVAL_ALREADY_RECORDED',
        output: adv.out.slice(0, 400),
      }
    }
    if (!transitions.canApply('approve', b.status)) {
      return {
        ok: false,
        code: 'NOT_WAITING',
        status: b.status,
        params: { status: b.status },
      }
    }

    const record = {
      task_id: id,
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      image: ak.image,
      note,
      approved_by: by,
      approved_at: new Date().toISOString(),
      verdict: 'visual-check-passed',
    }
    writeJsonAtomic(abs, record)

    const comment = await runKanban(['comment', id, 'Visual check passed', '--author', by])
    if (comment.code !== 0) {
      // コメントが残せなかったら検収の記録も消す（再挑戦でコメントを落とさないため）
      try {
        fs.unlinkSync(abs)
      } catch {
        /* 既に消えていれば noop */
      }
      return {
        ok: false,
        code: 'COMMENT_FAILED',
        status: b.status,
        moved: null,
        output: outputOf(comment).slice(0, 400),
      }
    }
    const adv = await approveAdvance(id, b, reason)
    return {
      ok: adv.code === 0,
      duplicate: false,
      status: adv.status,
      moved: adv.moved,
      files: { approval: rel },
      output: `${outputOf(comment)}\n${adv.out}`.trim().slice(0, 600),
    }
  }



  /*
   * メディア / フィードの API は閉包の外（`review/media.js` / `review/feeds.js`）へ出した。
   * ここで ctx を 1 回だけ渡し、従来の名前のまま使えるように戻す（公開 API の形は変えない）。
   */
  const surfaceCtx = {
    cfg,
    opts,
    board,
    explicitBoard,
    boardDir,
    dbPath,
    homeDir,
    dataRoot,
    reviewRoot,
    workdir,
    resolveInside,
    writeRootFor,
    readJsonIfExists,
    list,
    rows,
    bodyOf,
    lastEvents,
    siblingIndex,
    compareRelOf,
    sessionId,
    transitions,
    sheetHtml,
    sheetData,
    answer,
    reopen,
    approve,
    approveAdvance,
    readTaskChats,
    rememberTaskChat,
    sanitizeChatId,
    taskChatsFile,
    openDb,
    reviewAssignee,
    runKanban,
    runKanbanOn,
    resolveCreateBoard,
    shotWriteRoot,
    readBoardMeta,
    queryReviewBodies,
    listBoardDbs,
  }
  const media = createReviewMedia(surfaceCtx)
  const { thumb, image, annotation, saveAnnotation, targets, resolveTarget, repoForTarget, imageRepos, labelTarget, library } =
    media
  const feeds = createReviewFeeds({
    ...surfaceCtx,
    thumb,
    image,
    annotation,
    saveAnnotation,
    targets,
    resolveTarget,
    repoForTarget,
    imageRepos,
    labelTarget,
    library,
  })
  const { feed, chatReport, chatReports, libraryFile, slugOf, createFromImage, chatFor } = feeds

  return {
    board,
    workdir,
    dataRoot,
    reviewRoot,
    chatFor,
    list,
    sheetHtml,
    sheetData,
    answer,
    reopen,
    approve,
    sessionId,
    image,
    annotation,
    saveAnnotation,
    thumb,
    library,
    libraryFile,
    createFromImage,
    targets,
    feed,
    chatReport,
    chatReports,
  }
}
