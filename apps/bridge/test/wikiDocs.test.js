/**
 * 日本語版 Wiki（`docs/wiki/ja/`）の整合性を自動テストで固定する（SPEC-WIKI-JA 3.2 / Batch WJA-4）。
 *
 * **要点**: `scripts/check-wiki.mjs` は「6 ページが揃っていること」「全 48 カットが最低 1 回参照されること」
 * 「相対リンクが実在ファイル（画像は有効な PNG）に解決すること」を検査する。このテストは
 * ① 実リポジトリ（本物の 48 枚）に対して検査が緑であること、② 検査器そのものが壊れた Wiki を
 * きちんと落とすこと（合格側だけを固定すると検査器の退行を見逃す）、③ README から Wiki への導線、
 * の 3 点を押さえる。壊れた Wiki の再現は一時ディレクトリだけで行い、実リポジトリを汚さない。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SHOT_SIZES,
  WIKI_PAGES,
  checkWiki,
  extractRefs,
  formatSummary,
  isExternal,
  parseArgs,
  pathPart,
  resolveRef,
} from '../../../scripts/check-wiki.mjs'
import { WIKI_SHOTS, isValidPng } from '../../../scripts/capture-wiki.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-wiki.mjs')
const WIKI_DIR = path.join(REPO_ROOT, 'docs', 'wiki', 'ja')
const ASSETS_DIR = path.join(REPO_ROOT, 'docs', 'wiki', 'assets', 'ja')

/** 期待するカット名（`MN01_..._390.png` 形式）48 件。 */
const SHOT_NAMES = WIKI_SHOTS.flatMap((entry) => SHOT_SIZES.map((size) => `${entry.id}_${entry.slug}_${size}.png`))

/** 一時ディレクトリを作る（テストごとに独立、後始末は OS に任せる）。 */
function tempRoot(prefix = 'hm-wiki-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 親ディレクトリを作って書く。 */
function write(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

/** PNG シグネチャだけ正しい 1 KiB のダミー画像（`isValidPng` はサイズとマジックだけ見る）。 */
function fakePng() {
  const buf = Buffer.alloc(2048)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  return buf
}

const FILLER = 'これは検査器の見出し・最小文字数を満たすための説明文です。'.repeat(12)

/**
 * 完全に正しい Wiki ツリーを一時ディレクトリに組み立てる。
 * 48 カットは Home.md にまとめて参照させ、残り 5 ページは見出しと本文だけ持たせる。
 * @returns {string} リポジトリルート相当のパス
 */
function buildGoodWiki() {
  const root = tempRoot()
  const imageBlock = SHOT_NAMES.map(
    (name, i) => `![${path.basename(name, '.png')}](../assets/ja/${name}) <!-- ${i} -->`,
  ).join('\n')
  write(root, 'docs/wiki/ja/Home.md', `# Home\n\n${FILLER}\n\n${imageBlock}\n`)
  for (const page of WIKI_PAGES) {
    if (page === 'Home.md') continue
    if (page === '_Sidebar.md') {
      const links = WIKI_PAGES.filter((p) => p !== '_Sidebar.md')
        .map((p) => `- [${p.replace(/\.md$/, '')}](${p})`)
        .join('\n')
      write(root, `docs/wiki/ja/${page}`, `${links}\n\n${FILLER}\n`)
      continue
    }
    write(root, `docs/wiki/ja/${page}`, `# ${page.replace(/\.md$/, '')}\n\n${FILLER}\n`)
  }
  for (const name of SHOT_NAMES) write(root, `docs/wiki/assets/ja/${name}`, fakePng())
  return root
}

// --- 1. 実リポジトリ（本物の 48 枚） -------------------------------------------

test('48 カットすべてが docs/wiki/assets/ja に実在する有効な PNG である', () => {
  assert.equal(SHOT_NAMES.length, 48)
  const missing = SHOT_NAMES.filter((name) => !fs.existsSync(path.join(ASSETS_DIR, name)))
  assert.deepEqual(missing, [], `欠けているカット: ${missing.join(', ')}`)
  const invalid = SHOT_NAMES.filter((name) => !isValidPng(path.join(ASSETS_DIR, name)))
  assert.deepEqual(invalid, [], `壊れた PNG: ${invalid.join(', ')}`)
})

test('checkWiki は実リポジトリの ja Wiki を 6 ページ・48/48・リンク切れ 0 と判定する', async () => {
  const report = await checkWiki({ root: REPO_ROOT, lang: 'ja' })
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.missingPages, [])
  assert.deepEqual(report.emptyPages, [])
  assert.deepEqual(report.headinglessPages, [])
  assert.deepEqual(report.brokenLinks, [])
  assert.deepEqual(report.invalidImages, [])
  assert.deepEqual(report.shots.missing, [])
  assert.equal(report.ok, true)
  assert.deepEqual(report.pages.sort(), [...WIKI_PAGES].sort())
  assert.equal(report.shots.total, 48)
  assert.equal(report.shots.referenced, 48)
})

test('CI 用サマリ行が SPEC の契約どおりの書式で出る', async () => {
  const report = await checkWiki({ root: REPO_ROOT, lang: 'ja' })
  const line = formatSummary(report)
  assert.match(line, /^check-wiki: OK, 6 page\(s\), 48\/48 shot\(s\) referenced, 0 broken link\(s\) \(lang=ja\)$/)
})

test('CLI `node scripts/check-wiki.mjs --lang ja` は exit 0 で OK 行を 1 行出す', () => {
  const stdout = execFileSync(process.execPath, [CHECKER, '--lang', 'ja'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  assert.match(stdout, /check-wiki: OK, 6 page\(s\), 48\/48 shot\(s\) referenced, 0 broken link\(s\) \(lang=ja\)/)
})

// --- 2. README からの導線 -----------------------------------------------------

test('README.md と README.ja.md が docs/wiki/ja/Home.md へ案内している', () => {
  const home = path.join(WIKI_DIR, 'Home.md')
  assert.ok(fs.existsSync(home), 'docs/wiki/ja/Home.md が無い')
  for (const readme of ['README.md', 'README.ja.md']) {
    const body = fs.readFileSync(path.join(REPO_ROOT, readme), 'utf8')
    assert.match(body, /\]\(docs\/wiki\/ja\/Home\.md\)/, `${readme} に Wiki への相対リンクが無い`)
    // 相対リンクとしてリポジトリ直下から解決できること（README は root にある）。
    const target = path.resolve(REPO_ROOT, 'docs/wiki/ja/Home.md')
    assert.ok(fs.existsSync(target))
  }
})

// --- 3. 検査器そのものの退行を止める（壊れた Wiki は落ちる） ---------------------

test('正しい一時 Wiki なら checkWiki は緑（合格側の基準点）', async () => {
  const root = buildGoodWiki()
  const report = await checkWiki({ root, lang: 'ja' })
  assert.equal(report.ok, true, formatSummary(report))
  assert.equal(report.shots.referenced, 48)
  assert.deepEqual(report.brokenLinks, [])
})

test('ページが 1 枚欠けたら missingPages で落ちる', async () => {
  const root = buildGoodWiki()
  fs.rmSync(path.join(root, 'docs/wiki/ja/Manual-Chat-Memos-and-Terminal.md'))
  const report = await checkWiki({ root, lang: 'ja' })
  assert.equal(report.ok, false)
  assert.deepEqual(report.missingPages, ['Manual-Chat-Memos-and-Terminal.md'])
  assert.match(formatSummary(report), /^check-wiki: FAIL, 5 page\(s\)/)
})

test('リンク切れは where（ページ:行）付きで報告される', async () => {
  const root = buildGoodWiki()
  const home = path.join(root, 'docs/wiki/ja/Home.md')
  fs.appendFileSync(home, '\n[消えたページ](Manual-Does-Not-Exist.md)\n')
  const report = await checkWiki({ root, lang: 'ja' })
  assert.equal(report.ok, false)
  assert.equal(report.brokenLinks.length, 1)
  assert.match(report.brokenLinks[0].where, /docs\/wiki\/ja\/Home\.md:\d+$/)
  assert.equal(report.brokenLinks[0].href, 'Manual-Does-Not-Exist.md')
  assert.equal(report.brokenLinks[0].reason, 'missing file')
})

test('画像が実在しても PNG でなければ invalidImages で落ちる', async () => {
  const root = buildGoodWiki()
  write(root, 'docs/wiki/assets/ja/MN01_login-pairing_390.png', 'not a png at all')
  const report = await checkWiki({ root, lang: 'ja' })
  assert.equal(report.ok, false)
  assert.equal(report.invalidImages.length, 1)
  assert.match(report.invalidImages[0].href, /MN01_login-pairing_390\.png$/)
})

test('参照されないカットは unreferenced shot として 1 件ずつ挙がる', async () => {
  const root = buildGoodWiki()
  const home = path.join(root, 'docs/wiki/ja/Home.md')
  const body = fs.readFileSync(home, 'utf8')
  fs.writeFileSync(home, body.replace(/^!\[[^\n]*SC09_coherence-refactor-sheet_1180\.png[^\n]*\n/m, ''))
  const report = await checkWiki({ root, lang: 'ja' })
  assert.equal(report.ok, false)
  assert.deepEqual(report.shots.missing, ['SC09_coherence-refactor-sheet_1180.png'])
  assert.equal(report.shots.referenced, 47)
})

test('見出しの無いページ・短すぎるページも落ちる', async () => {
  const root = buildGoodWiki()
  write(root, 'docs/wiki/ja/Manual-Installation-and-Setup.md', 'short body without a heading\n')
  const report = await checkWiki({ root, lang: 'ja' })
  assert.equal(report.ok, false)
  assert.deepEqual(report.emptyPages, ['docs/wiki/ja/Manual-Installation-and-Setup.md'])
  assert.deepEqual(report.headinglessPages, ['docs/wiki/ja/Manual-Installation-and-Setup.md'])
})

test('--partial は未執筆ページと未参照カットを pending として通す（バッチ構築用）', async () => {
  const root = tempRoot()
  write(root, 'docs/wiki/ja/Home.md', `# Home\n\n${FILLER}\n\n![MN01](../assets/ja/MN01_login-pairing_390.png)\n`)
  write(root, 'docs/wiki/assets/ja/MN01_login-pairing_390.png', fakePng())
  const report = await checkWiki({ root, lang: 'ja', partial: true })
  assert.equal(report.ok, true, formatSummary(report))
  assert.equal(report.pages.length, 1)
  assert.equal(report.shots.referenced, 1)
  assert.equal(report.shots.pending.length, 47)
  assert.match(formatSummary(report), /^check-wiki: OK \(partial\), 1\/6 page\(s\), 1\/48 shot\(s\) referenced, 0 broken link\(s\), 47 pending shot\(s\), 5 pending page\(s\) \(lang=ja\)$/)
})

// --- 4. 部品（パーサとパス解決） -----------------------------------------------

test('extractRefs は画像とリンクを区別し、行番号を 1 起点で返す', () => {
  const text = ['# t', '![a](../assets/ja/MN01_login-pairing_390.png)', '[b](Home.md "title")'].join('\n')
  const refs = extractRefs(text)
  assert.deepEqual(
    refs.map((r) => [r.kind, r.href, r.line]),
    [
      ['image', '../assets/ja/MN01_login-pairing_390.png', 2],
      ['link', 'Home.md', 3],
    ],
  )
})

test('外部リンク・アンカーは解決対象から外れ、%20 はデコードされる', () => {
  for (const href of ['https://example.com/a.md', '//cdn.example.com/x.png', 'mailto:a@b.c', '#section']) {
    assert.equal(isExternal(href), true, href)
  }
  assert.equal(isExternal('Home.md'), false)
  assert.equal(pathPart('a%20b.png#frag'), 'a b.png')
  const resolved = resolveRef('/repo/docs/wiki/ja', '../assets/ja/MN01_x_390.png')
  assert.equal(resolved.external, false)
  assert.equal(resolved.abs, '/repo/docs/wiki/assets/ja/MN01_x_390.png')
})

test('parseArgs は未知フラグ・欠けた値・不正な言語コードを usage エラーにする', () => {
  assert.deepEqual(parseArgs(['--lang', 'ja']).lang, 'ja')
  assert.equal(parseArgs([]).lang, 'ja')
  assert.equal(parseArgs(['--partial']).partial, true)
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/)
  assert.throws(() => parseArgs(['--lang']), /needs a value/)
  assert.throws(() => parseArgs(['--lang', 'japanese']), /two letter code/)
})
