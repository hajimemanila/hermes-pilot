/**
 * Source bundling for the repository coherence checker.
 *
 * The bridge router was split into `apps/bridge/src/server/*.js`. Rules that audit the
 * HTTP surface (API parity, write route nudge audit) must see the entry file plus every
 * split module, otherwise the split itself looks like a removed route.
 *
 * All output of this module is ASCII (SPEC-EN-ZERO-LEAK).
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Concatenate the entry file and every `.js` module of a sibling directory.
 *
 * @param {string} root repository root
 * @param {string} entryRel entry file, repository relative
 * @param {string} dirRel module directory, repository relative (may be missing)
 * @param {(abs: string) => string|null} read text reader
 * @returns {string} concatenated source
 */
export function bundleSource(root, entryRel, dirRel, read) {
  const parts = [read(path.join(root, entryRel))].filter(Boolean)
  const dir = path.join(root, dirRel)
  try {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
      const text = read(path.join(dir, name))
      if (text) parts.push(text)
    }
  } catch {
    /* no module directory: the entry file is the whole surface */
  }
  return parts.join('\n')
}

/**
 * Whole HTTP surface of the bridge: `server.js` plus the split `server/` router modules.
 *
 * @param {string} root repository root
 * @param {(abs: string) => string|null} read text reader
 * @returns {string} concatenated source
 */
export function bundleServerSource(root, read) {
  return bundleSource(root, 'apps/bridge/src/server.js', 'apps/bridge/src/server', read)
}
