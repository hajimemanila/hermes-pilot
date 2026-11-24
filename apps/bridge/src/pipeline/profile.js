/**
 * A2B 用プロファイル（`~/.hermes/profiles/<name>`）の探索と SOUL 同期。
 *
 * 既定の専用プロファイルは `mobile`（普段使いの `default` を汚さないため分離・D64 拡張）。
 * 実際の書き込みは `soul.js` の `applySoulFile` に委ね、ここは**どのファイルを対象にするか**
 * だけを決める（過干渉防止のルールはこのファイルに集約）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { safeList } from '../lib/safe.js'
import { A2B_RULE_BLOCK, applySoulFile, optimizeHermesSoul, profileSoulState } from './soul.js'

/**
 * A2B パイプライン用の既定専用プロファイル（普段使いの `default` を汚さないため分離・D64 拡張）。
 */
export const DEFAULT_PILOT_PROFILE = 'mobile'

const PROFILE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * プロファイル名を安全な識別子へ正規化する（不正値・パストラバーサルは既定 `mobile` へ）。
 * @param {unknown} value 入力
 * @returns {string} 正規化後のプロファイル名
 */
export function sanitizePilotProfile(value) {
  const s = String(value ?? '').trim()
  if (!s || s === '.' || s === '..' || !PROFILE_NAME_RE.test(s)) return DEFAULT_PILOT_PROFILE
  return s
}

/**
 * プロファイル配下で `SOUL.md` を**新規作成してよい**名前（D64）。
 *
 * ディレクトリが既にある場合だけ、そして `mobile` だけ（実運用で毎ターン読ませたいプロファイル）。
 * それ以外のプロファイルは既存 `SOUL.md` があるときだけ更新する＝人の環境を勝手に増やさない。
 */
export const PROFILE_SOUL_CREATE_IF_MISSING = [DEFAULT_PILOT_PROFILE]

/**
 * Pilot 専用プロファイルのスキル置き場（`profiles/<pilot>/skills`）。
 *
 * **プロファイルのディレクトリが既にあるときだけ**パスを返す（プロファイルを勝手に作らない）。
 * `pilotProfile` が `default` のときは `<hermesHome>/skills` と同じ場所なので `null`（二重配置しない）。
 *
 * 背景（プロファイル別の最適化）: 同梱スキルは `hermes-pilot init` が `<hermesHome>/skills`
 * （= default プロファイル）にも置くが、PWA の既定プロファイルは `mobile`。プロファイル側にも
 * 置かないと、Pilot から `quick-review` / `annotation` / `spec-architect` の契約を一度も読めない。
 *
 * @param {{hermesHome?: string, pilotProfile?: string|null}} [opts] 入力
 * @returns {string|null} 配置先（無ければ null）
 */
export function pilotProfileSkillsDir({ hermesHome, pilotProfile = null } = {}) {
  const hh = String(hermesHome ?? process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'))
  const name = sanitizePilotProfile(pilotProfile)
  if (name === 'default') return null
  const profileDir = path.join(hh, 'profiles', name)
  try {
    if (!fs.statSync(profileDir).isDirectory()) return null
  } catch {
    return null
  }
  const dir = path.join(profileDir, 'skills')
  return path.resolve(dir) === path.resolve(path.join(hh, 'skills')) ? null : dir
}

/**
 * `<hermesHome>/profiles` 配下のプロファイル名（ディレクトリのみ・隠しディレクトリ除外）。
 *
 * @param {string} hermesHome Hermes のホーム
 * @returns {string[]} 昇順のプロファイル名
 */
export function listProfileNames(hermesHome) {
  const dir = path.join(String(hermesHome), 'profiles')
  if (!fs.existsSync(dir)) return []
  const entries = safeList('pipelineOptimizer.listProfileNames', () => fs.readdirSync(dir, { withFileTypes: true }))
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/**
 * 選択された Pilot 専用プロファイル（既定 `mobile`）を非破壊・冪等に準備・適用する。
 *
 * - `profile !== 'default'`（既定 `mobile`）のときは `profiles/<profile>/SOUL.md` のみを対象とし、
 *   ルートの `~/.hermes/SOUL.md` や他の未適用プロファイルへは 1 文字も追記しない（過干渉防止）。
 * - ルートに `config.yaml` がありプロファイル側にまだ無ければ初期設定としてコピーする（`force: false`）。
 * - 既にマーカーを持つ別 `SOUL.md` がある場合は最新ルールで冪等同期する（`create: false, append: false`）。
 *
 * @param {{hermesHome?: string, profile?: string, now?: number, block?: string}} [opts] 入力
 * @returns {{ok: boolean, profile: string, soul: object, rootSoul: object, profiles: Array<object>, copiedConfig: boolean}} 結果
 */
export function ensurePilotProfile({
  hermesHome,
  profile = DEFAULT_PILOT_PROFILE,
  now = Date.now(),
  block = A2B_RULE_BLOCK,
} = {}) {
  const hh = String(hermesHome ?? process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'))
  const target = sanitizePilotProfile(profile)
  let copiedConfig = false
  let soul
  let rootSoul

  if (target === 'default') {
    soul = optimizeHermesSoul({ hermesHome: hh, now, block })
    rootSoul = soul
  } else {
    const profileDir = path.join(hh, 'profiles', target)
    const memoriesDir = path.join(profileDir, 'memories')
    fs.mkdirSync(memoriesDir, { recursive: true })
    const rootConfig = path.join(hh, 'config.yaml')
    const profileConfig = path.join(profileDir, 'config.yaml')
    try {
      if (fs.existsSync(rootConfig) && !fs.existsSync(profileConfig)) {
        fs.cpSync(rootConfig, profileConfig, { force: false, errorOnExist: true })
        copiedConfig = true
      }
    } catch {
      copiedConfig = false
    }
    const { exists: _e, applied: _a, ...applied } = applySoulFile(path.join(profileDir, 'SOUL.md'), {
      now,
      block,
      create: true,
      append: true,
    })
    soul = applied
    // ルートの SOUL.md は「既にマーカーが入っているときだけ」追従させ、未適用なら触らない。
    const { exists: _re, applied: _ra, ...rootRes } = applySoulFile(path.join(hh, 'SOUL.md'), {
      now,
      block,
      create: false,
      append: false,
    })
    rootSoul = rootRes
  }

  const others = []
  for (const name of listProfileNames(hh)) {
    if (name === target) continue
    if (!PROFILE_NAME_RE.test(name) || name === '.' || name === '..') continue
    const r = applySoulFile(path.join(hh, 'profiles', name, 'SOUL.md'), {
      now,
      block,
      create: false,
      append: false,
    })
    const state = profileSoulState(hh, name)
    others.push({
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
  const targetEntry =
    target === 'default'
      ? []
      : [
          {
            name: target,
            ...profileSoulState(hh, target),
            changed: Boolean(soul?.changed),
            mode: soul?.mode,
            backupPath: soul?.backupPath ?? null,
          },
        ]
  const profilesList = [...targetEntry, ...others].sort((a, b) => a.name.localeCompare(b.name))
  const ok = Boolean(soul?.ok) && Boolean(rootSoul?.ok ?? true) && others.every((p) => p.mode !== 'error')
  return { ok, profile: target, soul, rootSoul, profiles: profilesList, copiedConfig }
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
  const explicit = Array.isArray(profiles) && profiles.length > 0
  const names = explicit
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

    /*
     * 追記してよいのは (1) Pilot 用プロファイル（`mobile`）と (2) 明示指定された名前だけ。
     * それ以外は「既にマーカーがある SOUL」だけを同期する（Pilot を一度も使っていない
     * プロファイルへ規範を書き込まない＝過干渉しない）。
     */
    const allowAppend = PROFILE_SOUL_CREATE_IF_MISSING.includes(name) || explicit
    const r = applySoulFile(path.join(dir, 'SOUL.md'), {
      now,
      block,
      create: PROFILE_SOUL_CREATE_IF_MISSING.includes(name),
      append: allowAppend,
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
