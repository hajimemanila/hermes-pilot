/**
 * エラーコード表と失敗ヘルパの検証（SPEC-i18n-resp B1 / §2 B1 受入条件）。
 *
 * - `ERROR_MESSAGES` の全コードに英語既定文がある（空・日本語が無い）
 * - `fail()` の戻り形が §6.3 の `{ok:false, code, error, params}` と一致し、throw しない
 * - `ApiError` が `code` / `params` / `statusCode` を運び、`message` は英語既定文
 * - 未知コードは code を保ったまま `BAD_REQUEST` の英語既定に落ちる（現行方針）
 * - 全コードに `err.<CODE>` の訳が en / ja 両方にある
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ERROR_MESSAGES,
  ERROR_CODES,
  FALLBACK_CODE,
  errorBody,
  fail,
  ApiError,
} from '../../bridge/src/api-errors.js'

const here = import.meta.dirname
const readDict = (lang) => JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'i18n', `${lang}.json`), 'utf8'))
const en = readDict('en')
const ja = readDict('ja')

/** ひらがな・カタカナ・漢字（英語既定文に混ざっていないか見る）。 */
const JP = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/

test('全コードに英語既定文がある（空・非文字列・日本語なし）', () => {
  const bad = []
  for (const code of Object.keys(ERROR_MESSAGES)) {
    const msg = ERROR_MESSAGES[code]
    if (typeof msg !== 'string') bad.push(`${code}: not a string`)
    else if (!msg.trim()) bad.push(`${code}: empty`)
    else if (JP.test(msg)) bad.push(`${code}: contains Japanese (${msg})`)
  }
  assert.deepEqual(bad, [])
  assert.ok(Object.keys(ERROR_MESSAGES).length >= 12, '既存 12 コードは温存されていること')
})

test('コード命名は <DOMAIN>_<REASON> 形式（大文字・数字・アンダースコア）', () => {
  const bad = Object.keys(ERROR_MESSAGES).filter((code) => !/^[A-Z][A-Z0-9_]*$/.test(code))
  assert.deepEqual(bad, [])
  assert.deepEqual(ERROR_CODES, Object.keys(ERROR_MESSAGES))
})

test('既存 12 コードは残っている（後方互換）', () => {
  const legacy = [
    'AUTH_REQUIRED',
    'BAD_REQUEST',
    'CONFLICT',
    'CONFIRM_MISMATCH',
    'INTERNAL',
    'NOT_FOUND',
    'NOT_WAITING',
    'NO_SESSION',
    'QUERY_REQUIRED',
    'RATE_LIMITED',
    'SESSION_REQUIRED',
    'UNKNOWN_ENDPOINT',
  ]
  for (const code of legacy) assert.ok(code in ERROR_MESSAGES, `missing legacy code: ${code}`)
})

test('fail() の戻り形は §6.3 と一致し、throw しない', () => {
  let out
  assert.doesNotThrow(() => {
    out = fail('TASK_NOT_FOUND', { id: 't_123' })
  })
  assert.deepEqual(Object.keys(out).sort(), ['code', 'error', 'ok', 'params'])
  assert.equal(out.ok, false)
  assert.equal(out.code, 'TASK_NOT_FOUND')
  assert.equal(out.error, ERROR_MESSAGES.TASK_NOT_FOUND)
  assert.deepEqual(out.params, { id: 't_123' })
})

test('fail() は params 省略時に空オブジェクト、壊れた params は空に丸める', () => {
  assert.deepEqual(fail('BAD_PATH').params, {})
  assert.deepEqual(fail('BAD_PATH', null).params, {})
  assert.deepEqual(fail('BAD_PATH', 'not-an-object').params, {})
  assert.deepEqual(fail('BAD_PATH', { path: 'a/b' }).params, { path: 'a/b' })
})

test('fail() は errorBody() と同一の本文を返す（2 経路で差が出ない）', () => {
  for (const code of Object.keys(ERROR_MESSAGES)) {
    assert.deepEqual(fail(code, { x: 1 }), errorBody(code, { x: 1 }), `mismatch for ${code}`)
  }
})

test('未知コードは code を保ち、英語既定は BAD_REQUEST に落ちる', () => {
  const out = fail('NO_SUCH_CODE', { a: 1 })
  assert.equal(out.code, 'NO_SUCH_CODE')
  assert.equal(out.error, ERROR_MESSAGES[FALLBACK_CODE])
  assert.deepEqual(out.params, { a: 1 })
  assert.equal(errorBody().code, FALLBACK_CODE)
  assert.equal(errorBody('').code, FALLBACK_CODE)
})

test('ApiError は code / params / statusCode / message を運ぶ', () => {
  const err = new ApiError('COMMENT_REQUIRED', { field: 'comment' }, 400)
  assert.ok(err instanceof Error)
  assert.ok(err instanceof ApiError)
  assert.equal(err.name, 'ApiError')
  assert.equal(err.code, 'COMMENT_REQUIRED')
  assert.deepEqual(err.params, { field: 'comment' })
  assert.equal(err.statusCode, 400)
  assert.equal(err.message, ERROR_MESSAGES.COMMENT_REQUIRED)
  assert.equal(ERROR_MESSAGES.COMMENT_REQUIRED, 'A comment is required', 'message は英語既定文')

  // statusCode 省略時は 400、params 省略時は {}
  const plain = new ApiError('TASK_NOT_FOUND')
  assert.equal(plain.statusCode, 400)
  assert.deepEqual(plain.params, {})

  // throw して catch しても情報が残る（server.js の sendFailure が読む形）
  try {
    throw new ApiError('INTERNAL', {}, 500)
  } catch (e) {
    assert.equal(e.code, 'INTERNAL')
    assert.equal(e.statusCode, 500)
  }
})

test('ApiError の未知コードも英語既定に落ちる', () => {
  const err = new ApiError('NOPE', {}, 409)
  assert.equal(err.code, 'NOPE')
  assert.equal(err.message, ERROR_MESSAGES[FALLBACK_CODE])
  assert.equal(err.statusCode, 409)
})

test('全コードに err.<CODE> の訳が en / ja 両方にある', () => {
  const missing = []
  for (const code of Object.keys(ERROR_MESSAGES)) {
    if (!(`err.${code}` in en)) missing.push(`en.err.${code}`)
    if (!(`err.${code}` in ja)) missing.push(`ja.err.${code}`)
  }
  assert.deepEqual(missing, [])
})
