/**
 * ログイン画面（`server.js` から切り出し）。静的な HTML 1 枚と、言語別の文言だけを持つ。
 *
 * 文言は英語が既定（PWA 本体の既定言語と揃える）。CLI / Bridge のログ・エラーは
 * 英語単一言語（SPEC-EN-ZERO-LEAK）だが、この画面は *UI* なので ja を持つ。
 */

import { langOf } from './respond.js'

/**
 * ログイン画面の文言（`Accept-Language` / `?lang=` で切り替える）。
 * 既定は英語 — PWA 本体の既定言語（`en`）と揃える。
 */
const LOGIN_TEXT = {
  en: {
    title: 'Hermes Pilot — Sign in',
    placeholder: 'App token',
    submit: 'Enter',
    hint: 'Find the token in <code>~/.hermes/plugin-data/hermes-pilot/token</code>.',
  },
  ja: {
    title: 'Hermes Pilot — ログイン',
    placeholder: 'アプリトークン',
    submit: '入る',
    hint: 'トークンは <code>~/.hermes/plugin-data/hermes-pilot/token</code>（トークンファイル）を確認してください。',
  },
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>body{background:#07171b;color:#e6f4f1;font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh}
form{background:#0d242a;padding:24px;border-radius:16px;border:1px solid #1d3a41;width:min(88vw,360px)}
h1{font-size:16px;margin:0 0 12px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #24515a;background:#081e23;color:#e6f4f1;font-size:15px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;background:#13807f;color:#fff;font-size:15px}
p{color:#7fa6a3;font-size:12px;margin:10px 0 0}</style>
<form method="get" action="/auth"><h1>Hermes Pilot</h1>
<input name="t" placeholder="__PLACEHOLDER__" autocomplete="off" autocapitalize="off" spellcheck="false">
<button>__SUBMIT__</button>
<p>__HINT__</p></form>`

/**
 * ログイン画面の HTML を要求言語で組み立てる。
 * @param {import('node:http').IncomingMessage} req 要求
 * @returns {string} HTML
 */
export function loginPage(req) {
  // 言語判定は `langOf()`（`?lang=` → `Accept-Language` → en）に一本化する
  let url
  try {
    url = new URL(String(req?.url ?? '/'), 'http://x')
  } catch {
    url = new URL('/', 'http://x')
  }
  const L = LOGIN_TEXT[langOf(req, url)] ?? LOGIN_TEXT.en
  return LOGIN_HTML
    .replace('__TITLE__', L.title)
    .replace('__PLACEHOLDER__', L.placeholder)
    .replace('__SUBMIT__', L.submit)
    .replace('__HINT__', L.hint)
}
