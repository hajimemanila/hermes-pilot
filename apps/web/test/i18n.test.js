/**
 * i18n 基盤の自動検証（SPEC §6.2 / Batch T3 受入条件）。
 *
 * - en.json と ja.json のキー差分 0 件
 * - `{var}` プレースホルダ名の不一致 0 件
 * - キー欠落時のフォールバック（ja → en → キー文字列）
 * - ブリッジの全エラーコードに `err.*` の訳があること
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DICTS,
  placeholders,
  resolveLang,
  formatMessage,
  translate,
  localizeError,
  setLang,
  getLang,
} from '../src/i18n/lang.js'
import { fmtBytes, fmtDateTime, fmtNumber, relTime, setLocale } from '../src/lib/format.js'
import { ERROR_MESSAGES } from '../../bridge/src/api-errors.js'

const here = import.meta.dirname
const readDict = (lang) => JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'i18n', `${lang}.json`), 'utf8'))
const en = readDict('en')
const ja = readDict('ja')

test('en.json と ja.json のキー集合は完全一致（差分 0 件）', () => {
  const enKeys = Object.keys(en).sort()
  const jaKeys = Object.keys(ja).sort()
  const onlyEn = enKeys.filter((k) => !(k in ja))
  const onlyJa = jaKeys.filter((k) => !(k in en))
  assert.deepEqual(onlyEn, [], `ja に無いキー: ${onlyEn.join(', ')}`)
  assert.deepEqual(onlyJa, [], `en に無いキー: ${onlyJa.join(', ')}`)
  assert.deepEqual(jaKeys, enKeys)
  // 実行時辞書（import されたもの）も同じキー集合であること
  assert.deepEqual(Object.keys(DICTS.ja).sort(), enKeys)
})

test('プレースホルダ {var} の名前は en/ja で一致（不一致 0 件）', () => {
  const mismatched = []
  for (const key of Object.keys(en)) {
    const a = placeholders(en[key])
    const b = placeholders(ja[key])
    if (a.join(',') !== b.join(',')) mismatched.push(`${key}: en=[${a}] ja=[${b}]`)
  }
  assert.deepEqual(mismatched, [])
})

test('訳文は空でなく、英語と日本語が同一ではない（訳し忘れ検出）', () => {
  const empty = []
  for (const key of Object.keys(en)) {
    if (!String(en[key]).trim()) empty.push(`en.${key}`)
    if (!String(ja[key]).trim()) empty.push(`ja.${key}`)
  }
  assert.deepEqual(empty, [])
  // 記号のみ・固有名詞のみのキー（GW / 日本語 / English）は除いて比較する
  const sameAllowed = new Set([
    'status.gw',
    'settings.languageEn',
    'settings.languageJa',
    'common.ok',
    // 言語に依存しない値（記号・実寸・仕様で固定された英語ラベル。SPEC V5 §3.3）
    'receipt.value.na', // 欠損値のダッシュ
    'receipt.canvas.size', // 1200×630 の Canvas 実寸
    'receipt.canvas.titleSerotonin', // Serotonin モードは "AUTONOMOUS EXECUTION SUMMARY" 固定
    // Demo 筐体のデバイス名・モード名（言語に依存しない固有名詞。SPEC V5 §3.4）
    'demo.view.phone',
    'demo.view.tablet',
    'demo.vibe.dopamine',
    'demo.vibe.serotonin',
    'demo.theme.dark',
    'demo.theme.light',
    // 実行方針の固有名詞（SPEC V7 D35。`Zero-stop` / `Visual-gate` は
    // 生成する SPEC の `Execution Mode` 表記と一致させるため両言語で同じ）
    'seed.policyZeroStop',
    'seed.policyVisualGate',
  ])
  const untranslated = Object.keys(en).filter((k) => !sameAllowed.has(k) && en[k] === ja[k])
  assert.deepEqual(untranslated, [], `未翻訳の疑い: ${untranslated.join(', ')}`)
})

test('§6.2 の対照表のキーがすべて存在する', () => {
  const required = [
    'nav.tasks', 'nav.review', 'nav.chat', 'nav.term', 'nav.settings',
    'status.gw', 'status.workers', 'status.reviewWaiting',
    'review.tab.waiting', 'review.tab.active', 'review.tab.done',
    'review.newAnnotation', 'review.submitAnswer',
    'chat.working', 'chat.toolsRan', 'chat.reviewWaitingTitle', 'chat.openInReview',
    'chat.jumpBottom', 'chat.jumpBottomWorking',
    'settings.language', 'settings.theme',
  ]
  const missing = required.filter((k) => !(k in en) || !(k in ja))
  assert.deepEqual(missing, [])
  // 表の代表値が仕様どおり
  assert.equal(en['chat.toolsRan'], '🔧 Ran {count} tools')
  assert.equal(ja['chat.toolsRan'], '🔧 ツール {count} 件を実行')
  assert.equal(en['review.newAnnotation'], '+ Annotate')
  assert.equal(ja['review.newAnnotation'], '＋ 注釈')
})

test('ブリッジの全エラーコードに err.* の訳がある', () => {
  const missing = []
  for (const code of Object.keys(ERROR_MESSAGES)) {
    if (!(`err.${code}` in en)) missing.push(`en.err.${code}`)
    if (!(`err.${code}` in ja)) missing.push(`ja.err.${code}`)
    if (!ERROR_MESSAGES[code].trim()) missing.push(`api-errors:${code}`)
  }
  assert.deepEqual(missing, [])
})

test('言語解決: localStorage → navigator.languages → en', () => {
  assert.equal(resolveLang({ stored: 'en', languages: ['ja-JP'] }), 'en')
  assert.equal(resolveLang({ stored: 'ja', languages: ['en-US'] }), 'ja')
  assert.equal(resolveLang({ stored: 'auto', languages: ['ja-JP', 'en-US'] }), 'ja')
  assert.equal(resolveLang({ stored: 'auto', languages: ['en-US', 'ja-JP'] }), 'en')
  assert.equal(resolveLang({ stored: null, languages: ['fr-FR'] }), 'en')
  assert.equal(resolveLang({ stored: 'bogus', language: 'ja' }), 'ja')
  assert.equal(resolveLang({}), 'en')
})

test('フォールバック: ja に無いキーは en、どちらにも無ければキー名', () => {
  const realJa = DICTS.ja['nav.tasks']
  try {
    delete DICTS.ja['nav.tasks']
    assert.equal(translate('ja', 'nav.tasks'), en['nav.tasks'])
  } finally {
    DICTS.ja['nav.tasks'] = realJa
  }
  assert.equal(translate('ja', 'no.such.key'), 'no.such.key')
  assert.equal(translate('xx', 'nav.tasks'), en['nav.tasks'])
})

test('プレースホルダ展開: 値は置換、未知の名前は残す', () => {
  assert.equal(formatMessage('{a} and {b}', { a: 1, b: 2 }), '1 and 2')
  assert.equal(formatMessage('{a} and {b}', { a: 1 }), '1 and {b}')
  assert.equal(formatMessage('no vars'), 'no vars')
  assert.deepEqual(placeholders('{b} {a} {b}'), ['a', 'b'])
  assert.equal(translate('ja', 'status.workers', { n: 3 }), '稼働 3')
  assert.equal(translate('en', 'status.workers', { n: 3 }), 'Workers 3')
})

test('エラー応答の自言語化（§6.3 の {ok,code,error,params}）', () => {
  setLang('ja')
  assert.equal(localizeError({ code: 'NOT_WAITING', error: 'Task is not waiting for review', params: { status: 'ready' } }), 'レビュー待ちではありません（現在: ready）')
  setLang('en')
  assert.equal(localizeError({ code: 'NOT_WAITING', params: { status: 'ready' } }), 'Task is not waiting for review (status: ready)')
  // 未知のコードはサーバーの英語メッセージをそのまま返す（画面を空にしない）
  assert.equal(localizeError({ code: 'SOMETHING_NEW', error: 'boom' }), 'boom')
  assert.equal(getLang(), 'en')
  setLang('en')
})

test('フォーマッタは Intl で言語に追従する', () => {
  setLocale('ja')
  const jaRel = relTime(Date.now() - 3 * 60 * 1000)
  assert.match(jaRel, /分前/)
  assert.equal(fmtBytes(1572864), '1.5MB')
  assert.equal(fmtNumber(1234567), '1,234,567')
  setLocale('en')
  const enRel = relTime(Date.now() - 3 * 60 * 1000)
  assert.match(enRel, /min/)
  assert.notEqual(enRel, jaRel)
  const d = Date.parse('2026-11-13T22:40:00Z')
  assert.notEqual(fmtDateTime(d, {}, 'ja'), fmtDateTime(d, {}, 'en'))
  setLocale('en')
})

test('スニペット編集 UI のキーがあり、err.OFFLINE は両言語で訳される', () => {
  const required = [
    'settings.snippets',
    'settings.snippetChat',
    'settings.snippetTerm',
    'settings.snippetBuiltin',
    'settings.snippetHot',
    'settings.snippetHide',
    'settings.snippetShow',
    'settings.snippetReset',
    'settings.snippetResetDone',
    'settings.snippetAddTitle',
    'settings.snippetAdd',
    'settings.snippetEditTitle',
    'settings.snippetEdit',
    'settings.snippetSave',
    'settings.snippetCancel',
    'settings.snippetRun',
    'settings.snippetCommandPlaceholder',
    'settings.snippetHint',
    'settings.customSnippets',
    'err.OFFLINE',
  ]
  const missing = required.filter((k) => !(k in en) || !(k in ja))
  assert.deepEqual(missing, [])
  // SW の 503 `{ok:false, code:'OFFLINE'}` はフロントで `t('err.OFFLINE')` にする（G4）
  setLang('en')
  assert.equal(translate('en', 'err.OFFLINE'), 'Cannot reach the bridge')
  setLang('ja')
  assert.match(translate('ja', 'err.OFFLINE'), /ブリッジ/)
  setLang('en')
})

test('setLang は hm:lang を発火する（スニペットをリロードなしで切り替える・SPEC §3.1）', () => {
  const events = []
  const prev = globalThis.window
  globalThis.window = {
    dispatchEvent: (e) => {
      events.push(e)
      return true
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  try {
    setLang('en')
    setLang('ja')
    const last = events[events.length - 1]
    assert.equal(last.type, 'hm:lang')
    assert.equal(last.detail.lang, 'ja')
    setLang('en')
    assert.equal(getLang(), 'en')
  } finally {
    if (prev === undefined) delete globalThis.window
    else globalThis.window = prev
    setLang('en')
  }
})

/**
 * SPEC-PILOT-V7 §3.5 / D37: ターミナル機能を指す「端末」は「ターミナル」、
 * 「仕様の種」は「仕様策定」へ統一する（物理デバイスの「端末」と英語 `Spec Seed` は維持）。
 */
test('日本語表記: ターミナル／仕様策定に統一され、物理デバイスの「端末」は残る（V7 §3.5 / D37）', () => {
  assert.equal(ja['nav.term'], 'ターミナル')
  assert.equal(ja['settings.snippetTerm'], 'ターミナル')
  assert.equal(ja['settings.secAppearance'], '外観・操作', '「外観・端末」はターミナル機能の意味だった')
  assert.match(ja['settings.audit'], /ターミナル/)
  assert.match(ja['app.termLoading'], /^ターミナル/)
  assert.equal(ja['seed.title'], '仕様策定')
  // 英語は "Spec Seed" を維持（英語 UI のタブは Terminal に統一）
  assert.equal(en['seed.title'], 'Spec Seed')
  assert.equal(en['nav.term'], 'Terminal')
  // 物理デバイスを指す「端末」は変えない（置換しすぎの検出）
  for (const key of [
    'review.pickFromDevice',
    'chat.thisDeviceDefault',
    'settings.themeSystem',
    'settings.pairing',
    'settings.pairingScanHint',
  ]) {
    assert.match(ja[key], /端末/, `${key} は物理デバイスの意味なので「端末」のまま`)
  }
  // 旧表記「仕様の種」がどこにも残っていない（seed.*・ガイド文言を含む）
  const stale = Object.entries(ja)
    .filter(([, v]) => typeof v === 'string' && v.includes('仕様の種'))
    .map(([k]) => k)
  assert.deepEqual(stale, [])
  // ターミナル機能の意味で残った「端末」も無い（残るのは上で列挙した物理デバイスのみ）
  const deviceKeys = new Set([
    'review.pickFromDevice',
    'review.newAnnoHint',
    'chat.thisDeviceDefault',
    'settings.themeSystem',
    'settings.pairing',
    'settings.pairingScanHint',
  ])
  const leftover = Object.entries(ja)
    .filter(([k, v]) => typeof v === 'string' && v.includes('端末') && !deviceKeys.has(k))
    .map(([k]) => k)
  assert.deepEqual(leftover, [])
})
