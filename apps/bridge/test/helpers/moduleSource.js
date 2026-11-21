/**
 * 分割後のモジュールを 1 本のソースとして読むためのテスト補助。
 *
 * `apps/bridge/src/<name>.js` は `<name>/` 配下のモジュールへ処理を出し、公開契約は
 * 再エクスポートで維持している。ソース文字列を検査するテスト（ルート網羅・i18n・ログ文言）は
 * 入口ファイルだけを見ると分割で空振りするため、ここで連結して読む。
 *
 * @param {string} name モジュール名（`server` / `review` / `specs` / `architect`）
 * @returns {string} 連結したソース
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(import.meta.dirname, '..', '..', 'src')

export function readModuleSource(name) {
  const entry = path.join(SRC, `${name}.js`)
  const parts = [fs.readFileSync(entry, 'utf8')]
  const dir = path.join(SRC, name)
  try {
    for (const file of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
      parts.push(fs.readFileSync(path.join(dir, file), 'utf8'))
    }
  } catch {
    /* 分割ディレクトリが無ければ入口ファイルだけ */
  }
  return parts.join('\n')
}

/** `server.js` ＋ `server/` 配下（HTTP 表面全体）。 */
export function readServerSource() {
  return readModuleSource('server')
}

/** `review.js` ＋ `review/` 配下（シート生成・回答の解析）。 */
export function readReviewSource() {
  return readModuleSource('review')
}
