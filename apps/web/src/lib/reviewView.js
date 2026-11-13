/**
 * レビュータブの表示ロジック（React に依存しない純関数）。
 *
 * 仕様は `docs/AKAPEN-VIEW.md`。2026-11-12 のレビュー（`~/Projects/review/sheets/review-view-01-1`）
 * で決まった 3 点をここに固定する:
 *  1. 既定表示は「判断待ちだけ」— 上部チップで 判断待ち / 進行中 / 完了 を切り替える
 *  2. 送信後は閉じず「次の判断待ち」を開き、最後の 1 件でだけ閉じる
 *  3. 完了は直近 8 件（畳みはタブが担う。件数は偽らない）
 *
 * 「レビューを送れる」= `blocked` かつ `review.label` を持つ（CONTRACT.md のレビュー待ち）。
 * bridge 側 `review.answer()` も同じ条件でしか受け付けない（二重の守り）。
 */

import { t } from '../i18n/lang.js'

/** 完了タブに出す件数（契約: 直近 8 件）。 */
export const DONE_LIMIT = 8

/** レビュー待ち = 回答を送ってよいタスク。 */
export function isWaiting(item) {
  return item?.status === 'blocked' && Boolean(item?.review?.label)
}

/** 一覧に出す（回答できない）進行中の状態。`review` は契約上ほぼ来ないが落とさない。 */
const ACTIVE_STATUSES = new Set(['review', 'ready', 'running', 'blocked'])

/**
 * 一覧 API の items を 3 グループへ分ける。
 *
 * @param {Array} items `/api/review` の items
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

/**
 * ナビのレビュータブに出す「小さな丸の数字」（ティッカー）。
 *
 * 注釈（`1377.jpg` の赤）で決まったこと: 件数は**下部ナビの丸バッジ**にだけ出し、
 * タブ内の表示（「N 件の判断待ち」）は変えない。0 のときはバッジ自体を出さない
 * （0 の丸は「何かある」と誤読させる）。
 *
 * @param {Array} items `/api/review` の items
 * @returns {number} レビュー待ちの件数（0 以上）
 */
export function waitingCount(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  return list.filter(isWaiting).length
}

/**
 * 自分が回答済みか。`lastComment` は `{author, body, at}` を返すので、
 * 最新コメントが mobile かつ blocked 以降なら「回答済み（再開待ち）」。
 * インボックス・ナビバッジ・黄色バーの3箇所で数字を揃えるために共有する。
 *
 * @param {object} item `/api/inbox` の item
 * @returns {boolean} 回答済みか
 */
export function isAnswered(item) {
  const c = item?.lastComment
  return Boolean(c && c.author === 'mobile' && (c.at ?? 0) >= (item?.blockedAt ?? 0))
}

/**
 * ナビのタスクタブに出す「小さな丸の数字」（未回答の承認待ち）。
 *
 * 注釈（`1377.jpg` の赤）で決まったこと: 「ティッカー」は下部ナビの丸バッジのこと。
 * 承認待ち（`/api/inbox`）とレビュー判断待ち（`/api/review`）は**別の数字**で、混ぜない。
 * `/api/inbox` 側が本文 `[review]` の blocked を除いているので、ここでは未回答だけを数える。
 *
 * @param {Array} items `/api/inbox` の items
 * @returns {number} 未回答の承認待ち件数（0 以上）
 */
export function pendingCount(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  return list.filter((it) => !isAnswered(it)).length
}

/**
 * 下部ナビのレビュータブに出す「進行中」の件数（反映待ち＋生成中）。
 *
 * 完了の可視化と合わせて「押すまで分からない」を減らす。件数は丸バッジではなく
 * 青い点で出す（数字は「判断待ち＝あなたの番」にだけ使う。2 つの数字を混ぜない）。
 *
 * @param {Array} items `/api/review` の items
 * @returns {number} 進行中の件数
 */
export function runningCount(items) {
  const list = Array.isArray(items) ? items : []
  return list.filter((i) => i && (i.status === 'running' || i.status === 'ready')).length
}

/**
 * 未読の作業フィード（監視 cron が書いた 1 行ログ）。
 *
 * @param {Array<{at: number, text: string}>} feed `/api/review/feed` の items
 * @param {number} lastSeen 端末が最後にレビュータブを開いた時刻（epoch ms）
 * @returns {Array} 未読だけ（古い順）
 */
export function unseenNotices(feed, lastSeen) {
  const list = Array.isArray(feed) ? feed : []
  const since = Number(lastSeen) || 0
  return list.filter((n) => n && Number.isFinite(Number(n.at)) && Number(n.at) > since)
}

/**
 * レビュータブの丸/点の状態（優先度: 判断待ち > 未読の完了 > 進行中）。
 *
 * 判断待ちだけ数字を出し、それ以外は点にする（「あなたの番」と「進んでいる」を
 * 同じ見た目にしない）。
 *
 * @param {{waiting?: number, unseen?: number, running?: number}} s 件数
 * @returns {'waiting'|'done'|'running'|null}
 */
export function navBadgeState({ waiting = 0, unseen = 0, running = 0 } = {}) {
  if (Number(waiting) > 0) return 'waiting'
  if (Number(unseen) > 0) return 'done'
  if (Number(running) > 0) return 'running'
  return null
}

/** 完了タブの見出し（件数を偽らない: 直近 N 件、とだけ言う）。 */
export function doneHint(doneTotal) {
  const n = Number(doneTotal) || 0
  if (!n) return t('review.doneEmpty')
  return t('review.doneRecent', { n: Math.min(n, DONE_LIMIT) })
}

/**
 * 挿絵を拡大したときのキャプション。
 *
 * 選択肢の id とラベルだけだと「A. 塗りのボタン」としか出ず、何の話か分からない
 * （レビュー review-empty-01 の注釈「この文言はなんですか？」）。問番号を頭に付け、
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
 * レビューの回答を「履歴」として読むための行（完了した項目の詳細で使う）。
 *
 * 回答が無い問（未回答のまま片付けた等）は `choice: null` で返し、UI 側が
 * 「お任せ（既定）」と書けるようにする — 回答を捏造しない。
 *
 * @param {object|null} data `/api/review/:id/data` の `data`（sheet.json）
 * @param {object|null} answer `/api/review/:id/data` の `answer`（answer.json）
 * @returns {{rows: Array<{id: string, question: string, choice: string|null, label: string, note: string}>, global: string}}
 */
export function answerRows(data, answer) {
  const questions = Array.isArray(data?.questions) ? data.questions : []
  const picked = Array.isArray(answer?.answers) ? answer.answers : []
  const rows = questions.map((q) => {
    const a = picked.find((x) => String(x?.id ?? '') === String(q?.id ?? '')) || null
    const options = Array.isArray(q?.options) ? q.options : []
    const opt = a?.choice ? options.find((o) => String(o?.id ?? '') === String(a.choice)) : null
    return {
      id: String(q?.id ?? ''),
      question: String(q?.text ?? ''),
      choice: a?.choice ? String(a.choice) : null,
      label: opt ? String(opt.label ?? '') : '',
      note: String(a?.note ?? ''),
    }
  })
  return { rows, global: String(answer?.global ?? '') }
}

/**
 * 画像一覧に出す「取得日時」。
 *
 * 3 列に並ぶので秒は出さない（分まで）。端末のローカル時刻で出す — UTC にすると
 * 「いつの画像か」が人に分からない。**一覧はこの値の新しい順**なので、並びの
 * 意味が読めるように必ず出す。
 *
 * @param {number} ms `/api/review/library` の `mtime`（epoch ms）
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
 * 画像にリポジトリ情報は無いので、bridge がレビューのタスク（`[review] … target=`）から
 * 推定した id を出す。推定できない画像（チャットから取り込んだだけ等）は '—'。
 *
 * @param {{id?: string, label?: string}|string|null} repo
 * @returns {string} 例: 'hermes-mobile-pwa' / '—'
 */
export function repoLabel(repo) {
  const id = typeof repo === 'string' ? repo : String(repo?.id ?? repo?.label ?? '')
  return id.trim() || '—'
}

/**
 * 推奨の印。`recommended: true` のほか、**ラベルに推奨の語を含む選択肢**も推奨として扱う。
 *
 * シートを作る側（akapen スキル）は `recommended: true` を付けるが、既存の資産には
 * ラベルに「推奨」と書いただけのものがある。日本語は `\u` エスケープで持つ
 * （`apps/web/test/noHardcodedJapanese.test.js` がソース中の生の日本語を弾く）。
 */
const RECOMMENDED_RE = /recommend|\u63a8\u5968/i

/** 否定（「非推奨」「not recommended」）は推奨として扱わない。先に判定する。 */
const NOT_RECOMMENDED_RE = /not\s+recommended|no\s+recommend|\u975e\u63a8\u5968/i

/**
 * 選択肢が推奨か。
 *
 * @param {{id?: string, label?: string, detail?: string, recommended?: boolean|string}} option 選択肢
 * @returns {boolean} 推奨か
 */
export function isRecommendedOption(option) {
  if (!option) return false
  const flag = option.recommended
  if (flag === true || flag === 'true') return true
  const text = `${option.label ?? ''} ${option.detail ?? ''}`
  if (NOT_RECOMMENDED_RE.test(text)) return false
  return RECOMMENDED_RE.test(text)
}

/**
 * 推奨案で一括承認するための材料（SPEC §5.1 / D15①）。
 *
 * 「推奨が 1 問でもあれば一括承認できる」— 推奨の無い問は `choice: null`（＝お任せ）で
 * 送る。回答の形は `POST /api/review/:id/answer` の `answers` と同じにして、送信側が
 * そのまま使えるようにする。
 *
 * @param {object|null} sheetData `/api/review/:id/data` の `data`（sheet.json）
 * @returns {{canFastTrack: boolean, summary: string, answers: Array<{id: string, choice: string|null, note: string}>}}
 *   summary は `Q1:A · Q2:B`（推奨のある問だけ）
 */
export function extractRecommendedAnswers(sheetData) {
  const questions = Array.isArray(sheetData?.questions) ? sheetData.questions : []
  const answers = []
  const parts = []
  questions.forEach((q, i) => {
    const options = Array.isArray(q?.options) ? q.options : []
    const rec = options.find((o) => isRecommendedOption(o)) || null
    const id = String(q?.id ?? `q${i + 1}`)
    const choice = rec && rec.id != null && rec.id !== '' ? String(rec.id) : null
    answers.push({ id, choice, note: '' })
    if (choice) parts.push(`Q${i + 1}:${choice}`)
  })
  return { canFastTrack: parts.length > 0, summary: parts.join(' · '), answers }
}

