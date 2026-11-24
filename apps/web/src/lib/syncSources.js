/**
 * 同期トピックの取得関数の**唯一の置き場**（D106 / SPEC-COHERENCE-RESIDUAL-DRIFT §3.1）。
 *
 * `lib/syncScheduler.js` の表が「いつ・どの状況で走らせるか」を持ち、ここが「何を取りに行くか」を持つ。
 * ペインと `App.jsx` は `api()` を**定期には**呼ばない（単発の操作は対象外）。
 *
 * - 1 トピック 1 本。購読者が何本あっても取得は 1 回で、同じ値を全員へ配る。
 * - 取得先が「いま開いている画面」で決まるトピック（`tasks` / `specs` / `taskDetail` …）は、
 *   ホストが `setSyncParams({...})` で渡した値だけを見る（取得側から React の state を覗かない）。
 * - 同じ URL を 2 系統が叩いていた例（`/api/inbox` ×2・`/api/live` ×3・`/api/review` ×2）は、
 *   トピックを共有することで 1 回になる。
 */
import { api } from '../api.js'
import { OVERVIEW_TIMEOUT_MS } from './netRecovery.js'

/**
 * 取得関数が読む状況パラメータ。ホスト（`App.jsx` / 各ペイン）が `setSyncParams()` で更新する。
 *
 * @type {{ board: string|null, architectBoard: string|null, taskDetail: {board: string, id: string}|null, reviewDetailId: string|null, workerFeedId: string|null }}
 */
export const SYNC_PARAMS = {
  board: null,
  architectBoard: null,
  taskDetail: null,
  reviewDetailId: null,
  workerFeedId: null,
}

const enc = encodeURIComponent

/**
 * topic → 取得関数を作る。
 *
 * @param {object} [options]
 * @param {(path: string, opts?: object) => Promise<any>} [options.apiFn] 差し替え用（テスト・デモ）
 * @param {Record<string, any>} [options.params] 初期パラメータ
 * @returns {{ params: Record<string, any>, setParams: (patch?: object) => Record<string, any>, sources: Record<string, () => Promise<any>> }}
 */
export function createSyncSources({ apiFn = api, params = {} } = {}) {
  // 静的なルート検査（`routeContracts.test.js`）が拾えるよう、注入した取得関数を `api` と呼ぶ
  const api = apiFn
  const p = { ...SYNC_PARAMS, ...(params || {}) }
  const board = () => (typeof p.board === 'string' && p.board ? p.board : null)

  /** @type {Record<string, () => Promise<any>>} */
  const sources = {
    overview: () => api('/api/overview', { timeoutMs: OVERVIEW_TIMEOUT_MS }),
    reports: () => api('/api/review/chat-reports?limit=200'),
    reviewWaiting: () => api('/api/review'),
    reviewFeed: () => api('/api/review/feed?limit=20'),
    usage: () => api('/api/usage?hours=24'),
    inbox: () => api('/api/inbox'),
    live: () => api('/api/live'),
    tasks: () => (board() ? api(`/api/boards/${enc(board())}/tasks?limit=60`) : Promise.resolve(null)),
    boards: () => api('/api/boards'),
    specs: () => (board() ? api(`/api/specs?board=${enc(board())}`) : Promise.resolve(null)),
    coherence: () => (board() ? api(`/api/coherence/report?board=${enc(board())}`) : Promise.resolve(null)),
    specReports: () =>
      board() ? api(`/api/specs/reports?board=${enc(board())}&limit=1`) : Promise.resolve(null),
    architectJobs: () =>
      p.architectBoard
        ? api(`/api/architect/jobs?board=${enc(p.architectBoard)}`)
        : api('/api/architect/jobs'),
    workerFeed: () =>
      p.workerFeedId ? api(`/api/review/${enc(p.workerFeedId)}/worker?limit=8`) : Promise.resolve(null),
    taskDetail: () =>
      p.taskDetail?.board && p.taskDetail?.id
        ? api(`/api/boards/${enc(p.taskDetail.board)}/tasks/${enc(p.taskDetail.id)}`)
        : Promise.resolve(null),
    taskDetailWorker: () =>
      p.taskDetail?.board && p.taskDetail?.id
        ? api(`/api/boards/${enc(p.taskDetail.board)}/tasks/${enc(p.taskDetail.id)}/worker?limit=30`)
        : Promise.resolve(null),
    reviewDetail: () =>
      p.reviewDetailId ? api(`/api/review/${enc(p.reviewDetailId)}/worker?limit=30`) : Promise.resolve(null),
  }

  return {
    params: p,
    /** 画面の状況を取得関数へ渡す。 */
    setParams(patch) {
      Object.assign(p, patch || {})
      return p
    },
    sources,
  }
}

/*
 * ここから下は「アプリ 1 つに 1 本」の配線。`App.jsx` が作ったスケジューラと取得関数を登録し、
 * 各ペインは `subscribeSync()` / `refreshSync()` / `setSyncParams()` だけを使う（prop 配線を増やさない）。
 */
let runtime = null

/**
 * アプリのスケジューラと取得関数を登録する（`App.jsx` が 1 回だけ呼ぶ）。
 *
 * @param {{ scheduler: object, sources: ReturnType<typeof createSyncSources> } | null} next
 */
export function installSyncRuntime(next) {
  runtime = next || null
  return runtime
}

/** テスト・デモ用に登録を外す。 */
export function resetSyncRuntime() {
  runtime = null
}

/** 登録済みのランタイム（未登録なら null）。 */
export function syncRuntime() {
  return runtime
}

/**
 * トピックを購読する。**マウント中だけ**呼ぶ（戻り値を effect の後始末で呼ぶ）。
 *
 * @param {string} id トピック id
 * @param {(value: any, meta: {error: Error|null, at: number}) => void} fn
 * @returns {() => void} 解除
 */
export function subscribeSync(id, fn) {
  if (!runtime?.scheduler) return () => {}
  return runtime.scheduler.subscribe(id, fn)
}

/** 規則（可視・タブ・`enabledWhen`）どおりに 1 回走らせる。 */
export function tickSync(id) {
  return runtime?.scheduler ? runtime.scheduler.tick(id) : null
}

/** 規則を無視して 1 回取り直す（送信後の再取得など）。 */
export function refreshSync(id) {
  return runtime?.scheduler
    ? runtime.scheduler.refresh(id)
    : Promise.resolve({ ran: false, ok: false, value: undefined, error: null })
}

/** 状況（`boardsFailed` / `workActive` / `architectBusy` / `detailActive`）を更新する。 */
export function setSyncState(patch) {
  return runtime?.scheduler ? runtime.scheduler.setState(patch) : {}
}

/** 取得先（表示中ボード・開いているタスク）を更新する。 */
export function setSyncParams(patch) {
  if (runtime?.sources) return runtime.sources.setParams(patch)
  return Object.assign(SYNC_PARAMS, patch || {})
}

/** いまの取得先パラメータ（読み取り専用の写し）。 */
export function syncParams() {
  return { ...(runtime?.sources?.params ?? SYNC_PARAMS) }
}
