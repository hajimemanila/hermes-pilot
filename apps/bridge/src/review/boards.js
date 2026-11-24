/**
 * Review パイプラインのマルチボード走査・解決ヘルパ。
 *
 * `mobile` ボードが存在しない新規環境（任意ボード運用）でも Review / Annotation /
 * Architect 連携がそのまま動作するよう、`<kanbanRoot>/boards/*\/kanban.db` を横断して
 * 読み取り・タスク所在の特定・起票先ボード解決を行う。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { safeList } from '../lib/safe.js'

/** `~` / `~/` をホームディレクトリへ展開する。 */
export function expandHome(p, home = os.homedir()) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return home
  if (s.startsWith('~/')) return path.join(home, s.slice(2))
  return s
}

/** 比較用にパスを正規化する（絶対化・小文字化・末尾スラッシュ除去）。 */
export function normPath(p, home = os.homedir()) {
  const raw = expandHome(p, home)
  if (!raw) return ''
  const abs = path.resolve(raw).toLowerCase()
  return abs.length > 1 ? abs.replace(/[/\\]+$/, '') : abs
}

/** `board.json` から workdir と archived を読む（壊れていても空既定）。 */
export function readBoardMeta(boardDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8'))
    const rawWd = meta?.default_workdir ? expandHome(meta.default_workdir) : ''
    return {
      workdir: rawWd ? path.resolve(rawWd) : null,
      archived: Boolean(meta?.archived),
    }
  } catch {
    return { workdir: null, archived: false }
  }
}

/**
 * 走査対象のカンバン DB 一覧を優先順で返す。
 * `onlyBoard` 指定時はそのボードだけ、未指定時は全ボード（`preferredBoard` → 非アーカイブ → アーカイブ順）。
 *
 * @param {string} kanbanRoot カンバンルート
 * @param {string} [preferredBoard] 優先ボード名
 * @param {string|null} [onlyBoard] 明示的に 1 ボードへ絞る場合
 * @returns {Array<{board: string, dir: string, dbPath: string, workdir: string|null, archived: boolean}>}
 */
export function listBoardDbs(kanbanRoot, preferredBoard = 'mobile', onlyBoard = null) {
  const root = String(kanbanRoot ?? '')
  if (!root) return []
  const boardsDir = path.join(root, 'boards')
  const entries = []
  if (onlyBoard) {
    const dir = path.join(boardsDir, onlyBoard)
    const dbPath = path.join(dir, 'kanban.db')
    if (fs.existsSync(dbPath)) {
      const meta = readBoardMeta(dir)
      entries.push({ board: onlyBoard, dir, dbPath, ...meta })
      return entries
    }
  } else {
    const names = safeList('review.boards.list', () =>
      fs.existsSync(boardsDir)
        ? fs.readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [],
    )
    for (const slug of names) {
      const dir = path.join(boardsDir, slug)
      const dbPath = path.join(dir, 'kanban.db')
      if (!fs.existsSync(dbPath)) continue
      const meta = readBoardMeta(dir)
      entries.push({ board: slug, dir, dbPath, ...meta })
    }
  }
  if (!entries.length) {
    const fallbackDb = path.join(root, 'kanban.db')
    if (fs.existsSync(fallbackDb)) {
      entries.push({ board: onlyBoard || preferredBoard, dir: root, dbPath: fallbackDb, workdir: null, archived: false })
    }
  }
  entries.sort(
    (a, b) =>
      Number(b.board === preferredBoard) - Number(a.board === preferredBoard) ||
      Number(a.archived) - Number(b.archived) ||
      a.board.localeCompare(b.board),
  )
  return entries
}

/** 読み取り専用で SQLite を開く（失敗時は null）。 */
function openReadOnly(dbPath, label) {
  return safeList(label, () => new DatabaseSync(dbPath, { readOnly: true }), null)
}

const STATUS_RANK = { review: 0, ready: 1, running: 2, blocked: 3 }

/**
 * 全（または指定）ボードからレビュー対象タスク行を集めて並び替えて返す。
 */
export function queryReviewRows(kanbanRoot, preferredBoard = 'mobile', onlyBoard = null, limit = 80) {
  const collected = []
  const seen = new Set()
  for (const entry of listBoardDbs(kanbanRoot, preferredBoard, onlyBoard)) {
    const db = openReadOnly(entry.dbPath, 'review.rows.openDb')
    if (!db) continue
    try {
      const part = safeList('review.rows.query', () =>
        db
          .prepare(
            `SELECT id, title, body, status, assignee, priority,
                    created_at, started_at, completed_at, result, last_heartbeat_at
               FROM tasks
              WHERE status IN ('review','ready','running','blocked','done')
              ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'ready' THEN 1 WHEN 'running' THEN 2
                                   WHEN 'blocked' THEN 3 ELSE 4 END,
                       COALESCE(completed_at, started_at, created_at) DESC
              LIMIT ?`,
          )
          .all(limit),
      )
      for (const r of part) {
        if (!r?.id || seen.has(r.id)) continue
        seen.add(r.id)
        collected.push({ ...r, _board: entry.board, _workdir: entry.workdir })
      }
    } finally {
      db.close()
    }
  }
  collected.sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 4
    const rb = STATUS_RANK[b.status] ?? 4
    if (ra !== rb) return ra - rb
    const ta = Number(a.completed_at ?? a.started_at ?? a.created_at ?? 0)
    const tb = Number(b.completed_at ?? b.started_at ?? b.created_at ?? 0)
    return tb - ta
  })
  return collected.slice(0, limit)
}

/** 複数ボードにまたがるタスクの最新イベントを集約する。 */
export function queryLastEvents(kanbanRoot, preferredBoard = 'mobile', onlyBoard = null, ids = []) {
  if (!ids.length) return {}
  const out = {}
  const pending = new Set(ids)
  for (const entry of listBoardDbs(kanbanRoot, preferredBoard, onlyBoard)) {
    if (!pending.size) break
    const db = openReadOnly(entry.dbPath, 'review.lastEvents.openDb')
    if (!db) continue
    try {
      const list = [...pending]
      const placeholders = list.map(() => '?').join(',')
      const rs = safeList('review.lastEvents.query', () =>
        db
          .prepare(
            `SELECT task_id, kind, created_at FROM task_events
              WHERE id IN (SELECT MAX(id) FROM task_events WHERE task_id IN (${placeholders}) GROUP BY task_id)`,
          )
          .all(...list),
      )
      for (const r of rs) {
        out[r.task_id] = { kind: r.kind, at: Number(r.created_at ?? 0) * 1000 }
        pending.delete(r.task_id)
      }
    } finally {
      db.close()
    }
  }
  return out
}

/** タスク ID が属するボードと行情報を探す。 */
export function findTaskBoard(kanbanRoot, id, preferredBoard = 'mobile', onlyBoard = null) {
  for (const entry of listBoardDbs(kanbanRoot, preferredBoard, onlyBoard)) {
    const db = openReadOnly(entry.dbPath, 'review.findTask.openDb')
    if (!db) continue
    try {
      const row = db.prepare('SELECT body, status, title, assignee FROM tasks WHERE id = ?').get(id)
      if (row) return { ...entry, row }
    } catch {
      /* read next board */
    } finally {
      db.close()
    }
  }
  return null
}

/** 全（または指定）ボードから比較用（Before）候補の `[review]` 索引を作る。 */
export function querySiblingIndex(kanbanRoot, preferredBoard = 'mobile', onlyBoard = null, parseReviewLine) {
  const byLabel = new Map()
  for (const entry of listBoardDbs(kanbanRoot, preferredBoard, onlyBoard)) {
    const db = openReadOnly(entry.dbPath, 'review.siblings.openDb')
    if (!db) continue
    try {
      const rs = safeList('review.siblings.query', () =>
        db.prepare("SELECT id, body, created_at FROM tasks WHERE body LIKE '%[review]%'").all(),
      )
      for (const r of rs) {
        const ak = parseReviewLine(r.body)
        if (!ak?.image || !ak.label) continue
        const list = byLabel.get(ak.label) || []
        list.push({
          id: r.id,
          image: ak.image,
          round: Number(ak.round ?? 1),
          createdAt: Number(r.created_at ?? 0) * 1000,
        })
        byLabel.set(ak.label, list)
      }
    } finally {
      db.close()
    }
  }
  for (const list of byLabel.values()) list.sort((a, b) => b.createdAt - a.createdAt)
  return byLabel
}

/** タスクを実行しているワーカーの session_id と state.db パスを引く。 */
export function querySessionId(kanbanRoot, preferredBoard = 'mobile', onlyBoard = null, id) {
  for (const entry of listBoardDbs(kanbanRoot, preferredBoard, onlyBoard)) {
    const db = openReadOnly(entry.dbPath, 'review.sessionId.openDb')
    if (!db) continue
    try {
      const r = db.prepare('SELECT session_id, status FROM tasks WHERE id = ?').get(id)
      if (!r) continue
      const fromRow = r.session_id ? String(r.session_id) : null
      const evs = safeList('review.sessionId.events', () =>
        db
          .prepare(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind IN ('owner_admitted','worker_bound','spawned') ORDER BY id DESC LIMIT 6",
          )
          .all(id),
      )
      let sid = fromRow
      let evDb = null
      for (const ev of evs) {
        try {
          const p = JSON.parse(ev.payload || '{}')
          if (!sid && p.session_id) sid = String(p.session_id)
          if (!evDb && p.db) evDb = String(p.db)
          if (sid && evDb) break
        } catch {
          /* ignore invalid payload */
        }
      }
      if (!sid) return null
      return { sessionId: sid, status: r.status ?? null, db: evDb }
    } catch {
      return null
    } finally {
      db.close()
    }
  }
  return null
}

/** media.imageRepos() 用: 全ボードから `[review]` / `[akapen]` の `body` 文字列を集める。 */
export function queryReviewBodies(kanbanRoot, preferredBoard = 'mobile', onlyBoard = null) {
  const out = []
  for (const entry of listBoardDbs(kanbanRoot, preferredBoard, onlyBoard)) {
    const db = openReadOnly(entry.dbPath, 'review.media.openDb')
    if (!db) continue
    try {
      const rs = safeList('review.media.query', () =>
        db.prepare("SELECT body FROM tasks WHERE body LIKE '%[review]%' OR body LIKE '%[akapen]%'").all(),
      )
      out.push(...rs)
    } finally {
      db.close()
    }
  }
  return out
}

/**
 * 新規注釈タスクの起票先ボードを決める（`targetPath` のボード → `preferredBoard` → `current` → 先頭ボード）。
 */
export function resolveCreateBoard({ kanbanRoot, targetPath, preferredBoard = 'mobile', onlyBoard = null }) {
  if (onlyBoard) return onlyBoard
  const entries = listBoardDbs(kanbanRoot, preferredBoard, null)
  const want = normPath(targetPath)
  if (want) {
    let best = null
    for (const e of entries) {
      if (e.archived || !e.workdir) continue
      const wd = normPath(e.workdir)
      if (want === wd || want.startsWith(wd + path.sep) || wd.startsWith(want + path.sep)) {
        if (!best || wd.length > best.len) best = { board: e.board, len: wd.length }
      }
    }
    if (best) return best.board
  }
  const live = entries.filter((e) => !e.archived)
  const pref = live.find((e) => e.board === preferredBoard)
  if (pref) return pref.board
  try {
    const cur = fs.readFileSync(path.join(String(kanbanRoot ?? ''), 'current'), 'utf8').trim()
    if (cur && live.some((e) => e.board === cur)) return cur
  } catch {
    /* ignore missing current */
  }
  return live[0]?.board || entries[0]?.board || preferredBoard
}

/** 注釈スクリーンショットの書き込み先ルート（Git リポジトリ内を汚さず `reviewRoot` へ寄せる）。 */
export function shotWriteRoot({ preferredRoot = null, boardWorkdir = null, reviewRoot }) {
  if (preferredRoot) return path.resolve(expandHome(preferredRoot))
  if (boardWorkdir) {
    const abs = path.resolve(expandHome(boardWorkdir))
    if (!fs.existsSync(path.join(abs, '.git'))) return abs
  }
  return path.resolve(expandHome(reviewRoot))
}
