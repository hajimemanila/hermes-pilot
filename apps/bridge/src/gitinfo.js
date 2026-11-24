import fs from 'node:fs'
import path from 'node:path'
import { run } from './lib/cli.js'
import { safeList } from './lib/safe.js'

/**
 * タスクと Git の紐付け。
 *
 * 1. 旧 `kanban-sop` の履歴（`~/.hermes/state/kanban-sop/history.jsonl`）があれば優先して読む
 *    （`metadata.git` と `metadata.session_anchor` をそのまま使う）。
 * 2. 履歴に無いタスクは、Kanban ネイティブ情報（`branch_name` / `result`・`comments` 中の明示 SHA /
 *    `git log --fixed-strings --grep=<taskId>`）から厳密に解決する。
 *    該当するコミットが無いタスクは**推測で埋めない**（HEAD を勝手に当てない・バッジを出さない）。
 *
 * git は `lib/cli.js` の `run()` でシェルを介さず実行する。
 */

const MAX_PATCH_LINES = 200
const MAX_PATCH_BYTES = 60_000
const RESOLVED_TTL_MS = 30_000
const REPO_STATE_TTL_MS = 5_000
const SHA_MENTION_RE = /\b(?:commit|head)\s+([0-9a-f]{7,40})\b/gi

export function createGitInfo(cfg = {}, deps = {}) {
  const home = cfg.home ?? ''
  const hermesHome = cfg.hermesHome ?? path.join(home, '.hermes')
  const historyPath = cfg.sopHistory ?? path.join(hermesHome, 'state', 'kanban-sop', 'history.jsonl')
  const kanban = deps.kanban ?? null

  /** @type {{mtimeMs: number, map: Map<string, {git: object, anchor: object|null, changedFiles?: string[]}>}} */
  let cache = { mtimeMs: -1, map: new Map() }
  /** @type {Map<string, {at: number, value: {git: object, anchor: null, changedFiles: string[]}|null}>} */
  const resolvedCache = new Map()
  /** @type {Map<string, {at: number, value: {exists: boolean, head: string, dirty: boolean}}>} */
  const repoStateCache = new Map()
  /** @type {Map<string, string>} */
  const subjectCache = new Map()
  /** @type {Map<string, {at: number, files: Array<{path: string, add: number, del: number}>, subject: string}>} */
  const numstatCache = new Map()

  /** 履歴を読み直す（mtime が変わったときだけ）。 */
  function loadHistory() {
    let st
    try {
      st = fs.statSync(historyPath)
    } catch {
      return new Map()
    }
    if (st.mtimeMs === cache.mtimeMs) return cache.map
    const map = new Map()
    let text = ''
    try {
      text = fs.readFileSync(historyPath, 'utf8')
    } catch {
      return cache.map
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.event !== 'done' || !row.task_id) continue
      const md = row.metadata ?? {}
      const git = md.git
      if (!git?.repo) continue
      map.set(String(row.task_id), { git, anchor: md.session_anchor ?? null, changedFiles: md.changed_files ?? [] })
    }
    cache = { mtimeMs: st.mtimeMs, map }
    return map
  }

  /** タスクIDから履歴のエントリを引く。 */
  function entryFor(taskId) {
    const map = loadHistory()
    return map.get(String(taskId)) ?? null
  }

  /** 先頭の `~` を展開する。 */
  function expandHome(p) {
    const raw = String(p ?? '').trim()
    if (!raw) return ''
    if (home && (raw === '~' || raw.startsWith('~/'))) return path.join(home, raw.slice(1))
    return raw
  }

  /** `.git`（ディレクトリまたは worktree ファイル）を持つリポジトリか判定する。 */
  function isGitRepoDir(dir) {
    if (!dir) return false
    try {
      return fs.existsSync(path.join(dir, '.git'))
    } catch {
      return false
    }
  }

  /** ボード一覧を安全に取る。 */
  function listBoards() {
    if (!kanban || typeof kanban.boards !== 'function') return []
    return safeList('gitinfo.boards', () => kanban.boards())
  }

  /** Kanban DB からタスクと対象ボードの workdir を引く。 */
  function findKanbanTask(taskId, hintBoard = null) {
    if (!kanban || typeof kanban.task !== 'function') return { task: null, boardWorkdir: null }
    const boards = listBoards()
    if (hintBoard) {
      try {
        const task = kanban.task(hintBoard, taskId)
        const boardWorkdir = boards.find((b) => b && b.slug === hintBoard)?.workdir ?? null
        return { task, boardWorkdir }
      } catch {
        return { task: null, boardWorkdir: null }
      }
    }
    for (const b of boards) {
      if (!b || b.archived || !b.slug) continue
      try {
        const task = kanban.task(b.slug, taskId)
        if (task) return { task, boardWorkdir: b.workdir ?? null }
      } catch {
        /* 他のボードを探す */
      }
    }
    return { task: null, boardWorkdir: null }
  }

  /** result / comments テキスト中の明示的な commit / HEAD SHA を集める。 */
  function extractMentionedShas(task) {
    const texts = [task?.result, ...(Array.isArray(task?.comments) ? task.comments.map((c) => c?.body) : [])]
    const seen = new Set()
    const out = []
    for (const text of texts) {
      if (typeof text !== 'string' || !text) continue
      SHA_MENTION_RE.lastIndex = 0
      let m
      while ((m = SHA_MENTION_RE.exec(text)) !== null) {
        const sha = m[1].toLowerCase()
        if (!seen.has(sha)) {
          seen.add(sha)
          out.push(sha)
        }
      }
    }
    return out
  }

  /** タスクに厳密に紐づくコミットだけを解決する（無関係な HEAD は返さない）。 */
  async function resolveCommitFromTask(repo, taskId, task) {
    const br = String(task?.branch ?? '').trim()
    if (br && !/^-/.test(br) && !/\s/.test(br)) {
      const res = await git(repo, ['rev-parse', '--verify', '--short', br])
      const head = res.ok ? String(res.stdout).trim().split('\n')[0] ?? '' : ''
      if (head) return { head, branch: br }
    }
    for (const sha of extractMentionedShas(task)) {
      const res = await git(repo, ['rev-parse', '--verify', '--short', `${sha}^{commit}`])
      const head = res.ok ? String(res.stdout).trim().split('\n')[0] ?? '' : ''
      if (head) return { head, branch: br }
    }
    const tid = String(taskId ?? '').trim()
    if (tid && !/^-/.test(tid)) {
      const res = await git(repo, ['log', '-1', '--fixed-strings', `--grep=${tid}`, '--format=%h'])
      const head = res.ok ? String(res.stdout).trim().split('\n')[0] ?? '' : ''
      if (head) return { head, branch: br }
    }
    return null
  }

  /** Kanban ネイティブ情報から Git エントリをフォールバック解決する（30 秒キャッシュ付き）。 */
  async function resolveFromKanban(taskId, opts = {}) {
    if (!kanban && !opts?.task) return null
    const hintBoard = opts?.board ? String(opts.board) : null
    const key = `${hintBoard || '*'}::${String(taskId)}`
    const hasComments = Array.isArray(opts?.task?.comments) && opts.task.comments.length > 0
    const cached = resolvedCache.get(key)
    if (cached && Date.now() - cached.at < RESOLVED_TTL_MS && (cached.value || !hasComments)) {
      return cached.value
    }

    let task = opts?.task ?? null
    let boardWorkdir = opts?.boardWorkdir ?? null
    if (task) {
      if (!boardWorkdir && hintBoard && kanban) {
        boardWorkdir = listBoards().find((b) => b && b.slug === hintBoard)?.workdir ?? null
      }
    } else {
      const found = findKanbanTask(taskId, hintBoard)
      task = found.task
      boardWorkdir = found.boardWorkdir
    }
    if (!task) {
      resolvedCache.set(key, { at: Date.now(), value: null })
      return null
    }
    if (String(task.status ?? '').toLowerCase() === 'ready' && !task.branch && !task.result) {
      resolvedCache.set(key, { at: Date.now(), value: null })
      return null
    }

    const ws = expandHome(task.workspace)
    const wd = expandHome(boardWorkdir)
    const repo = isGitRepoDir(ws) ? ws : isGitRepoDir(wd) ? wd : null
    if (!repo) {
      resolvedCache.set(key, { at: Date.now(), value: null })
      return null
    }

    const hit = await resolveCommitFromTask(repo, taskId, task)
    const value = hit
      ? {
          git: { repo, branch: hit.branch ?? '', head: hit.head, dirty: false, changed_count: 0 },
          anchor: null,
          changedFiles: [],
        }
      : null
    resolvedCache.set(key, { at: Date.now(), value })
    return value
  }

  /** 履歴を優先し、無ければ Kanban ネイティブ解決を試す。 */
  async function resolveEntry(taskId, opts = {}) {
    return entryFor(taskId) ?? (await resolveFromKanban(taskId, opts))
  }

  /**
   * `git -C repo args...` を実行する（戻り値は `lib/cli.js` の統一形）。
   * `null` で潰さない: `ok` を見れば「git が無い」「リポジトリでない」「timeout」を区別できる。
   */
  function git(repo, args, maxBuffer = 1_000_000) {
    return run('git', ['-C', repo, ...args], {
      timeoutMs: 10_000,
      maxBuffer,
      env: { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    })
  }

  /** コミットの1行目サマリ（キャッシュ付き）。 */
  async function subject(repo, head) {
    if (!repo || !head) return ''
    const key = `${repo}@${head}`
    if (subjectCache.has(key)) return subjectCache.get(key)
    const res = await git(repo, ['log', '-1', '--format=%s', head])
    const s = res.ok ? String(res.stdout).trim().split('\n')[0] ?? '' : ''
    subjectCache.set(key, s)
    return s
  }

  /** 実リポジトリの現在 HEAD と作業ツリー汚損状態を取得（5 秒キャッシュ付き）。 */
  async function readLiveRepoState(repo) {
    if (!isGitRepoDir(repo)) return { exists: false, head: '', dirty: false }
    const cached = repoStateCache.get(repo)
    if (cached && Date.now() - cached.at < REPO_STATE_TTL_MS) return cached.value
    const res = await git(repo, ['status', '--porcelain=v2', '--branch'])
    if (!res.ok) return null
    let head = ''
    let dirty = false
    for (const line of String(res.stdout).split('\n')) {
      if (!line) continue
      if (line.startsWith('# ')) {
        if (line.startsWith('# branch.oid ')) {
          const oid = line.slice('# branch.oid '.length).trim().toLowerCase()
          if (oid && oid !== '(initial)') head = oid
        }
        continue
      }
      dirty = true
    }
    const value = { exists: true, head, dirty }
    repoStateCache.set(repo, { at: Date.now(), value })
    return value
  }

  /**
   * 記録上の `dirty` を現在の実ツリーと突き合わせる。
   * 既にクリーン、または HEAD が対象コミットから先へ進んでいれば false を返す。
   */
  async function resolveDirty(repo, head, recordedDirty) {
    if (!recordedDirty) return false
    const live = await readLiveRepoState(repo)
    if (!live) return Boolean(recordedDirty)
    if (!live.exists || !live.dirty) return false
    const want = String(head ?? '').trim().toLowerCase()
    if (!want) return true
    return Boolean(live.head && want.length >= 4 && (live.head === want || live.head.startsWith(want) || want.startsWith(live.head)))
  }

  /**
   * タスクの git 情報（バッジ用）。履歴・Kanban 双方に無ければ null。
   * @param {string} taskId タスクID
   * @param {{board?: string|null, task?: object|null, boardWorkdir?: string|null}} [opts] 解決補助
   * @returns {Promise<{repo: string, branch: string, head: string, dirty: boolean, changedCount: number, subject: string} | null>} 情報
   */
  async function forTask(taskId, opts = {}) {
    const e = await resolveEntry(taskId, opts)
    if (!e) return null
    const { repo, branch, head, dirty, changed_count: changedCount } = e.git
    const [subj, liveDirty] = await Promise.all([subject(repo, head), resolveDirty(repo, head, dirty)])
    return {
      repo,
      branch: branch ?? '',
      head: head ?? '',
      dirty: liveDirty,
      changedCount: liveDirty ? Number(changedCount ?? 0) : 0,
      subject: subj,
    }
  }

  /**
   * コミットの差分サマリ（+add −del のファイル一覧）。
   * @param {string} taskId タスクID
   * @param {{board?: string|null, task?: object|null, boardWorkdir?: string|null}} [opts] 解決補助
   * @returns {Promise<object>} サマリ
   */
  async function diffSummary(taskId, opts = {}) {
    const e = await resolveEntry(taskId, opts)
    if (!e) {
      return { ok: false, code: 'NO_GIT_RECORD', reason: 'This task has no Git record yet' }
    }
    const { repo, head, dirty } = e.git
    if (!head) return { ok: false, code: 'NO_COMMITS', reason: 'No commits yet' }
    if (!fs.existsSync(repo)) return { ok: false, code: 'GIT_REPO_MISSING', reason: `The Git repository directory was not found: ${repo}` }

    const key = `${repo}@${head}`
    const cached = numstatCache.get(key)
    let files = cached?.files
    let subj = cached?.subject
    if (!files) {
      const res = await git(repo, ['show', '--numstat', '--format=%h%x09%s', head])
      if (!res.ok) return { ok: false, code: 'GIT_SHOW_FAILED', reason: 'git show failed' }
      const lines = res.stdout.split('\n')
      const headLine = lines.shift() ?? ''
      subj = headLine.split('\t')[1] ?? ''
      files = []
      for (const l of lines) {
        if (!l.trim()) continue
        const [add, del, file] = l.split('\t')
        if (!file) continue
        files.push({
          path: file,
          add: add === '-' ? 0 : Number(add) || 0,
          del: del === '-' ? 0 : Number(del) || 0,
          binary: add === '-' && del === '-',
        })
      }
      numstatCache.set(key, { at: Date.now(), files, subject: subj })
      if (subj) subjectCache.set(key, subj)
    }
    const total = files.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 })
    const liveDirty = await resolveDirty(repo, head, dirty)
    return {
      ok: true,
      repo,
      head,
      subject: subj ?? '',
      dirty: liveDirty,
      files: files.slice(0, 100),
      total,
      truncated: files.length > 100,
      changedFilesFallback: e.changedFiles ?? [],
    }
  }

  /**
   * 1ファイルのパッチ（そのコミットに含まれるファイルだけ許可）。
   * @param {string} taskId タスクID
   * @param {string} file パス
   * @param {{board?: string|null, task?: object|null, boardWorkdir?: string|null}} [opts] 解決補助
   * @returns {Promise<object>} パッチ
   */
  async function filePatch(taskId, file, opts = {}) {
    const e = await resolveEntry(taskId, opts)
    if (!e?.git?.head) return { ok: false, code: 'NO_COMMITS', reason: 'No commits yet' }
    const { repo, head } = e.git
    const key = `${repo}@${head}`
    if (!numstatCache.has(key)) await diffSummary(taskId, opts)
    const files = numstatCache.get(key)?.files ?? []
    const allowed = files.some((f) => f.path === file)
    if (!allowed) return { ok: false, code: 'FILE_NOT_IN_COMMIT', reason: 'That file is not part of this commit' }

    const res = await git(repo, ['show', '--format=', '--no-color', head, '--', file], MAX_PATCH_BYTES * 4)
    if (!res.ok) return { ok: false, code: 'GIT_SHOW_FAILED', reason: 'git show failed' }
    const patch = res.stdout
    const lines = patch.split('\n')
    const clipped = lines.slice(0, MAX_PATCH_LINES).join('\n')
    const text = clipped.length > MAX_PATCH_BYTES ? clipped.slice(0, MAX_PATCH_BYTES) : clipped
    return {
      ok: true,
      path: file,
      text,
      lines: lines.length,
      truncated: lines.length > MAX_PATCH_LINES || text.length < patch.length,
    }
  }

  /** 起動時にサマリを温める（初回リクエストの待ちを無くす）。 */
  async function warm() {
    const map = loadHistory()
    const seen = new Set()
    for (const [, e] of map) {
      const head = e?.git?.head
      const repo = e?.git?.repo
      if (!head || !repo) continue
      const key = `${repo}@${head}`
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > 200) break
      await subject(repo, head)
    }
  }

  return { forTask, diffSummary, filePatch, entryFor, warm }
}
