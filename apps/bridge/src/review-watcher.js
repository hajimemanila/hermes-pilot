import fs from 'node:fs'
import path from 'node:path'
import { parseReviewLine } from './review.js'
import { writeJsonAtomic } from './lib/atomic.js'

/**
 * ブリッジ内蔵のレビュー完了ウォッチャー（D7 / SPEC §4.3 / D110）。
 *
 * 旧名の外部 cron ウォッチャーを置き換える。`kanban.db` の走査は **しない** —
 * 盤面は `board-tick.js` が 10 秒ごとに 1 回だけ読み、スナップショット（行＋差分）を
 * 購読者へ配る。ここはその 1 本を受け取り、`[review]` タスクの `done` 遷移と
 * `running → blocked` 遷移を `review/feed.jsonl` と `review/chat-reports.jsonl` に
 * 1 行ずつ追記する。
 *
 * 大事な性質:
 *  - **遷移の根拠は `snapshot.changes`**（pipeline も同じ差分を見る）
 *  - **初回起動はベースライン確立のみ**（既存の done / blocked を通知しない。通知スパム防止）
 *  - **冪等**: 状態は `watcher-state.json` に持ち、`reportedDoneAt` / `reportedBlockedAt` が
 *    入っている遷移は二度書かない。`done` から離れたら印を消し、再度 done になったら 1 回だけ書く
 *  - **アトミック**: 状態ファイルは `lib/atomic.js`（tmp → rename）。JSONL は 1 行完結 append
 *
 * @param {object} cfg ブリッジ設定（kanbanRoot / pluginDataDir）
 * @param {{
 *   review?: object,
 *   snapshot?: () => object|null,
 *   boardTick?: { subscribe: Function, latest: Function },
 *   now?: () => number,
 *   logger?: object,
 * }} [opts]
 */

/** 1 行の末尾改行を保証して追記する（JSONL が途中で連結しないように）。 */
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let prefix = ''
  try {
    const st = fs.statSync(file)
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(1)
      fs.readSync(fd, buf, 0, 1, st.size - 1)
      fs.closeSync(fd)
      if (buf.toString() !== '\n') prefix = '\n'
    }
  } catch {
    /* 無ければそのまま作る */
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(obj)}\n`)
}

/** 結果の 1 行要約（長すぎる result は切る）。 */
function oneLine(text, max = 180) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function createReviewWatcher(cfg, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const log = opts.logger ?? console
  const root = cfg.reviewDir ?? path.join(cfg.pluginDataDir ?? path.join(cfg.kanbanRoot, '..', 'plugin-data', 'hermes-pilot'), 'review')
  const statePath = path.join(root, 'watcher-state.json')
  const feedPath = path.join(root, 'feed.jsonl')
  const reportsPath = path.join(root, 'chat-reports.jsonl')

  /**
   * スナップショットの取得元。
   *
   * 実運用は `boardTick.latest()`（`subscribe` で新しいものを渡される）、テストは
   * `opts.snapshot()`。どちらも無ければ走査できない＝何も書かない。
   */
  const takeSnapshot =
    typeof opts.snapshot === 'function'
      ? opts.snapshot
      : opts.boardTick && typeof opts.boardTick.latest === 'function'
        ? () => opts.boardTick.latest()
        : null

  let detach = null
  let running = false
  let ticks = 0
  let lastError = null

  /** 状態を読む（無ければ null = 初回起動）。壊れていても null 扱い（ベースラインからやり直す）。 */
  function readState() {
    try {
      const j = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (!j || typeof j !== 'object' || typeof j.tasks !== 'object' || Array.isArray(j.tasks)) return null
      return j
    } catch {
      return null
    }
  }

  /** 状態を書く（`lib/atomic.js` が tmp → rename を持つ）。 */
  function writeState(state) {
    writeJsonAtomic(statePath, state)
  }

  /** 宛先の会話 ID（本文の `chat=` → `task-chats.json`）。 */
  function sessionFor(task, review) {
    const line = parseReviewLine(task.body)
    const fromBody = String(line?.chat ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
    if (fromBody) return fromBody
    if (review && typeof review.chatFor === 'function') {
      const c = review.chatFor(task.id)
      if (c) return c
    }
    return null
  }

  /**
   * 1 ティック分の処理。テストから直接呼べる。
   *
   * @param {object|null} [snapshot] 盤面スナップショット（省略時は取得元から）
   * @returns {{baseline: boolean, seen: number, reported: Array<object>, skipped?: string}}
   */
  function tick(snapshot) {
    ticks += 1
    const snap = snapshot ?? (takeSnapshot ? takeSnapshot() : null)
    const stored = readState()
    const baseline = stored === null
    const state = stored ?? { version: 1, tasks: {}, updatedAt: new Date(now()).toISOString() }
    const reported = []
    if (!snap) {
      // 走査が来ていないティックでは何もしない（状態も書かない）
      return { baseline, seen: 0, reported, skipped: 'no-snapshot' }
    }

    const rows = Array.isArray(snap.rows) ? snap.rows : []
    const at = new Date(now()).toISOString()
    const live = new Set()
    const rowById = new Map()
    const statusBefore = new Map()
    let seen = 0
    let dirty = baseline

    // 1) 現在の状態を写す（通知はしない）。ベースラインではこれだけ。
    for (const row of rows) {
      const line = parseReviewLine(row.body)
      if (!line) continue // `[review]` 行が無い（本文の言及だけ）ものはレビューではない
      const id = String(row.id)
      seen += 1
      live.add(id)
      rowById.set(id, row)
      const status = String(row.status ?? '')
      const prev = state.tasks[id]
      if (!prev) {
        // 初回 or 新しいタスク。どちらも「今の状態」を覚えるだけで通知しない（遡って通知しない）
        state.tasks[id] = {
          board: row.board ?? null,
          status,
          updatedAt: at,
          reportedDoneAt: null,
          reportedBlockedAt: null,
        }
        dirty = true
        continue
      }
      statusBefore.set(id, String(prev.status ?? ''))
      if (prev.status !== status) {
        prev.status = status
        prev.updatedAt = at
        dirty = true
      }
      if (prev.board !== (row.board ?? null)) {
        prev.board = row.board ?? null
        dirty = true
      }
    }

    // 2) 通知は盤面ティックの差分（pipeline と同じ根拠）で決める。
    for (const change of Array.isArray(snap.changes) ? snap.changes : []) {
      const id = String(change.id ?? '')
      const row = rowById.get(id)
      if (!row) continue // レビュータスクではない
      const entry = state.tasks[id]
      if (!entry) continue // このティックで初めて見たタスク（ベースライン扱い）
      const line = parseReviewLine(row.body)
      if (!line) continue
      const to = String(change.to ?? '')
      // 起動直後（盤面ティックの前回が無い）は差分が `new` になる。そのときは
      // 自分の状態ファイルの値からの遷移として読む（ブリッジ停止中の遷移を取りこぼさない）。
      const from = change.kind === 'new' ? String(statusBefore.get(id) ?? '') : String(change.from ?? '')
      if (!baseline && from === to) continue
      const label = line.label ?? null

      if (!baseline && to === 'done' && !entry.reportedDoneAt) {
        const text = `✅ ${oneLine(row.title)} (${id})`
        appendJsonl(feedPath, { at, task_id: id, kind: 'done', label, text })
        const sessionId = sessionFor(row, opts.review)
        if (sessionId) {
          const summary = oneLine(row.result) || oneLine(row.title)
          appendJsonl(reportsPath, { at, session_id: sessionId, task_id: id, label, text: summary })
        }
        entry.reportedDoneAt = at
        reported.push({ kind: 'done', taskId: id, label, sessionId })
      } else if (!baseline && to === 'blocked' && from === 'running' && !entry.reportedBlockedAt) {
        const text = `⏸ ${oneLine(row.title)} (${id})`
        appendJsonl(feedPath, { at, task_id: id, kind: 'blocked', label, text })
        entry.reportedBlockedAt = at
        reported.push({ kind: 'blocked', taskId: id, label })
      }

      // done から離れたら印を消す（再度 done になったら 1 回だけ通知する）
      if (to !== 'done') entry.reportedDoneAt = null
      if (to !== 'blocked') entry.reportedBlockedAt = null
      dirty = true
    }

    // 消えたタスクは状態から落とす（ボードを消した・アーカイブした等）。印だけ残すと育つため。
    for (const id of Object.keys(state.tasks)) {
      if (!live.has(id)) {
        delete state.tasks[id]
        dirty = true
      }
    }

    if (dirty) {
      state.updatedAt = new Date(now()).toISOString()
      writeState(state)
    }
    return { baseline, seen, reported }
  }

  /** 例外でプロセスを落とさないティック（購読用・テストからも呼べる）。 */
  function safeTick(snapshot) {
    if (running) return null
    running = true
    try {
      const r = tick(snapshot)
      lastError = null
      return r
    } catch (err) {
      lastError = String(err?.message ?? err)
      log.warn?.(`[review-watcher] ${lastError}`)
      return null
    } finally {
      running = false
    }
  }

  /**
   * 盤面ティックへ購読する（自前のタイマーは持たない・D110）。
   *
   * `opts.boardTick` があれば構築時に購読する。`start()` は互換のための入口で、
   * 購読が無いときだけ購読する（二重購読しない）。
   */
  function attach() {
    if (detach) return
    const bt = opts.boardTick
    if (!bt || typeof bt.subscribe !== 'function') return
    detach = bt.subscribe((snapshot) => safeTick(snapshot))
  }

  function start() {
    attach()
    // 購読先が無いテスト環境でも、スナップショット取得元があれば 1 回走らせる
    if (!detach && takeSnapshot) safeTick()
  }

  function stop() {
    if (!detach) return
    detach()
    detach = null
  }

  // 構築時に購読する（`server.js` は `boardTick.start()` を 1 回呼ぶだけ）
  attach()

  return {
    statePath,
    feedPath,
    reportsPath,
    tick,
    start,
    stop,
    status: () => ({ running: Boolean(detach), ticks, lastError, statePath }),
  }
}
