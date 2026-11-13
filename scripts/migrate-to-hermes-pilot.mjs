#!/usr/bin/env node
/**
 * 旧環境（`~/Projects/akapen` / `~/.hermes/plugin-data/akapen` / `~/.hermes/mobile-pwa`）から
 * `~/.hermes/plugin-data/hermes-pilot/` への物理移行（D6 / SPEC §4.4）。
 *
 * 方針:
 *  - **物理コピーのみ**。旧ディレクトリは削除しない（既存データを壊さない）
 *  - **冪等**: `fs.cpSync(..., { force: false })` は既にあるファイルを上書きしない。2 回流しても増えない
 *  - 画像の `mtime` を保つ（`preserveTimestamps: true`。一覧の撮影日時順ソートが壊れない）
 *  - `kanban.db` を書き換える前に **必ず** `kanban.db.bak-<timestamp>` を取る
 *
 * 使い方: `npm run migrate:pilot`（`hermes-pilot init` からも呼ぶ）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const TAG_OLD = '[akapen]'
const TAG_NEW = '[review]'

/** ディレクトリを冪等にコピーし、コピーしたファイル数を返す。 */
function copyDirIfExists(src, dest) {
  if (!fs.existsSync(src)) return { copied: 0, skipped: true }
  fs.mkdirSync(dest, { recursive: true })
  let copied = 0
  let total = 0
  const walk = (from, to) => {
    let ents = []
    try {
      ents = fs.readdirSync(from, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const s = path.join(from, e.name)
      const d = path.join(to, e.name)
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true })
        walk(s, d)
        continue
      }
      total += 1
      if (fs.existsSync(d)) continue // 冪等: 既にあるものは触らない
      fs.cpSync(s, d, { recursive: true, force: false, preserveTimestamps: true })
      copied += 1
    }
  }
  walk(src, dest)
  return { copied, total, skipped: false }
}

/** 単一ファイルを冪等にコピーする。 */
function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return { copied: 0, skipped: true }
  if (fs.existsSync(dest)) return { copied: 0, skipped: true }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: false, force: false, preserveTimestamps: true })
  return { copied: 1, skipped: false }
}

/** `~` を home に展開し、絶対パスへ。 */
function expand(p, home) {
  return path.resolve(String(p).replace(/^~/, home))
}

/**
 * `HERMES_HOME` がプロファイルディレクトリ（`~/.hermes/profiles/<name>`）を指していることがある
 * （worker / cron から実行した場合）。その時は 2 つ上（`~/.hermes`）を Hermes ホームとして扱う。
 * そうしないと kanban.db を見つけられず、データも `profiles/<name>/plugin-data` に散らばる。
 */
export function resolveHermesHome(raw, home = os.homedir()) {
  const abs = path.resolve(String(raw).replace(/^~/, home))
  if (path.basename(path.dirname(abs)) === 'profiles') return path.dirname(path.dirname(abs))
  return abs
}

/** 監視対象の kanban.db（ルート＋各ボード）。 */
export function findKanbanDbs(hermesHome) {
  const out = []
  const root = path.join(hermesHome, 'kanban.db')
  if (fs.existsSync(root)) out.push(root)
  const boardsDir = path.join(hermesHome, 'kanban', 'boards')
  let ents = []
  try {
    ents = fs.readdirSync(boardsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const p = path.join(boardsDir, e.name, 'kanban.db')
    if (fs.existsSync(p)) out.push(p)
  }
  return out
}

/**
 * kanban.db のタグ置換。バックアップ → 置換の順で、置換対象が無ければ何もしない。
 * @returns {{db: string, backup: string|null, updated: number}}
 */
export function rewriteKanbanTag(dbPath, { tagOld = TAG_OLD, tagNew = TAG_NEW, now = Date.now } = {}) {
  const db = new DatabaseSync(dbPath)
  let updated = 0
  let backup = null
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE COALESCE(body, ?) LIKE ?').get('', `%${tagOld}%`)
    const matches = Number(row?.n ?? 0)
    if (matches > 0) {
      // 書換前に必ずバックアップ（失敗したら置換しない）
      backup = `${dbPath}.bak-${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`
      fs.copyFileSync(dbPath, backup)
      const stmt = db.prepare('UPDATE tasks SET body = replace(body, ?, ?) WHERE body LIKE ?')
      const res = stmt.run(tagOld, tagNew, `%${tagOld}%`)
      updated = Number(res?.changes ?? 0)
    }
  } finally {
    try {
      db.close()
    } catch {
      /* noop */
    }
  }
  return { db: dbPath, backup, updated }
}

/** `boards/mobile/board.json` の `default_workdir` を新パスへ（旧パスを指している時だけ）。 */
export function rewriteBoardWorkdir(hermesHome, { oldWorkdir, newWorkdir }) {
  const out = []
  const boardsDir = path.join(hermesHome, 'kanban', 'boards')
  let ents = []
  try {
    ents = fs.readdirSync(boardsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const file = path.join(boardsDir, e.name, 'board.json')
    let meta
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!meta || typeof meta.default_workdir !== 'string') continue
    const cur = path.resolve(meta.default_workdir.replace(/^~/, os.homedir()))
    if (cur !== path.resolve(oldWorkdir)) continue
    meta.default_workdir = newWorkdir
    fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    out.push(file)
  }
  return out
}

/**
 * 移行本体。
 *
 * @param {{home?: string, hermesHome?: string, pluginDataDir?: string, srcRoot?: string, dryRun?: boolean}} [opts]
 * @returns {object} レポート
 */
export function migrate(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? os.homedir()
  const hermesHome = resolveHermesHome(opts.hermesHome ?? process.env.HERMES_HOME ?? path.join(home, '.hermes'), home)
  const pluginDataDir =
    opts.pluginDataDir ?? process.env.HP_DATA_DIR ?? path.join(hermesHome, 'plugin-data', 'hermes-pilot')
  const reviewDir = path.join(pluginDataDir, 'review')
  const srcRoot = opts.srcRoot ?? path.join(home, 'Projects', 'akapen')
  const oldPluginData = path.join(hermesHome, 'plugin-data', 'akapen')
  const oldMobilePwa = path.join(hermesHome, 'mobile-pwa')

  const report = {
    home,
    hermesHome,
    pluginDataDir,
    reviewDir,
    srcRoot,
    copied: { sheets: 0, shots: 0, library: 0, reviewFiles: 0, session: 0 },
    existing: { sheets: 0, shots: 0, library: 0 },
    kanban: [],
    boards: [],
    skipped: [],
  }

  if (opts.dryRun) return report

  // 1) シート・画像の物理コピー（mtime 保持）
  for (const [key, sub] of [
    ['sheets', 'sheets'],
    ['shots', 'shots'],
    ['library', 'library'],
  ]) {
    const src = path.join(srcRoot, sub)
    const r = copyDirIfExists(src, path.join(reviewDir, sub))
    if (r.skipped) {
      report.skipped.push(`${sub}: 旧ディレクトリが無い`)
      continue
    }
    report.copied[key] = r.copied
    report.existing[key] = r.total
  }

  // 2) 旧 plugin-data/akapen の JSONL と紐づけマップを review/ へ
  fs.mkdirSync(reviewDir, { recursive: true })
  for (const name of ['feed.jsonl', 'chat-reports.jsonl', 'task-chats.json']) {
    const r = copyFileIfExists(path.join(oldPluginData, name), path.join(reviewDir, name))
    if (r.skipped) report.skipped.push(`${name}: 既にあるか旧ファイルが無い`)
    report.copied.reviewFiles += r.copied
  }

  // 3) mobile-pwa の token / snippets / audit を plugin-data/hermes-pilot へ
  fs.mkdirSync(pluginDataDir, { recursive: true })
  for (const name of ['token', 'snippets.json', 'audit.jsonl']) {
    const r = copyFileIfExists(path.join(oldMobilePwa, name), path.join(pluginDataDir, name))
    if (r.skipped) report.skipped.push(`${name}: 既にあるか旧ファイルが無い`)
    report.copied.session += r.copied
  }

  // 4) kanban.db のタグ置換（バックアップ → 置換）
  for (const dbPath of findKanbanDbs(hermesHome)) {
    try {
      report.kanban.push(rewriteKanbanTag(dbPath, { now: opts.now }))
    } catch (err) {
      report.kanban.push({ db: dbPath, backup: null, updated: 0, error: String(err?.message ?? err) })
    }
  }

  // 5) ボードの default_workdir を新パスへ
  report.boards = rewriteBoardWorkdir(hermesHome, {
    oldWorkdir: srcRoot,
    newWorkdir: reviewDir,
  })

  return report
}

/** レポートを 1 画面に整形する（stdout 用）。 */
export function formatReport(r, { tagOld = TAG_OLD, tagNew = TAG_NEW } = {}) {
  const lines = []
  lines.push('=== hermes-pilot migration ===')
  lines.push(`from: ${r.srcRoot}`)
  lines.push(`to:   ${r.pluginDataDir}`)
  lines.push('')
  lines.push(`sheets : 新規 ${r.copied.sheets} / 既存 ${r.existing.sheets}`)
  lines.push(`shots  : 新規 ${r.copied.shots} / 既存 ${r.existing.shots}`)
  lines.push(`library: 新規 ${r.copied.library} / 既存 ${r.existing.library}`)
  lines.push(`review/*.jsonl + task-chats: 新規 ${r.copied.reviewFiles}`)
  lines.push(`token/snippets/audit: 新規 ${r.copied.session}`)
  const totalUpdated = r.kanban.reduce((n, k) => n + Number(k.updated ?? 0), 0)
  lines.push('')
  lines.push(`kanban.db: ${r.kanban.length} 個を確認 / ${tagOld} → ${tagNew} を ${totalUpdated} 件更新`)
  for (const k of r.kanban) {
    if (k.error) lines.push(`  ! ${k.db}: ${k.error}`)
    else if (k.updated) lines.push(`  * ${k.db}: ${k.updated} 件（bak: ${path.basename(k.backup)}）`)
  }
  if (r.boards.length) {
    lines.push(`board の default_workdir 更新: ${r.boards.length} 件`)
    for (const b of r.boards) lines.push(`  * ${b}`)
  }
  lines.push('')
  lines.push('旧ディレクトリは削除していません（物理コピーのみ）。')
  return lines.join('\n')
}

// CLI（`npm run migrate:pilot` / `node scripts/migrate-to-hermes-pilot.mjs`）
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    const report = migrate()
    console.log(formatReport(report))
  } catch (err) {
    console.error(`[migrate] 失敗: ${err?.stack ?? err}`)
    process.exit(1)
  }
}
