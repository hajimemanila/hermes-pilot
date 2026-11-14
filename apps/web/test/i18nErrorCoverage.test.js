/**
 * エラー表示の多言語カバレッジ（SPEC-i18n-resp B2 / §2 B2 受入条件）。
 *
 * 目的: 「EN なのに日本語」「JA なのに英語」を機械で止める。判定は 4 つ。
 *
 * 1. ブリッジが実際に返すコード（`code: 'X'` / `new ApiError('X'`）は、必ず
 *    `ERROR_MESSAGES` に英語既定文を持ち、`err.<CODE>` が en / ja 両方にある
 * 2. `err.*` の `{param}` 名が en と ja で一致する（片方だけ欠けると埋まらない）
 * 3. `message:` / `error:` / `reason:` と `new Error('…')` に日本語リテラルが残っていない
 *    （残ると `sendFailure` の `detail` として応答 JSON にそのまま載る）
 * 4. `language=en` のとき、レビューの失敗応答 JSON と PWA の表示文に日本語が 1 文字も無い
 *    （JA のときは逆に日本語で出る＝辞書を引いている証拠）
 *
 * 3 と 4 が揃うと、応答本文（`error` は英語既定・`detail` は英語のみ・`params` は値だけ）に
 * 日本語が入る経路が無くなる。4 は `createReview()` の失敗経路を実際に呼び、
 * `server.js` の `sendFailure()` と同じ規則で応答本文を組み立てて検証する。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ERROR_MESSAGES, errorBody } from '../../bridge/src/api-errors.js'
import { createReview } from '../../bridge/src/review.js'
import { localizeError, placeholders, setLang } from '../src/i18n/lang.js'

const here = import.meta.dirname
const bridgeDir = path.join(here, '..', '..', 'bridge', 'src')
const readDict = (lang) => JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'i18n', `${lang}.json`), 'utf8'))
const en = readDict('en')
const ja = readDict('ja')

/** ひらがな・カタカナ・漢字（全角記号は含めない＝記号だけの文は許す）。 */
const JP = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/

/** B2 で置換した 9 ファイル（`runKanban` の運用文・シート HTML・生成文は対象外）。 */
const SCOPED = [
  'review.js',
  'repos.js',
  'inbox.js',
  'specs.js',
  'ops.js',
  'kanban.js',
  'capture.js',
  'chat-profile.js',
  'server.js',
]

/** 行コメント・ブロックコメントを落とす（コメント内の日本語は対象外）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** ブリッジが返すコードを静的に集める。 */
function bridgeCodes() {
  const codes = new Set()
  for (const name of fs.readdirSync(bridgeDir).filter((f) => f.endsWith('.js'))) {
    const src = stripComments(fs.readFileSync(path.join(bridgeDir, name), 'utf8'))
    for (const m of src.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]*)'/g)) codes.add(m[1])
    for (const m of src.matchAll(/new ApiError\(\s*'([A-Z][A-Z0-9_]*)'/g)) codes.add(m[1])
  }
  return [...codes].sort()
}

test('ブリッジが返すコードは余さず英語既定文と err.<CODE>（en/ja）を持つ', () => {
  const codes = bridgeCodes()
  assert.ok(codes.length >= 20, `コードが少なすぎる（抽出の失敗を疑う）: ${codes.length}`)
  const bad = []
  for (const code of codes) {
    if (!(code in ERROR_MESSAGES)) bad.push(`${code}: ERROR_MESSAGES に無い`)
    if (!(`err.${code}` in en)) bad.push(`${code}: en.err.${code} が無い`)
    if (!(`err.${code}` in ja)) bad.push(`${code}: ja.err.${code} が無い`)
  }
  assert.deepEqual(bad, [])
})

test('err.* の {param} 名は en と ja で一致する（両言語同数）', () => {
  const enKeys = Object.keys(en).filter((k) => k.startsWith('err.')).sort()
  const jaKeys = Object.keys(ja).filter((k) => k.startsWith('err.')).sort()
  assert.deepEqual(enKeys, jaKeys, 'err.* のキー集合が両言語で一致すること')
  const bad = []
  for (const key of enKeys) {
    const a = placeholders(en[key])
    const b = placeholders(ja[key])
    if (a.join(',') !== b.join(',')) bad.push(`${key}: en={${a}} ja={${b}}`)
  }
  assert.deepEqual(bad, [])
})

test('英語辞書の err.* に日本語が混ざっていない', () => {
  const bad = Object.keys(en)
    .filter((k) => k.startsWith('err.') && JP.test(en[k]))
    .map((k) => `${k}: ${en[k]}`)
  assert.deepEqual(bad, [])
})

test('message: / error: / reason: / new Error() に日本語リテラルが残っていない（B2 の 9 ファイル）', () => {
  const bad = []
  for (const name of SCOPED) {
    const src = stripComments(fs.readFileSync(path.join(bridgeDir, name), 'utf8'))
    for (const m of src.matchAll(/\b(?:message|error|reason):\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/gs)) {
      if (JP.test(m[2])) bad.push(`${name}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
    }
    for (const m of src.matchAll(/new Error\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/gs)) {
      if (JP.test(m[2])) bad.push(`${name}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  assert.deepEqual(bad, [])
})

/** `server.js` の `sendFailure()` と同じ規則で応答本文を組み立てる（テスト用の写し）。 */
function failureBody(r, status = 400) {
  const fallback = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST'
  const code = r?.code ?? fallback
  const params = r?.params ?? (r?.status ? { status: r.status } : {})
  const body = errorBody(code, params)
  const detail = [r?.message, r?.error, r?.reason].find((v) => typeof v === 'string' && v.trim())
  if (detail && detail !== body.error) body.detail = String(detail)
  return body
}

/** 応答本文 → 実際に PWA が出す表示文（api.js と同じ経路）。 */
function shownText(body) {
  return localizeError(body)
}

test('language=en: /api/review の失敗応答 JSON と表示文に日本語が無い', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-err-'))
  try {
    const review = createReview(
      { kanbanRoot: path.join(tmp, 'kanban'), pluginDataDir: path.join(tmp, 'data') },
      { board: 'noboard', workdir: tmp, runKanban: async () => ({ code: 1, out: '' }) },
    )
    // 失敗する経路を実際に通す（DB が無い・パスが不正・画像が無い 等）
    const results = [
      review.sheetHtml('t_deadbeef'),
      review.sheetData('t_deadbeef'),
      review.image('t_deadbeef'),
      review.annotation('t_deadbeef'),
      review.thumb('../../etc/passwd'),
      review.libraryFile('../../etc/passwd'),
      await review.answer('t_deadbeef', { answers: [] }),
      await review.approve('t_deadbeef', {}),
      await review.saveAnnotation('t_deadbeef', { annotated_image: 'nope' }),
      await review.createFromImage({ source: 'path', path: '../../etc/passwd' }),
    ]
    const failures = results.filter((r) => r && r.ok === false)
    assert.ok(failures.length >= 6, `失敗結果が取れていない（経路が変わった？）: ${failures.length}`)

    setLang('en')
    const bad = []
    for (const r of failures) {
      const body = failureBody(r)
      const json = JSON.stringify(body)
      if (JP.test(json)) bad.push(`${body.code}: ${json.slice(0, 120)}`)
      const text = shownText(body)
      if (JP.test(text)) bad.push(`${body.code} 表示: ${text}`)
    }
    assert.deepEqual(bad, [])

    // JA では辞書を引いて日本語になる（＝英語既定文をそのまま出していない証拠）
    setLang('ja')
    const jaText = failures.map((r) => shownText(failureBody(r)))
    assert.ok(jaText.some((t) => JP.test(t)), 'JA では日本語の表示文になること')
  } finally {
    setLang('en')
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
