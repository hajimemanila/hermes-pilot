#!/usr/bin/env node
/**
 * Wiki coherence checker for `docs/wiki/<lang>/` (SPEC-WIKI-JA 3.2 / decision D4).
 *
 * Verifies, for one language directory:
 *   1. the six required pages exist, are non-empty and carry a heading
 *      (`_Sidebar.md` carries navigation links instead of a heading),
 *   2. every `![alt](path)` and `[text](path)` relative reference resolves to a
 *      real file, and every image is a valid PNG (`isValidPng`),
 *   3. all 48 shots of `WIKI_SHOTS` (`MN01`-`MN15` and `SC01`-`SC09`, each in
 *      `390` and `1180`) are referenced at least once across the pages.
 *
 * Usage:
 *   node scripts/check-wiki.mjs [--lang ja|en] [--root <dir>] [--json]
 *   node scripts/check-wiki.mjs --partial      # only the pages that exist yet
 *
 * `--partial` exists because the wiki is built batch by batch (WJA-1 writes
 * Home / _Sidebar / the installation manual, WJA-2 the showcase, WJA-3 the two
 * remaining manuals). In that mode a page that has not been written yet, and a
 * shot that no page references yet, are reported as `pending` instead of a
 * failure; broken links and invalid PNGs still fail. The full contract (six
 * pages, 48/48 shots) is the default and is what CI runs.
 *
 * Exit codes: 0 = OK, 1 = violation, 2 = usage error.
 * All output and all source text of this file are ASCII.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIKI_SHOTS, isValidPng } from './capture-wiki.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..')

/** The seven pages every language directory must provide. */
export const WIKI_PAGES = Object.freeze([
  'Home.md',
  '_Sidebar.md',
  'Showcase-From-Idea-to-Product.md',
  'Showcase-Autopilot-Mode.md',
  'Manual-Installation-and-Setup.md',
  'Manual-A2B-Tasks-and-Review.md',
  'Manual-Chat-Memos-and-Terminal.md',
])

export const SHOT_SIZES = Object.freeze(['390', '1180'])

const IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g
const LINK_RE = /(?<!!)\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g
const MIN_PAGE_CHARS = 200
const MIN_SIDEBAR_LINKS = 4

function usage() {
  return [
    'usage: node scripts/check-wiki.mjs [--lang ja|en] [--root <dir>] [--json] [--partial]',
    '',
    '  --lang <code>   wiki language directory under docs/wiki/ (default: ja)',
    '  --root <dir>    repository root (default: the parent of this script)',
    '  --partial       only check the pages that exist (batch build), pending otherwise',
    '  --json          machine readable report on stdout',
    '  --help          this text',
  ].join('\n')
}

/** Minimal flag parser; unknown flags are a usage error (exit 2). */
export function parseArgs(argv) {
  const args = { lang: 'ja', root: DEFAULT_ROOT, json: false, partial: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--lang' || flag === '--root') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      if (flag === '--lang') args.lang = value
      else args.root = value
      i += 1
    } else if (flag === '--json') args.json = true
    else if (flag === '--partial') args.partial = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`unknown flag: ${flag}`)
  }
  if (!/^[a-z]{2}$/.test(args.lang)) throw new Error(`--lang must be a two letter code (got "${args.lang}")`)
  return args
}

/** `![alt](href)` and `[text](href)` occurrences with their 1-based line. */
export function extractRefs(text) {
  const refs = []
  const collect = (re, kind) => {
    re.lastIndex = 0
    let match = re.exec(text)
    while (match) {
      refs.push({ kind, href: match[2].trim(), line: text.slice(0, match.index).split('\n').length })
      match = re.exec(text)
    }
  }
  collect(IMAGE_RE, 'image')
  collect(LINK_RE, 'link')
  return refs.sort((a, b) => a.line - b.line)
}

/** http(s), protocol relative, mailto:, data:, in-page anchor. */
export function isExternal(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')
}

/** Strip `#fragment` / `?query`; decode percent escapes so `%20` resolves. */
export function pathPart(href) {
  const cut = href.replace(/[#?].*$/, '')
  try {
    return decodeURIComponent(cut)
  } catch {
    return cut
  }
}

/**
 * Resolve one reference against the page that carries it.
 * Returns `{ external, abs, rel, trailingSlash }`.
 */
export function resolveRef(pageDir, href) {
  if (isExternal(href)) return { external: true, abs: null, rel: null, trailingSlash: false }
  const cleaned = pathPart(href)
  const trailingSlash = cleaned.endsWith('/')
  const abs = path.resolve(pageDir, cleaned || '.')
  return { external: false, abs, rel: path.relative(pageDir, abs), trailingSlash }
}

function exists(target, isDirectory) {
  try {
    const stat = fs.statSync(target)
    return isDirectory ? stat.isDirectory() : stat.isFile()
  } catch {
    return false
  }
}

/**
 * Check one language directory.
 * @returns {Promise<object>} report consumed by `main` and by the unit test.
 */
export async function checkWiki({ root = DEFAULT_ROOT, lang = 'ja', partial = false } = {}) {
  const dir = path.join(root, 'docs', 'wiki', lang)
  const report = {
    ok: false,
    lang,
    dir: path.relative(root, dir) || 'docs/wiki',
    partial,
    pages: [],
    missingPages: [],
    emptyPages: [],
    headinglessPages: [],
    brokenLinks: [],
    invalidImages: [],
    pendingPages: [],
    referenceCount: { images: 0, links: 0 },
    shots: { total: WIKI_SHOTS.length * SHOT_SIZES.length, referenced: 0, missing: [], pending: [] },
    errors: [],
  }

  if (!exists(dir, true)) {
    report.errors.push(`wiki directory not found: ${report.dir}`)
    return report
  }

  const shotBasenames = new Set()

  for (const page of WIKI_PAGES) {
    const file = path.join(dir, page)
    if (!exists(file, false)) {
      if (!partial) report.missingPages.push(page)
      continue
    }
    const text = fs.readFileSync(file, 'utf8')
    const rel = `${report.dir}/${page}`
    report.pages.push(page)
    if (text.trim().length < MIN_PAGE_CHARS) report.emptyPages.push(rel)
    const heading = /^#{1,6}\s+\S/m.test(text)
    if (page === '_Sidebar.md') {
      const links = extractRefs(text).filter((ref) => ref.kind === 'link')
      if (links.length < MIN_SIDEBAR_LINKS) report.headinglessPages.push(`${rel} (<${MIN_SIDEBAR_LINKS} links)`)
    } else if (!heading) {
      report.headinglessPages.push(rel)
    }

    for (const ref of extractRefs(text)) {
      if (ref.kind === 'image') report.referenceCount.images += 1
      else report.referenceCount.links += 1
      const target = resolveRef(dir, ref.href)
      if (target.external) continue
      const where = `${rel}:${ref.line}`
      if (target.trailingSlash) {
        if (!exists(target.abs, true)) report.brokenLinks.push({ where, href: ref.href, reason: 'missing directory' })
        continue
      }
      if (!exists(target.abs, false)) {
        const base = path.basename(target.abs)
        if (partial && WIKI_PAGES.includes(base) && path.dirname(target.abs) === dir) continue
        report.brokenLinks.push({ where, href: ref.href, reason: 'missing file' })
        continue
      }
      if (ref.kind === 'image') {
        if (!isValidPng(target.abs)) report.invalidImages.push({ where, href: ref.href })
        shotBasenames.add(path.basename(target.abs))
      }
    }
  }

  for (const entry of WIKI_SHOTS) {
    for (const size of SHOT_SIZES) {
      const name = `${entry.id}_${entry.slug}_${size}.png`
      if (shotBasenames.has(name)) report.shots.referenced += 1
      else if (partial) report.shots.pending.push(name)
      else report.shots.missing.push(name)
    }
  }

  if (partial) report.pendingPages = WIKI_PAGES.filter((page) => !report.pages.includes(page))

  report.ok =
    report.errors.length === 0 &&
    report.missingPages.length === 0 &&
    report.emptyPages.length === 0 &&
    report.headinglessPages.length === 0 &&
    report.brokenLinks.length === 0 &&
    report.invalidImages.length === 0 &&
    report.shots.missing.length === 0
  return report
}

/** The one-line contract consumed by CI (`check-wiki: OK, 6 page(s), ...`). */
export function formatSummary(report) {
  const pages = report.partial
    ? `${report.pages.length}/${WIKI_PAGES.length} page(s)`
    : `${report.pages.length} page(s)`
  const shots = `${report.shots.referenced}/${report.shots.total} shot(s) referenced`
  const head = report.ok ? `check-wiki: OK${report.partial ? ' (partial)' : ''}` : 'check-wiki: FAIL'
  const parts = [head, pages, shots, `${report.brokenLinks.length + report.invalidImages.length} broken link(s)`]
  if (report.partial) {
    if (report.shots.pending.length) parts.push(`${report.shots.pending.length} pending shot(s)`)
    if (report.pendingPages.length) parts.push(`${report.pendingPages.length} pending page(s)`)
  }
  return `${parts.join(', ')} (lang=${report.lang})`
}

function printFailures(report) {
  for (const error of report.errors) console.error(`  error: ${error}`)
  for (const page of report.missingPages) console.error(`  missing page: ${report.dir}/${page}`)
  for (const page of report.emptyPages) console.error(`  empty page: ${page}`)
  for (const page of report.headinglessPages) console.error(`  no heading: ${page}`)
  for (const link of report.brokenLinks) console.error(`  broken link: ${link.where} -> ${link.href} (${link.reason})`)
  for (const image of report.invalidImages) console.error(`  invalid png: ${image.where} -> ${image.href}`)
  for (const shot of report.shots.missing) console.error(`  unreferenced shot: ${shot}`)
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`check-wiki: ${error.message}`)
    console.error(usage())
    process.exit(2)
  }
  if (args.help) {
    console.log(usage())
    return
  }
  const report = await checkWiki(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    if (!report.ok) printFailures(report)
    console.log(formatSummary(report))
  }
  process.exit(report.ok ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    console.error(`check-wiki: ${error?.message ?? error}`)
    process.exit(1)
  })
}
