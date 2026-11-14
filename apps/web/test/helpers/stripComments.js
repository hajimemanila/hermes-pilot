/**
 * ソースからコメントだけを落とす共有ヘルパ（テスト専用・依存追加なし）。
 *
 * 使う側: `test/noHardcodedJapanese.test.js`（画面の未翻訳チェック）と
 * `test/i18nLeak.test.js`（エラー文言の日本語漏れチェック）。
 * コメント中の日本語を違反として数えないために、文字列・正規表現リテラルを
 * 認識しながら `//` と `/* *\/` だけを落とす（**行数は保つ**ので違反行番号がずれない）。
 *
 * ここに置く理由: 素朴な正規表現による除去は `'https://…'` の `//` や
 * `` /[*_`~]/ `` のような正規表現で壊れ、**存在しない違反**を報告する（実測）。
 * 2 つのガードが同じ壊れ方をしないよう実装を 1 つに集約する。
 */

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
