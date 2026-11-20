/**
 * 言語規則の同一性ガード（SPEC-i18n-gen §3.6-2）。
 *
 * 生成文の言語規則（「実行時言語で書け／機械トークンは ASCII のまま」）は
 * **1 つの定数**（`apps/bridge/src/language-rule.js` の `LANGUAGE_RULE_MARKER`）に置き、
 * ブリッジが組むプロンプト（`architect.js` / `specs.js`）と同梱 3 スキル
 * （`skills/quick-review` / `skills/annotation` / `skills/spec-architect`）が
 * **同じ 1 文**を持つことを機械で突き合わせる（D2）。
 *
 * 片方だけ更新すると「スキルは en で書け、プロンプトは ja のまま」に戻る。
 * 規則を変えるときは `language-rule.js` を直し、このテストが落ちた先（3 スキル）を直す。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  LANGUAGE_RULE_MARKER,
  LANGUAGE_RULE_EN,
  LANGUAGE_RULE_JA,
  languageRule,
} from '../src/language-rule.js'

const here = import.meta.dirname
const REPO = path.join(here, '..', '..', '..')
const BRIDGE_SRC = path.join(here, '..', 'src')

/** 同梱スキル（この 3 つがパイプラインの散文を書く）。 */
const SKILLS = ['quick-review', 'annotation', 'spec-architect']

/** 言語規則を本文に差し込むブリッジのモジュール。 */
const PROMPT_BUILDERS = ['architect.js', 'specs.js']

test('LANGUAGE_RULE_MARKER は 1 文で、EN 規則にそのまま含まれる', () => {
  assert.equal(typeof LANGUAGE_RULE_MARKER, 'string')
  assert.ok(LANGUAGE_RULE_MARKER.trim().length >= 20, `marker が短すぎる: ${JSON.stringify(LANGUAGE_RULE_MARKER)}`)
  assert.ok(!/\n/.test(LANGUAGE_RULE_MARKER), 'marker は 1 行（スキルに 1 行で置くため）')
  assert.ok(
    LANGUAGE_RULE_EN.includes(LANGUAGE_RULE_MARKER),
    'LANGUAGE_RULE_EN が marker を含んでいません（marker と規則文が別物になっている）',
  )
  // marker 自体は ASCII（生成物に CJK を混ぜない・SPEC §1）
  assert.ok(!/[\u3000-\u30ff\u4e00-\u9fff]/.test(LANGUAGE_RULE_MARKER), 'marker に CJK が入っています')
})

test('languageRule(lang) は ja だけ日本語、それ以外は EN（既定は en）', () => {
  assert.equal(languageRule('ja'), LANGUAGE_RULE_JA)
  assert.equal(languageRule('en'), LANGUAGE_RULE_EN)
  assert.equal(languageRule(undefined), LANGUAGE_RULE_EN, '既定は en（DEFAULT_LANG）')
  assert.equal(languageRule(''), LANGUAGE_RULE_EN)
  assert.equal(languageRule('JA'), LANGUAGE_RULE_EN, '未知の値は en に倒す')
  assert.ok(LANGUAGE_RULE_JA.includes('ASCII'), 'ja の規則にも「機械トークンは ASCII」が要る')
})

test('同梱 3 スキルがすべて LANGUAGE_RULE_MARKER を含む（同一文の証明）', () => {
  for (const name of SKILLS) {
    const file = path.join(REPO, 'skills', name, 'SKILL.md')
    assert.ok(fs.existsSync(file), `スキルがありません: skills/${name}/SKILL.md`)
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(
      text.includes(LANGUAGE_RULE_MARKER),
      `skills/${name}/SKILL.md に marker がありません（language-rule.js と同じ 1 文を置く・§3.4）`,
    )
    assert.match(text, /^## Language$/m, `skills/${name}/SKILL.md に \`## Language\` 節がありません`)
  }
})

test('プロンプトを組む 2 モジュールが languageRule( を使っている（静的検査）', () => {
  for (const name of PROMPT_BUILDERS) {
    const file = path.join(BRIDGE_SRC, name)
    assert.ok(fs.existsSync(file), `モジュールがありません: apps/bridge/src/${name}`)
    const src = fs.readFileSync(file, 'utf8')
    assert.ok(
      src.includes('languageRule('),
      `apps/bridge/src/${name} が languageRule( を使っていません（規則文の写し書きは禁止・D2）`,
    )
    assert.match(
      src,
      /from\s+['"]\.\/language-rule\.js['"]/,
      `apps/bridge/src/${name} が ./language-rule.js から import していません（規則の二重定義）`,
    )
  }
})
