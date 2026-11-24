/**
 * Review のフィード / チャット報告 API（feed・chatReport(s)・画像からの起票）。
 * `review.js` の `createReview` から分割した。「ctx」で閉包のヘルパを受け取り、公開契約は
 * `review.js` が組み立てる（呼び出し側の API 形は変えない）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readTailText } from '../tail.js'
import { outputOf } from '../lib/cli.js'
import { isSafeRel, parseReviewLine } from './parse.js'
import { opsText } from './text.js'
import { writeFileAtomic } from '../lib/atomic.js'
import { safeList } from '../lib/safe.js'

export function createReviewFeeds(ctx = {}) {
  const {
    cfg,
    opts,
    board,
    explicitBoard,
    reviewRoot,
    workdir,
    resolveInside,
    bodyOf,
    readTaskChats,
    rememberTaskChat,
    sanitizeChatId,
    reviewAssignee,
    runKanbanOn,
    resolveCreateBoard,
    shotWriteRoot,
    readBoardMeta,
    targets,
    resolveTarget,
  } = ctx

  function feed(limit = 20, since = 0) {
    const file = path.join(reviewRoot(), 'feed.jsonl')
    if (!fs.existsSync(file)) return []
    const raw = safeList('review.feeds.feed', () => readTailText(file, 128 * 1024), '')
    if (!raw) return []
    const tail = raw.split('\n').filter((l) => l.trim()).slice(-Math.min(200, Math.max(1, Number(limit) || 20)))
    const out = []
    for (const line of tail) {
      try {
        const j = JSON.parse(line)
        const at = Date.parse(String(j.at ?? ''))
        if (!Number.isFinite(at)) continue
        if (since && at <= Number(since)) continue
        out.push({ at, text: String(j.text ?? '') })
      } catch {
        // 書きかけ・壊れた行は捨てる（フィードは補助情報）
      }
    }
    return out
  }

  /**
   * レビューの完了報告の生データ（監視 cron `mobile-review-watch` が書く 1 行/タスク）。
   *
   * 1 会話だけを見る `chatReport` と、全会話を見る `chatReports` の共通読み取り。
   * ファイルが無い（＝宛先つきのタスクがまだ完了していない）のは正常なので空で返す。
   *
   * @returns {Array<{at: number, sessionId: string, taskId: string, label: string|null, text: string}>} 古い順
   */
  function readChatReportRows() {
    const file = path.join(reviewRoot(), 'chat-reports.jsonl')
    if (!fs.existsSync(file)) return []
    const raw = safeList('review.feeds.chatReports', () => readTailText(file, 256 * 1024), '')
    if (!raw) return []
    const taskChats = readTaskChats()
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const at = Date.parse(String(j.at ?? ''))
        if (!Number.isFinite(at)) continue
        const taskId = String(j.task_id ?? '')
        let sessionId = String(j.session_id ?? '')
        if (!sessionId && taskId) {
          sessionId = taskChats[taskId] || sanitizeChatId(parseReviewLine(bodyOf(taskId)?.body)?.chat) || ''
        }
        if (!sessionId) continue
        // パイプライン統合レポート（`kind: 'pipeline'`）の追加フィールドは**透過的に**保持する。
        // 既存のレビュー 1 行レポート（at/session_id/task_id/label/text だけ）は今まで通り。
        out.push({
          at,
          sessionId,
          taskId,
          label: j.label ?? null,
          text: String(j.text ?? ''),
          kind: j.kind ? String(j.kind) : null,
          status: j.status ? String(j.status) : null,
          board: j.board ? String(j.board) : null,
          spec: j.spec ? String(j.spec) : null,
          repoPath: j.repo_path ? String(j.repo_path) : null,
          markdown: typeof j.markdown === 'string' ? j.markdown : '',
          markdownEn: typeof j.markdown_en === 'string' ? j.markdown_en : '',
          textEn: typeof j.text_en === 'string' ? j.text_en : '',
          followUpPrompt: typeof j.follow_up_prompt === 'string' ? j.follow_up_prompt : '',
          followUp: j.follow_up && typeof j.follow_up === 'object' && !Array.isArray(j.follow_up) ? j.follow_up : null,
          counts: j.counts && typeof j.counts === 'object' && !Array.isArray(j.counts) ? j.counts : null,
        })
      } catch {
        // 書きかけ・壊れた行は捨てる（補助情報）
      }
    }
    return out
  }

  /**
   * ある会話に流すレビューの完了報告（監視 cron `mobile-review-watch` が書く）。
   *
   * 完了報告は Discord と作業フィードにしか出ておらず、**起票した会話**には戻らなかった
   * （実測: 回答 22:19 → 完了 22:26 の報告を、会話を開いても読めない）。起票時に本文へ
   * `chat=<session_id>` を書いたタスクだけ、完了の 1 行をその会話へ返す。
   *
   * @param {string} sessionId 会話のセッション ID
   * @param {{limit?: number, since?: number}} [opts] 末尾何件・この epoch ms より新しい行だけ
   * @returns {Array<{at: number, taskId: string, label: string|null, text: string}>} 古い順
   */
  function chatReport(sessionId, opts = {}) {
    const id = String(sessionId ?? '').slice(0, 128)
    if (!id) return []
    const limit = Math.min(Math.max(Number(opts.limit) || 3, 1), 50)
    const since = Number(opts.since) || 0
    const out = readChatReportRows()
      .filter((r) => r.sessionId === id)
      .filter((r) => !since || r.at > since)
      .map(({ sessionId: _sid, ...rest }) => rest)
    return out.slice(-limit)
  }

  /**
   * 全会話ぶんの完了報告（未読の点を出すため）。
   *
   * 下部ナビのチャットタブと「会話」一覧の行に点を出すには「どの会話に新着があるか」を
   * 1 回で知る必要がある。会話ごとに問い合わせると N 回になるので、絞らずに返して
   * 端末側で既読時刻（localStorage）と突き合わせる。
   *
   * @param {{limit?: number, since?: number}} [opts] 末尾何件（既定 200）・この epoch ms より新しい行だけ
   * @returns {Array<{at: number, sessionId: string, taskId: string, label: string|null, text: string}>} 古い順
   */
  function chatReports(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500)
    const since = Number(opts.since) || 0
    const out = readChatReportRows().filter((r) => !since || r.at > since)
    return out.slice(-limit)
  }

  /** library の画像を返す（allowlist 内のみ）。 */
  function libraryFile(rel) {
    if (!isSafeRel(rel)) return { ok: false, code: 'BAD_PATH' }
    const lower = String(rel).toLowerCase()
    if (!(lower.startsWith('library/') || lower.startsWith('shots/'))) {
      return { ok: false, code: 'OUTSIDE' }
    }
    if (!/\.(png|jpe?g|webp)$/.test(lower)) return { ok: false, code: 'BAD_EXT' }
    const abs = resolveInside(rel)
    if (!abs) return { ok: false, code: 'NOT_FOUND' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type }
  }

  const slugOf = (s) =>
    String(s || 'anno')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'anno'

  /**
   * 画像から注釈タスクを1件作る（upload の dataURL / library・shots の既存ファイル）。
   * 成功したら taskId を返すので、PWA はそのまま注釈エディタを開ける。
   *
   * @param {{source?: string, image?: string, path?: string, title?: string, slug?: string, target?: string, chat?: string}} payload
   * @param {'ja'|'en'} [lang] カード title と block 理由の言語（既定 en）
   */
  async function createFromImage(payload, lang = 'en') {
    const ops = opsText(lang)
    const source = String(payload?.source || 'upload')
    const title = String(payload?.title || '').slice(0, 120) || ops.annotationTitle
    let buf = null
    let ext = '.png'

    if (source === 'upload') {
      const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(payload?.image || ''))
      if (!m) return { ok: false, code: 'BAD_IMAGE' }
      buf = Buffer.from(m[2], 'base64')
      ext = m[1] === 'image/png' ? '.png' : '.jpg'
      if (buf.length > 12 * 1024 * 1024) return { ok: false, code: 'TOO_LARGE' }
    } else {
      const rel = String(payload?.path || '')
      if (!isSafeRel(rel)) return { ok: false, code: 'BAD_PATH' }
      if (!(rel.toLowerCase().startsWith('library/') || rel.toLowerCase().startsWith('shots/'))) {
        return { ok: false, code: 'OUTSIDE' }
      }
      const abs = resolveInside(rel)
      if (!abs) return { ok: false, code: 'NOT_FOUND' }
      buf = fs.readFileSync(abs)
      const e = path.extname(abs).toLowerCase()
      ext = e === '.jpg' || e === '.jpeg' ? '.jpg' : e === '.webp' ? '.webp' : '.png'
    }

    // 注釈の反映先は登録済みリポジトリから選ぶ（自由入力は受けない）
    const picked = resolveTarget(payload?.target)
    if (!picked) {
      return {
        ok: false,
        code: 'UNKNOWN_TARGET',
        targets: targets().map((x) => ({ id: x.id, label: x.label })),
      }
    }
    const target = picked.path
    const targetBoard =
      payload?.board ||
      resolveCreateBoard({ kanbanRoot: cfg.kanbanRoot, targetPath: target, preferredBoard: board, onlyBoard: explicitBoard })
    const metaWd = readBoardMeta(path.join(String(cfg.kanbanRoot ?? ''), 'boards', targetBoard)).workdir
    const writeRoot = shotWriteRoot({
      preferredRoot: opts?.root,
      boardWorkdir: metaWd ?? (targetBoard === board ? workdir() : null),
      reviewRoot: reviewRoot(),
    })

    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[-:T]/g, '')
      .slice(0, 12)
    const label = `${slugOf(payload?.slug || title)}-${stamp}`
    const relShot = `shots/${label}-1${ext}`
    const shotAbs = path.resolve(writeRoot, relShot)
    writeFileAtomic(shotAbs, buf)

    // 起票した会話へ完了報告を返す宛先（レビュー chat-badge-01 q1=A の「紐づけ」）。
    // 注釈タスクは bridge が本文を組み立てるので、端末が渡さないと `chat=` が付かず
    // 完了が会話に戻らない（従来の宛先つきはレビューシート経由だけだった）。
    const chat = sanitizeChatId(payload?.chat)
    const body =
      `[review] label=${label} round=1 mode=annotation image=${relShot} target=${target}` + (chat ? ` chat=${chat}` : '')
    // assignee が無いと dispatcher が拾わない（実測: ready のまま止まる）
    const created = await runKanbanOn(targetBoard, ['create', title, '--body', body, '--assignee', reviewAssignee()])
    // ID 抽出は stdout を優先する（`stderr` は失敗本文用・D102）。
    const m = /t_[0-9a-f]{8}/.exec(created.stdout || created.stderr || '')
    if (created.code !== 0 || !m) {
      return { ok: false, code: 'CREATE_FAILED', message: outputOf(created).slice(0, 300) }
    }
    const taskId = m[0]
    if (chat) rememberTaskChat(taskId, chat)
    const blocked = await runKanbanOn(targetBoard, ['block', taskId, ops.annotationWaiting, '--kind', 'needs_input'])
    return {
      ok: blocked.code === 0,
      board: targetBoard,
      taskId,
      image: relShot,
      label,
      blocked: blocked.code === 0,
      output: outputOf(blocked).slice(0, 300),
    }
  }

  /**
   * タスクの宛先チャット（本文の `chat=` → `task-chats.json`）。
   * reviewWatcher が完了報告の宛先を決めるのに使う（SPEC §4.3）。
   */
  function chatFor(id) {
    const b = bodyOf(id)
    const fromBody = sanitizeChatId(parseReviewLine(b?.body)?.chat)
    if (fromBody) return fromBody
    return readTaskChats()[id] || null
  }

  return { feed, readChatReportRows, chatReport, chatReports, libraryFile, slugOf, createFromImage, chatFor }
}
