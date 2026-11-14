#!/usr/bin/env node
/**
 * OAuth 境界の機械検査（SPEC V5 §3.2 / D25 の受入条件）。
 *
 * `agy` 連携は**公式ローカル CLI の子プロセス起動だけ**に限定する。Antigravity の
 * OAuth 認証ファイル（ユーザーの資格情報）を読む・コピーする・トークンを流用するコードが
 * 1 箇所でも混ざったら失敗させる。人が目で追う約束にせず、`npm run verify` に載せる。
 *
 * 走査対象は**コード**（配布物とテストを含む）。仕様書や README の説明文は
 * 「アクセス」ではないので対象外。
 *
 * 出力: 見つかった箇所を `path:line: text` で列挙し、exit 1。0 件なら exit 0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** コードとして走査するディレクトリ（配布物・テストを含む）。 */
const SCAN_DIRS = ['apps/bridge/src', 'apps/bridge/test', 'apps/web/src', 'apps/web/test', 'apps/dashboard', 'bin', 'scripts']

/** 走査する拡張子。 */
const EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.json', '.css'])

/**
 * 禁止パターン。literal を分割して組み立てるのは、この検査自身が
 * 「リポジトリに literal が無い」という受入条件を汚さないため。
 */
const NEEDLES = [
  { label: 'antigravity oauth credential file', needle: ['oauth', 'creds'].join('_') },
  { label: 'gemini dir + oauth', re: new RegExp(['\\.', 'gemini'].join('') + '[^\\n]{0,80}?oauth', 'i') },
]

/** この検査自身は走査しない（パターン定義そのものが当たるため）。 */
const SELF = fileURLToPath(import.meta.url)

/** 再帰的にファイルを集める（`node_modules` / `dist` は見ない）。 */
function walk(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__pycache__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (EXTS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

const hits = []
let scanned = 0
for (const rel of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, rel))) {
    if (file === SELF) continue
    scanned += 1
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (const { label, needle, re } of NEEDLES) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        const found = needle ? line.includes(needle) : re.test(line)
        if (found) hits.push({ file: path.relative(ROOT, file), line: i + 1, label, text: line.trim().slice(0, 160) })
      }
    }
  }
}

if (hits.length) {
  console.error(`check-oauth-boundary: ${hits.length} forbidden access point(s) in ${scanned} files`)
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}: [${hit.label}] ${hit.text}`)
  process.exit(1)
}

console.log(`check-oauth-boundary: OK — 0 access points in ${scanned} files (CLI subprocess only)`)
