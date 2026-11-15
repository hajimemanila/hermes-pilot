/**
 * コックピット計器盤（上部ステータスバー）の表示ロジック（React に依存しない純関数）。
 *
 * 仕様は `docs/SPEC-PILOT-V2.md` §5.5 / D15⑤。ピルは 4 つ:
 *  1. GW ピル      … 正常時は緑ドットだけ、異常時のみ赤くラベル展開
 *  2. 🔔 判断待ち   … reviewWaiting + inboxPending > 0 で琥珀パルス。タップで最初の判断待ちへ
 *  3. ⚡ 稼働       … 実行中ターン ＋ 実行中タスク > 0 で表示。直近ツール名を添える
 *  4. 💎 キャッシュ … /api/usage のキャッシュ率
 *
 * 数字はすべて「0 のときは出さない」— 0 のピルは「何かある」と誤読させるため。
 */

import { isWaiting } from './reviewView.js'

/**
 * キャッシュヒット率（0〜1）をパーセントに丸める。
 *
 * @param {number|null|undefined} rate `/api/usage` の `cacheHitRate`
 * @returns {number|null} 0〜100（算出できなければ null）
 */
export function cachePercent(rate) {
  if (rate === null || rate === undefined) return null
  const n = Number(rate)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.min(1, Math.max(0, n)) * 100)
}

/**
 * 稼働中ターンのうち**いちばん新しいツール**の名前。
 *
 * @param {Array<{lastTool?: {name?: string, at?: number}}>} turns `/api/live` の turns
 * @returns {string|null} ツール名（無ければ null）
 */
export function latestToolName(turns) {
  const list = Array.isArray(turns) ? turns.filter(Boolean) : []
  let best = null
  for (const t of list) {
    const name = t.lastTool?.name
    if (!name) continue
    const at = Number(t.lastTool?.at ?? 0)
    if (!best || at > best.at) best = { name: String(name), at }
  }
  return best ? best.name : null
}

/**
 * 稼働中の合計（実行中タスク ＋ 実行中ターン ＋ 実行中の Architect ジョブ）。
 *
 * Architect（仕様策定）は カンバンタスクを持たない `agy` ジョブもあるので、
 * `/api/live` の `counts.architect` を第 3 項として足す（SPEC-PILOT-V9 §3.2 / D43）。
 *
 * @param {{tasksRunning?: unknown, turns?: unknown, architectRunning?: unknown}} input 入力
 * @returns {number} 件数
 */
export function runningTotal({ tasksRunning = 0, turns = 0, architectRunning = 0 } = {}) {
  const a = Number(tasksRunning) || 0
  const b = Number(turns) || 0
  const c = Number(architectRunning) || 0
  return Math.max(0, a) + Math.max(0, b) + Math.max(0, c)
}

/**
 * GW ピルの状態。ブリッジに繋がっていても GW（Hermes 本体）が落ちていれば異常。
 *
 * @param {{conn?: string, bridge?: {ok?: boolean}|null}} input 入力
 * @returns {'ok'|'offline'|'error'} 状態
 */
export function gwState({ conn = 'ok', bridge = null } = {}) {
  if (conn === 'offline') return 'offline'
  if (conn !== 'ok') return 'error'
  if (bridge && bridge.ok === false) return 'error'
  return 'ok'
}

/**
 * 🔔 を押したときに開く先。判断待ちが 1 件でもあればそのタスク、無くて承認待ちだけなら
 * タスクタブのインボックスを開く（「押しても何も起きない」を作らない）。
 *
 * @param {{reviewItems?: Array<object>, inboxPending?: number}} input 入力
 * @returns {{kind: 'review', taskId: string}|{kind: 'inbox'}|null} 遷移先
 */
export function reviewJumpTarget({ reviewItems = [], inboxPending = 0 } = {}) {
  const first = (Array.isArray(reviewItems) ? reviewItems : []).find((i) => isWaiting(i))
  if (first?.id) return { kind: 'review', taskId: String(first.id) }
  if (Number(inboxPending) > 0) return { kind: 'inbox' }
  return null
}
