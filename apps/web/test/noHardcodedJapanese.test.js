/**
 * ハードコード日本語の残存チェック（SPEC §10 Batch T4 の受入条件）。
 *
 * `apps/web/src/` のコード（**コメントを除く**）に日本語の UI 文字列が残っていないことを検査する。
 * JSX のテキストノードも対象にするため、文字列リテラルではなく「コメントを落としたソース全体」を見る。
 *
 * 対象外（理由つき）:
 *  - `src/i18n/en.json` / `ja.json`: 辞書そのもの（ja 側は日本語で当然）
 *  - `src/lib/reviewPaste.js`: 画面の文言ではなく、シート（HTML）とレビュー skill が出力する
 *    **外部と共有するデータ形式**（`補足:` / `全体へのレビュー:` / `(未選択`）。訳すと解析が壊れる
 *
 * 装飾用の記号（`＋` U+FF0B）は文字列ではないので判定前に落とす。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/stripComments.js'

const here = import.meta.dirname
const SRC = path.join(here, '..', 'src')

/** ひらがな・カタカナ・漢字・全角記号（`・` と長音 `ー` は区切り記号なので除外）。 */
const JP = /[\u3040-\u309f\u30a0-\u30fa\u30fd-\u30ff\u4e00-\u9fff\uff01-\uff60]/

/** 判定前に落とす装飾記号（文字ではなく図形）。 */
const GLYPHS = /＋/g

/** 走査対象外のファイルと、その理由。 */
const SKIP = new Map([
  ['lib/reviewPaste.js', 'シートと skill が出力する貼り付け形式（データ）なので日本語のまま'],
  ['demo/snippets.js', 'デモ専用の定型スニペット（フィクスチャ・本番バンドル外）なので日本語のまま'],
])
/**
 * ディレクトリ配下の JS/JSX を集める。
 * @param {string} dir 起点
 * @param {string[]} [acc] 蓄積
 * @returns {string[]} 絶対パス
 */
function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(jsx?|mjs)$/.test(name)) acc.push(p)
  }
  return acc
}

/**
 * 1ファイルを検査して違反行を返す。
 * @param {string} file 絶対パス
 * @returns {Array<{line: number, text: string}>} 違反
 */
export function findJapanese(file) {
  const source = stripComments(fs.readFileSync(file, 'utf8')).replace(GLYPHS, '')
  const out = []
  source.split('\n').forEach((line, idx) => {
    if (JP.test(line)) out.push({ line: idx + 1, text: line.trim().slice(0, 140) })
  })
  return out
}

test('apps/web/src のコード（コメント除く）に日本語の UI 文字列が残っていない', () => {
  const files = walk(SRC).filter((f) => {
    const rel = path.relative(SRC, f).split(path.sep).join('/')
    if (rel.startsWith('i18n/')) return false
    return !SKIP.has(rel)
  })
  assert.ok(files.length > 10, `走査対象が少なすぎる（${files.length} 件）`)

  const violations = []
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join('/')
    for (const hit of findJapanese(f)) violations.push(`${rel}:${hit.line}: ${hit.text}`)
  }
  assert.deepEqual(violations, [], `未翻訳の日本語が残っています（t('...') に置き換える）:\n${violations.join('\n')}`)
})

test('除外リストは実在し、理由が書かれている', () => {
  for (const [rel, why] of SKIP) {
    assert.ok(fs.existsSync(path.join(SRC, rel)), `${rel} が存在しない（除外リストが古い）`)
    assert.ok(why.trim().length > 0, `${rel} の除外理由が空`)
  }
})

test('コメント除去は正規表現リテラル内の記号で壊れない（検出器の自己検証）', () => {
  const src = [
    'const s = a.replace(/[*_`~]/g, "")',
    '// これはコメント',
    'const q = b.replace(/[\'"]/g, "")',
    '/* ブロック',
    'コメント */',
    'const w = "日本語"',
    '',
  ].join('\n')
  const stripped = stripComments(src)
  assert.ok(!stripped.includes('これはコメント'), '正規表現の直後の行コメントも落ちる')
  assert.ok(!stripped.includes('ブロック'), '正規表現の直後のブロックコメントも落ちる')
  assert.ok(stripped.includes('日本語'), '文字列の日本語は残って検出される')
  assert.equal(stripped.split('\n').length, src.split('\n').length, '行数は保たれる')
  assert.ok(stripComments('const d = a / b\n// コメント\n').includes('a / b'), '除算を正規表現と誤認しない')
})

test('コメント除去は文字列内の // を壊さない（検出器の自己検証）', () => {
  const src = "const u = 'https://example.com/ja'\n// これはコメント\nconst v = '日本語'\n/* ブロック\nコメント */\n"
  const stripped = stripComments(src)
  assert.ok(stripped.includes('https://example.com/ja'), 'URL の // は残る')
  assert.ok(!stripped.includes('これはコメント'), '行コメントは落ちる')
  assert.ok(!stripped.includes('ブロック'), 'ブロックコメントは落ちる')
  assert.equal(stripped.split('\n').length, src.split('\n').length, '行数は保たれる')
  const rows = stripped.split('\n').filter((l) => JP.test(l))
  assert.deepEqual(rows.map((l) => l.trim()), ["const v = '日本語'"], '文字列の日本語は残って検出される')
})
