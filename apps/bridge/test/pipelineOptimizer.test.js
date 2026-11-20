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
  backupStamp,
  getOptimizeStatus,
  installSkill,
  listProfileNames,
  mergeSoul,
  nextBackupPath,
  optimizeAntigravitySkills,
  optimizeHermesSoul,
  optimizeProfileSouls,
} from '../src/pipeline-optimizer.js'

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

test('optimizeAntigravitySkills は存在する置き場にだけ配置し、冪等', () => {
  const home = tempHome()
  try {
    const srcDir = path.join(home, 'skills-src')
    for (const name of BUNDLED_SKILLS) {
      fs.mkdirSync(path.join(srcDir, name), { recursive: true })
      fs.writeFileSync(path.join(srcDir, name, 'SKILL.md'), `# ${name}\n`, 'utf8')
    }
    // `~/.agents` だけがある環境（Antigravity 未インストール）
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true })

    const first = optimizeAntigravitySkills({ home, skillsSrcDir: srcDir })
    assert.equal(first.ok, true)
    const ids = first.targets.map((t) => t.id)
    assert.deepEqual(ids, ['agents'], `配置先が想定と違う: ${ids.join(',')}`)
    assert.equal(first.targets[0].installed.length, BUNDLED_SKILLS.length)
    for (const name of BUNDLED_SKILLS) {
      assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', name, 'SKILL.md')), `${name} が無い`)
    }
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false, '無い環境に .gemini を作っている')

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
    assert.match(fs.readFileSync(workSoul, 'utf8'), /hermes-pilot:a2b:end/, 'work プロファイルが同期されていない')

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
  // 機械トークンは ASCII のまま残す
  for (const token of ['`spec-architect`', '`quick-review`', 'needs_input', '`Mode: zero-stop`', '`npm run verify`']) {
    assert.ok(A2B_RULES.includes(token), `機械トークンが消えた: ${token}`)
  }
})
