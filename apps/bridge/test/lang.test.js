/**
 * ブリッジの言語解決とエラー本文（SPEC §6.1 / §6.3）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLang, fromAcceptLanguage, normalizeLang, DEFAULT_LANG } from '../src/lang.js'
import { errorBody, ERROR_MESSAGES } from '../src/api-errors.js'

test('?lang= が最優先、次に Accept-Language、無ければ en', () => {
  assert.equal(resolveLang({ queryLang: 'ja', acceptLanguage: 'en-US' }), 'ja')
  assert.equal(resolveLang({ queryLang: 'en', acceptLanguage: 'ja-JP' }), 'en')
  assert.equal(resolveLang({ queryLang: 'fr', acceptLanguage: 'ja-JP' }), 'ja')
  assert.equal(resolveLang({ acceptLanguage: 'ja-JP,ja;q=0.9,en;q=0.8' }), 'ja')
  assert.equal(resolveLang({ acceptLanguage: 'en-US,en;q=0.9' }), 'en')
  assert.equal(resolveLang({}), DEFAULT_LANG)
  assert.equal(resolveLang(), 'en')
})

test('Accept-Language は q 値の高い順に見る', () => {
  assert.equal(fromAcceptLanguage('en;q=0.5, ja;q=0.9'), 'ja')
  assert.equal(fromAcceptLanguage('ja;q=0.2, en;q=0.7'), 'en')
  assert.equal(fromAcceptLanguage('*'), null)
  assert.equal(fromAcceptLanguage(''), null)
  assert.equal(fromAcceptLanguage(undefined), null)
  // ja 以外の言語は英語へフォールバックする（SPEC §6.1）
  assert.equal(fromAcceptLanguage('fr-FR,fr;q=0.9'), 'en')
})

test('normalizeLang は接頭辞で判定し、未知は null', () => {
  assert.equal(normalizeLang('JA-jp'), 'ja')
  assert.equal(normalizeLang('en-GB'), 'en')
  assert.equal(normalizeLang('de'), null)
  assert.equal(normalizeLang(''), null)
  assert.equal(normalizeLang(null), null)
})

test('エラー本文は {ok:false, code, error, params} の形', () => {
  const body = errorBody('NOT_WAITING', { status: 'ready' })
  assert.deepEqual(body, {
    ok: false,
    code: 'NOT_WAITING',
    error: 'Task is not waiting for review',
    params: { status: 'ready' },
  })
  // 未知コードは BAD_REQUEST の英語既定に落ちる
  assert.equal(errorBody('WHATEVER').code, 'WHATEVER')
  assert.equal(errorBody('WHATEVER').error, ERROR_MESSAGES.BAD_REQUEST)
  assert.deepEqual(errorBody().params, {})
  assert.equal(errorBody().code, 'BAD_REQUEST')
})
