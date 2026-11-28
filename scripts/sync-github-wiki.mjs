#!/usr/bin/env node
/**
 * Sync local `docs/wiki/<lang>/` markdown pages into a checked-out GitHub Wiki
 * repository (`*.wiki.git`) with valid `raw.githubusercontent.com` image URLs
 * and GitHub Wiki page links.
 *
 * Usage:
 *   node scripts/sync-github-wiki.mjs --out <dir> [--lang ja] [--repo owner/name] [--branch main]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIKI_PAGES } from './check-wiki.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEFAULT_REPO = 'hajimemanila/hermes-pilot'
const DEFAULT_BRANCH = 'main'

/**
 * Rewrite repo-relative Wiki markdown image/link references for GitHub Wiki hosting.
 * @param {string} markdown
 * @param {{ repo?: string, branch?: string, lang?: string, pages?: ReadonlyArray<string> }} [opts]
 * @returns {string}
 */
export function transformWikiPage(
  markdown,
  { repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, lang = 'ja', pages = WIKI_PAGES } = {},
) {
  const wikiPageSet = new Set(pages.map((p) => String(p)))
  const rawAssetsBase = `https://raw.githubusercontent.com/${repo}/${branch}/docs/wiki/assets/${lang}`
  const repoBlobBase = `https://github.com/${repo}/blob/${branch}`

  // 1. Rewrite `../assets/<lang>/<file>` image/link references to raw GitHub URLs
  let out = String(markdown ?? '').replace(
    /\.\.\/assets\/([a-z]{2})\/([^)\s>"']+)/g,
    (_m, assetLang, file) => `https://raw.githubusercontent.com/${repo}/${branch}/docs/wiki/assets/${assetLang}/${file}`,
  )

  // 2. Rewrite markdown links (`[text](href)` without leading `!`)
  out = out.replace(
    /(?<!!)\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(\s+"[^"]*")?\s*\)/g,
    (full, label, href, title = '') => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
        return full
      }
      const hashIdx = href.indexOf('#')
      const cleanPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href
      const fragment = hashIdx >= 0 ? href.slice(hashIdx) : ''
      if (wikiPageSet.has(cleanPath)) {
        const pageSlug = cleanPath.replace(/\.md$/, '')
        return `[${label}](${pageSlug}${fragment}${title})`
      }
      if (cleanPath.startsWith('../')) {
        const abs = path.posix.resolve(`/docs/wiki/${lang}`, cleanPath)
        const relFromRoot = abs.replace(/^\/+/, '')
        return `[${label}](${repoBlobBase}/${relFromRoot}${fragment}${title})`
      }
      return `[${label}](${rawAssetsBase}/${cleanPath}${fragment}${title})`
    },
  )

  return out
}

export function syncWikiDirectory({
  outDir,
  root = ROOT,
  lang = 'ja',
  repo = DEFAULT_REPO,
  branch = DEFAULT_BRANCH,
} = {}) {
  if (!outDir) throw new Error('outDir is required')
  const srcDir = path.join(root, 'docs', 'wiki', lang)
  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  for (const page of WIKI_PAGES) {
    const src = path.join(srcDir, page)
    if (!fs.existsSync(src)) throw new Error(`missing source wiki page: ${src}`)
    const raw = fs.readFileSync(src, 'utf8')
    const transformed = transformWikiPage(raw, { repo, branch, lang, pages: WIKI_PAGES })
    const dest = path.join(outDir, page)
    fs.writeFileSync(dest, transformed)
    written.push(page)
  }
  return { outDir, lang, written }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  let outDir = ''
  let lang = 'ja'
  let repo = DEFAULT_REPO
  let branch = DEFAULT_BRANCH
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { outDir = argv[++i] }
    else if (argv[i] === '--lang' && argv[i + 1]) { lang = argv[++i] }
    else if (argv[i] === '--repo' && argv[i + 1]) { repo = argv[++i] }
    else if (argv[i] === '--branch' && argv[i + 1]) { branch = argv[++i] }
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`)
  }
  if (!outDir) {
    console.error('usage: node scripts/sync-github-wiki.mjs --out <dir> [--lang ja] [--repo owner/name] [--branch main]')
    process.exit(2)
  }
  const res = syncWikiDirectory({ outDir: path.resolve(outDir), lang, repo, branch })
  console.log(`sync-github-wiki: wrote ${res.written.length} page(s) to ${res.outDir} (lang=${res.lang})`)
}
