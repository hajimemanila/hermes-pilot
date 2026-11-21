import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * タスクと Git の紐付け。
 *
 * データ源は `~/.hermes/state/kanban-sop/history.jsonl`（kanban-sop の done が
 * `metadata.git` = {repo, branch, head, dirty, changed_count} と
 * `metadata.session_anchor` = {chat_id, message_id, session_id, user} を残している）。
 * ここに無いタスクは**推測で埋めない**（バッジを出さない）。
 *
 * git は `execFile` でシェルを介さず実行し、リポジトリも head も履歴の値しか使わない。
 */

const MAX_PATCH_LINES = 200
const MAX_PATCH_BYTES = 60_000

export function createGitInfo(cfg) {
  const historyPath = cfg.sopHistory ?? path.join(cfg.home, '.hermes', 'state', 'kanban-sop', 'history.jsonl')

  /** @type {{mtimeMs: number, map: Map<string, {git: object, anchor: object|null}>}} */
  let cache = { mtimeMs: -1, map: new Map() }
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

  /** `git -C repo args...` を実行して stdout を返す（失敗は null）。 */
  function git(repo, args, maxBuffer = 1_000_000) {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-C', repo, ...args],
        { timeout: 10_000, maxBuffer, env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout) => resolve(err ? null : String(stdout ?? '')),
      )
    })
  }

  /** コミットの1行目サマリ（キャッシュ付き）。 */
  async function subject(repo, head) {
    if (!repo || !head) return ''
    const key = `${repo}@${head}`
    if (subjectCache.has(key)) return subjectCache.get(key)
    const out = await git(repo, ['log', '-1', '--format=%s', head])
    const s = (out ?? '').trim().split('\n')[0] ?? ''
    subjectCache.set(key, s)
    return s
  }

  /**
   * タスクの git 情報（バッジ用）。履歴に無ければ null。
   * @param {string} taskId タスクID
   * @returns {Promise<{repo: string, branch: string, head: string, dirty: boolean, changedCount: number, subject: string} | null>} 情報
   */
  async function forTask(taskId) {
    const e = entryFor(taskId)
    if (!e) return null
    const { repo, branch, head, dirty, changed_count: changedCount } = e.git
    return {
      repo,
      branch: branch ?? '',
      head: head ?? '',
      dirty: Boolean(dirty),
      changedCount: Number(changedCount ?? 0),
      subject: await subject(repo, head),
    }
  }

  /**
   * コミットの差分サマリ（+add −del のファイル一覧）。
   * @param {string} taskId タスクID
   * @returns {Promise<object>} サマリ
   */
  async function diffSummary(taskId) {
    const e = entryFor(taskId)
    if (!e) {
      return { ok: false, code: 'NO_GIT_RECORD', reason: 'This task has no Git record (it may not have gone through kanban-sop)' }
    }
    const { repo, head, dirty } = e.git
    if (!head) return { ok: false, code: 'NO_COMMITS', reason: 'No commits yet' }
    if (!fs.existsSync(repo)) return { ok: false, code: 'GIT_REPO_MISSING', reason: `The Git repository directory was not found: ${repo}` }

    const key = `${repo}@${head}`
    const cached = numstatCache.get(key)
    let files = cached?.files
    let subj = cached?.subject
    if (!files) {
      const out = await git(repo, ['show', '--numstat', '--format=%h%x09%s', head])
      if (out == null) return { ok: false, code: 'GIT_SHOW_FAILED', reason: 'git show failed' }
      const lines = out.split('\n')
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
    return {
      ok: true,
      repo,
      head,
      subject: subj ?? '',
      dirty: Boolean(dirty),
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
   * @returns {Promise<object>} パッチ
   */
  async function filePatch(taskId, file) {
    const e = entryFor(taskId)
    if (!e?.git?.head) return { ok: false, code: 'NO_COMMITS', reason: 'No commits yet' }
    const { repo, head } = e.git
    const key = `${repo}@${head}`
    if (!numstatCache.has(key)) await diffSummary(taskId)
    const files = numstatCache.get(key)?.files ?? []
    const allowed = files.some((f) => f.path === file)
    if (!allowed) return { ok: false, code: 'FILE_NOT_IN_COMMIT', reason: 'That file is not part of this commit' }

    const patch = await git(repo, ['show', '--format=', '--no-color', head, '--', file], MAX_PATCH_BYTES * 4)
    if (patch == null) return { ok: false, code: 'GIT_SHOW_FAILED', reason: 'git show failed' }
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
