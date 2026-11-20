/**
 * A2B パイプラインの第 3 段 — 1 タップ環境最適化（SPEC §3.2 / D25③）。
 *
 * 「インストールしただけで自走する」ための**非破壊・冪等**な環境最適化だけを行う。
 * - `optimizeHermesSoul`  … `~/.hermes/SOUL.md` へ行動規範ブロックを 1 つだけ埋め込む
 *   （事前バックアップ＋マーカー間の置換。何度押してもブロックは 1 つ）。
 * - `optimizeAgentSkills`（旧名 `optimizeAntigravitySkills`）… 汎用エージェントのスキル置き場へ
 *   `quick-review` / `annotation` / `spec-architect` をリンク（無理ならコピー）する。
 *   **ファイル配置だけ**を行い、外部 AI CLI のサブプロセスは一切起動しない（SPEC V11 D50）。
 * - `getOptimizeStatus` … 適用済みかどうかを**真偽値と件数だけ**で返す（内容は返さない）。
 *
 * 禁止事項（この関数群が絶対にやらないこと）:
 * - 既存の `SOUL.md` の**マーカー外**の文章を書き換える
 * - 人の手で置いたスキル（実ディレクトリ・別ソースを指すリンク）を上書きする
 * - SOUL / スキルの**中身を API 応答に載せる**（秘密情報の露出経路を作らない）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** リポジトリのルート（このファイルは `apps/bridge/src/` の下）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

/** 同梱スキルの置き場（`hermes-pilot init` と同じ 3 つ）。 */
export const BUNDLED_SKILLS = ['quick-review', 'annotation', 'spec-architect']

/** 既定のスキル供給元。 */
export const DEFAULT_SKILLS_SRC = path.join(REPO_ROOT, 'skills')

/** 冪等更新のマーカー（この 2 行の間だけを書き換える）。 */
export const A2B_START = '<!-- hermes-pilot:a2b:start -->'
export const A2B_END = '<!-- hermes-pilot:a2b:end -->'

/**
 * マーカー内に入れる行動規範（短く保つ。SOUL は毎ターン読まれる）。
 *
 * **英語で書く**（意図的）。ここは利用者向けの散文ではなく**機械向けの指示**で、
 * 読み手はモデル。混在言語の指示は出力の言語を引きずる（日本語の規範を置くと
 * 英語運用でも summary / comment が日本語に寄る・実測）。日本語で読みたい利用者には
 * プロファイル側（SOUL のマーカー外・メモリ）で書いてもらう。
 *
 * **言語の指定はここに置かない**。人が読む散文の言語はプロファイル設定と
 * `language-rule.js`（`LANGUAGE_RULE_EN` / `LANGUAGE_RULE_JA`）が決める。
 * 機械トークン（`[review] label=` / `needs_input` / `Mode:` / パス）は ASCII のまま。
 */
export const A2B_RULES = [
  '## Hermes Pilot A2B pipeline',
  '',
  '- For specification work, follow the two-round `spec-architect` skill (question sheet → SPEC).',
  '- When a decision is needed, do not dump long questions into chat. Build a `quick-review` sheet,',
  '  file a task with a `[review] label=... round=...` line, and stop with `needs_input`.',
  '- Take visual sign-off through `annotation` (screenshot + red marks). Do not ask back in prose.',
  // D60 / D61 / D63: 抽象ロール・ネイティブ委譲・外部 CLI 禁止（SOUL を太らせないため 3 行に抑える）
  '- Reason in abstract roles (`role:planner` / `role:builder` / `role:visual-reviewer` / `role:decision-framer`)',
  '  and delegate with `delegate_task` using the per-role model assignment and fallback order in profile memory.',
  '  On delegation failure, rate limit, timeout or an unsupported model, fall back instead of stopping; never',
  '  spawn an external AI CLI subprocess.',
  '- If the task body carries `Mode: zero-stop` / `fast-track-review` / `visual-gate`, follow that contract.',
  '  `zero-stop` self-repairs until `npm run verify` passes, then marks the task `done`.',
  '- Keep completion reports to four points: what changed / verification command and exit code / unverified / next step.',
].join('\n')

/** マーカー付きのルールブロック全体。 */
export const A2B_RULE_BLOCK = `${A2B_START}\n${A2B_RULES}\n${A2B_END}`

/**
 * バックアップ用のタイムスタンプ（`20261115T101500Z`）。
 * @param {number} ms epoch ms
 * @returns {string} スタンプ
 */
export function backupStamp(ms = Date.now()) {
  return new Date(Number(ms) || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * `SOUL.md` の本文にルールブロックを 1 つだけ埋め込んだ結果を返す（純関数）。
 *
 * - マーカーが両方ある → **その間だけ**置換（前後の文章は 1 文字も変えない）
 * - start だけで end が無い（壊れた状態）→ start 以降を捨ててブロックを置き直す
 * - マーカーが無い → 末尾に空行を挟んで追記
 * - 空文字 → ブロックだけの新しい `SOUL.md`
 *
 * @param {string} current 現在の `SOUL.md`（無ければ空文字）
 * @param {string} [block] 埋め込むブロック（既定 `A2B_RULE_BLOCK`）
 * @returns {{text: string, mode: 'created'|'replaced'|'appended'|'unchanged', changed: boolean}} 結果
 */
export function mergeSoul(current, block = A2B_RULE_BLOCK) {
  const src = String(current ?? '')
  const hasStart = src.includes(A2B_START)
  const hasEnd = src.includes(A2B_END)

  if (!src.trim()) return { text: `${block}\n`, mode: 'created', changed: true }

  if (hasStart && hasEnd) {
    const at = src.indexOf(A2B_START)
    const endAt = src.indexOf(A2B_END, at)
    if (endAt > at) {
      const next = `${src.slice(0, at)}${block}${src.slice(endAt + A2B_END.length)}`
      return { text: next, mode: next === src ? 'unchanged' : 'replaced', changed: next !== src }
    }
  }
  if (hasStart && !hasEnd) {
    // 途中で切れたブロック。start 以降はこちらの管理下なので置き直す。
    const at = src.indexOf(A2B_START)
    const next = `${src.slice(0, at)}${block}\n`
    return { text: next, mode: 'replaced', changed: next !== src }
  }
  // 追記（既存の末尾改行数に合わせて 1 つの空行を挟む）
  const head = src.replace(/\s*$/, '')
  const next = `${head}\n\n${block}\n`
  return { text: next, mode: 'appended', changed: true }
}

/**
 * 空いているバックアップ名を決める（`SOUL.md.bak-<stamp>`、衝突時は `-2`, `-3` …）。
 *
 * @param {string} soulPath `SOUL.md` の絶対パス
 * @param {string} stamp スタンプ
 * @param {(p: string) => boolean} exists 存在判定（テスト差し替え用）
 * @returns {string} バックアップの絶対パス
 */
export function nextBackupPath(soulPath, stamp, exists = (p) => fs.existsSync(p)) {
  const base = `${soulPath}.bak-${stamp}`
  if (!exists(base)) return base
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`
    if (!exists(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * `SOUL.md` 1 枚へ A2B 行動規範を冪等に適用する（本体。`optimizeHermesSoul` とプロファイル同期の共通処理）。
 *
 * 2 回目以降はブロックが同一なので**書き込みもバックアップもしない**（1 タップボタンの連打で
 * `SOUL.md.bak-*` が増えない）。内容が変わるときだけバックアップを 1 枚作ってから書く。
 *
 * @param {string} soulPath 対象ファイルの絶対パス
 * @param {{now?: number, block?: string, create?: boolean}} [opts] 入力（`create:false` はファイルが無ければ作らない）
 * @returns {{ok: boolean, path: string, mode: string, changed: boolean, backupPath: string|null, exists: boolean, applied: boolean, error?: string}} 結果
 */
function applySoulFile(soulPath, { now = Date.now(), block = A2B_RULE_BLOCK, create = true } = {}) {
  let current = ''
  let exists = false
  try {
    current = fs.readFileSync(soulPath, 'utf8')
    exists = true
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return {
        ok: false,
        path: soulPath,
        mode: 'error',
        changed: false,
        backupPath: null,
        exists: false,
        applied: false,
        error: String(err?.message ?? err),
      }
    }
    // `create:false` は既存 SOUL.md だけを対象にする（人の環境に勝手に作らない）。
    if (!create) return { ok: true, path: soulPath, mode: 'skipped', changed: false, backupPath: null, exists: false, applied: false }
  }

  const merged = mergeSoul(current, block)
  const applied = merged.text.includes(A2B_START) && merged.text.includes(A2B_END)
  if (!merged.changed) {
    return { ok: true, path: soulPath, mode: 'unchanged', changed: false, backupPath: null, exists, applied }
  }

  let backupPath = null
  try {
    fs.mkdirSync(path.dirname(soulPath), { recursive: true })
    // 既存の SOUL.md があるときだけ、書く前に 1 枚控える（非破壊の担保）。
    if (fs.existsSync(soulPath)) {
      backupPath = nextBackupPath(soulPath, backupStamp(now))
      fs.copyFileSync(soulPath, backupPath)
    }
    const tmp = `${soulPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, merged.text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, soulPath)
  } catch (err) {
    return { ok: false, path: soulPath, mode: 'error', changed: false, backupPath, exists, applied, error: String(err?.message ?? err) }
  }
  return { ok: true, path: soulPath, mode: merged.mode, changed: true, backupPath, exists: true, applied: true }
}

/**
 * `<hermesHome>/SOUL.md` へ A2B 行動規範を冪等に適用する。
 *
 * 引数・戻り値は従来どおり（`{ ok, path, mode, changed, backupPath }`）。プロファイル配下の同期は
 * `optimizeProfileSouls` が担う（D64）。
 *
 * @param {{hermesHome?: string, now?: number, block?: string}} [opts] 入力
 * @returns {{ok: boolean, path: string, mode: string, changed: boolean, backupPath: string|null, error?: string}} 結果
 */
export function optimizeHermesSoul({ hermesHome, now = Date.now(), block = A2B_RULE_BLOCK } = {}) {
  const home = String(hermesHome ?? process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'))
  const soulPath = path.join(home, 'SOUL.md')
  const applied = applySoulFile(soulPath, { now, block, create: true })
  // `exists` / `applied` は内部用の追加情報。従来の戻り値の形は変えない。
  const { exists: _exists, applied: _applied, ...result } = applied
  return result
}

/**
 * プロファイル配下で `SOUL.md` を**新規作成してよい**名前（D64）。
 *
 * ディレクトリが既にある場合だけ、そして `mobile` だけ（実運用で毎ターン読ませたいプロファイル）。
 * それ以外のプロファイルは既存 `SOUL.md` があるときだけ更新する＝人の環境を勝手に増やさない。
 */
export const PROFILE_SOUL_CREATE_IF_MISSING = ['mobile']

/**
 * `<hermesHome>/profiles` 配下のプロファイル名（ディレクトリのみ・隠しディレクトリ除外）。
 *
 * @param {string} hermesHome Hermes のホーム
 * @returns {string[]} 昇順のプロファイル名
 */
export function listProfileNames(hermesHome) {
  let entries = []
  try {
    entries = fs.readdirSync(path.join(String(hermesHome), 'profiles'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/**
 * プロファイル 1 つ分の `SOUL.md` 適用状況（**中身は返さない**）。
 *
 * @param {string} hermesHome Hermes のホーム
 * @param {string} name プロファイル名
 * @returns {{name: string, path: string, exists: boolean, applied: boolean, backups: number}} 状態
 */
function profileSoulState(hermesHome, name) {
  const soulPath = path.join(String(hermesHome), 'profiles', name, 'SOUL.md')
  let exists = false
  let applied = false
  try {
    const text = fs.readFileSync(soulPath, 'utf8')
    exists = true
    applied = text.includes(A2B_START) && text.includes(A2B_END)
  } catch {
    exists = false
  }
  let backups = 0
  try {
    backups = fs.readdirSync(path.dirname(soulPath)).filter((n) => n.startsWith('SOUL.md.bak-')).length
  } catch {
    backups = 0
  }
  return { name, path: soulPath, exists, applied, backups }
}

/**
 * `~/.hermes/profiles/<name>/SOUL.md` へ A2B 行動規範を**非破壊・冪等**に同期する（D64）。
 *
 * - 対象は `profiles` を渡せばその名前だけ、省略時は `<hermesHome>/profiles/*` を自動検出。
 * - `SOUL.md` が既にある → マーカー間だけ置換し、内容が変わるときだけ `.bak-<stamp>` を 1 枚作る。
 * - `SOUL.md` が無い → `PROFILE_SOUL_CREATE_IF_MISSING`（`mobile`）だけ最小構成で新規作成、
 *   それ以外は `mode: 'skipped'`（ディレクトリを勝手に作らない）。
 * - 内容（テキスト）は戻り値に載せない。`changed` / `mode` / `backupPath` / 件数だけ。
 *
 * @param {{hermesHome?: string, now?: number, block?: string, profiles?: string[]}} [opts] 入力
 * @returns {{ok: boolean, profiles: Array<{name: string, path: string, exists: boolean, applied: boolean, changed: boolean, mode: string, backupPath: string|null, backups: number, error?: string}>}} 結果
 */
export function optimizeProfileSouls({ hermesHome, now = Date.now(), block = A2B_RULE_BLOCK, profiles } = {}) {
  const home = String(hermesHome ?? process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'))
  const names = Array.isArray(profiles) && profiles.length
    ? profiles.map((n) => String(n ?? '').trim()).filter(Boolean)
    : listProfileNames(home)

  const out = []
  for (const name of names) {
    // パス連結に使う名前だけを受け付ける（`../` 等の脱出を許さない）。
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') continue
    const dir = path.join(home, 'profiles', name)
    let dirExists = false
    try {
      dirExists = fs.statSync(dir).isDirectory()
    } catch {
      dirExists = false
    }
    if (!dirExists) {
      out.push({
        name,
        path: path.join(dir, 'SOUL.md'),
        exists: false,
        applied: false,
        changed: false,
        mode: 'skipped',
        backupPath: null,
        backups: 0,
      })
      continue
    }

    const r = applySoulFile(path.join(dir, 'SOUL.md'), {
      now,
      block,
      create: PROFILE_SOUL_CREATE_IF_MISSING.includes(name),
    })
    const state = profileSoulState(home, name)
    out.push({
      name,
      path: r.path,
      exists: r.exists,
      applied: Boolean(r.applied),
      changed: Boolean(r.changed),
      mode: r.mode,
      backupPath: r.backupPath ?? null,
      backups: state.backups,
      ...(r.error ? { error: r.error } : {}),
    })
  }
  return { ok: out.every((p) => p.mode !== 'error'), profiles: out }
}

/**
 * Antigravity / 汎用エージェントのスキル置き場の候補。
 * `~/.gemini` や `~/.agents` が**無い**環境では配置しない（勝手にディレクトリを作らない）。
 */
export const SKILL_TARGET_CANDIDATES = [
  {
    id: 'antigravity',
    /** Antigravity のプラグイン・スキル置き場 */
    dir: (home) => path.join(home, '.gemini', 'config', 'plugins', 'hermes-pilot-architect', 'skills'),
    /** このディレクトリの親（`~/.gemini`）が存在するときだけ候補にする */
    guard: (home) => path.join(home, '.gemini'),
  },
  {
    id: 'agents',
    dir: (home) => path.join(home, '.agents', 'skills'),
    guard: (home) => path.join(home, '.agents'),
  },
]

/**
 * 1 スキルを 1 つの置き場へ配置する（リンク優先、失敗時はコピー）。
 *
 * 既存の**実ディレクトリ / 実ファイル**は触らない（人のスキルを壊さない）。
 * 既存の symlink は、この供給元（`skillsSrcDir`）を指しているときだけ貼り替える。
 *
 * @param {{name: string, srcDir: string, destDir: string}} input 入力
 * @returns {{name: string, status: 'linked'|'copied'|'skipped', reason?: string}} 結果
 */
export function installSkill({ name, srcDir, destDir }) {
  const src = path.join(srcDir, name)
  const dest = path.join(destDir, name)
  try {
    if (!fs.existsSync(src)) return { name, status: 'skipped', reason: 'source-missing' }
  } catch {
    return { name, status: 'skipped', reason: 'source-missing' }
  }

  let stat = null
  try {
    stat = fs.lstatSync(dest)
  } catch {
    stat = null
  }

  if (stat) {
    // 既存の配置は原則さわらない。自分のリンク（＝同じ供給元を指す）だけは「配置済み」とみなす。
    if (stat.isSymbolicLink()) {
      let target = ''
      try {
        target = fs.readlinkSync(dest)
      } catch {
        target = ''
      }
      const resolved = target ? path.resolve(path.dirname(dest), target) : ''
      if (resolved === path.resolve(src)) return { name, status: 'skipped', reason: 'exists' }
      return { name, status: 'skipped', reason: 'foreign-link' }
    }
    return { name, status: 'skipped', reason: 'exists' }
  }

  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.symlinkSync(src, dest, 'dir')
    return { name, status: 'linked' }
  } catch {
    try {
      fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true })
      return { name, status: 'copied' }
    } catch (err) {
      return { name, status: 'skipped', reason: String(err?.code ?? 'copy-failed') }
    }
  }
}

/**
 * 汎用エージェントのスキル置き場へ同梱スキルを配置する（冪等）。
 *
 * **プロセスは起動しない**（`fs.linkSync` / `fs.cpSync` だけ）。外部 AI CLI を
 * ラップ起動しないという SPEC V11 D50 の境界はここでも守る。
 *
 * @param {{home?: string, skillsSrcDir?: string, targets?: string[], names?: string[]}} [opts] 入力
 * @returns {{ok: boolean, targets: Array<{id: string, path: string, installed: string[], skipped: Array<object>, error?: string}>}} 結果
 */
export function optimizeAntigravitySkills({
  home = os.homedir(),
  skillsSrcDir = DEFAULT_SKILLS_SRC,
  targets = null,
  names = BUNDLED_SKILLS,
} = {}) {
  const base = String(home || os.homedir())
  let list
  if (Array.isArray(targets) && targets.length) {
    // 明示指定（テスト・上級者向け）。`~` は展開する。
    list = targets.map((t, i) => ({ id: `custom-${i + 1}`, dir: () => String(t).replace(/^~(?=$|\/)/, base) }))
  } else {
    list = SKILL_TARGET_CANDIDATES.filter((c) => {
      try {
        return fs.existsSync(c.guard(base))
      } catch {
        return false
      }
    })
  }

  const out = []
  for (const target of list) {
    const dir = target.dir(base)
    const entry = { id: target.id, path: dir, installed: [], skipped: [] }
    for (const name of names) {
      const r = installSkill({ name, srcDir: skillsSrcDir, destDir: dir })
      if (r.status === 'linked' || r.status === 'copied') entry.installed.push(`${name}:${r.status}`)
      else entry.skipped.push({ name, reason: r.reason })
    }
    out.push(entry)
  }
  return { ok: out.every((t) => !t.error), targets: out }
}

/**
 * `optimizeAntigravitySkills` の現行名（サーバー側はこちらを使う）。
 *
 * 名前から外部ツール連携を想像させないための別名で、実体は同じ関数。
 * 繰り返しになるが**プロセスは起動しない**（リンク／コピーだけ）。
 */
export const optimizeAgentSkills = optimizeAntigravitySkills

/**
 * 適用状況を返す（**中身は返さない**。真偽値・件数・ファイル名だけ）。
 *
 * @param {{hermesHome?: string, home?: string, skillsSrcDir?: string}} [opts] 入力
 * @returns {object} 状態
 */
export function getOptimizeStatus({
  hermesHome = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'),
  home = os.homedir(),
  skillsSrcDir = DEFAULT_SKILLS_SRC,
} = {}) {
  const hh = String(hermesHome)
  const base = String(home || os.homedir())
  const soulPath = path.join(hh, 'SOUL.md')

  let soulExists = false
  let soulApplied = false
  let backups = []
  try {
    const text = fs.readFileSync(soulPath, 'utf8')
    soulExists = true
    soulApplied = text.includes(A2B_START) && text.includes(A2B_END)
  } catch {
    soulExists = false
  }
  try {
    backups = fs
      .readdirSync(hh)
      .filter((n) => n.startsWith('SOUL.md.bak-'))
      .sort()
  } catch {
    backups = []
  }

  const skillState = (dir) => {
    const present = []
    const missing = []
    for (const name of BUNDLED_SKILLS) {
      try {
        fs.lstatSync(path.join(dir, name))
        present.push(name)
      } catch {
        missing.push(name)
      }
    }
    return { path: dir, present, missing }
  }

  const antigravity = SKILL_TARGET_CANDIDATES.map((c) => {
    const dir = c.dir(base)
    let available = false
    try {
      available = fs.existsSync(c.guard(base))
    } catch {
      available = false
    }
    return { id: c.id, available, ...skillState(dir) }
  })

  return {
    ok: true,
    soul: {
      path: soulPath,
      exists: soulExists,
      applied: soulApplied,
      backups: backups.length,
      latestBackup: backups.length ? backups[backups.length - 1] : null,
    },
    // プロファイル配下（`profiles/<name>/SOUL.md`）も「適用済みか」だけを返す（中身は返さない）。
    profiles: listProfileNames(hh).map((name) => profileSoulState(hh, name)),
    hermes: skillState(path.join(hh, 'skills')),
    bundled: { source: skillsSrcDir, names: BUNDLED_SKILLS },
    antigravity,
  }
}
