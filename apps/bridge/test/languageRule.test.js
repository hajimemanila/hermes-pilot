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
import { injectReviewBridge, parseReplyText, replyTextOf } from '../src/review.js'

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


test('同梱 3 スキルは英語（機械向け）で、CJK を含まない', () => {
  // 読み手はモデル。日本語の指示を混ぜると英語運用でも出力が日本語へ寄る（A2B_RULES と同じ理由）。
  // 人が読む散文の言語は各スキルの `## Language` 節と language-rule.js が受け持つ。
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  // 旧フォーマットの見出しは**パーサが受理する機械トークン**なので、記述のために残す
  const LEGACY_TOKENS = ['【レビュー回答】', '【赤ペン回答】', '全体へのコメント:', '全体への赤ペン:']
  for (const name of SKILLS) {
    const file = path.join(REPO, 'skills', name, 'SKILL.md')
    const text = fs.readFileSync(file, 'utf8')
    const bad = text.split('\n')
      .map((line, i) => [i + 1, line])
      .map(([n, line]) => [n, LEGACY_TOKENS.reduce((acc, tok) => acc.split(tok).join(''), line)])
      .filter(([, line]) => CJK.test(line))
    assert.deepEqual(bad.slice(0, 3), [], `skills/${name}/SKILL.md に日本語が残っている`)
  }
})

/**
 * シートのテンプレート（`skills/quick-review/assets/sheet-template.html`）。
 *
 * モデルが `.html` シートを作るときのコピー元なので、本文も HTML コメントも JS の固定文も
 * ここが英語でないと英語環境に日本語が出る（SPEC-EN-ZERO-LEAK I1 / D70）。
 */
const SHEET_TEMPLATE = path.join(REPO, 'skills', 'quick-review', 'assets', 'sheet-template.html')

/** 日本語（CJK）と全角の和文記号。テンプレートは 1 文字も含んではならない。 */
const CJK_WIDE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe4f\uff01-\uff60\uffe0-\uffe6]/

test('quick-review のシートテンプレートは英語のみ（CJK 0 文字）', () => {
  assert.ok(fs.existsSync(SHEET_TEMPLATE), 'skills/quick-review/assets/sheet-template.html がありません')
  const html = fs.readFileSync(SHEET_TEMPLATE, 'utf8')
  assert.match(html, /^<!DOCTYPE html>/i)
  assert.match(html, /<html lang="en">/, 'テンプレートは <html lang="en"> でなければならない')

  const bad = html
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => CJK_WIDE.test(line))
  assert.deepEqual(
    bad.slice(0, 5),
    [],
    'skills/quick-review/assets/sheet-template.html に日本語（CJK・全角記号）が残っている',
  )
})

test('シートテンプレートは DOM 契約を保ち、回答文が parseReplyText / injectReviewBridge と往復する', () => {
  const html = fs.readFileSync(SHEET_TEMPLATE, 'utf8')

  // ブリッジが依存する構造（SKILL.md の契約）
  for (const needle of [
    'id="akForm"',
    'id="out"',
    'id="genBtn"',
    'data-q="q1"',
    'data-opt="A"',
    'type="radio"',
    'name="note-q1"',
    'name="global_note"',
  ]) {
    assert.ok(html.includes(needle), `テンプレートから ${needle} が消えている（ブリッジの契約）`)
  }

  // 回答テキストの見出しは replyTextOf('en') と同じ（写し書きが片側だけずれるのを止める・D70）
  const T = replyTextOf('en')
  for (const token of [T.head.trim(), T.unselected, T.noteMark, `${T.globalLabel}: `, T.tail]) {
    assert.ok(html.includes(token), `テンプレートの回答フォーマットが REPLY_TEXT.en と一致しない: ${JSON.stringify(token)}`)
  }

  // テンプレートの buildReply() と同じ形の回答文 → parseReplyText で戻る
  const reply = [
    `${T.head}example-01`,
    `Q1. Write exactly one question: A — Label of option A / ${T.noteMark} keep it short`,
    `Q2. Write exactly one question: ${T.unselected}`,
    `${T.globalLabel}: do both`,
    '---',
    T.tail,
  ].join('\n')
  const parsed = parseReplyText(reply)
  assert.equal(parsed.answers.length, 2)
  assert.equal(parsed.answers[0].choice, 'A — Label of option A')
  assert.equal(parsed.answers[0].note, 'keep it short')
  assert.equal(parsed.answers[1].choice, null, '未選択は null に落ちる（お任せ）')
  assert.equal(parsed.global, 'do both')

  // 注入しても構造は変わらず、英語注入で CJK が増えない（沙箱内で「送信」に化ける経路）
  const injected = injectReviewBridge(html, 't_template01', 'en')
  assert.ok(injected.includes('id="akBridgeStyle"'), 'ブリッジの CSS が注入されていない')
  assert.ok(injected.includes('__reviewSubmit'), 'ブリッジの送信関数が注入されていない')
  for (const needle of ['id="akForm"', 'id="out"', 'id="genBtn"', 'data-opt="B"']) {
    assert.ok(injected.includes(needle), `注入後に ${needle} が失われた`)
  }
  const leaked = injected
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => CJK_WIDE.test(line))
  assert.deepEqual(leaked.slice(0, 5), [], 'injectReviewBridge(html, id, "en") の出力に日本語が混ざっている')
})
