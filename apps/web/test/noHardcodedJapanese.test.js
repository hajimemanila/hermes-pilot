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

const here = import.meta.dirname
const SRC = path.join(here, '..', 'src')

/** ひらがな・カタカナ・漢字・全角記号（`・` と長音 `ー` は区切り記号なので除外）。 */
const JP = /[\u3040-\u309f\u30a0-\u30fa\u30fd-\u30ff\u4e00-\u9fff\uff01-\uff60]/

/** 判定前に落とす装飾記号（文字ではなく図形）。 */
const GLYPHS = /＋/g

/** 走査対象外のファイルと、その理由。 */
const SKIP = new Map([
  ['lib/reviewPaste.js', 'シートと skill が出力する貼り付け形式（データ）なので日本語のまま'],
])

/**
 * 直前の意味のある文字（空白・改行を読み飛ばした最後の出力）から、`/` が
 * **正規表現リテラルの開始**かどうかを判定する。
 *
 * 素朴に `"`/`'`/`` ` `` だけを見て文字列モードへ入ると、`/[*_`~]/g` のような
 * 正規表現の中のバッククォートで以降が全部「文字列」になり、コメント除去が止まって
 * **存在しない日本語（コメント中の日本語）を違反として報告する**（実測: `reportSummaryLine`）。
 *
 * @param {string[]} out これまでに出力した文字（1 文字ずつ）
 * @returns {boolean} 正規表現の開始位置か
 */
function regexAt(out) {
  let k = out.length - 1
  while (k >= 0 && /\s/.test(out[k])) k -= 1
  if (k < 0) return true
  const prev = out[k]
  if (prev === ')' || prev === ']' || prev === '}') return false
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true
  if (/[A-Za-z_$]/.test(prev)) {
    let start = k
    while (start >= 0 && /[A-Za-z0-9_$]/.test(out[start])) start -= 1
    const word = out.slice(start + 1, k + 1).join('')
    return REGEX_KEYWORDS.has(word)
  }
  // 数字・`"`/`'`/`` ` `` の直後は除算（`1 / 2`）
  return false
}

/** `return /re/` のように直後が正規表現になり得るキーワード。 */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'new',
  'do',
  'else',
  'yield',
  'await',
])

/**
 * `/* *\/` と `//` を落とす（文字列・正規表現リテラル内の `//` は残す）。行数は保つ。
 * @param {string} src ソース
 * @returns {string} コメント除去後
 */
export function stripComments(src) {
  const out = []
  let i = 0
  const n = src.length
  let mode = 'code'
  let quote = ''
  let inClass = false
  while (i < n) {
    const c = src[i]
    const nx = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && nx === '/') {
        mode = 'line'
        i += 2
        continue
      }
      if (c === '/' && nx === '*') {
        mode = 'block'
        i += 2
        continue
      }
      // 正規表現リテラル（中に `"` `'` `` ` `` `/` が入っても文字列・コメント扱いしない）
      if (c === '/' && regexAt(out)) {
        mode = 'regex'
        inClass = false
        out.push(c)
        i += 1
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        mode = 'str'
        quote = c
      }
      out.push(c)
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out.push('\n')
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && nx === '/') {
        mode = 'code'
        i += 2
        continue
      }
      if (c === '\n') out.push('\n')
      i += 1
      continue
    }
    if (mode === 'regex') {
      if (c === '\\') {
        out.push(src.slice(i, i + 2))
        i += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) mode = 'code'
      else if (c === '\n') mode = 'code' // 閉じ忘れで以降を飲み込まない
      out.push(c)
      i += 1
      continue
    }
    // 文字列の中
    if (c === '\\') {
      out.push(src.slice(i, i + 2))
      i += 2
      continue
    }
    if (c === quote) mode = 'code'
    out.push(c)
    i += 1
  }
  return out.join('')
}

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
