/**
 * カンバン（boards / tasks）とレビュー（review）の API ハンドラ。
 *
 * `server.js` の `handleApi` から**そのまま**切り出した（ルート条件・応答形・404 の位置は変えない）。
 * 依存（cfg・各クライアント・送信ヘルパ）は `ctx` で受け取る。
 */
import { injectReviewBridge, reviewSheetHeaders, reviewViewHeaders, reviewViewHtml } from '../review.js'

export function createBoardsApi(ctx = {}) {
  const {
    cfg,
    auth,
    kanban,
    review,
    inbox,
    discord,
    capture,
    gitinfo,
    readWorkerFeed,
    sendJson,
    sendError,
    sendFailure,
    readJson,
    langOf,
    writeAllowed,
    BULK_ARCHIVE_MAX,
    TASK_ID_RE,
    sendOutcome,
    getPilotProfile,
    ensureWatchersFresh,
    nudgeWatchers,
  } = ctx

  async function handleBoards(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    // /api/boards                                        … ボード一覧
    // /api/boards/:slug/tasks                            … タスク一覧（git / Discord 付き）
    // /api/boards/:slug/tasks/:id                        … タスク詳細
    // /api/boards/:slug/tasks/:id/diff                   … そのタスクのコミット差分
    // POST /api/boards/:slug/tasks/:id/abort             … 実行中タスクの中断
    if (!b) return sendJson(res, 200, { boards: kanban.boards() })
    // クイック起票（POST /api/boards/:slug/tasks）
    if (b && c === 'tasks' && !d && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const assignee = String(body?.assignee ?? getPilotProfile()).trim() || 'mobile'
      const r = await capture.create({ ...body, board: b, assignee })
      auth.audit({
        kind: 'kanban.create',
        board: b,
        task: r.task?.id ?? null,
        assignee,
        created: Boolean(r.created),
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (b && c === 'tasks' && !d) {
      // 一覧は本文を載せない（1 件 1.5KB 平均 × 60 件で 90KB になり、モバイル回線で重い）。
      // 本文は詳細（/api/boards/:slug/tasks/:id）から取る。
      // `archivedCount` は一覧の LIMIT と独立に数える（「アーカイブ済み (N)」の N。D92）。
      const list = kanban.tasks(b, { limit: Number(url.searchParams.get('limit') ?? 60), withBody: false })
      const archivedCount = kanban.statusCounts(b).archivedCount
      // Git 記録（履歴または Kanban ネイティブ解決）と Discord アンカーを添える
      const boardWorkdir =
        typeof kanban.boards === 'function' ? kanban.boards().find((x) => x && x.slug === b)?.workdir ?? null : null
      const enriched = await Promise.all(
        list.map(async (t) => {
          const entry = gitinfo.entryFor(t.id)
          const g = await gitinfo.forTask(t.id, { board: b, task: t, boardWorkdir })
          const dc = entry?.anchor ? discord.forAnchor(entry.anchor) : null
          if (!g && !dc) return t
          return { ...t, ...(g ? { git: g } : {}), ...(dc ? { discord: dc } : {}) }
        }),
      )
      return sendJson(res, 200, { tasks: enriched, archivedCount })
    }
    // POST /api/boards/:slug/tasks/bulk-archive { taskIds: [1..50], reason?, by? }
    //   … 「整理モード」の一括アーカイブ（D92）。実行中のタスクは**止めずに**スキップして返す。
    if (b && c === 'tasks' && d === 'bulk-archive' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const ids = Array.isArray(body?.taskIds)
        ? body.taskIds.map((x) => String(x ?? '').trim()).filter(Boolean)
        : []
      if (!ids.length || ids.length > BULK_ARCHIVE_MAX) {
        return sendError(res, 400, 'TASK_IDS_INVALID', { count: ids.length, max: BULK_ARCHIVE_MAX })
      }
      const bad = ids.filter((id) => !TASK_ID_RE.test(id))
      if (bad.length) return sendError(res, 400, 'TASK_ID_INVALID', { ids: bad.slice(0, 10) })
      const by = String(body?.by ?? 'mobile').slice(0, 40)
      const lang = langOf(req, url)
      const reason = String(
        body?.reason ?? (lang === 'ja' ? 'ゴミ整理（一括アーカイブ）' : 'Cleanup (bulk archive)'),
      ).slice(0, 200)
      const known = new Map(kanban.tasks(b, { limit: 200, withBody: false }).map((t) => [t.id, t.status]))
      const archived = []
      const skippedRunning = []
      const skippedArchived = []
      const failed = []
      for (const id of ids) {
        let status = known.get(id) ?? null
        if (status == null) {
          try {
            status = kanban.task(b, id).status
          } catch {
            failed.push({ id, code: 'TASK_NOT_FOUND' })
            continue
          }
        }
        if (status === 'running') {
          skippedRunning.push(id)
          continue
        }
        if (status === 'archived') {
          skippedArchived.push(id)
          continue
        }
        try {
          const out = await inbox.close(b, id, 'cancel', reason, by, lang)
          if (out?.status === 'archived') archived.push(id)
          else if (out?.noop) skippedArchived.push(id)
          else failed.push({ id, reason: 'not_closed' })
        } catch (err) {
          failed.push({ id, code: err?.code ?? 'CLOSE_FAILED' })
        }
      }
      auth.audit({
        kind: 'kanban.bulk_archive',
        board: b,
        requested: ids.length,
        archived: archived.length,
        skippedRunning: skippedRunning.length,
        skippedArchived: skippedArchived.length,
        failed: failed.length,
        by,
      })
      if (archived.length) nudgeWatchers()
      return sendJson(res, 200, { ok: true, board: b, archived, skippedRunning, skippedArchived, failed })
    }
    if (b && c === 'tasks' && d && e === 'diff' && req.method === 'GET') {
      const file = url.searchParams.get('file')
      if (file) {
        const patch = await gitinfo.filePatch(d, String(file).slice(0, 400), { board: b })
        return sendJson(res, patch.ok ? 200 : 404, patch)
      }
      const summary = await gitinfo.diffSummary(d, { board: b })
      return sendJson(res, summary.ok ? 200 : 404, summary)
    }
    if (b && c === 'tasks' && d && e === 'comment' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.comment(b, d, body?.body ?? body?.text, String(body?.by ?? 'mobile'))
      auth.audit({ kind: 'kanban.comment', board: b, task: d, chars: String(body?.body ?? body?.text ?? '').length })
      return sendOutcome(res, out)
    }
    if (b && c === 'tasks' && d && e === 'close' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.close(b, d, body?.action, body?.note ?? body?.reason ?? '', String(body?.by ?? 'mobile'), langOf(req, url))
      auth.audit({
        kind: 'kanban.close',
        board: b,
        task: d,
        action: body?.action ?? null,
        status: out.status,
        noop: Boolean(out.noop),
      })
      if (!out?.noop) nudgeWatchers()
      return sendOutcome(res, out)
    }
    if (b && c === 'tasks' && d && e === 'unblock' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const out = await inbox.unblock(b, d, body?.note ?? body?.reason ?? '', String(body?.by ?? 'mobile'), langOf(req, url))
      auth.audit({
        kind: 'kanban.unblock',
        board: b,
        task: d,
        status: out.status,
        noop: Boolean(out.noop),
      })
      if (!out?.noop) nudgeWatchers()
      return sendOutcome(res, out)
    }
    if (b && c === 'tasks' && d && e === 'worker' && req.method === 'GET') {
      // 任意のボードの実行中タスクでもワーカーのライブ進捗を読めるようにする（SPEC V8-B3）
      const info = kanban.taskSession(b, d)
      if (!info) return sendError(res, 404, 'NO_SESSION')
      const { feed, db, profile } = await readWorkerFeed(info.sessionId, info, Number(url.searchParams.get('limit') ?? 40))
      return sendJson(res, 200, {
        taskId: d,
        status: kanban.task(b, d).status,
        sessionId: info.sessionId,
        db,
        profile,
        feed,
      })
    }
    if (b && c === 'tasks' && d && e === 'abort' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const reason = String(body?.reason ?? 'mobile kill switch').slice(0, 200)
      const out = await kanban.abort(b, d, reason, langOf(req, url))
      auth.audit({ kind: 'kanban.abort', board: b, task: d, reason, result: out })
      if (out?.ok !== false) nudgeWatchers()
      return sendOutcome(res, out?.ok === false ? { ...out, error: out?.output || 'Failed to abort task' } : out)
    }
    if (b && c === 'tasks' && d) {
      const detail = kanban.task(b, d)
      const entry = gitinfo.entryFor(d)
      const g = await gitinfo.forTask(d, { board: b, task: detail })
      if (g) detail.git = g
      if (entry?.anchor) detail.discord = discord.forAnchor(entry.anchor)
      return sendJson(res, 200, detail)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  async function handleReview(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    if (!b) {
      return sendJson(res, 200, {
        board: review.board,
        workdir: review.workdir(),
        items: review.list(Number(url.searchParams.get('limit') ?? 80)),
      })
    }
    // /api/review/feed?limit=&since= … 作業フィード（監視 cron が書く 1 行ログ）
    if (b === 'feed' && req.method === 'GET') {
      await ensureWatchersFresh()
      return sendJson(res, 200, {
        items: review.feed(
          Number(url.searchParams.get('limit') ?? 20),
          Number(url.searchParams.get('since') ?? 0),
        ),
      })
    }
    // /api/review/chat-reports?limit=&since= … 全会話ぶんの完了報告（未読の点を出すため）
    // 会話一覧の行と下部ナビのチャットタブは「どの会話に新着があるか」を 1 回で要る。
    if (b === 'chat-reports' && req.method === 'GET') {
      await ensureWatchersFresh()
      return sendJson(res, 200, {
        items: review.chatReports({
          limit: Number(url.searchParams.get('limit') ?? 200),
          since: Number(url.searchParams.get('since') ?? 0),
        }),
      })
    }
    // /api/review/chat-report?session_id=&limit=&since= … その会話に流す完了報告
    // （監視 cron が起票元の会話へ返す 1 行。端末はチャットタブが 15 秒ごとに読む）
    if (b === 'chat-report' && req.method === 'GET') {
      const sessionId = String(url.searchParams.get('session_id') || '')
      if (!sessionId) return sendError(res, 400, 'SESSION_REQUIRED')
      await ensureWatchersFresh()
      return sendJson(res, 200, {
        sessionId,
        items: review.chatReport(sessionId, {
          limit: Number(url.searchParams.get('limit') ?? 3),
          since: Number(url.searchParams.get('since') ?? 0),
        }),
      })
    }
    // /api/review/:id/session        … 実行ワーカーの session_id を解決する
    if (c === 'session' && req.method === 'GET') {
      const info = review.sessionId(b)
      if (!info) return sendError(res, 404, 'NO_SESSION')
      return sendJson(res, 200, { taskId: b, status: info.status, sessionId: info.sessionId })
    }
    if (c === 'worker' && req.method === 'GET') {
      // worker（profile mobile）の進行を読む。session.resume は通らないので state.db を直接読む
      const info = review.sessionId(b)
      if (!info) return sendError(res, 404, 'NO_SESSION')
      const { feed, db, profile } = await readWorkerFeed(info.sessionId, info, Number(url.searchParams.get('limit') ?? 40))
      return sendJson(res, 200, { taskId: b, status: info.status, sessionId: info.sessionId, db, profile, feed })
    }
    // /api/review/library            … 注釈の下地にできる画像（library + shots）
    // /api/review/library/file?path= … その画像
    // /api/review/from-image         … 画像から注釈タスクを1件作る
    if (b === 'targets') {
      return sendJson(res, 200, { targets: review.targets() })
    }
    if (b === 'library' && !c) {
      return sendJson(res, 200, { items: review.library(Number(url.searchParams.get('limit') ?? 60)) })
    }
    if (b === 'library' && c === 'file' && req.method === 'GET') {
      const r = review.libraryFile(String(url.searchParams.get('path') || ''))
      if (!r.ok) return sendFailure(res, 404, r)
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=600' })
      return res.end(r.data)
    }
    // POST /api/review/annotation/new … 画像から注釈タスクを1件作る（SPEC §4.2）
    // 旧 `/api/review/from-image` は、配信済み dist を掴んだ端末のために受け続ける。
    if (((b === 'annotation' && c === 'new') || b === 'from-image') && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req, 12_000_000)
      const r = await review.createFromImage(body || {}, langOf(req, url))
      auth.audit({ kind: 'review.from_image', task: r.taskId ?? null, source: body?.source ?? 'upload', ok: Boolean(r.ok) })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (c === 'image' && req.method === 'GET') {
      const r = review.image(b, {
        annotated: url.searchParams.get('annotated') === '1',
        // compare=1 … Before（前回の赤入れ／前ラウンド）画像。SPEC §5.2
        compare: url.searchParams.get('compare') === '1',
      })
      if (!r.ok) return sendFailure(res, 404, r)
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=120' })
      return res.end(r.data)
    }
    if (c === 'annotation' && req.method === 'GET') {
      const r = review.annotation(b)
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 404, r)
    }
    if (c === 'annotation' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      // 画像は base64 で来るので、この経路だけ上限を上げる（既定は 1MB）
      const body = await readJson(req, 12_000_000)
      const r = await review.saveAnnotation(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.annotation',
        task: b,
        duplicate: Boolean(r.duplicate),
        marks: r.marks ?? 0,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
    }
    if (c === 'sheet' && req.method === 'GET') {
      const lang = langOf(req, url)
      const r = review.sheetHtml(b, lang)
      if (!r.ok) return sendFailure(res, r.code === 'NOT_FOUND' ? 404 : 409, r)
      // D57: 埋め込みでも単体タブでも**同じ**厳格な CSP（sandbox = 不透明オリジン）で返す。
      // シート内のスクリプトは same-origin Cookie にも /ws/term にも /api/* にも届かない。
      // 回答は postMessage で親（PWA の iframe / :id/view ラッパー）へ渡し、親が POST する。
      res.writeHead(200, reviewSheetHeaders())
      return res.end(injectReviewBridge(r.html, b, lang))
    }
    // /api/review/:id/view … 単体タブ用のラッパー（D57）。
    // シートを sandbox iframe で囲み、postMessage を受けて same-origin で回答を POST する。
    // 存在判定は sheetHtml（.html が無くても .json から生成できる）に合わせる。
    if (c === 'view' && req.method === 'GET') {
      const lang = langOf(req, url)
      const r = review.sheetHtml(b, lang)
      if (!r.ok) return sendFailure(res, r.code === 'NOT_FOUND' ? 404 : 409, r)
      res.writeHead(200, reviewViewHeaders())
      return res.end(reviewViewHtml(b, lang))
    }
    if (c === 'thumb' && req.method === 'GET') {
      const rel = url.pathname.split('/').slice(5).join('/')
      const r = review.thumb(decodeURIComponent(rel))
      if (!r.ok) return sendFailure(res, 404, r)
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'private, max-age=600' })
      return res.end(r.data)
    }
    if (c === 'data' && req.method === 'GET') {
      const r = review.sheetData(b)
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 409, r)
    }
    if (c === 'answer' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.answer(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.answer',
        task: b,
        duplicate: Boolean(r.duplicate),
        choiceCount: Array.isArray(body?.answers) ? body.answers.length : 0,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      // レビュー待ち以外への送信は 409（状態の衝突）として返す。他の失敗は 400。
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, r.code === 'NOT_WAITING' ? 409 : 400, r)
    }
    if (c === 'remix' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.remix(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.remix',
        task: b,
        questionId: body?.questionId ?? null,
        reason: body?.reason ?? null,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, r.code === 'NOT_WAITING' ? 409 : 400, r)
    }
    if (c === 'reopen' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.reopen(b, body?.reason, langOf(req, url))
      auth.audit({ kind: 'review.reopen', task: b, ok: Boolean(r.ok) })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, 400, r)
    }
    // POST /api/review/:id/approve … 赤入れせずに 1 タップ検収（SPEC §5.2.3）
    // コメント `Visual check passed` を残して done（作業済み）または unblock（未作業）へ進める。
    if (c === 'approve' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = await review.approve(b, body || {}, langOf(req, url))
      auth.audit({
        kind: 'review.approve',
        task: b,
        duplicate: Boolean(r.duplicate),
        moved: r.moved ?? null,
        ok: Boolean(r.ok),
      })
      if (r.ok) nudgeWatchers()
      return r.ok ? sendJson(res, 200, r) : sendFailure(res, r.code === 'NOT_WAITING' ? 409 : 400, r)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  return { handleBoards, handleReview }
}
