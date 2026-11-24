/**
 * A2B 行動規範（SOUL）の冪等適用。
 *
 * `~/.hermes/SOUL.md` と `~/.hermes/profiles/<name>/SOUL.md` を**非破壊・冪等**に更新する
 * 純関数＋薄い I/O だけを置く。プロファイルの探索は `profile.js`、スキル配置は `skills.js`。
 *
 * — 禁止事項（この関数群が絶対にやらないこと）—
 * - 既存の `SOUL.md` の**マーカー外**の文章を書き換える
 * - バックアップ無しで上書きする
 * - SOUL の**中身を API 応答に載せる**（秘密情報の露出経路を作らない）
 *
 * 公開しているもののうち `applySoulFile` / `inspectSoulFile` / `profileSoulState` は
 * **`pipeline/` 内部の共有専用**（モジュール境界を越えるため export している）。
 * バレル（`pipeline-optimizer.js`）からは出さない＝公開契約には数えない。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { VERIFY_COMMAND_NOUN } from '../contracts/verify.js'
import { writeFileAtomic } from '../lib/atomic.js'

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
  'Apply the rules below ONLY when working on a Hermes Pilot kanban task or A2B spec run',
  '(or when explicitly asked to use `spec-architect` / `quick-review` / `annotation`).',
  'In normal chat conversations outside kanban tasks, reply normally in chat without filing kanban tasks.',
  '',
  '- For specification work, follow the two-round `spec-architect` skill (question sheet → SPEC).',
  '- When a decision is needed, do not dump long questions into chat. Build a `quick-review` sheet,',
  '  file a task with a `[review] label=... round=...` line, and stop with `needs_input`.',
  '- Take visual sign-off through `annotation` (screenshot + red marks). Do not ask back in prose.',
  // D60 / D61 / D63: 抽象ロール・ネイティブ委譲・外部 CLI 禁止（未定義時は現在モデルで続行）
  '- Reason in abstract roles (`role:planner` / `role:builder` / `role:visual-reviewer` / `role:decision-framer`)',
  '  and delegate with `delegate_task` using the per-role model assignment and fallback order in profile memory.',
  '  If profile memory does not define a role table, or on delegation failure, rate limit, timeout or an',
  '  unsupported model, fall back and continue with your current model instead of stopping; never spawn an',
  '  external AI CLI subprocess.',
  '- If the task body carries `Mode: zero-stop` / `fast-track-review` / `visual-gate`, follow that contract.',
  `  \`zero-stop\` self-repairs until ${VERIFY_COMMAND_NOUN} passes, then marks the task \`done\`.`,
  '  The command and the screen sizes come from the target repository, never from a plugin-wide default.',
  '- Do not file follow-up or spin-off kanban tasks (`hermes kanban create`) from inside a running kanban task to defer failing verification gates; fix the issue within the current task or block with `needs_input` (D55).',
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
 * **`pipeline/` 内部の共有専用**（`profile.js` から呼ぶ。バレルは再エクスポートしない）。
 *
 * @param {string} soulPath 対象ファイルの絶対パス
 * @param {{now?: number, block?: string, create?: boolean}} [opts] 入力（`create:false` はファイルが無ければ作らない）
 * @returns {{ok: boolean, path: string, mode: string, changed: boolean, backupPath: string|null, exists: boolean, applied: boolean, error?: string}} 結果
 */
export function applySoulFile(soulPath, { now = Date.now(), block = A2B_RULE_BLOCK, create = true, append = true } = {}) {
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

  /*
   * **他人の SOUL に勝手に追記しない**（過干渉の防止）。
   *
   * `append: false` は「マーカーが既にある SOUL だけを同期する」モード。
   * マーカーが無い（＝まだ Pilot を使っていない）プロファイルには 1 文字も書き込まない。
   * 対象を明示指定されたときだけ `append: true` で追記する。
   */
  const hasMarker = current.includes(A2B_START) && current.includes(A2B_END)
  if (!append && current.trim() && !hasMarker) {
    return { ok: true, path: soulPath, mode: 'skipped', changed: false, backupPath: null, exists, applied: false }
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
    writeFileAtomic(soulPath, merged.text, { mode: 0o600 })
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
 * 1 つの `SOUL.md` の適用状態とバックアップ数を読む（中身は返さない）。
 *
 * **`pipeline/` 内部の共有専用**（`skills.js` から呼ぶ。バレルは再エクスポートしない）。
 *
 * @param {string} soulPath パス
 * @returns {{path: string, exists: boolean, applied: boolean, backups: number, latestBackup: string|null}} 状態
 */
export function inspectSoulFile(soulPath) {
  let exists = false
  let applied = false
  try {
    const text = fs.readFileSync(soulPath, 'utf8')
    exists = true
    applied = text.includes(A2B_START) && text.includes(A2B_END)
  } catch {
    exists = false
  }
  let backups = []
  try {
    backups = fs
      .readdirSync(path.dirname(soulPath))
      .filter((n) => n.startsWith('SOUL.md.bak-'))
      .sort()
  } catch {
    backups = []
  }
  return {
    path: soulPath,
    exists,
    applied,
    backups: backups.length,
    latestBackup: backups.length ? backups[backups.length - 1] : null,
  }
}

/**
 * プロファイル 1 つ分の `SOUL.md` 適用状況（**中身は返さない**）。
 *
 * **`pipeline/` 内部の共有専用**（`profile.js` / `skills.js` から呼ぶ。バレルは再エクスポートしない）。
 *
 * @param {string} hermesHome Hermes のホーム
 * @param {string} name プロファイル名
 * @returns {{name: string, path: string, exists: boolean, applied: boolean, backups: number}} 状態
 */
export function profileSoulState(hermesHome, name) {
  const s = inspectSoulFile(path.join(String(hermesHome), 'profiles', name, 'SOUL.md'))
  return { name, path: s.path, exists: s.exists, applied: s.applied, backups: s.backups }
}
