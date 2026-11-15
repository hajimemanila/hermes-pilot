/**
 * 実行ワーカーのトランスクリプト（`<WorkerFeed>`）を読むための DB 選択。
 *
 * 1 つのセッションの会話は、その worker が動いたプロファイルの `state.db` にしか無い。
 * カンバンのタスク行（`tasks.session_id`）には DB のパスが残らないので、
 * `task_events` の `owner_admitted` payload にある `db` を最優先し、無ければ
 * 全プロファイルの `state.db` を横断して **messages が 1 件以上あった DB** を採用する。
 *
 * ここは純粋な選択ロジックだけを持つ（`node:fs` も `node:sqlite` も触らない）ので、
 * ブリッジを起動せずにテストできる。
 */

/**
 * 候補 DB の並び（`info.db` 優先 → `stateDbs` の順、重複除去）。
 * @param {{db?: string|null}} [info] イベント由来の情報
 * @param {Array<{profile: string, path: string}>} [stateDbs] `listStateDbs()` の結果
 * @returns {Array<{profile: string, path: string}>} 候補
 */
export function feedCandidates(info = {}, stateDbs = []) {
  const out = []
  const seen = new Set()
  const push = (profile, path) => {
    const p = String(path ?? '')
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push({ profile: String(profile ?? ''), path: p })
  }
  if (info?.db) push('event', info.db)
  for (const d of stateDbs ?? []) push(d?.profile, d?.path)
  return out
}

/**
 * 読み取り結果から採用する 1 件を選ぶ（messages が 1 件以上あった最初のもの）。
 * どれも空なら先頭（DB のパスは分かったので、UI 側で「まだ出力がありません」を出す）。
 * @param {Array<{feed: object|null, db: string, profile: string}>} [results] 読み取り結果
 * @returns {{feed: object|null, db: string|null, profile: string|null}} 採用する結果
 */
export function pickFeed(results = []) {
  let first = null
  for (const r of results ?? []) {
    if (!r?.feed) continue
    if ((r.feed.messages ?? []).length > 0) return r
    if (!first) first = r
  }
  return first ?? { feed: null, db: null, profile: null }
}

/**
 * 候補を順に読む `readWorkerFeed` を作る。
 * @param {{listStateDbs: () => Promise<Array<{profile: string, path: string}>>, read: (sessionId: string, opts: object) => object}} deps 依存
 * @returns {(sessionId: string, info?: object, limit?: number) => Promise<{feed: object|null, db: string|null, profile: string|null}>} 読み取り関数
 */
export function createWorkerFeed({ listStateDbs, read }) {
  return async function readWorkerFeed(sessionId, info = {}, limit = 40) {
    const sid = String(sessionId ?? '')
    if (!sid) return { feed: null, db: null, profile: null }
    const candidates = feedCandidates(info, await listStateDbs())
    const results = []
    for (const c of candidates) {
      let feed = null
      try {
        feed = read(sid, { dbPath: c.path, limit, includeTools: true })
      } catch {
        feed = null
      }
      if (!feed) continue
      results.push({ feed, db: c.path, profile: c.profile })
    }
    return pickFeed(results)
  }
}
