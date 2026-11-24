/**
 * 定期同期の正本（D106 / SPEC-COHERENCE-RESIDUAL-DRIFT §3.1）。
 *
 * このファイルは **純粋**（`fetch` を持たない）。取得関数の唯一の置き場は `lib/syncSources.js` で、
 * ここには「何秒で・どんな状況なら走らせるか」だけを書く。実行は 1 本のスケジューラが持ち、
 * **1 トピック 1 取得**: `sources[id]` を 1 回だけ await して、結果を購読者全員へ配る
 * （購読者が 2 つでも fetch は 1 回）。
 *
 * - `enabledWhen(state)` は「状況で走らせない」だけを担う（破棄せず skip）。状態はホストが
 *   `setState({ boardsFailed, workActive, architectBusy, detailActive })` で更新する。
 * - `everyMsOf(state)` は状況で変わる間隔。tick のたびに値を比べ、**変わったときだけ**張り直す
 *   （毎 tick 張り直すと位相がリセットされ、永久に走らない）。
 * - `pauseOnTabs` は「そのタブを見ている間は叩かない」規則。1 トピック 1 取得になって
 *   タブ跨ぎの重複が消えたため、表では使っていない（規則そのものは残す）。
 * - 1 秒時計（間隔 1000ms かつ本文が `Date.now()`）だけは各コンポーネントに置いてよい。
 */

/** 時計として許す間隔（`sync-owner` の共通規則と同じ値）。 */
export const CLOCK_INTERVAL_MS = 1000

/**
 * 同期トピックの宣言表。
 *
 * `id` は購読キー、`everyMs` は固定間隔、`everyMsOf(state)` は状況依存の間隔、
 * `enabledWhen(state)` は「この状況でだけ走らせる」述語、`pauseOnTabs` は止めるタブ id。
 *
 * @type {ReadonlyArray<{ id: string, everyMs?: number, everyMsOf?: (state: object) => number, enabledWhen?: (state: object) => boolean, pauseOnTabs?: string[] }>}
 */
export const SYNC_TOPICS = [
  { id: 'overview', everyMs: 5_000 }, // 接続状態・稼働数（App）
  { id: 'reports', everyMs: 15_000 }, // 完了報告（App）
  { id: 'reviewWaiting', everyMs: 15_000 }, // 判断待ち一覧（App のバッジ + ReviewPane）
  { id: 'reviewFeed', everyMs: 15_000 }, // 赤ペン完了フィード（App + ReviewPane）
  { id: 'usage', everyMs: 60_000 }, // 24h 使用量（App + TasksPane）
  { id: 'inbox', everyMs: 15_000 }, // 承認待ち（TasksPane + InboxSheet）
  { id: 'live', everyMs: 5_000 }, // 実行中ターン（TasksPane + LiveSheet）
  { id: 'tasks', everyMs: 5_000 }, // カンバン一覧（TasksPane）
  { id: 'boards', everyMs: 5_000, enabledWhen: (s) => Boolean(s.boardsFailed) }, // 取得失敗時の再試行
  { id: 'specs', everyMs: 60_000 }, // SPEC 一覧（TasksPane）
  { id: 'coherence', everyMs: 120_000, enabledWhen: (s) => !s.workActive }, // 作業中は走らせない
  { id: 'specReports', everyMs: 30_000 }, // 完走レポート 1 件（TasksPane）
  { id: 'architectJobs', everyMsOf: (s) => (s.architectBusy ? 4_000 : 20_000) }, // 進行中だけ 4 秒
  { id: 'workerFeed', everyMs: 4_000 }, // チャットの紐づきワーカー進捗（ChatPane）
  { id: 'taskDetail', everyMs: 5_000, enabledWhen: (s) => Boolean(s.detailActive) }, // タスク詳細
  { id: 'taskDetailWorker', everyMs: 5_000, enabledWhen: (s) => Boolean(s.detailActive) }, // その worker 進捗
  { id: 'reviewDetail', everyMs: 5_000 }, // レビュー詳細の worker 進捗（開いている間だけ購読）
]

/** その状況でのこのトピックの間隔（`everyMsOf` 優先）。 */
export function everyMsOf(topic, state = {}) {
  if (!topic) return 0
  if (typeof topic.everyMsOf === 'function') {
    try {
      return Number(topic.everyMsOf(state))
    } catch {
      return 0
    }
  }
  return Number(topic.everyMs)
}

/** `enabledWhen` を満たすか（宣言が無ければ常に真）。 */
export function isEnabled(topic, state = {}) {
  if (!topic) return false
  if (typeof topic.enabledWhen !== 'function') return true
  try {
    return Boolean(topic.enabledWhen(state))
  } catch {
    return false
  }
}

/**
 * このトピックを「いま叩いてよいか」。`tick` とテストが同じ規則を見る。
 *
 * @param {{ pauseOnTabs?: string[], enabledWhen?: (state: object) => boolean } | null | undefined} topic
 * @param {{ tab?: string | null, visible?: boolean, state?: object }} [ctx]
 * @returns {boolean}
 */
export function shouldRun(topic, { tab = null, visible = true, state = {} } = {}) {
  if (!topic) return false
  if (!visible) return false
  const paused = Array.isArray(topic.pauseOnTabs) ? topic.pauseOnTabs : []
  if (paused.includes(tab)) return false
  return isEnabled(topic, state)
}

/**
 * 1 本のスケジューラを作る。タイマーと時計は差し替え可能（テスト用）。
 *
 * @param {object} [options]
 * @param {ReadonlyArray<object>} [options.topics] 宣言表
 * @param {Record<string, () => Promise<any>>} [options.sources] トピック id → 取得関数（1 トピック 1 本）
 * @param {() => boolean} [options.isVisible] 画面が見えているか
 * @param {() => string | null} [options.currentTab] 表示中のタブ id
 * @param {() => number} [options.now] 時計
 * @param {typeof setInterval} [options.setIntervalFn]
 * @param {typeof clearInterval} [options.clearIntervalFn]
 */
export function createSyncScheduler({
  topics = SYNC_TOPICS,
  sources = {},
  isVisible = () => true,
  currentTab = () => null,
  now = () => Date.now(),
  setIntervalFn,
  clearIntervalFn,
} = {}) {
  const list = (Array.isArray(topics) ? topics : []).filter((t) => t && typeof t.id === 'string')
  const byId = new Map(list.map((t) => [t.id, t]))
  /** @type {Map<string, () => Promise<any>>} */
  const src = new Map()
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Map<string, { handle: any, everyMs: number }>} */
  const timers = new Map()
  /** @type {Set<string>} */
  const inflight = new Set()
  let state = {}
  let running = false
  let lastWakeAt = 0

  for (const [id, fn] of Object.entries(sources || {})) {
    if (typeof fn === 'function') src.set(id, fn)
  }

  /** 取得関数を後から足す。**1 トピック 1 本**（重複登録は throw）。 */
  function registerSource(id, fn) {
    if (typeof fn !== 'function') throw new TypeError(`sync source must be a function: ${id}`)
    if (src.has(id)) throw new Error(`duplicate sync source: ${id}`)
    src.set(id, fn)
  }

  const stopTimer = (id) => {
    const cur = timers.get(id)
    if (!cur) return
    const unschedule = clearIntervalFn ?? globalThis.clearInterval
    unschedule(cur.handle)
    timers.delete(id)
  }

  /** 表の間隔が変わったときだけ張り直す（位相を保つ）。 */
  function armTimer(id) {
    const topic = byId.get(id)
    if (!topic) return
    const everyMs = everyMsOf(topic, state)
    const cur = timers.get(id)
    if (cur && cur.everyMs === everyMs) return
    stopTimer(id)
    if (!Number.isFinite(everyMs) || everyMs <= 0) return
    const schedule = setIntervalFn ?? globalThis.setInterval
    timers.set(id, { everyMs, handle: schedule(() => { tick(id) }, everyMs) })
  }

  /** 1 トピックを 1 回取得して、購読者全員へ同じ値を配る。 */
  async function run(id, { force = false } = {}) {
    const source = src.get(id)
    const fns = listeners.get(id)
    if (!force && (!fns || fns.size === 0)) return { ran: false, ok: false, value: undefined, error: null }
    const at0 = Number(now())
    if (typeof source !== 'function') {
      if (!fns || fns.size === 0) return { ran: false, ok: false, value: undefined, error: null }
      // 取得関数を持たないトピックは従来どおり「合図だけ」を配る（時計・再描画用）
      for (const fn of [...fns]) {
        try {
          const out = fn(undefined, { error: null, at: at0 })
          if (out && typeof out.then === 'function') out.catch(() => {})
        } catch {
          /* 1 本が落ちても他は叩く */
        }
      }
      return { ran: true, ok: true, value: undefined, error: null }
    }
    let value
    let error = null
    try {
      value = await source()
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e?.message ?? e))
    }
    const at = Number(now())
    for (const fn of [...(listeners.get(id) ?? [])]) {
      try {
        const out = fn(value, { error, at })
        if (out && typeof out.then === 'function') out.catch(() => {})
      } catch {
        /* 1 本が落ちても他は叩く */
      }
    }
    return { ran: true, ok: !error, value, error }
  }

  /** 実行を開始する（購読者 0・実行中なら何もしない）。 */
  function launch(id, { force = false } = {}) {
    const fns = listeners.get(id)
    if (!force && (!fns || fns.size === 0)) return null
    if (inflight.has(id)) return null
    inflight.add(id)
    return run(id, { force }).finally(() => inflight.delete(id))
  }

  /** 表の規則どおりに 1 回走らせる（可視・タブ・`enabledWhen` を見る）。 */
  function tick(id) {
    const topic = byId.get(id)
    if (!topic) return null
    if (!shouldRun(topic, { tab: currentTab(), visible: Boolean(isVisible()), state })) return null
    armTimer(id)
    return launch(id)
  }

  /** 手元の操作の後など、規則を無視して 1 回取り直す（購読者が 0 でも取得する）。 */
  function refresh(id) {
    if (!byId.has(id)) return Promise.resolve({ ran: false, ok: false, value: undefined, error: null })
    return (
      launch(id, { force: true }) ?? Promise.resolve({ ran: false, ok: false, value: undefined, error: null })
    )
  }

  /** 可視・タブを無視して全トピックを 1 回ずつ走らせる（`enabledWhen` は尊重する）。 */
  function forceAll({ skip = null } = {}) {
    const skipped = new Set(Array.isArray(skip) ? skip : skip ? [skip] : [])
    const ran = []
    for (const topic of list) {
      if (skipped.has(topic.id)) continue
      if (!isEnabled(topic, state)) continue
      if (launch(topic.id)) ran.push(topic.id)
    }
    return ran
  }

  /** スロットル付きの全体同期（短時間の復帰イベント連打を 1 回に束ねる）。 */
  function wake({ skip = null, minGapMs = 2500 } = {}) {
    const at = Number(now())
    if (minGapMs > 0 && lastWakeAt > 0 && at - lastWakeAt < minGapMs) return []
    lastWakeAt = at
    return forceAll({ skip })
  }

  /** 現在見えている画面の規則に従って表を 1 周する。 */
  function tickVisible() {
    const ran = []
    for (const topic of list) {
      if (tick(topic.id)) ran.push(topic.id)
    }
    return ran
  }

  /** 状況（`boardsFailed` / `workActive` / `architectBusy` / `detailActive`）を更新する。 */
  function setState(patch) {
    state = { ...state, ...(patch ?? {}) }
    for (const id of [...timers.keys()]) armTimer(id)
    return { ...state }
  }

  function getState() {
    return { ...state }
  }

  /** トピックを購読する。戻り値を呼ぶと解除（購読 0 になったタイマーは止まる）。 */
  function subscribe(id, fn) {
    if (!byId.has(id) || typeof fn !== 'function') return () => {}
    if (!listeners.has(id)) listeners.set(id, new Set())
    listeners.get(id).add(fn)
    if (running) armTimer(id)
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

  /** 購読済みトピックのタイマーを張る。二重呼び出しは無害。 */
  function start() {
    if (running) return
    running = true
    for (const id of listeners.keys()) armTimer(id)
  }

  /** 全タイマーを止める。購読は残す（`start()` で再開できる）。 */
  function stop() {
    running = false
    for (const id of [...timers.keys()]) stopTimer(id)
  }

  return {
    topics: list,
    registerSource,
    setState,
    getState,
    subscribe,
    start,
    stop,
    refresh,
    forceAll,
    wake,
    tickVisible,
    tick,
    now,
    /** テスト用: いま張っているタイマーの間隔。 */
    intervalOf: (id) => timers.get(id)?.everyMs ?? 0,
    subscriberCount: (id) => listeners.get(id)?.size ?? 0,
  }
}
