/**
 * 赤ペンタブの表示ロジック（React に依存しない純関数）。
 *
 * 仕様は `docs/AKAPEN-VIEW.md`。2026-11-12 の赤ペン（`~/Projects/akapen/sheets/akapen-view-01-1`）
 * で決まった 3 点をここに固定する:
 *  1. 既定表示は「判断待ちだけ」— 上部チップで 判断待ち / 進行中 / 完了 を切り替える
 *  2. 送信後は閉じず「次の判断待ち」を開き、最後の 1 件でだけ閉じる
 *  3. 完了は直近 8 件（畳みはタブが担う。件数は偽らない）
 *
 * 「赤ペンを送れる」= `blocked` かつ `akapen.label` を持つ（CONTRACT.md の赤ペン待ち）。
 * bridge 側 `akapen.answer()` も同じ条件でしか受け付けない（二重の守り）。
 */

/** 完了タブに出す件数（契約: 直近 8 件）。 */
export const DONE_LIMIT = 8

/** 赤ペン待ち = 回答を送ってよいタスク。 */
export function isWaiting(item) {
  return item?.status === 'blocked' && Boolean(item?.akapen?.label)
}

/** 一覧に出す（回答できない）進行中の状態。`review` は契約上ほぼ来ないが落とさない。 */
const ACTIVE_STATUSES = new Set(['review', 'ready', 'running', 'blocked'])

/**
 * 一覧 API の items を 3 グループへ分ける。
 *
 * @param {Array} items `/api/akapen` の items
 * @param {number} [doneLimit] 完了タブに残す件数
 * @returns {{waiting: Array, active: Array, done: Array, doneTotal: number}}
 */
export function groupItems(items, doneLimit = DONE_LIMIT) {
  const all = Array.isArray(items) ? items.filter(Boolean) : []
  const waiting = all.filter(isWaiting)
  const active = all.filter((i) => !isWaiting(i) && i.status !== 'done' && ACTIVE_STATUSES.has(i.status))
  const doneAll = all.filter((i) => i.status === 'done')
  return {
    waiting,
    active,
    done: doneAll.slice(0, doneLimit),
    doneTotal: doneAll.length,
  }
}

/**
 * 送信直後に開く「次の判断待ち」。回答済み（= もう待ちではない）ID は必ず除外する。
 *
 * @param {Array} items 送信後に取り直した items
 * @param {string|null} answeredId いま回答したタスク ID
 * @returns {object|null} 次に開く項目。残っていなければ null（呼び出し側はシートを閉じる）
 */
export function nextWaiting(items, answeredId) {
  const list = Array.isArray(items) ? items : []
  return list.find((i) => isWaiting(i) && i.id !== answeredId) || null
}

/** 完了タブの見出し（件数を偽らない: 直近 N 件、とだけ言う）。 */
export function doneHint(doneTotal) {
  const n = Number(doneTotal) || 0
  if (!n) return '完了はまだありません'
  return `直近 ${Math.min(n, DONE_LIMIT)} 件`
}

/**
 * 挿絵を拡大したときのキャプション。
 *
 * 選択肢の id とラベルだけだと「A. 塗りのボタン」としか出ず、何の話か分からない
 * （赤ペン akapen-empty-01 の注釈「この文言はなんですか？」）。問番号を頭に付け、
 * 問いの文を 2 行目に必ず添える。
 *
 * @param {string} qno 問番号（例: 'Q2'）
 * @param {{id?: string, label?: string}} option 選択肢
 * @param {string} [questionText] 問いの本文
 * @returns {{head: string, sub: string}} head=「Q2 A. 塗りのボタン」/ sub=問いの文（無ければ ''）
 */
export function thumbCaption(qno, option, questionText) {
  const no = String(qno ?? '').trim()
  const id = String(option?.id ?? '').trim()
  const label = String(option?.label ?? '').trim()
  const pick = [id && `${id}.`, label].filter(Boolean).join(' ')
  const head = [no, pick].filter(Boolean).join(' ').trim()
  const sub = String(questionText ?? '').trim()
  return { head, sub }
}

/**
 * 画像一覧に出す「取得日時」。
 *
 * 3 列に並ぶので秒は出さない（分まで）。端末のローカル時刻で出す — UTC にすると
 * 「いつの画像か」が人に分からない。**一覧はこの値の新しい順**なので、並びの
 * 意味が読めるように必ず出す。
 *
 * @param {number} ms `/api/akapen/library` の `mtime`（epoch ms）
 * @returns {string} 例: '11/12 21:05'。値が無ければ '—'
 */
export function capturedLabel(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  const p = (v) => String(v).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 画像一覧に出す「リポジトリ名」。
 *
 * 画像にリポジトリ情報は無いので、bridge が赤ペンのタスク（`[akapen] … target=`）から
 * 推定した id を出す。推定できない画像（チャットから取り込んだだけ等）は '—'。
 *
 * @param {{id?: string, label?: string}|string|null} repo
 * @returns {string} 例: 'hermes-mobile-pwa' / '—'
 */
export function repoLabel(repo) {
  const id = typeof repo === 'string' ? repo : String(repo?.id ?? repo?.label ?? '')
  return id.trim() || '—'
}
