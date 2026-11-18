import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ApiError } from './api-errors.js'

/**
 * メモ・ひらめき・定期レポート受信箱ストア（`memos.json`）。
 *
 * Google Keep 風にメモ、チェックリスト、チャット切り抜き、定期レポートの保存先を
 * 1 ファイルへ永続化する（最大 500 件）。
 */

const MAX_MEMOS = 500
const MAX_TITLE = 160
const MAX_BODY = 10_000
const MAX_TAGS = 12
const MAX_CHECKLIST = 50
const COLORS = new Set(['default', 'teal', 'amber', 'violet'])
const KINDS = new Set(['note', 'report', 'clip'])

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const clean = String(item ?? '')
      .trim()
      .replace(/^#+/, '')
      .slice(0, 32)
    if (!clean || seen.has(clean.toLowerCase())) continue
    seen.add(clean.toLowerCase())
    out.push(clean)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function normalizeChecklist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim().slice(0, 300)
    if (!text) continue
    const id = String(item.id ?? '').trim() || `c_${crypto.randomBytes(4).toString('hex')}`
    out.push({ id, text, done: Boolean(item.done) })
    if (out.length >= MAX_CHECKLIST) break
  }
  return out
}

function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const k of ['chatId', 'chatTitle', 'board', 'repo', 'mid', 'reportKey']) {
    const v = raw[k]
    if (v != null && String(v).trim()) out[k] = String(v).trim().slice(0, 200)
  }
  return Object.keys(out).length ? out : null
}

function sortMemos(list) {
  return [...list].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))
  })
}

export function createMemosStore(dataDir) {
  const file = path.join(dataDir, 'memos.json')

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(raw?.memos) ? raw.memos : []
    } catch {
      return []
    }
  }

  function writeAll(memos) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ memos: memos.slice(0, MAX_MEMOS) }, null, 2))
    fs.renameSync(tmp, file)
  }

  function list() {
    return sortMemos(readAll())
  }

  function create(input = {}) {
    const title = String(input.title ?? '').trim().slice(0, MAX_TITLE)
    const body = String(input.body ?? '').trim().slice(0, MAX_BODY)
    const checklist = normalizeChecklist(input.checklist)
    if (!title && !body && !checklist.length) {
      throw new ApiError('MEMO_EMPTY', {}, 400)
    }
    const now = new Date().toISOString()
    const memo = {
      id: `m_${crypto.randomBytes(5).toString('hex')}`,
      title,
      body,
      tags: normalizeTags(input.tags),
      pinned: Boolean(input.pinned),
      color: COLORS.has(input.color) ? input.color : 'default',
      kind: KINDS.has(input.kind) ? input.kind : 'note',
      checklist,
      source: normalizeSource(input.source),
      createdAt: now,
      updatedAt: now,
    }
    const next = sortMemos([memo, ...readAll()]).slice(0, MAX_MEMOS)
    writeAll(next)
    return memo
  }

  function update(id, patch = {}) {
    const targetId = String(id ?? '').trim()
    const all = readAll()
    const idx = all.findIndex((m) => m.id === targetId)
    if (idx === -1) throw new ApiError('MEMO_NOT_FOUND', {}, 404)
    const cur = all[idx]
    const updated = {
      ...cur,
      ...(patch.title !== undefined ? { title: String(patch.title ?? '').trim().slice(0, MAX_TITLE) } : {}),
      ...(patch.body !== undefined ? { body: String(patch.body ?? '').trim().slice(0, MAX_BODY) } : {}),
      ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
      ...(patch.pinned !== undefined ? { pinned: Boolean(patch.pinned) } : {}),
      ...(patch.color !== undefined && COLORS.has(patch.color) ? { color: patch.color } : {}),
      ...(patch.kind !== undefined && KINDS.has(patch.kind) ? { kind: patch.kind } : {}),
      ...(patch.checklist !== undefined ? { checklist: normalizeChecklist(patch.checklist) } : {}),
      updatedAt: new Date().toISOString(),
    }
    all[idx] = updated
    writeAll(sortMemos(all))
    return updated
  }

  function remove(id) {
    const targetId = String(id ?? '').trim()
    const all = readAll()
    const next = all.filter((m) => m.id !== targetId)
    if (next.length === all.length) throw new ApiError('MEMO_NOT_FOUND', {}, 404)
    writeAll(next)
    return { ok: true, id: targetId }
  }

  return { list, create, update, remove }
}
