/**
 * SPEC Launchpad・コヒーレンス診断・パイプライン最適化・Architect・リポジトリの API ハンドラ。
 *
 * `server.js` の `handleApi` から**そのまま**切り出した（ルート条件・応答形・404 の位置は変えない）。
 * 依存（cfg・各クライアント・送信ヘルパ）は `ctx` で受け取る。
 */
export function createSpecsApi(ctx = {}) {
  const {
    cfg,
    auth,
    repos,
    specs,
    architect,
    readPipelineReports,
    getPilotProfile,
    writePilotProfile,
    ensurePilotProfile,
    DEFAULT_SKILLS_SRC,
    getOptimizeStatus,
    optimizeAgentSkills,
    sendJson,
    sendError,
    sendFailure,
    readJson,
    langOf,
    writeAllowed,
    archiveSpec,
    partitionSpecs,
    readRuns,
    attachRunTaskIds,
    readSpecContent,
    runsPathFor,
    analyzeCoherence,
    resolveSpecRepo,
    coherenceCache,
    COHERENCE_TTL_MS,
    ensureWatchersFresh,
    nudgeWatchers,
  } = ctx

  async function handleRepos(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    if (!b && req.method === 'GET') {
      return sendJson(res, 200, { repos: repos.list({ force: url.searchParams.get('fresh') === '1' }), scanDirs: repos.scanDirs() })
    }
    if (!b && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const r = Array.isArray(body?.scanDirs) ? repos.setScanDirs(body.scanDirs) : repos.add(body)
      auth.audit({ kind: 'repos.save', ok: Boolean(r.ok), path: body?.path ?? null })
      if (!r.ok) return sendFailure(res, 400, r)
      return sendJson(res, 201, { ...r, repos: repos.list({ force: true }), scanDirs: repos.scanDirs() })
    }
    if (b === 'scan' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = repos.scan()
      auth.audit({ kind: 'repos.scan', count: r.repos.length })
      return sendJson(res, 200, r)
    }
    if (b && c === 'board' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = await repos.createBoard(b)
      auth.audit({ kind: 'repos.board.create', repo: b, board: r.board?.slug ?? null, ok: Boolean(r.ok) })
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    if (b && req.method === 'DELETE') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = repos.remove(b)
      auth.audit({ kind: 'repos.remove', repo: b, hidden: r.hidden ?? null, ok: Boolean(r.ok) })
      if (!r.ok) return sendFailure(res, 400, r)
      return sendJson(res, 200, { ...r, repos: repos.list({ force: true }) })
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  async function handleSpecs(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    if (!b && req.method === 'GET') {
      const target = resolveSpecRepo({
        repoId: url.searchParams.get('repo'),
        boardSlug: url.searchParams.get('board'),
      })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      // 既定はアクティブ SPEC だけ（完了済みで Launchpad が埋まらないようにする。D84）。
      // `?includeArchived=1` で全件（`specs` にアーカイブも含める）。
      const all = attachRunTaskIds(specs.listSpecs(target.path), readRuns(runsPathFor(cfg)))
      const parts = partitionSpecs(all)
      const includeArchived = url.searchParams.get('includeArchived') === '1'
      return sendJson(res, 200, {
        ok: true,
        repo: target.repo,
        label: target.label,
        path: target.path,
        board: target.board,
        specs: includeArchived ? all : parts.active,
        archivedSpecs: parts.archived,
        archivedCount: parts.archived.length,
      })
    }
    // GET /api/specs/content?board=<slug>&repo=<id>&path=<rel>
    //   … 1 枚の SPEC の全文（リポジトリ境界内・`.md` のみ・256KB 上限）
    //   不正パス（`../` 等）は 400、未検出は 404（`readSpecContent` の ApiError を外側が拾う）
    if (b === 'content' && req.method === 'GET') {
      const target = resolveSpecRepo({
        repoId: url.searchParams.get('repo'),
        boardSlug: url.searchParams.get('board'),
      })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const content = readSpecContent(target.path, url.searchParams.get('path'))
      auth.audit({ kind: 'specs.content', repo: target.repo, path: content.path, bytes: content.bytes })
      return sendJson(res, 200, { ...content, repo: target.repo, label: target.label, board: target.board })
    }
    // GET /api/specs/reports?board=<slug>&limit=<n>  … 直近のパイプライン完走レポート（D20 / D21）
    if (b === 'reports' && req.method === 'GET') {
      await ensureWatchersFresh()
      const board = String(url.searchParams.get('board') ?? '').trim()
      const limit = Number(url.searchParams.get('limit')) || 20
      return sendJson(res, 200, {
        ok: true,
        board: board || null,
        reports: readPipelineReports(cfg.reviewDir, { board, limit }),
      })
    }
    // POST /api/specs/archive { board?, repo?, path }
    //   … SPEC のメタデータ部へ `- **Status**: archived` を追記して退避する（D92 / D84 互換）。
    //     ファイルは消さない・移動しない（パスを維持するので既存リンクは壊れない）。
    //     既にアーカイブ済みなら冪等 `{ ok: true, noop: true }`、`../` は 400。
    if (b === 'archive' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const target = resolveSpecRepo({ repoId: body?.repo, boardSlug: body?.board })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const out = archiveSpec(target.path, body?.path)
      auth.audit({
        kind: 'specs.archive',
        repo: target.repo,
        board: target.board ?? null,
        path: out.path,
        noop: Boolean(out.noop),
      })
      return sendJson(res, 200, { ...out, repo: target.repo, board: target.board ?? null })
    }
    if (b === 'launch' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const target = resolveSpecRepo({ repoId: body?.repo, boardSlug: body?.board })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const board = String(body?.board ?? target.board ?? '').trim()
      const r = await specs.launchSpec({
        repoPath: target.path,
        board,
        specRelPath: body?.specRelPath,
        batchIds: body?.batchIds,
        assignee: String(body?.assignee ?? getPilotProfile()).trim() || 'mobile',
        // 起票元チャット（`Chat:` 行 ＋ ラン記録の originSessionId）。書式外は specs 側で捨てる。
        chat: body?.chat,
        // 本文の見出し言語（`?lang=` → `Accept-Language` → en）。散文だけが従う。
        lang: langOf(req, url),
        dryRun: Boolean(body?.dryRun),
      })
      auth.audit({
        kind: 'specs.launch',
        board,
        spec: String(body?.specRelPath ?? ''),
        created: r.created?.length ?? 0,
        skipped: r.skipped?.length ?? 0,
        failed: r.failed?.length ?? 0,
        ok: Boolean(r.ok),
      })
      if (r.ok && !body?.dryRun) nudgeWatchers()
      return r.ok ? sendJson(res, 201, r) : sendFailure(res, 400, r)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  async function handleCoherence(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    const target = resolveSpecRepo({
      repoId: url.searchParams.get('repo'),
      boardSlug: url.searchParams.get('board'),
    })
    if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
    const fresh = url.searchParams.get('fresh') === '1'
    const key = `${target.repo}:${target.path}`
    const hit = coherenceCache.get(key)
    if (!fresh && hit && Date.now() - hit.at < COHERENCE_TTL_MS) {
      return sendJson(res, 200, { ...hit.report, cached: true })
    }
    let report
    try {
      report = await analyzeCoherence(target.path)
    } catch (e) {
      // 診断の失敗で UI を壊さない（バナーが出ないだけ）。
      return sendJson(res, 200, {
        ok: false,
        error: String(e?.message ?? e).slice(0, 200),
        repo: target.repo,
        board: target.board,
        generatedAt: new Date().toISOString(),
        layers: { universal: false, repoConfig: false, repoChecker: false },
        hardFails: [],
        softSignals: [],
        hotspots: [],
        summary: { hardFailCount: 0, softSignalCount: 0, hotspotCount: 0, activeSpecCount: 0, archivedSpecCount: 0, deprecatedRoutes: 0 },
        recommendedSweep: null,
      })
    }
    coherenceCache.set(key, { at: Date.now(), report })
    return sendJson(res, 200, { ...report, repo: target.repo, label: target.label, board: target.board, cached: false })
  }

  async function handlePipeline(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    if (b === 'status' && req.method === 'GET') {
      return sendJson(
        res,
        200,
        getOptimizeStatus({
          hermesHome: cfg.hermesHome,
          home: cfg.home,
          skillsSrcDir: DEFAULT_SKILLS_SRC,
          pilotProfile: getPilotProfile(),
        }),
      )
    }
    if (b === 'profile' && (req.method === 'POST' || req.method === 'PUT')) {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const pilotProfile = writePilotProfile(cfg.configPath, body?.profile)
      let ensured = null
      if (body?.optimize !== false) {
        ensured = ensurePilotProfile({ hermesHome: cfg.hermesHome, profile: pilotProfile })
      }
      const ok = ensured ? ensured.ok : true
      auth.audit({
        kind: 'pipeline.profile',
        profile: pilotProfile,
        copiedConfig: Boolean(ensured?.copiedConfig),
        soulMode: ensured?.soul?.mode ?? null,
        ok,
      })
      return sendJson(res, ok ? 200 : 500, {
        ok,
        pilotProfile,
        ...(ensured ? { soul: ensured.soul, copiedConfig: ensured.copiedConfig } : {}),
        status: getOptimizeStatus({
          hermesHome: cfg.hermesHome,
          home: cfg.home,
          skillsSrcDir: DEFAULT_SKILLS_SRC,
          pilotProfile,
        }),
      })
    }
    if (b === 'optimize' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      if (typeof body?.profile === 'string' && body.profile.trim()) {
        writePilotProfile(cfg.configPath, body.profile)
      }
      const pilotProfile = getPilotProfile()
      // 既定は SOUL とスキル配置の両方。片方だけ試したいときは明示的に false を渡す。
      const doSoul = body?.soul !== false
      const doSkills = body?.skills !== false
      // 既定の専用プロファイル（`mobile`）のみに書き込み、普段使いの default SOUL は汚さない。
      const ensured = doSoul ? ensurePilotProfile({ hermesHome: cfg.hermesHome, profile: pilotProfile }) : null
      const soul = ensured ? ensured.soul : null
      const profiles = ensured ? { ok: ensured.ok, profiles: ensured.profiles } : null
      const skills = doSkills
        ? optimizeAgentSkills({
            home: cfg.home,
            hermesHome: cfg.hermesHome,
            skillsSrcDir: DEFAULT_SKILLS_SRC,
            pilotProfile,
          })
        : null
      const ok = (soul?.ok ?? true) && (profiles?.ok ?? true) && (skills?.ok ?? true)
      auth.audit({
        kind: 'pipeline.optimize',
        profile: pilotProfile,
        soul: soul?.mode ?? null,
        soulChanged: Boolean(soul?.changed),
        profileTargets: profiles?.profiles?.length ?? 0,
        profileChanged: profiles?.profiles?.filter((p) => p.changed).length ?? 0,
        skillTargets: skills?.targets?.length ?? 0,
        ok,
      })
      return sendJson(res, ok ? 200 : 500, {
        ok,
        pilotProfile,
        soul,
        profiles,
        skills,
        status: getOptimizeStatus({
          hermesHome: cfg.hermesHome,
          home: cfg.home,
          skillsSrcDir: DEFAULT_SKILLS_SRC,
          pilotProfile,
        }),
      })
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  async function handleArchitect(req, res, url, seg) {
    const [, a, b, c, d, e] = seg
    if (b === 'config') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...architect.getConfig() })
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
          return sendError(res, 429, 'RATE_LIMITED')
        }
        const body = await readJson(req)
        // 正規化せずに渡す（未知のランナー名は INVALID_RUNNER で 400 にする）
        const r = architect.setConfig({ runner: body?.runner })
        auth.audit({ kind: 'architect.config', runner: r.runner ?? null, ok: Boolean(r.ok) })
        if (!r.ok) return sendFailure(res, r.code === 'INVALID_RUNNER' ? 400 : 409, r)
        return sendJson(res, 200, { ok: true, ...architect.getConfig() })
      }
      return sendError(res, 405, 'METHOD_NOT_ALLOWED')
    }

    if (b === 'seed' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const body = await readJson(req)
      const target = resolveSpecRepo({ repoId: body?.repo, boardSlug: body?.board })
      if (!target) return sendError(res, 404, 'NOT_FOUND', { resource: 'repo' })
      const board = String(body?.board ?? target.board ?? '').trim()
      const r = await architect.seed({
        repoPath: target.path,
        board,
        seedText: body?.seedText,
        runner: body?.runner,
        autoStart: Boolean(body?.autoStart),
        executionPolicy: body?.executionPolicy,
        chat: body?.chat,
        lang: body?.lang,
      })
      auth.audit({
        kind: 'architect.seed',
        board,
        repo: target.repo,
        runner: r.runner ?? null,
        executionPolicy: r.executionPolicy ?? null,
        autoStart: Boolean(body?.autoStart),
        chars: String(body?.seedText ?? '').length,
        ok: Boolean(r.ok),
      })
      // 202: ジョブは動き出したが、SPEC はまだ無い（PWA は jobs をポーリングする）
      return r.ok ? sendJson(res, 202, r) : sendFailure(res, 400, r)
    }

    if (b === 'jobs' && c && d === 'dismiss' && req.method === 'POST') {
      if (!writeAllowed(cfg.rate.maxWrites, cfg.rate.windowMs)) {
        return sendError(res, 429, 'RATE_LIMITED')
      }
      const r = architect.dismiss(c)
      auth.audit({ kind: 'architect.dismiss', jobId: String(c), ok: Boolean(r.ok), persisted: Boolean(r.persisted) })
      if (!r.ok) return sendFailure(res, r.code === 'JOB_NOT_FOUND' ? 404 : 400, r)
      return sendJson(res, 200, { ok: true, jobId: r.jobId, persisted: Boolean(r.persisted) })
    }

    if (b === 'jobs' && !c && req.method === 'GET') {
      const board = String(url.searchParams.get('board') ?? '').trim()
      // D42: 既定はアクティブジョブをボード横断で返す。`?strictBoard=1` で V7 互換の厳密一致。
      const strictBoard = ['1', 'true', 'yes'].includes(String(url.searchParams.get('strictBoard') ?? '').trim().toLowerCase())
      const target = resolveSpecRepo({ repoId: url.searchParams.get('repo'), boardSlug: board || null })
      const snapshot = await architect.jobs({
        board,
        strictBoard,
        ...(target?.path ? { include: { repoPath: target.path, board: target.board ?? board } } : {}),
      })
      return sendJson(res, 200, snapshot)
    }
    return sendError(res, 404, 'UNKNOWN_ENDPOINT', { path: url.pathname })
  }

  return { handleRepos, handleSpecs, handleCoherence, handlePipeline, handleArchitect }
}
