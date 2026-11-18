#!/usr/bin/env node
/**
 * 旧環境（`~/Projects/akapen` / `~/.hermes/plugin-data/akapen` / `~/.hermes/mobile-pwa`）から
 * `~/.hermes/plugin-data/hermes-pilot/` への物理移行（D6 / SPEC §4.4）。
 *
 * 方針（D55）:
 *  - **物理コピーのみ**。旧ディレクトリは削除しない（既存データを壊さない）
 *  - **冪等**: `fs.cpSync(..., { force: false })` は既にあるファイルを上書きしない。2 回流しても増えない
 *  - 画像の `mtime` を保つ（`preserveTimestamps: true`。一覧の撮影日時順ソートが壊れない）
 *  - **Hermes の state を直接書き換えない**: `kanban.db` は read-write で開かない（`[akapen]` タグは
 *    `apps/bridge/src/review.js` が後方互換で読むので置換自体が不要）。cron は
 *    `hermes cron list` → `hermes cron remove <id>` の公式 CLI だけを通す。
 *
 * 使い方: `npm run migrate:pilot`（`hermes-pilot migrate` と明示 `init --yes` から呼ぶ）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

/**
 * 監視対象の `kanban.db`（ルート＋各ボード）。
 *
 * **存在確認だけ**で、DB は開かない（D55: `[akapen]` タグの置換は廃止。`review.js` が
 * `[akapen]` / `[review]` の両方を読むため書き換える必要が無い）。レポート用の一覧を返す。
 */
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

/** 旧外部 cron（Pilot の reviewWatcher / pipelineWatcher と二重通知になる）の名前（D44）。 */
export const LEGACY_CRON_NAMES = ['mobile-akapen-watch', 'mobile-review-watch']

/** ジョブ 1 件が旧 cron かを、名前系フィールドの部分一致で判定する。 */
export function isLegacyCronEntry(job, names = LEGACY_CRON_NAMES) {
  if (!job || typeof job !== 'object') return false
  for (const key of ['name', 'id', 'script', 'prompt', 'label', 'title']) {
    const v = job[key]
    if (typeof v === 'string' && names.some((n) => v.includes(n))) return true
  }
  return false
}

/**
 * `hermes cron list` の 1 行目（`  <id> [active]`）を拾うための正規表現。
 * ANSI カラーは `stripAnsi()` で落としてから当てる。
 */
const CRON_JOB_HEAD_RE = /^\s{0,6}([A-Za-z0-9_.:-]+)\s+\[(active|paused|disabled|completed)\]\s*$/
const CRON_NAME_RE = /^\s+Name:\s*(.+?)\s*$/
const ANSI_RE = /\x1b\[[0-9;]*m/g

/** ANSI カラーコードを落とす。 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '')
}

/**
 * `hermes cron list` のテキスト出力を `[{id, name, text}]` にする。
 *
 * 出力形式（`hermes_cli/cron.py` の `cron_list`）:
 * ```text
 *   ┌───┐
 *   │       Scheduled Jobs (profile: default)  │
 *   └───┘
 *
 *   7cad0b034fff [active]
 *     Name:       kanban-reap
 *     Schedule:   *／30 * * * *
 * ```
 * ジョブの無い環境は `No scheduled jobs in profile '…'` だけなので空配列になる。
 *
 * @param {string} text `hermes cron list` の stdout
 * @returns {{id: string, name: string, text: string}[]}
 */
export function parseCronList(text) {
  const jobs = []
  let cur = null
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const head = line.match(CRON_JOB_HEAD_RE)
    if (head) {
      cur = { id: head[1], name: '', text: line.trim() }
      jobs.push(cur)
      continue
    }
    if (!cur) continue
    const name = line.match(CRON_NAME_RE)
    if (name) {
      cur.name = name[1]
      continue
    }
    if (line.trim()) cur.text += `\n${line.trim()}`
  }
  return jobs
}

/**
 * `hermes` CLI を 1 回呼ぶ既定ランナー（テストでは DI で差し替える）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?: object}} [opts]
 * @returns {{status: number|null, stdout: string, stderr: string, error: string|null}}
 */
export function defaultCronRunner(cmd, args, { env = process.env } = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env })
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error ? String(r.error.message ?? r.error) : null,
    }
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: String(err?.message ?? err) }
  }
}

/**
 * 旧外部 cron（`mobile-akapen-watch` / `mobile-review-watch`）を **公式 CLI 経由で** 削除する（D44 / D55）。
 *
 * 方針:
 *  - `~/.hermes/cron/jobs.json` などの **state ファイルは一切読まない・書かない**。`hermes cron list` の
 *    テキスト出力から ID を抽出し、`hermes cron remove <id>` を呼ぶ（スキーマ変更に自動追従する）
 *  - **冪等**: 既に無ければ CLI を 1 回呼ぶだけで終わる
 *  - `dryRun: true` では検出だけ行い、`cron remove` を呼ばない
 *  - 失敗は握りつぶさず `errors` に積む（1 件失敗しても残りは続行）
 *
 * @param {string} hermesHome 互換のため受け取るが、判定には使わない（レポートに残すだけ）
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] 検出だけ行う
 * @param {string[]} [opts.names] 旧 cron 名
 * @param {(cmd: string, args: string[], o?: object) => {status: number|null, stdout: string, stderr: string, error: string|null}} [opts.runner] CLI ランナー（テスト用 DI）
 * @param {string} [opts.hermesBin] `hermes` 実行ファイル（既定は PATH の `hermes`）
 * @param {object} [opts.env] ランナーに渡す環境変数
 * @returns {{hermesHome: string, via: string, detected: number, removed: number, names: string[], ids: string[], scanned: number, errors: object[], dryRun: boolean}}
 */
export function cleanupLegacyCrons(
  hermesHome,
  {
    dryRun = false,
    names = LEGACY_CRON_NAMES,
    runner = null,
    hermesBin = process.env.HERMES_PILOT_HERMES_BIN || 'hermes',
    env = process.env,
  } = {},
) {
  const resolved = path.resolve(String(hermesHome).replace(/^~/, os.homedir()))
  const result = {
    hermesHome: resolved,
    via: `${hermesBin} cron`,
    detected: 0,
    removed: 0,
    names: [],
    ids: [],
    scanned: 0,
    errors: [],
    dryRun: Boolean(dryRun),
  }

  // テストから DI を忘れたまま本物の `hermes cron remove` が走ると実環境の cron が消える。
  // node:test 配下（NODE_TEST_CONTEXT）ではランナー未指定を「実行しない」に倒す。
  const run = runner ?? (process.env.NODE_TEST_CONTEXT ? null : defaultCronRunner)
  if (!run) {
    result.errors.push({
      cmd: `${hermesBin} cron list`,
      error: 'refusing to run the hermes CLI inside node:test without an injected runner',
      stderr: '',
    })
    return result
  }

  const listed = run(hermesBin, ['cron', 'list'], { env })
  if (!listed || listed.error || listed.status !== 0) {
    result.errors.push({
      cmd: `${hermesBin} cron list`,
      error: String(listed?.error ?? `exit ${listed?.status}`),
      stderr: String(listed?.stderr ?? '').trim().slice(0, 400),
    })
    return result
  }

  const jobs = parseCronList(listed.stdout)
  result.scanned = jobs.length
  const legacy = jobs.filter((job) => isLegacyCronEntry({ id: job.id, name: job.name }, names))
  result.detected = legacy.length
  if (!legacy.length) return result

  const label = (job) => job.name || job.id
  if (dryRun) {
    result.names = legacy.map(label)
    result.ids = legacy.map((job) => job.id)
    return result
  }

  for (const job of legacy) {
    const r = runner(hermesBin, ['cron', 'remove', job.id], { env })
    if (r && !r.error && r.status === 0) {
      result.removed += 1
      result.names.push(label(job))
      result.ids.push(job.id)
      continue
    }
    result.errors.push({
      cmd: `${hermesBin} cron remove ${job.id}`,
      error: String(r?.error ?? `exit ${r?.status}`),
      stderr: String(r?.stderr ?? '').trim().slice(0, 400),
    })
  }
  return result
}

/**
 * 移行本体。
 *
 * @param {{home?: string, hermesHome?: string, pluginDataDir?: string, srcRoot?: string, dryRun?: boolean,
 *   runner?: Function, hermesBin?: string, env?: object}} [opts]
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
    crons: {
      hermesHome: hermesHome,
      via: 'hermes cron',
      detected: 0,
      removed: 0,
      names: [],
      ids: [],
      scanned: 0,
      errors: [],
      dryRun: Boolean(opts.dryRun),
    },
    skipped: [],
  }

  const cronOpts = {
    dryRun: Boolean(opts.dryRun),
    runner: opts.runner,
    hermesBin: opts.hermesBin,
    // `hermes cron` は HERMES_HOME のプロファイルのストアを見る。移行対象の Hermes home を明示して
    // 「別プロファイルの cron を消す / 消すべきものが見えない」を取り違えないようにする。
    env: opts.env ?? { ...process.env, HERMES_HOME: hermesHome },
  }

  if (opts.dryRun) {
    // dryRun でも「何が消えるか」だけは返す（ファイルも cron ストアも触らない）
    report.kanban = findKanbanDbs(hermesHome).map((db) => ({ db, updated: 0, written: false }))
    report.crons = cleanupLegacyCrons(hermesHome, cronOpts)
    return report
  }

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

  // 4) kanban.db は **存在確認だけ**（D55: 直接 read-write しない。[akapen] は review.js が後方互換で読む）
  report.kanban = findKanbanDbs(hermesHome).map((db) => ({ db, updated: 0, written: false }))

  // 5) ボードの default_workdir を新パスへ
  report.boards = rewriteBoardWorkdir(hermesHome, {
    oldWorkdir: srcRoot,
    newWorkdir: reviewDir,
  })

  // 6) 旧外部 cron（mobile-akapen-watch / mobile-review-watch）を公式 CLI で除去（D44 / D55）
  report.crons = cleanupLegacyCrons(hermesHome, cronOpts)

  return report
}

/** レポートを 1 画面に整形する（stdout 用）。 */
export function formatReport(r, { tagOld = TAG_OLD, tagNew = TAG_NEW, dryRun = false } = {}) {
  const lines = []
  lines.push('=== hermes-pilot migration ===')
  lines.push(`from: ${r.srcRoot}`)
  lines.push(`to:   ${r.pluginDataDir}`)
  lines.push(`home: ${r.hermesHome}${dryRun ? '（dry run: 何も書き換えていません）' : ''}`)
  lines.push('')
  lines.push(`sheets : 新規 ${r.copied.sheets} / 既存 ${r.existing.sheets}`)
  lines.push(`shots  : 新規 ${r.copied.shots} / 既存 ${r.existing.shots}`)
  lines.push(`library: 新規 ${r.copied.library} / 既存 ${r.existing.library}`)
  lines.push(`review/*.jsonl + task-chats: 新規 ${r.copied.reviewFiles}`)
  lines.push(`token/snippets/audit: 新規 ${r.copied.session}`)
  lines.push('')
  lines.push(
    `kanban.db: ${r.kanban.length} 個を確認 / ${tagOld} → ${tagNew} の書換は廃止（review.js が両タグを読みます・DB は開きません）`,
  )
  for (const k of r.kanban) lines.push(`  * ${k.db}`)
  if (r.boards.length) {
    lines.push(`board の default_workdir 更新: ${r.boards.length} 件`)
    for (const b of r.boards) lines.push(`  * ${b}`)
  }
  const crons = r.crons ?? { detected: 0, removed: 0, names: [], scanned: 0, errors: [], dryRun: false }
  const cronErrs = crons.errors ?? []
  lines.push('')
  if (crons.removed) {
    lines.push(`旧 cron のクリーンアップ: ${crons.removed} 件を削除（${crons.via ?? 'hermes cron remove'}: ${crons.names.join(', ')}）`)
  } else if (crons.detected) {
    lines.push(`旧 cron のクリーンアップ: ${crons.detected} 件を検出（dry run のため未削除: ${crons.names.join(', ')}）`)
  } else if (!cronErrs.length) {
    lines.push('旧 cron のクリーンアップ: 0 件（mobile-akapen-watch / mobile-review-watch は既に無い）')
  }
  for (const e of cronErrs.slice(0, 3)) lines.push(`  ! ${e.cmd}: ${e.error}${e.stderr ? ` (${e.stderr.split('\n')[0]})` : ''}`)
  if (cronErrs.length > 3) lines.push(`  ! …他 ${cronErrs.length - 3} 件`)
  lines.push('')
  lines.push('旧ディレクトリは削除していません（物理コピーのみ）。')
  return lines.join('\n')
}

// CLI（`npm run migrate:pilot` / `node scripts/migrate-to-hermes-pilot.mjs [--dry-run]`）
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  // `HERMES_HOME` が環境にあると `HOME` を変えても実ストアを見る。何も壊さず下見したい時は --dry-run。
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n')
  try {
    const report = migrate({ dryRun })
    console.log(formatReport(report, { dryRun }))
  } catch (err) {
    console.error(`[migrate] 失敗: ${err?.stack ?? err}`)
    process.exit(1)
  }
}
