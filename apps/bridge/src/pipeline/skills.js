/**
 * 同梱スキル（`quick-review` / `annotation` / `spec-architect`）の**ファイル配置**と、
 * 適用状況の読み取り。
 *
 * **プロセスは起動しない**（`fs.symlinkSync` / `fs.cpSync` だけ）。外部 AI CLI を
 * ラップ起動しないという SPEC V11 D50 の境界はここでも守る。
 *
 * 禁止事項:
 * - 人の手で置いたスキル（実ディレクトリ・別ソースを指すリンク）を上書きする
 * - スキルの**中身を API 応答に載せる**（秘密情報の露出経路を作らない）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BUNDLED_SKILLS, DEFAULT_SKILLS_SRC } from './paths.js'
import { inspectSoulFile, profileSoulState } from './soul.js'
import {
  DEFAULT_PILOT_PROFILE,
  listProfileNames,
  pilotProfileSkillsDir,
  sanitizePilotProfile,
} from './profile.js'

/**
 * Hermes 本体のスキル置き場候補（他エージェント領域 `~/.gemini` / `~/.agents` には書き込まない）。
 */
export const SKILL_TARGET_CANDIDATES = [
  {
    id: 'hermes',
    /** Hermes 本体のスキル置き場（`~/.hermes/skills`） */
    dir: (home, hermesHome) => path.join(hermesHome ?? path.join(home, '.hermes'), 'skills'),
    guard: () => true,
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
    // リンク切れ（遷移前の配置先移動など）は張り直す。
    if (stat.isSymbolicLink()) {
      if (!fs.existsSync(dest)) {
        try {
          fs.unlinkSync(dest)
        } catch {
          return { name, status: 'skipped', reason: 'dangling-link' }
        }
      } else {
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
    } else {
      return { name, status: 'skipped', reason: 'exists' }
    }
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
 * @param {{home?: string, skillsSrcDir?: string, targets?: string[], names?: string[], pilotProfile?: string|null}} [opts] 入力
 * @returns {{ok: boolean, targets: Array<{id: string, path: string, installed: string[], skipped: Array<object>, error?: string}>}} 結果
 */
export function optimizeAntigravitySkills({
  home = os.homedir(),
  hermesHome = null,
  skillsSrcDir = DEFAULT_SKILLS_SRC,
  targets = null,
  names = BUNDLED_SKILLS,
  pilotProfile = null,
} = {}) {
  const base = String(home || os.homedir())
  const hh = String(hermesHome || path.join(base, '.hermes'))
  let list
  if (Array.isArray(targets) && targets.length) {
    // 明示指定（テスト・上級者向け）。`~` は展開する。
    list = targets.map((t, i) => ({ id: `custom-${i + 1}`, dir: () => String(t).replace(/^~(?=$|\/)/, base) }))
  } else {
    list = SKILL_TARGET_CANDIDATES.filter((c) => {
      try {
        return c.guard(base, hh)
      } catch {
        return false
      }
    })
    /*
     * Pilot 専用プロファイル（既定 `mobile`）にも置く。PWA の既定プロファイルは `mobile` なので、
     * ここを抜かすと Pilot 側から `annotation` / `quick-review` の契約を一度も読めない。
     * プロファイルのディレクトリが無いときは何もしない（勝手に作らない）。
     */
    const profileDir = pilotProfileSkillsDir({ hermesHome: hh, pilotProfile })
    if (profileDir) {
      list = [...list, { id: `profile:${sanitizePilotProfile(pilotProfile)}`, dir: () => profileDir }]
    }
  }

  const out = []
  for (const target of list) {
    const dir = target.dir(base, hh)
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
 * @param {{hermesHome?: string, home?: string, skillsSrcDir?: string, pilotProfile?: string|null}} [opts] 入力
 * @returns {object} 状態
 */
export function getOptimizeStatus({
  hermesHome = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes'),
  home = os.homedir(),
  skillsSrcDir = DEFAULT_SKILLS_SRC,
  pilotProfile = null,
} = {}) {
  const hh = String(hermesHome)
  const base = String(home || os.homedir())
  const activeProfile = pilotProfile ? sanitizePilotProfile(pilotProfile) : null
  const rootSoul = inspectSoulFile(path.join(hh, 'SOUL.md'))
  const soul =
    activeProfile && activeProfile !== 'default'
      ? { profile: activeProfile, ...inspectSoulFile(path.join(hh, 'profiles', activeProfile, 'SOUL.md')) }
      : { ...(activeProfile ? { profile: activeProfile } : {}), ...rootSoul }

  const skillState = (dir) => {
    const present = []
    const missing = []
    for (const name of BUNDLED_SKILLS) {
      try {
        // symlink を辿って SKILL.md の実在まで確かめる（リンク切れや空ディレクトリを誤認しない）
        if (fs.statSync(path.join(dir, name, 'SKILL.md')).isFile()) present.push(name)
        else missing.push(name)
      } catch {
        missing.push(name)
      }
    }
    return { path: dir, present, missing }
  }

  const antigravity = SKILL_TARGET_CANDIDATES.map((c) => {
    const dir = c.dir(base, hh)
    let available = false
    try {
      available = Boolean(c.guard(base, hh))
    } catch {
      available = false
    }
    return { id: c.id, available, ...skillState(dir) }
  })

  const availableProfiles = [...new Set([DEFAULT_PILOT_PROFILE, ...listProfileNames(hh), 'default'])]

  // Pilot プロファイル側の配置状態（SOUL と同じプロファイルを対象にする。無ければ null）。
  const profileSkillsDir = pilotProfileSkillsDir({ hermesHome: hh, pilotProfile })
  const profileSkills = profileSkillsDir
    ? { profile: sanitizePilotProfile(pilotProfile), ...skillState(profileSkillsDir) }
    : null

  return {
    ok: true,
    pilotProfile: activeProfile ?? DEFAULT_PILOT_PROFILE,
    availableProfiles,
    soul,
    rootSoul,
    // プロファイル配下（`profiles/<name>/SOUL.md`）も「適用済みか」だけを返す（中身は返さない）。
    profiles: listProfileNames(hh).map((name) => profileSoulState(hh, name)),
    hermes: skillState(path.join(hh, 'skills')),
    profileSkills,
    bundled: { source: skillsSrcDir, names: BUNDLED_SKILLS },
    antigravity,
  }
}
