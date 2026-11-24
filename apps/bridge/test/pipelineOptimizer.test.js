/**
 * A2B パイプライン最適化（`apps/bridge/src/pipeline-optimizer.js`）のテスト。
 * SPEC-PILOT-V5 §3.2 / Batch V5-1 受入条件:
 * - ダミーの `~/.hermes/SOUL.md` に**複数回**実行してもバックアップが作られ、
 *   ルールブロックが**1 回分だけ**冪等更新されること。
 * - Antigravity / 汎用エージェントのスキル置き場への配置が冪等で、既存を壊さないこと。
 * - `getOptimizeStatus` が**中身を返さない**（真偽値・件数だけ）こと。
 *
 * すべて一時ディレクトリで完結する（実ホームは触らない）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  A2B_END,
  A2B_RULE_BLOCK,
  A2B_RULES,
  A2B_START,
  BUNDLED_SKILLS,
  DEFAULT_PILOT_PROFILE,
  backupStamp,
  ensurePilotProfile,
  getOptimizeStatus,
  installSkill,
  listProfileNames,
  mergeSoul,
  nextBackupPath,
  optimizeAgentSkills,
  optimizeAntigravitySkills,
  optimizeHermesSoul,
  optimizeProfileSouls,
  pilotProfileSkillsDir,
  sanitizePilotProfile,
} from '../src/pipeline-optimizer.js'
import { readPilotProfile, writePilotProfile } from '../src/config.js'

/** 一時ディレクトリ（後始末は呼び出し側）。 */
function tempHome(prefix = 'hm-opt-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** ルールブロックの出現回数。 */
const countBlocks = (text) => String(text).split(A2B_START).length - 1

test('mergeSoul は空の SOUL をブロックだけの新規ファイルにする（created）', () => {
  const r = mergeSoul('')
  assert.equal(r.mode, 'created')
  assert.equal(r.changed, true)
  assert.equal(countBlocks(r.text), 1)
  assert.ok(r.text.includes(A2B_END))
})

test('mergeSoul は既存本文を 1 文字も変えず末尾へ追記する（appended）', () => {
  const before = '# SOUL\n\n- 既存のルール\n'
  const r = mergeSoul(before)
  assert.equal(r.mode, 'appended')
  assert.ok(r.text.startsWith('# SOUL\n\n- 既存のルール'), '既存本文が変わった')
  assert.ok(r.text.includes(A2B_RULE_BLOCK), 'ブロックが入っていない')
  assert.equal(countBlocks(r.text), 1)
})

test('mergeSoul はマーカー間だけを置換し、前後の文章を保つ（replaced）', () => {
  const before = `上の段落\n\n${A2B_START}\n古いルール\n${A2B_END}\n\n下の段落\n`
  const r = mergeSoul(before)
  assert.equal(r.mode, 'replaced')
  assert.ok(r.text.startsWith('上の段落'), '前の段落が消えた')
  assert.ok(r.text.trimEnd().endsWith('下の段落'), '後の段落が消えた')
  assert.equal(r.text.includes('古いルール'), false, '古いブロックが残っている')
  assert.equal(countBlocks(r.text), 1)
})

test('mergeSoul は同一内容なら changed=false（書き込みもしない）', () => {
  const once = mergeSoul('# SOUL\n')
  const twice = mergeSoul(once.text)
  assert.equal(twice.mode, 'unchanged')
  assert.equal(twice.changed, false)
  assert.equal(countBlocks(twice.text), 1)
})

test('mergeSoul は end マーカーだけ欠けた壊れたブロックを置き直す', () => {
  const broken = `# SOUL\n\n${A2B_START}\n途中で切れた\n`
  const r = mergeSoul(broken)
  assert.equal(r.mode, 'replaced')
  assert.equal(countBlocks(r.text), 1)
  assert.ok(r.text.includes(A2B_END))
  assert.equal(r.text.includes('途中で切れた'), false)
})

test('backupStamp は 8 桁 + T + 6 桁 + Z の形（ファイル名に使える）', () => {
  const stamp = backupStamp(Date.UTC(2026, 10, 15, 10, 15, 0))
  assert.equal(stamp, '20261115T101500Z')
})

test('nextBackupPath は衝突したら -2 / -3 と採番する', () => {
  const taken = new Set(['/h/SOUL.md.bak-20261115T101500Z', '/h/SOUL.md.bak-20261115T101500Z-2'])
  assert.equal(
    nextBackupPath('/h/SOUL.md', '20261115T101500Z', (p) => taken.has(p)),
    '/h/SOUL.md.bak-20261115T101500Z-3',
  )
})

test('optimizeHermesSoul は既存 SOUL をバックアップして 1 回だけ冪等追記する', () => {
  const home = tempHome()
  try {
    const soul = path.join(home, 'SOUL.md')
    fs.writeFileSync(soul, '# SOUL\n\n- 人が書いた行\n', 'utf8')

    const first = optimizeHermesSoul({ hermesHome: home, now: Date.UTC(2026, 10, 15, 10, 15, 0) })
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    assert.equal(first.mode, 'appended')
    assert.ok(first.backupPath, 'バックアップが作られていない')
    assert.equal(fs.readFileSync(first.backupPath, 'utf8'), '# SOUL\n\n- 人が書いた行\n', 'バックアップ内容が元と違う')
    assert.match(path.basename(first.backupPath), /^SOUL\.md\.bak-20261115T101500Z$/)

    const afterFirst = fs.readFileSync(soul, 'utf8')
    assert.equal(countBlocks(afterFirst), 1)
    assert.ok(afterFirst.includes('- 人が書いた行'), '既存の行が消えた')

    // 2 回目・3 回目: ブロックは増えず、書き込みもバックアップもしない
    const second = optimizeHermesSoul({ hermesHome: home, now: Date.UTC(2026, 10, 15, 10, 16, 0) })
    const third = optimizeHermesSoul({ hermesHome: home, now: Date.UTC(2026, 10, 15, 10, 17, 0) })
    assert.equal(second.mode, 'unchanged')
    assert.equal(second.backupPath, null)
    assert.equal(third.mode, 'unchanged')
    assert.equal(fs.readFileSync(soul, 'utf8'), afterFirst, '2 回目以降で内容が変わった')

    const backups = fs.readdirSync(home).filter((n) => n.startsWith('SOUL.md.bak-'))
    assert.equal(backups.length, 1, `バックアップが増えている: ${backups.join(',')}`)
    assert.equal(countBlocks(fs.readFileSync(soul, 'utf8')), 1, 'ブロックが 2 つ以上ある')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('optimizeHermesSoul は SOUL が無ければ最小構成で新規作成する（バックアップ無し）', () => {
  const home = tempHome()
  try {
    const r = optimizeHermesSoul({ hermesHome: home })
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'created')
    assert.equal(r.backupPath, null)
    const text = fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8')
    assert.equal(countBlocks(text), 1)
    assert.match(text, /quick-review/)
    // 既存ルールが手で編集されていても、マーカー内は次回上書き（管理下）
    fs.writeFileSync(path.join(home, 'SOUL.md'), `# SOUL\n\n${A2B_START}\n手で消した\n${A2B_END}\n`, 'utf8')
    const again = optimizeHermesSoul({ hermesHome: home })
    assert.equal(again.mode, 'replaced')
    assert.ok(again.backupPath, '置換時はバックアップを取る')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('installSkill はリンクを作り、2 回目は exists でスキップする（人のディレクトリは触らない）', () => {
  const root = tempHome()
  try {
    const srcDir = path.join(root, 'src')
    const destDir = path.join(root, 'dest')
    fs.mkdirSync(path.join(srcDir, 'quick-review'), { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'quick-review', 'SKILL.md'), '# skill\n', 'utf8')

    const first = installSkill({ name: 'quick-review', srcDir, destDir })
    assert.equal(first.status, 'linked')
    assert.equal(fs.readFileSync(path.join(destDir, 'quick-review', 'SKILL.md'), 'utf8'), '# skill\n')
    const second = installSkill({ name: 'quick-review', srcDir, destDir })
    assert.equal(second.status, 'skipped')
    assert.equal(second.reason, 'exists')

    // 人の実ディレクトリが既にある場合は触らない
    fs.mkdirSync(path.join(destDir, 'annotation'), { recursive: true })
    fs.writeFileSync(path.join(destDir, 'annotation', 'SKILL.md'), 'handmade\n', 'utf8')
    fs.mkdirSync(path.join(srcDir, 'annotation'), { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'annotation', 'SKILL.md'), '# ours\n', 'utf8')
    const third = installSkill({ name: 'annotation', srcDir, destDir })
    assert.equal(third.status, 'skipped')
    assert.equal(third.reason, 'exists')
    assert.equal(fs.readFileSync(path.join(destDir, 'annotation', 'SKILL.md'), 'utf8'), 'handmade\n')

    // 供給元が無いスキルは静かにスキップ
    const missing = installSkill({ name: 'spec-architect', srcDir, destDir })
    assert.equal(missing.status, 'skipped')
    assert.equal(missing.reason, 'source-missing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('optimizeAntigravitySkills は Hermes の skills に配置し、外部エージェント領域へは書かない（冪等）', () => {
  const home = tempHome()
  try {
    const srcDir = path.join(home, 'skills-src')
    for (const name of BUNDLED_SKILLS) {
      fs.mkdirSync(path.join(srcDir, name), { recursive: true })
      fs.writeFileSync(path.join(srcDir, name, 'SKILL.md'), `# ${name}\n`, 'utf8')
    }
    // 仮に ~/.gemini や ~/.agents がホストに存在しても一切書き込まない
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true })

    const first = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir })
    assert.equal(first.ok, true)
    const ids = first.targets.map((t) => t.id)
    assert.deepEqual(ids, ['hermes'], `配置先が想定と違う: ${ids.join(',')}`)
    assert.equal(first.targets[0].installed.length, BUNDLED_SKILLS.length)
    for (const name of BUNDLED_SKILLS) {
      assert.ok(fs.existsSync(path.join(home, '.hermes', 'skills', name, 'SKILL.md')), `${name} が無い`)
    }
    assert.equal(fs.existsSync(path.join(home, '.agents', 'skills')), false, '.agents へ過干渉している')
    assert.equal(fs.existsSync(path.join(home, '.gemini', 'config')), false, '.gemini へ過干渉している')

    const second = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir })
    assert.deepEqual(second.targets[0].installed, [], '2 回目で再配置している')
    assert.equal(second.targets[0].skipped.length, BUNDLED_SKILLS.length)
    assert.ok(second.targets[0].skipped.every((s) => s.reason === 'exists'))

    // 明示指定（上級者向け）
    const custom = path.join(home, 'elsewhere', 'skills')
    const third = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir, targets: [custom], names: ['quick-review'] })
    assert.equal(third.targets[0].path, custom)
    assert.equal(third.targets[0].installed.length, 1)
    assert.ok(fs.existsSync(path.join(custom, 'quick-review', 'SKILL.md')))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('optimizeAntigravitySkills は Pilot プロファイルにも同梱スキルを置く（プロファイルは作らない）', () => {
  const home = tempHome()
  try {
    const srcDir = path.join(home, 'skills-src')
    for (const name of BUNDLED_SKILLS) {
      fs.mkdirSync(path.join(srcDir, name), { recursive: true })
      fs.writeFileSync(path.join(srcDir, name, 'SKILL.md'), `# ${name}\n`, 'utf8')
    }
    const hermesHome = path.join(home, '.hermes')
    const profileDir = path.join(hermesHome, 'profiles', DEFAULT_PILOT_PROFILE)

    // プロファイルが無い → `<hermesHome>/skills` だけ（プロファイルを勝手に作らない）
    const noProfile = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir, pilotProfile: DEFAULT_PILOT_PROFILE })
    assert.deepEqual(noProfile.targets.map((t) => t.id), ['hermes'])
    assert.equal(pilotProfileSkillsDir({ hermesHome, pilotProfile: DEFAULT_PILOT_PROFILE }), null)
    assert.equal(fs.existsSync(profileDir), false, 'プロファイルを勝手に作っている')

    // プロファイルがある → 置き場は 2 つ（default と Pilot プロファイル）
    fs.mkdirSync(profileDir, { recursive: true })
    assert.equal(
      pilotProfileSkillsDir({ hermesHome, pilotProfile: DEFAULT_PILOT_PROFILE }),
      path.join(profileDir, 'skills'),
    )
    const first = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir, pilotProfile: DEFAULT_PILOT_PROFILE })
    assert.deepEqual(first.targets.map((t) => t.id), ['hermes', `profile:${DEFAULT_PILOT_PROFILE}`])
    // `hermes` 側は直前の noProfile 呼び出しで配置済みなので、プロファイル側の 3 件を見る
    const byId = Object.fromEntries(first.targets.map((t) => [t.id, t]))
    assert.equal(byId[`profile:${DEFAULT_PILOT_PROFILE}`].installed.length, BUNDLED_SKILLS.length)
    for (const name of BUNDLED_SKILLS) {
      assert.ok(
        fs.existsSync(path.join(profileDir, 'skills', name, 'SKILL.md')),
        `${name} がプロファイル側に無い`,
      )
    }

    // 冪等（2 回目は何も置かず、既存としてスキップ）
    const second = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir, pilotProfile: DEFAULT_PILOT_PROFILE })
    for (const t of second.targets) {
      assert.deepEqual(t.installed, [], '2 回目で再配置している')
      assert.ok(t.skipped.every((s) => s.reason === 'exists'))
    }

    // `default` は `<hermesHome>/skills` と同じ場所なので二重に置かない
    assert.equal(pilotProfileSkillsDir({ hermesHome, pilotProfile: 'default' }), null)
    const def = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir, pilotProfile: 'default' })
    assert.deepEqual(def.targets.map((t) => t.id), ['hermes'])

    // 人の手で置いた実ディレクトリは上書きしない
    const handmade = path.join(profileDir, 'skills', 'annotation')
    fs.rmSync(handmade, { recursive: true, force: true })
    fs.mkdirSync(handmade, { recursive: true })
    fs.writeFileSync(path.join(handmade, 'SKILL.md'), 'handmade\n', 'utf8')
    optimizeAntigravitySkills({ home, skillsSrcDir: srcDir, pilotProfile: DEFAULT_PILOT_PROFILE })
    assert.equal(fs.readFileSync(path.join(handmade, 'SKILL.md'), 'utf8'), 'handmade\n')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('getOptimizeStatus はプロファイル側のスキル配置も件数だけで返す', () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    const profileSkills = path.join(hermesHome, 'profiles', DEFAULT_PILOT_PROFILE, 'skills')
    fs.mkdirSync(profileSkills, { recursive: true })

    const status = getOptimizeStatus({
      hermesHome,
      home,
      skillsSrcDir: path.join(home, 'none'),
      pilotProfile: DEFAULT_PILOT_PROFILE,
    })
    assert.equal(status.profileSkills.profile, DEFAULT_PILOT_PROFILE)
    assert.equal(status.profileSkills.path, profileSkills)
    assert.deepEqual(status.profileSkills.present, [])
    assert.deepEqual(status.profileSkills.missing, BUNDLED_SKILLS)

    fs.mkdirSync(path.join(profileSkills, 'annotation'), { recursive: true })
    fs.writeFileSync(path.join(profileSkills, 'annotation', 'SKILL.md'), `# secret body ${'x'.repeat(20)}\n`, 'utf8')
    const after = getOptimizeStatus({ hermesHome, home, skillsSrcDir: path.join(home, 'none'), pilotProfile: DEFAULT_PILOT_PROFILE })
    assert.deepEqual(after.profileSkills.present, ['annotation'])
    assert.equal(JSON.stringify(after).includes('secret body'), false, 'スキルの中身を返している')

    // プロファイルが無ければ null（勝手に作らない）
    const noProfile = getOptimizeStatus({ hermesHome: path.join(home, 'other'), home, skillsSrcDir: path.join(home, 'none') })
    assert.equal(noProfile.profileSkills, null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('getOptimizeStatus は真偽値と件数だけを返す（SOUL の中身を載せない）', () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    const empty = getOptimizeStatus({ hermesHome, home, skillsSrcDir: path.join(home, 'none') })
    assert.equal(empty.soul.exists, false)
    assert.equal(empty.soul.applied, false)
    assert.deepEqual(empty.soul.backups, 0)
    assert.equal(empty.soul.latestBackup, null)
    assert.deepEqual(empty.hermes.missing, BUNDLED_SKILLS)
    assert.deepEqual(empty.bundled.names, BUNDLED_SKILLS)

    const secret = 'sk-DO-NOT-LEAK-123'
    fs.mkdirSync(hermesHome, { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'SOUL.md'), `# SOUL\n\n${secret}\n`, 'utf8')
    optimizeHermesSoul({ hermesHome })

    const status = getOptimizeStatus({ hermesHome, home, skillsSrcDir: path.join(home, 'none') })
    assert.equal(status.soul.exists, true)
    assert.equal(status.soul.applied, true)
    assert.equal(status.soul.backups, 1)
    assert.match(status.soul.latestBackup, /^SOUL\.md\.bak-/)
    const json = JSON.stringify(status)
    assert.equal(json.includes(secret), false, 'SOUL の中身が API 応答に載っている')
    assert.equal(json.includes('hermes-pilot:a2b:start'), false, 'マーカー本文が漏れている')
    // Antigravity 候補は「使えるか」だけを返す
    for (const t of status.antigravity) {
      assert.equal(typeof t.available, 'boolean')
      assert.ok(Array.isArray(t.present))
      assert.ok(Array.isArray(t.missing))
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/** `<hermesHome>/profiles/<name>/SOUL.md` を用意する（バックアップ件数の数え上げにも使う）。 */
function writeProfileSoul(hermesHome, name, text) {
  const file = path.join(hermesHome, 'profiles', name, 'SOUL.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (text !== null) fs.writeFileSync(file, text, 'utf8')
  return file
}

/** そのディレクトリの `SOUL.md.bak-*` の数。 */
const countBackups = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('SOUL.md.bak-')).length : 0

test('optimizeProfileSouls はプロファイル配下の SOUL.md をバックアップ付きで冪等更新する', () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    const original = '# MOBILE\n\n- 人が書いた行\n'
    const mobileSoul = writeProfileSoul(hermesHome, 'mobile', original)
    const workSoul = writeProfileSoul(hermesHome, 'work', '# WORK\n')

    assert.deepEqual(listProfileNames(hermesHome), ['mobile', 'work'])

    const now = Date.UTC(2026, 10, 19, 10, 0, 0)
    const first = optimizeProfileSouls({ hermesHome, now })
    assert.equal(first.ok, true)
    const mobile = first.profiles.find((p) => p.name === 'mobile')
    assert.equal(mobile.mode, 'appended')
    assert.equal(mobile.changed, true)
    assert.equal(mobile.exists, true)
    assert.equal(mobile.applied, true)
    assert.equal(mobile.backups, 1)
    assert.match(path.basename(mobile.backupPath), /^SOUL\.md\.bak-20261119T100000Z$/)
    assert.equal(fs.readFileSync(mobile.backupPath, 'utf8'), original, 'バックアップが元の内容と違う')
    const afterFirst = fs.readFileSync(mobileSoul, 'utf8')
    assert.equal(countBlocks(afterFirst), 1)
    assert.ok(afterFirst.includes('- 人が書いた行'), '既存の行が消えた')
    // 過干渉しない: Pilot を使っていない work プロファイルの SOUL は 1 文字も変えない
    assert.equal(
      fs.readFileSync(workSoul, 'utf8'),
      '# WORK\n',
      'Pilot 未使用のプロファイルの SOUL に追記している（過干渉）',
    )
    assert.equal(first.profiles.find((p) => p.name === 'work').mode, 'skipped')

    // 2 回目・3 回目は書き込みもバックアップもしない（1 タップ連打でファイルが増えない）
    const second = optimizeProfileSouls({ hermesHome, now })
    const third = optimizeProfileSouls({ hermesHome, now })
    const m2 = second.profiles.find((p) => p.name === 'mobile')
    assert.equal(m2.mode, 'unchanged')
    assert.equal(m2.changed, false)
    assert.equal(m2.backupPath, null)
    assert.equal(third.profiles.find((p) => p.name === 'mobile').backups, 1)
    assert.equal(fs.readFileSync(mobileSoul, 'utf8'), afterFirst, '2 回目以降で内容が変わった')
    assert.equal(countBackups(path.join(hermesHome, 'profiles', 'mobile')), 1, 'バックアップが増えている')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('optimizeProfileSouls は SOUL.md の無いプロファイルを作らない（mobile だけは作る）', () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    // ディレクトリはあるが SOUL.md が無い 2 プロファイル
    writeProfileSoul(hermesHome, 'mobile', null)
    writeProfileSoul(hermesHome, 'work', null)

    const r = optimizeProfileSouls({ hermesHome })
    const mobile = r.profiles.find((p) => p.name === 'mobile')
    const work = r.profiles.find((p) => p.name === 'work')
    assert.equal(mobile.mode, 'created')
    assert.equal(mobile.exists, true)
    assert.equal(countBlocks(fs.readFileSync(path.join(hermesHome, 'profiles', 'mobile', 'SOUL.md'), 'utf8')), 1)
    assert.equal(work.mode, 'skipped')
    assert.equal(work.exists, false)
    assert.equal(
      fs.existsSync(path.join(hermesHome, 'profiles', 'work', 'SOUL.md')),
      false,
      'SOUL.md の無いプロファイルに勝手に作っている',
    )

    // ディレクトリごと無い名前は、明示指定でもディレクトリを作らない
    const ghost = optimizeProfileSouls({ hermesHome, profiles: ['ghost'] })
    assert.equal(ghost.profiles[0].mode, 'skipped')
    assert.equal(fs.existsSync(path.join(hermesHome, 'profiles', 'ghost')), false)
    // パス脱出する名前は黙って無視する
    assert.deepEqual(optimizeProfileSouls({ hermesHome, profiles: ['../evil'] }).profiles, [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('getOptimizeStatus の profiles も真偽値と件数だけを返す（プロファイル SOUL の中身を載せない）', () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    const empty = getOptimizeStatus({ hermesHome, home, skillsSrcDir: path.join(home, 'none') })
    assert.deepEqual(empty.profiles, [], 'profiles ディレクトリが無いのに配列が空でない')

    const secret = '«redacted:profile-soul-secret»'
    const mobileSoul = writeProfileSoul(hermesHome, 'mobile', `# MOBILE\n\n${secret}\n`)
    optimizeProfileSouls({ hermesHome })

    const status = getOptimizeStatus({ hermesHome, home, skillsSrcDir: path.join(home, 'none') })
    const mobile = status.profiles.find((p) => p.name === 'mobile')
    assert.equal(mobile.exists, true)
    assert.equal(mobile.applied, true)
    assert.equal(mobile.backups, 1)
    assert.equal(typeof mobile.path, 'string')
    const json = JSON.stringify(status)
    assert.equal(json.includes(secret), false, 'プロファイル SOUL の中身が API 応答に載っている')
    assert.equal(json.includes('hermes-pilot:a2b:start'), false, 'マーカー本文が漏れている')
    assert.match(fs.readFileSync(mobileSoul, 'utf8'), /hermes-pilot:a2b:start/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})


test('A2B_RULES は英語（機械向け指示）で、CJK を含まない', () => {
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  assert.doesNotMatch(A2B_RULES, CJK, 'SOUL へ入れる規範に日本語が混ざっている')
  // 言語の指定はブロックに置かない（プロファイル設定と language-rule.js が持つ）
  assert.doesNotMatch(A2B_RULES, /write (user-facing )?prose in|in Japanese|日本語で/, '言語指定を SOUL ブロックに置かない')
  // 機械トークン・非干渉スコープ・ロール未定義時フォールバックを含む
  for (const token of [
    '`spec-architect`',
    '`quick-review`',
    'needs_input',
    '`Mode: zero-stop`',
    'the verification command the target repository declares',
    'ONLY when working on a Hermes Pilot kanban task',
    'reply normally in chat without filing kanban tasks',
    'does not define a role table',
    'Do not file follow-up or spin-off kanban tasks',
  ]) {
    assert.ok(A2B_RULES.includes(token), `必要な規則・機械トークンが欠けている: ${token}`)
  }
})

test('ensurePilotProfile は既定 mobile で専用プロファイルを CLI 経由で隔離作成し、ルート SOUL.md に干渉しない', async () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    fs.mkdirSync(hermesHome, { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'SOUL.md'), '# Default User Soul\n\nKeep daily chat casual.\n', 'utf8')
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model: main-chat\n', 'utf8')
    const workSoul = writeProfileSoul(hermesHome, 'work', '# Work Profile\n')

    const cliCalls = []
    const fakeCreateProfile = async (args, opts) => {
      cliCalls.push({ args, env: opts?.env })
      const name = args[2]
      const profDir = path.join(opts.env.HERMES_HOME, 'profiles', name)
      fs.mkdirSync(profDir, { recursive: true })
      if (args.includes('--clone')) {
        fs.writeFileSync(path.join(profDir, 'config.yaml'), 'model: main-chat\n', 'utf8')
      } else {
        fs.writeFileSync(path.join(profDir, 'config.yaml'), 'model: default\n', 'utf8')
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }

    const res = await ensurePilotProfile({ hermesHome, profile: DEFAULT_PILOT_PROFILE, createProfile: fakeCreateProfile })
    assert.equal(res.ok, true)
    assert.equal(res.profile, 'mobile')
    assert.equal(res.copiedConfig, true)
    assert.equal(cliCalls.length, 1)
    assert.deepEqual(cliCalls[0].args, ['profile', 'create', 'mobile', '--clone', '--no-alias'])
    assert.equal(cliCalls[0].env.HERMES_HOME, hermesHome)
    assert.equal(res.soul.applied, undefined) // optimizeHermesSoul と同じ { ok, path, mode, changed, backupPath }
    assert.equal(res.soul.mode, 'created')
    assert.ok(fs.existsSync(path.join(hermesHome, 'profiles', 'mobile', 'memories')))
    assert.equal(fs.readFileSync(path.join(hermesHome, 'profiles', 'mobile', 'config.yaml'), 'utf8'), 'model: main-chat\n')
    assert.match(fs.readFileSync(path.join(hermesHome, 'profiles', 'mobile', 'SOUL.md'), 'utf8'), /hermes-pilot:a2b:start/)
    // ルートの default SOUL.md と他プロファイル work は 1 文字も変更されない
    assert.equal(
      fs.readFileSync(path.join(hermesHome, 'SOUL.md'), 'utf8'),
      '# Default User Soul\n\nKeep daily chat casual.\n',
    )
    assert.equal(fs.readFileSync(workSoul, 'utf8'), '# Work Profile\n')

    // 既存プロファイルは CLI を再実行しない（冪等）
    const again = await ensurePilotProfile({ hermesHome, profile: DEFAULT_PILOT_PROFILE, createProfile: fakeCreateProfile })
    assert.equal(again.ok, true)
    assert.equal(cliCalls.length, 1)

    // CLI 失敗時は手動コピーにフォールバックせず失敗を返す
    const failed = await ensurePilotProfile({
      hermesHome,
      profile: 'broken-prof',
      createProfile: async () => ({ ok: false, code: 1, stdout: '', stderr: 'create error' }),
    })
    assert.equal(failed.ok, false)
    assert.match(failed.soul.error, /create error/)

    // getOptimizeStatus(..., { pilotProfile: 'mobile' }) は専用プロファイルの状態を返す
    const st = getOptimizeStatus({ hermesHome, home, skillsSrcDir: path.join(home, 'none'), pilotProfile: 'mobile' })
    assert.equal(st.pilotProfile, 'mobile')
    assert.equal(st.soul.applied, true)
    assert.equal(st.soul.profile, 'mobile')
    assert.equal(st.rootSoul.applied, false)
    assert.ok(st.availableProfiles.includes('mobile'))
    assert.ok(st.availableProfiles.includes('default'))
    assert.ok(st.availableProfiles.includes('work'))

    // 明示的に 'default' を選んだときだけルート SOUL.md に追記する
    const def = await ensurePilotProfile({ hermesHome, profile: 'default' })
    assert.equal(def.ok, true)
    assert.equal(def.profile, 'default')
    assert.match(fs.readFileSync(path.join(hermesHome, 'SOUL.md'), 'utf8'), /hermes-pilot:a2b:start/)
    assert.equal(sanitizePilotProfile('../bad'), 'mobile')
    assert.equal(sanitizePilotProfile('custom-a2b'), 'custom-a2b')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('readPilotProfile / writePilotProfile は config.json の他キーを保ったまま専用プロファイルを保存する', () => {
  const dir = tempHome('hm-cfg-prof-')
  try {
    const cfgPath = path.join(dir, 'config.json')
    assert.equal(readPilotProfile(cfgPath), 'mobile', 'ファイル不在の既定は mobile')
    fs.writeFileSync(cfgPath, JSON.stringify({ lang: 'en', servicePort: 4097, scanDirs: ['~/Projects'] }), 'utf8')
    assert.equal(readPilotProfile(cfgPath), 'mobile')

    assert.equal(writePilotProfile(cfgPath, 'a2b-work'), 'a2b-work')
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.equal(saved.pilotProfile, 'a2b-work')
    assert.equal(saved.lang, 'en')
    assert.equal(saved.servicePort, 4097)
    assert.equal(readPilotProfile(cfgPath), 'a2b-work')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test('Pilot 未使用プロファイルの SOUL には追記せず、明示指定と既マーカーだけ同期する', () => {
  const home = tempHome()
  try {
    const hermesHome = path.join(home, '.hermes')
    const workSoul = writeProfileSoul(hermesHome, 'work', '# WORK\n\n- 人の行\n')
    const handoffSoul = writeProfileSoul(hermesHome, 'handoff', '# HANDOFF\n')

    // 1) 既定（自動検出）: work / handoff には書かない
    const r1 = optimizeProfileSouls({ hermesHome })
    assert.equal(r1.profiles.find((p) => p.name === 'work').mode, 'skipped')
    assert.equal(fs.readFileSync(workSoul, 'utf8'), '# WORK\n\n- 人の行\n')

    // 2) 明示指定した名前だけは追記する（利用者が選んだ場合）
    const r2 = optimizeProfileSouls({ hermesHome, profiles: ['handoff'] })
    assert.equal(r2.profiles[0].mode, 'appended')
    assert.match(fs.readFileSync(handoffSoul, 'utf8'), /hermes-pilot:a2b:end/)

    // 3) 既にマーカーがある SOUL は、自動検出でも同期される（再適用・更新）
    fs.writeFileSync(
      workSoul,
      `# WORK\n\n${A2B_START}\n古いブロック\n${A2B_END}\n`,
      'utf8',
    )
    const r3 = optimizeProfileSouls({ hermesHome })
    const work = r3.profiles.find((p) => p.name === 'work')
    assert.equal(work.mode, 'replaced')
    assert.equal(countBlocks(fs.readFileSync(workSoul, 'utf8')), 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('スキル配下の切れた symlink は missing として検知され、optimizeAgentSkills で張り直される', () => {
  const root = tempHome('hm-opt-dangle-')
  try {
    const hermesHome = path.join(root, '.hermes')
    const skillsSrc = path.join(root, 'bundled-skills')
    const profDir = path.join(hermesHome, 'profiles', 'mobile')
    const profSkills = path.join(profDir, 'skills')
    fs.mkdirSync(path.join(hermesHome, 'skills'), { recursive: true })
    fs.mkdirSync(profSkills, { recursive: true })
    for (const name of BUNDLED_SKILLS) {
      fs.mkdirSync(path.join(skillsSrc, name), { recursive: true })
      fs.writeFileSync(path.join(skillsSrc, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }
    // quick-review に存在しない参照先へ向く symlink を置く
    const broken = path.join(profSkills, 'quick-review')
    fs.symlinkSync(path.join(root, 'removed-dir', 'quick-review'), broken, 'dir')

    const before = getOptimizeStatus({ home: root, hermesHome, skillsSrcDir: skillsSrc, pilotProfile: 'mobile' })
    assert.ok(before.profileSkills.missing.includes('quick-review'), 'リンク切れが missing になる')

    const res = optimizeAgentSkills({ home: root, hermesHome, skillsSrcDir: skillsSrc, pilotProfile: 'mobile' })
    assert.equal(res.ok, true)
    assert.equal(fs.realpathSync(broken), fs.realpathSync(path.join(skillsSrc, 'quick-review')))

    const after = getOptimizeStatus({ home: root, hermesHome, skillsSrcDir: skillsSrc, pilotProfile: 'mobile' })
    assert.deepEqual(after.profileSkills.missing, [])
    assert.deepEqual(after.profileSkills.present.sort(), [...BUNDLED_SKILLS].sort())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
