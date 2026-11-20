/**
 * PWA のメタデータ（manifest / index.html）に日本語を残さない機械検査。
 *
 * 画面の辞書（en.json）は空でも、**OS やブラウザに読まれる静的ファイル**は別経路:
 * manifest の `description` / `lang` と `<html lang>` が ja のままだと、
 * 英語端末のユーザーは「インストール案内・アプリ情報・支援技術」の文脈で日本語に触れる。
 * 既定の UI 言語（`DEFAULT_LANG = en`）に揃えておく。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const webDir = path.join(here, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'public', 'manifest.webmanifest'), 'utf8'))
const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')

/** かなが・漢字・ハングル。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3130-\u318f]/

test('manifest: description / lang / name に日本語（CJK）を含めない', () => {
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 10, 'description が空')
  for (const key of ['name', 'short_name', 'description']) {
    assert.doesNotMatch(String(manifest[key] ?? ''), CJK, `${key} に日本語が残っている: ${manifest[key]}`)
  }
  assert.equal(manifest.lang, 'en', 'manifest.lang は既定の UI 言語（en）に揃える')
})

test('index.html: 既定の html lang とアプリ名は英語既定に揃える', () => {
  assert.match(indexHtml, /<html lang="en">/, '<html lang> は en（実行時に表示言語へ切り替わる）')
  assert.match(indexHtml, /<title>Hermes Pilot<\/title>/)
  assert.match(indexHtml, /name="application-name" content="Hermes Pilot"/)
  assert.match(indexHtml, /name="apple-mobile-web-app-title" content="Hermes Pilot"/)
  // 静的な head に日本語を置かない（タイトル・メタは英語）
  const head = indexHtml.slice(0, indexHtml.indexOf('</head>'))
  const headWithoutComments = head.replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(headWithoutComments, CJK, 'head に日本語が残っている')
})
