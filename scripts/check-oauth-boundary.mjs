#!/usr/bin/env node
/**
 * 境界の機械検査（SPEC V5 §3.2 / D25、SPEC V11 §3.4 / D52）。
 *
 * 2 種類の境界を守る。人が目で追う約束にせず、`npm run verify` に載せる。
 *
 * 1. **OAuth 境界** … Antigravity の OAuth 認証ファイル（ユーザーの資格情報）を
 *    読む・コピーする・トークンを流用するコードが 1 箇所でも混ざったら失敗させる。
 * 2. **`agy` 境界（V11 D52）** … V11 で `agy Opt-in`（`spawn('agy')` /
 *    `execFile('agy')` による CLI 子プロセス起動とその検出・パス解決）を完全削除した。
 *    ランナーは `Hermes Native` だけなので、検出コード（`hasAgyCli` / `agyCliDirs` /
 *    `resolveAgyBin`）や `agy` 起動文字列が**ランタイムコードへ再混入**したら失敗させる。
 *    リポジトリが配る `demo/index.html`（単一 HTML バンドル）も同じ境界の一部。
 * 3. **外部 AI CLI 境界（D63）** … V11 D52 を `gemini` CLI へ拡張した。ラップ起動
 *    （`spawn` / `execFile` / `exec` 系での `'gemini'` 起動、`gemini` に `-p` を渡す文字列）が
 *    ランタイムコードに混ざったら失敗させる。ネイティブのプロバイダと `delegate_task` だけを使う。
 *
 * 走査対象は**コード**（配布物とテストを含む）。仕様書や README の説明文は
 * 「アクセス」ではないので対象外。テストコードは「削除されたことを主張する」ために
 * 禁止語を含み得るので、`agy` 境界の検査はランタイムコードだけを見る。
 *
 * 出力: 見つかった箇所を `path:line: text` で列挙し、exit 1。0 件なら exit 0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** OAuth 検査も含めてコードとして走査するディレクトリ（配布物・テストを含む）。 */
const SCAN_DIRS = ['apps/bridge/src', 'apps/bridge/test', 'apps/web/src', 'apps/web/test', 'apps/dashboard', 'bin', 'scripts']

/** ランタイムコードのディレクトリ（`agy` 境界の検査対象。テストは含めない）。 */
const RUNTIME_DIRS = ['apps/bridge/src', 'apps/web/src', 'apps/dashboard', 'bin']

/** 単一 HTML バンドル。ビルド生成物だが配布物なので境界検査に含める。 */
const DEMO_FILE = path.join(ROOT, 'demo', 'index.html')

/** 走査する拡張子。 */
const EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.json', '.css', '.html'])

/**
 * 外部 AI CLI 名（D63）。リテラルを分割して組み立てるのは、この検査自身が
 * 「リポジトリに起動 literal が無い」という受入条件を汚さないため。
 */
const EXTERNAL_CLI = ['gem', 'ini'].join('')

/** 引用符 3 種（`'` / `"` / バッククォート）の正規表現クラス。エスケープ事故を避けて組み立てる。 */
const QUOTE_CLASS = `[${String.fromCharCode(39, 34, 96)}]`

/** 子プロセス起動の関数名（`gemini` / `agy` の検出で共用する）。 */
const SPAWN_CALL = '(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)'

/**
 * 禁止パターン。literal を分割して組み立てるのは、この検査自身が
 * 「リポジトリに literal が無い」という受入条件を汚さないため。
 *
 * `scope`:
 *   - `code`    … `SCAN_DIRS` 全体（OAuth 境界）
 *   - `runtime` … `RUNTIME_DIRS` のみ（`agy` 境界。テストの主張は対象外）
 *   - `demo`    … `demo/index.html` のみ
 */
const NEEDLES = [
  { label: 'antigravity oauth credential file', needle: ['oauth', 'creds'].join('_'), scope: 'code' },
  { label: 'gemini dir + oauth', re: new RegExp(['\\.', 'gemini'].join('') + '[^\\n]{0,80}?oauth', 'i'), scope: 'code' },
  // --- V11 D52: `agy` CLI の検出・パス解決・子プロセス起動の再混入禁止 ---
  { label: 'agy CLI detection', needle: ['has', 'Agy'].join(''), scope: 'runtime' },
  { label: 'agy CLI detection (python)', needle: ['has', '_agy'].join(''), scope: 'runtime' },
  { label: 'agy CLI path resolution', needle: ['agy', 'CliDirs'].join(''), scope: 'runtime' },
  { label: 'agy CLI path resolution', needle: ['resolve', 'AgyBin'].join(''), scope: 'runtime' },
  {
    label: 'agy CLI subprocess',
    re: new RegExp(['\\b', 'agy', '\\b', '\\s*[\'"`]?\\s+-p\\b'].join(''), 'i'),
    scope: 'runtime',
  },
  {
    label: 'agy CLI subprocess',
    re: new RegExp(['(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\\s*\\([^)\\n]{0,200}?[\'"`]', 'agy', '[\'"`]'].join(''), 'i'),
    scope: 'runtime',
  },
  // --- D63: 外部 AI CLI（`gemini`）の子プロセス起動の再混入禁止 ---
  {
    label: 'external AI CLI subprocess',
    re: new RegExp(`${SPAWN_CALL}\\s*\\([^)\\n]{0,200}?${QUOTE_CLASS}${EXTERNAL_CLI}${QUOTE_CLASS}`, 'i'),
    scope: 'runtime',
  },
  {
    label: 'external AI CLI subprocess',
    re: new RegExp(`\\b${EXTERNAL_CLI}\\b\\s*${QUOTE_CLASS}?\\s+-p\\b`, 'i'),
    scope: 'runtime',
  },
  // --- V11 D51 / D53: デモバンドルに `agy` ランナー UI が残っていないこと ---
  { label: 'agy runner in demo bundle', needle: ['has', 'AgyCli'].join(''), scope: 'demo' },
  { label: 'agy runner in demo bundle', needle: ['Antigravity (', 'agy)'].join(''), scope: 'demo' },
  { label: 'agy runner in demo bundle', needle: ['DEMO_HAS', '_AGY'].join(''), scope: 'demo' },
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

/** そのファイルに適用するパターンだけを返す。 */
function needlesFor(rel, scope) {
  if (scope === 'demo') return rel === path.relative(ROOT, DEMO_FILE) ? NEEDLES.filter((n) => n.scope === 'demo') : []
  if (scope === 'runtime') {
    const inRuntime = RUNTIME_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`))
    return inRuntime ? NEEDLES.filter((n) => n.scope === 'runtime' || n.scope === 'code') : NEEDLES.filter((n) => n.scope === 'code')
  }
  return NEEDLES.filter((n) => n.scope === 'code')
}

/**
 * `--self-test` 用の見本（D63 の検出が効いていることの機械的な証明）。
 * `expect: true` は検出されるべき起動、`false` は正常なコード（誤検出してはいけない）。
 */
const SELF_TEST_CASES = [
  { label: 'external CLI subprocess (spawn)', text: "spawn('gemini', ['-p', prompt])", expect: true },
  { label: 'external CLI subprocess (execFile)', text: 'execFile("gemini", args)', expect: true },
  { label: 'external CLI -p argument string', text: 'const cmd = `gemini -p ${prompt}`', expect: true },
  { label: 'agy CLI subprocess (spawn)', text: "spawn('agy', ['-p', prompt])", expect: true },
  { label: 'agy -p argument string', text: 'execSync(`agy -p ${prompt}`)', expect: true },
  { label: 'model id is not a launch', text: "const model = 'gemini-flash'", expect: false },
  { label: 'config dir is not a launch', text: "path.join(home, '.gemini', 'config', 'plugins')", expect: false },
]

if (process.argv.includes('--self-test')) {
  const patterns = NEEDLES.filter((n) => n.scope === 'runtime' || n.scope === 'code')
  const matches = (sample) => patterns.some((n) => (n.needle ? sample.includes(n.needle) : n.re.test(sample)))
  const failures = []
  for (const c of SELF_TEST_CASES) {
    const hit = matches(c.text)
    if (hit !== c.expect) {
      failures.push(`${c.label}: expected ${c.expect ? 'detected' : 'clean'}, got ${hit ? 'detected' : 'clean'}`)
    }
  }
  // `gemini` CLI と `agy` の**両方**が「起動」として検出されること（片方だけでは受入条件を満たさない）
  for (const name of ['gemini', 'agy']) {
    if (!matches(`spawn('${name}', ['-p', 'x'])`)) failures.push(`required pattern for ${name} did not detect its launch sample`)
  }
  if (failures.length) {
    console.error(`check-oauth-boundary: self-test FAILED (${failures.length})`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log(
    `check-oauth-boundary: self-test OK — ${SELF_TEST_CASES.length} cases; gemini and agy launches are both detected`,
  )
  process.exit(0)
}

const hits = []
const seen = new Set()
let scanned = 0

/** 1 ファイルを走査する。 */
function scanFile(file, scope) {
  if (file === SELF) return
  const rel = path.relative(ROOT, file)
  const needles = needlesFor(rel, scope)
  if (!needles.length) return
  scanned += 1
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = text.split('\n')
  for (const { label, needle, re } of needles) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const found = needle ? line.includes(needle) : re.test(line)
      if (!found) continue
      const key = `${rel}:${i + 1}:${label}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ file: rel, line: i + 1, label, text: line.trim().slice(0, 160) })
    }
  }
}

for (const rel of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, rel))) scanFile(file, 'runtime')
}
if (fs.existsSync(DEMO_FILE)) scanFile(DEMO_FILE, 'demo')

if (hits.length) {
  console.error(`check-oauth-boundary: ${hits.length} forbidden access point(s) in ${scanned} files`)
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}: [${hit.label}] ${hit.text}`)
  console.error('check-oauth-boundary: Antigravity OAuth credentials are never touched; only the Hermes Native runner is supported.')
  process.exit(1)
}

console.log(`check-oauth-boundary: OK — 0 forbidden access points in ${scanned} files (Hermes Native runner only)`)
