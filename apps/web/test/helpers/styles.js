import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '../../src')

/**
 * スタイルの全ソースを 1 本の文字列で返す（テスト用）。
 *
 * `src/styles.css` は `@import './styles/*.css'` の manifest なので、
 * 読み込み順（＝カスケード順）どおりに展開して連結する。テストは
 * 「どのファイルに書かれているか」ではなく「規則が存在するか」を見る。
 *
 * @param {string} [entry] `src/` からの相対パス（既定 `styles.css`）
 * @returns {string} CSS 全ソース
 */
export function readStyles(entry = 'styles.css') {
  return expand(path.join(SRC, entry), new Set())
}

function expand(file, seen) {
  const text = fs.readFileSync(file, 'utf8')
  if (seen.has(file)) return ''
  seen.add(file)
  return text.replace(/@import\s+'([^']+)';\s*(?:\/\*[^*]*\*\/)?/g, (m, rel) =>
    expand(path.resolve(path.dirname(file), rel), seen),
  )
}

export const STYLES_DIR = path.join(SRC, 'styles')
