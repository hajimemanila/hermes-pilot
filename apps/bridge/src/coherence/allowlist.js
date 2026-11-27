import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from '../lib/atomic.js'
import { resolveHermesHome } from '../config.js'

const ALLOWLIST_FILE = 'coherence-allowlist.json'
const EMPTY = Object.freeze({ version: 1, approved: {} })

/**
 * プラグイン管理のチェッカー許可リストのパスを返す（既定は `pluginDataDir/coherence-allowlist.json`）。
 *
 * @param {{allowlistPath?: string|null, pluginDataDir?: string|null}} [opts] 設定
 * @returns {string} 許可リストの絶対パス
 */
export function defaultAllowlistPath(opts = {}) {
  if (opts?.allowlistPath) return path.resolve(String(opts.allowlistPath))
  const dataDir =
    opts?.pluginDataDir ??
    process.env.HP_DATA_DIR ??
    path.join(resolveHermesHome(process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')), 'plugin-data', 'hermes-pilot')
  return path.join(String(dataDir), ALLOWLIST_FILE)
}

/**
 * チェッカーファイルの内容から SHA-256（hex）を返す。読めなければ null。
 *
 * @param {string} absPath ファイルの絶対パス
 * @returns {string|null} SHA-256 hex
 */
export function checkerSha256(absPath) {
  try {
    const buf = fs.readFileSync(absPath)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

/**
 * 許可リストを読む（未作成・破損時は空の許可リスト＝既定 OFF）。
 *
 * @param {string} allowlistPath 許可リストの絶対パス
 * @returns {{version: number, approved: Record<string, {checker: string, sha256: string, approvedAt?: string}>}} 内容
 */
function readAllowlist(allowlistPath) {
  if (!allowlistPath) return { version: 1, approved: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, approved: {} }
    const approved = raw.approved && typeof raw.approved === 'object' && !Array.isArray(raw.approved) ? raw.approved : {}
    return { version: 1, approved }
  } catch {
    return { ...EMPTY, approved: {} }
  }
}

/**
 * 対象リポジトリとチェッカーの `(repoPath, rel, sha256)` が承認済みか判定する（既定 OFF）。
 *
 * @param {{allowlistPath?: string|null, repoRoot: string, rel: string, sha256: string|null}} input 入力
 * @returns {boolean} 承認済みなら true
 */
export function isCheckerApproved({ allowlistPath, repoRoot, rel, sha256 }) {
  if (!allowlistPath || !sha256 || !rel) return false
  const key = path.resolve(String(repoRoot))
  const data = readAllowlist(allowlistPath)
  const entry = data.approved?.[key]
  if (!entry || typeof entry !== 'object') return false
  return entry.checker === String(rel) && entry.sha256 === String(sha256)
}

/**
 * 対象リポジトリのチェッカーを `(repoRoot, checker, sha256)` で許可リストへ保存する。
 *
 * @param {{allowlistPath?: string|null, repoRoot: string, rel: string, absPath: string}} input 入力
 * @returns {{ok: boolean, repoRoot: string, checker: string, sha256: string|null, error?: string}} 結果
 */
export function approveChecker({ allowlistPath, repoRoot, rel, absPath }) {
  const targetPath = defaultAllowlistPath({ allowlistPath })
  const key = path.resolve(String(repoRoot))
  const sha256 = checkerSha256(absPath)
  if (!sha256) return { ok: false, repoRoot: key, checker: String(rel ?? ''), sha256: null, error: 'CHECKER_UNREADABLE' }
  const data = readAllowlist(targetPath)
  const next = {
    version: 1,
    approved: {
      ...data.approved,
      [key]: { checker: String(rel), sha256, approvedAt: new Date().toISOString() },
    },
  }
  writeJsonAtomic(targetPath, next)
  return { ok: true, repoRoot: key, checker: String(rel), sha256 }
}

/**
 * 対象リポジトリのチェッカー承認を取り消す。
 *
 * @param {{allowlistPath?: string|null, repoRoot: string}} input 入力
 * @returns {{ok: boolean, repoRoot: string}} 結果
 */
export function revokeChecker({ allowlistPath, repoRoot }) {
  const targetPath = defaultAllowlistPath({ allowlistPath })
  const key = path.resolve(String(repoRoot))
  const data = readAllowlist(targetPath)
  if (Object.prototype.hasOwnProperty.call(data.approved, key)) {
    const { [key]: _removed, ...rest } = data.approved
    writeJsonAtomic(targetPath, { version: 1, approved: rest })
  }
  return { ok: true, repoRoot: key }
}
