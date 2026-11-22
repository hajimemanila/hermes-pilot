/**
 * 定期同期の正本（SPEC-EXECUTION-MODE-INTEGRITY D97 / `lib/syncScheduler.js`）。
 *
 * 以前は `App.jsx` に 7 本の `setInterval` が並び、「何秒で・どのタブで止めるか」が
 * 呼び出し側ごとに書かれていた（`:640` `:679` は review、`:708` は tasks、`:745` は無条件）。
 * ここでは**宣言表 1 つ**に間隔と停止規則を書き、実行は 1 本のスケジューラが持つ。
 * 追加時は表に 1 行足すだけで、停止規則の書き忘れが起きない。
 *
 * - `tick` は「見えている」かつ「表示中タブが `pauseOnTabs` に無い」ときだけ `fn()` を呼ぶ。
 *   **間隔そのものは止めない**（位相がずれて、復帰直後に全トピックが同時に走るのを避ける）。
 * - `forceAll()` は可視・タブ・スロットルのどれも無視して全トピックを 1 回走らせる
 *   （復帰・回線回復・手動再試行の合図）。
 */

/**
 * 同期トピックの宣言表。`id` は購読キー、`everyMs` は間隔、`pauseOnTabs` は
 * 「このタブを見ている間は叩かない」タブ id。
 *
 * @type {ReadonlyArray<{ id: string, everyMs: number, pauseOnTabs: string[] }>}
 */
export const SYNC_TOPICS = [
  { id: 'overview', everyMs: 5_000, pauseOnTabs: [] }, // 接続状態・稼働数の供給元
  { id: 'reports', everyMs: 15_000, pauseOnTabs: [] }, // 完了報告（HM_EVENTS.REFRESH_REPORTS で即時）
  { id: 'reviewWaiting', everyMs: 15_000, pauseOnTabs: ['review'] },
  { id: 'reviewFeed', everyMs: 15_000, pauseOnTabs: ['review'] },
  { id: 'inbox', everyMs: 15_000, pauseOnTabs: ['tasks'] },
  { id: 'live', everyMs: 15_000, pauseOnTabs: ['tasks'] }, // タスクタブでは TasksPane の 10 秒が全量を運ぶ
  { id: 'usage', everyMs: 60_000, pauseOnTabs: [] },
]

/**
 * このトピックを「いま叩いてよいか」。`tick` とテストが同じ規則を見る。
 *
 * @param {{ pauseOnTabs?: string[] } | null | undefined} topic
 * @param {{ tab?: string | null, visible?: boolean }} state
 * @returns {boolean}
 */
export function shouldRun(topic, { tab = null, visible = true } = {}) {
  if (!topic) return false
  if (!visible) return false
  const paused = Array.isArray(topic.pauseOnTabs) ? topic.pauseOnTabs : []
  return !paused.includes(tab)
}

/**
 * 1 本のスケジューラを作る。タイマーと時計は差し替え可能（テスト用）。
 *
 * @param {object} [options]
 * @param {ReadonlyArray<{ id: string, everyMs: number, pauseOnTabs?: string[] }>} [options.topics]
 * @param {() => boolean} [options.isVisible] 画面が見えているか（`document.visibilityState === 'visible'`）
 * @param {() => string | null} [options.currentTab] 表示中のタブ id
 * @param {() => number} [options.now] 時計（未使用の拡張点。位相計算を足すときに使う）
 * @param {typeof setInterval} [options.setIntervalFn]
 * @param {typeof clearInterval} [options.clearIntervalFn]
 */
export function createSyncScheduler({
  topics = SYNC_TOPICS,
  isVisible = () => true,
  currentTab = () => null,
  now = () => Date.now(),
  setIntervalFn,
  clearIntervalFn,
} = {}) {
  const list = (Array.isArray(topics) ? topics : []).filter((t) => t && typeof t.id === 'string')
  const byId = new Map(list.map((t) => [t.id, t]))
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Map<string, any>} */
  const timers = new Map()
  let running = false

  const startTimer = (topic) => {
    if (!topic) return
    if (timers.has(topic.id)) return
    const everyMs = Number(topic.everyMs)
    if (!Number.isFinite(everyMs) || everyMs <= 0) return
    const schedule = setIntervalFn ?? globalThis.setInterval
    timers.set(
      topic.id,
      schedule(() => tick(topic.id), everyMs),
    )
  }

  const stopTimer = (id) => {
    if (!timers.has(id)) return
    const unschedule = clearIntervalFn ?? globalThis.clearInterval
    unschedule(timers.get(id))
    timers.delete(id)
  }

  /** 購読済みの関数を全部呼ぶ。1 本が落ちても他は叩く。 */
  const run = (id) => {
    const fns = listeners.get(id)
    if (!fns || fns.size === 0) return false
    for (const fn of [...fns]) {
      try {
        Promise.resolve(fn()).catch(() => {})
      } catch {
        /* 1 本が落ちても他は叩く */
      }
    }
    return true
  }

  /** 表の規則どおりに 1 回走らせる（可視・タブを見る）。 */
  function tick(id) {
    const topic = byId.get(id)
    if (!topic) return false
    if (!shouldRun(topic, { tab: currentTab(), visible: Boolean(isVisible()) })) return false
    return run(id)
  }

  /** 可視・タブ・スロットルを無視して全トピックを 1 回ずつ走らせる。 */
  function forceAll({ skip = null } = {}) {
    const skipped = new Set(Array.isArray(skip) ? skip : skip ? [skip] : [])
    const ran = []
    for (const topic of list) {
      if (skipped.has(topic.id)) continue
      if (run(topic.id)) ran.push(topic.id)
    }
    return ran
  }

  /**
   * トピックに同期関数を登録する。戻り値を呼ぶと解除。
   * 実行中に購読したトピックは、その場でタイマーを張る（購読順に依存しない）。
   */
  function subscribe(id, fn) {
    if (!byId.has(id) || typeof fn !== 'function') return () => {}
    if (!listeners.has(id)) listeners.set(id, new Set())
    listeners.get(id).add(fn)
    if (running) startTimer(byId.get(id))
    return () => {
      const fns = listeners.get(id)
      if (!fns) return
      fns.delete(fn)
      if (fns.size === 0) {
        listeners.delete(id)
        stopTimer(id)
      }
    }
  }

  /** 全トピックのタイマーを張る。二重呼び出しは無害。 */
  function start() {
    if (running) return
    running = true
    for (const topic of list) {
      if (listeners.has(topic.id)) startTimer(topic)
    }
  }

  /** 全タイマーを止める。購読は残す（`start()` で再開できる）。 */
  function stop() {
    running = false
    for (const id of [...timers.keys()]) stopTimer(id)
  }

  return { topics: list, subscribe, start, stop, forceAll, tick, now }
}
