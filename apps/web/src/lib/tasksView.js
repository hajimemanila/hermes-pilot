/**
 * タスク詳細シートの表示用の純関数（SPEC-PILOT-V8 §V8-B3）。
 *
 * カンバンの `task_events` は worker の `heartbeat` で埋まる。1 件ずつ並べると
 * タイムラインが heartbeat だけで埋まり、本当に見たい `created` / `claimed` /
 * `completed` が押し出される。ここでは**連続する** heartbeat を 1 行に畳む。
 */

/**
 * イベント列の `kind`（辞書キーに使う）。
 * @param {object} e イベント
 * @returns {string} kind（無ければ空文字）
 */
export function eventKind(e) {
  return String(e?.kind ?? '')
}

/**
 * 連続する `heartbeat` を 1 件に畳む。
 *
 * - 入力は `kanban.task()` の `events`（**新しい順**）を想定する
 * - `{ kind: 'heartbeat', count, at, firstAt }` を返す（`at` が最新、`firstAt` が最古）
 * - 別種のイベントを跨いで合算しない（間に `claimed` などが挟まれば別グループ）
 * - 元の配列・要素は書き換えない（React の再描画で差分が出ないように）
 *
 * @param {Array<object>} [events] イベント（新しい順）
 * @returns {Array<object>} 畳んだイベント（新しい順・同じ長さ以下）
 */
export function collapseTaskEvents(events = []) {
  /** @type {Array<object>} */
  const out = []
  /** @type {{kind: string, count: number, at: number, firstAt: number}|null} */
  let run = null
  for (const e of events ?? []) {
    if (!e) continue
    const at = Number(e.at ?? 0)
    if (eventKind(e) !== 'heartbeat') {
      out.push(e)
      run = null
      continue
    }
    if (run && out[out.length - 1] === run) {
      run.count += 1
      // 新しい順なので、先に来た方が `at`（最新）、後から来た方が `firstAt`（最古）
      run.firstAt = at
      continue
    }
    run = { kind: 'heartbeat', count: 1, at, firstAt: at }
    out.push(run)
  }
  return out
}
