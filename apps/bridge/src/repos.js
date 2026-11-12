import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'

/**
 * リポジトリ（作業ディレクトリ）とカンバンボードの対応。
 *
 * 決定: 赤ペン `sheets/repo-picker-01-1.html` の 4 問すべて A。
 *  - リポジトリの一覧は **Git Ops の `repos.json` が唯一の一覧**（`akapen.targets()` を再利用）
 *  - 対応は **board の `default_workdir` が repo の path と一致**するものだけ（推測で寄せない）
 *  - 板が無い repo は UI が確認してから **この endpoint で作る**（黙って増やさない）
 *
 * macOS は大文字小文字を区別しないので比較は小文字で行う（実測: `~/projects/...` と
 * `~/Projects/...`、ボードの workdir と repos.json の path で表記が混在している）。
 */

/** パス比較用の正規化（~ 展開・絶対化・小文字化・末尾スラッシュ落とし）。 */
export function normalizePath(p) {
  const raw = String(p ?? '').trim()
  if (!raw) return ''
  const abs = path.resolve(raw.replace(/^~(?=$|[/\\])/, os.homedir()))
  const lower = abs.toLowerCase()
  return lower.length > 1 ? lower.replace(/[/\\]+$/, '') : lower
}

/**
 * repo の path と workdir が一致するボード（アーカイブ済みは除く）。
 * @param {string} repoPath リポジトリの絶対パス
 * @param {Array<object>} boards `kanban.boards()` の結果
 * @returns {Array<{slug: string, name: string, current: boolean}>} ボード（複数ありうる）
 */
export function boardsForRepo(repoPath, boards = []) {
  const want = normalizePath(repoPath)
  if (!want) return []
  return boards
    .filter((b) => b && !b.archived && normalizePath(b.workdir) === want)
    .map((b) => ({ slug: String(b.slug), name: String(b.name ?? b.slug), current: Boolean(b.current) }))
}

/**
 * repos × boards を合成する（並びは既存の targets() の順＝ hermes-mobile-pwa が先頭）。
 * @param {Array<{id: string, label: string, path: string}>} repos
 * @param {Array<object>} boards
 * @returns {Array<{id: string, label: string, path: string, boards: Array<object>}>} 合成結果
 */
export function joinRepos(repos = [], boards = []) {
  const out = []
  const seen = new Set()
  for (const r of repos) {
    const id = String(r?.id ?? '').trim()
    const abs = String(r?.path ?? '').trim()
    if (!id || !abs || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: String(r.label ?? id),
      path: abs,
      boards: boardsForRepo(abs, boards),
    })
  }
  return out
}

/**
 * ボード名（slug）として安全か。CLI と同じ規則に寄せる。
 * @param {unknown} slug 候補
 * @returns {boolean} 安全なら true
 */
export function isSafeBoardSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)
}

/**
 * リポジトリ一覧の読み取りと、板が無いリポジトリのボード作成。
 *
 * @param {object} cfg 設定（`hermesBin` を使う）
 * @param {{targets?: Function, boards?: Function, runner?: Function}} [deps] 差し替え（テスト用）
 * @returns {object} 操作
 */
export function createRepos(cfg = {}, deps = {}) {
  const listBoards = deps.boards ?? (() => [])
  const listRepos = deps.targets ?? (() => [])
  const run =
    deps.runner ??
    ((args) =>
      new Promise((resolve) => {
        execFile(
          cfg.hermesBin ?? 'hermes',
          args,
          { timeout: 30_000, maxBuffer: 1_000_000, env: { ...process.env } },
          (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          },
        )
      }))

  /** 合成済みの一覧。 */
  function list() {
    return joinRepos(listRepos(), listBoards())
  }

  /**
   * 板が無いリポジトリにボードを 1 つ作る（既に同じ workdir の板があればそれを返す）。
   * @param {string} repoId リポジトリ id（＝ボードの slug に使う）
   * @returns {Promise<{ok: boolean, board?: object, error?: string, created?: boolean}>} 結果
   */
  async function createBoard(repoId) {
    const repo = list().find((r) => r.id === String(repoId ?? ''))
    if (!repo) return { ok: false, error: '未登録のリポジトリです' }
    if (repo.boards.length) {
      const hit = repo.boards.find((b) => b.current) ?? repo.boards[0]
      return { ok: true, created: false, board: hit }
    }
    if (!isSafeBoardSlug(repo.id)) return { ok: false, error: 'ボード名に使えない id です' }
    const args = ['kanban', 'boards', 'create', repo.id, '--name', repo.label, '--default-workdir', repo.path]
    const res = await run(args)
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || 'ボードを作成できませんでした').trim().slice(0, 400)
      return { ok: false, error: msg }
    }
    return { ok: true, created: true, board: { slug: repo.id, name: repo.label, current: false } }
  }

  return { list, createBoard }
}
