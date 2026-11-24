/**
 * レビュータブの表示ロジック（React に依存しない純関数）。
 *
 * 仕様は `docs/REVIEW-VIEW.md`。2026-11-12 のレビュー（`~/Projects/review/sheets/review-view-01-1`）
 * で決まった 3 点をここに固定する:
 *  1. 既定表示は「判断待ちだけ」— 上部チップで 判断待ち / 進行中 / 完了 を切り替える
 *  2. 送信後は閉じず「次の判断待ち」を開き、最後の 1 件でだけ閉じる
 *  3. 完了は直近 8 件（畳みはタブが担う。件数は偽らない）
 *
 * 「レビューを送れる」= `blocked` かつ `review.label` を持つ（CONTRACT.md のレビュー待ち）。
 * bridge 側 `review.answer()` も同じ条件でしか受け付けない（二重の守り）。
 */

import { t } from '../i18n/lang.js'
import { sep } from './format.js'

/** 完了タブに出す件数（契約: 直近 8 件）。 */
export const DONE_LIMIT = 8

/** 状態 → 辞書キー（ReviewPane / WorkerFeed 共有）。 */
export const REVIEW_STATUS_KEY = Object.freeze({
  review: 'review.status.review',
  ready: 'review.status.ready',
  running: 'review.status.running',
  blocked: 'review.status.blocked',
  done: 'review.status.done',
})

/**
 * レビュー待ち = 回答を送ってよいタスク。
 *
 * `sheet` 指定タスクで `review.exists === false`（シート JSON がまだ生成前）のときは
 * 「判断待ち／確認ボタン」を出さない（問題②）。
 */
export function isWaiting(item) {
  if (item?.status !== 'blocked' || !item?.review?.label) return false
  const ak = item.review
  if (ak.mode === 'annotation' || !ak.sheet) return true
  return ak.exists !== false
}

/** 回答・注釈・検収の記録がある（= 反映側フェーズ）か（問題①）。 */
export function isAnsweredReview(item) {
  return Boolean(item?.review?.answeredAt)
}

/** 一覧に出す（回答できない）状態。`review` は契約上ほぼ来ないが落とさない。 */
const ACTIVE_STATUSES = new Set(['review', 'ready', 'running', 'blocked'])

/**
 * レビュー項目を 4 段階（`generating` / `waiting` / `reflecting` / `done`）へ分類する（問題①）。
 *
 * @param {object|null|undefined} item `/api/review` の要素
 * @returns {'generating'|'waiting'|'reflecting'|'done'|'other'} フェーズ
 */
export function reviewPhase(item) {
  if (!item) return 'other'
  if (item.status === 'done') return 'done'
  if (isWaiting(item)) return 'waiting'
  if (ACTIVE_STATUSES.has(item.status)) {
    return isAnsweredReview(item) ? 'reflecting' : 'generating'
  }
  return 'other'
}

/** 生成中フェーズか（シート生成待ち／作成中）。 */
export function isGenerating(item) {
  return reviewPhase(item) === 'generating'
}

/** 反映中フェーズか（回答済み・コード反映待ち／反映中）。 */
export function isReflecting(item) {
  return reviewPhase(item) === 'reflecting'
}

/** 遷移先タブ ID（`focusRequest` 等で使う）。 */
export function reviewTabFor(item) {
  const phase = reviewPhase(item)
  if (phase === 'generating' || phase === 'waiting' || phase === 'reflecting' || phase === 'done') return phase
  return 'generating'
}

/**
 * カード右端チップの辞書キー（`generating` と `reflecting` で意味を一致させる・問題①）。
 *
 * @param {object|null|undefined} item `/api/review` の要素
 * @returns {string|null} i18n キー（未知状態は null）
 */
export function reviewChipKey(item) {
  const phase = reviewPhase(item)
  if (phase === 'waiting') return 'review.progress.waiting'
  if (phase === 'done') return 'review.status.done'
  if (phase === 'generating') {
    if (item?.status === 'running') return 'review.status.running'
    if (item?.status === 'ready') return 'review.status.queuedGenerate'
    return REVIEW_STATUS_KEY[item?.status] ?? null
  }
  if (phase === 'reflecting') {
    if (item?.status === 'running') return 'review.progress.reflecting'
    if (item?.status === 'ready') return 'review.status.ready'
    if (item?.status === 'blocked') return 'review.status.blocked'
    return 'review.progress.reflecting'
  }
  return REVIEW_STATUS_KEY[item?.status] ?? null
}

/**
 * カード左下に出す 1 行進行文（経過・心拍数・フェーズに応じた見出し）。
 *
 * @param {object} item `/api/review` の要素
 * @param {string} [sepStr] 区切り記号（`sep()`）
 * @param {number} [now] 現在時刻（テスト用）
 * @returns {string} 進行文
 */
export function reviewProgressText(item, sepStr = sep(), now = Date.now()) {
  if (!item) return ''
  const pr = item.progress || {}
  const ago = (ts) => {
    if (!ts) return null
    const s = Math.max(0, Math.round((now - ts) / 1000))
    if (s < 90) return t('review.ago.seconds', { n: s })
    if (s < 3600) return t('review.ago.minutes', { n: Math.round(s / 60) })
    return t('review.ago.hours', { n: Math.round(s / 3600) })
  }
  const phase = reviewPhase(item)
  if (item.status === 'running') {
    const beat = ago(pr.heartbeatAt)
    const since = ago(pr.startedAt)
    const head = phase === 'generating' ? t('review.progress.generating') : t('review.progress.reflecting')
    return [
      head,
      since ? t('review.progress.since', { ago: since }) : '',
      beat ? t('review.progress.beat', { ago: beat }) : '',
    ].join('')
  }
  if (item.status === 'ready') {
    return phase === 'generating' ? t('review.progress.generatingReady') : t('review.progress.ready')
  }
  if (phase === 'waiting') {
    const at = ago(pr.lastEventAt)
    return t('review.progress.waiting') + (at ? t('review.progress.presented', { ago: at }) : '')
  }
  if (phase === 'done') return t('review.progress.done') + (pr.lastEventAt ? ` ${sepStr} ${ago(pr.lastEventAt)}` : '')
  return ''
}

/**
 * 一覧 API の items を 4 段階（`generating` / `waiting` / `reflecting` / `done`）へ分ける。
 * 後方互換として `active`（`[...generating, ...reflecting]`）も併せて返す。
 *
 * @param {Array} items `/api/review` の items
 * @param {number} [doneLimit] 完了タブに残す件数
 * @returns {{generating: Array, waiting: Array, reflecting: Array, active: Array, done: Array, doneTotal: number}}
 */
export function groupItems(items, doneLimit = DONE_LIMIT) {
  const all = Array.isArray(items) ? items.filter(Boolean) : []
  const generating = all.filter(isGenerating)
  const waiting = all.filter(isWaiting)
  const reflecting = all.filter(isReflecting)
  const doneAll = all.filter((i) => i.status === 'done')
  return {
    generating,
    waiting,
    reflecting,
    active: [...generating, ...reflecting],
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

/**
 * OS アプリアイコンバッジに出す数（SPEC-PILOT-V3 §3.2 / D17①）。
 *
 * 基準は「人間の対応・判断待ちの合計」= レビュー判断待ち（`reviewWaiting`）
 * ＋ 承認待ち（`inboxPending`）。以前は実行中タスク数（`runningTasks`）を出していたため、
 * 自分が答えるべきものがあるのにバッジが 0 のままだった（逆に裏で動いているだけで数字が残った）。
 * 0 のときは呼び出し側が `clearAppBadge()` する（0 の丸を出さない）。
 *
 * @param {{reviewWaiting?: number, inboxPending?: number}} s 件数
 * @returns {number} バッジに出す数（0 以上・整数）
 */
export function appBadgeCount({ reviewWaiting = 0, inboxPending = 0 } = {}) {
  const clamp = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return clamp(reviewWaiting) + clamp(inboxPending)
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
 * 設問 JSON（`/api/review/:id/data`）を取りに行くか。
 *
 * ドロワー統合フォーム（`<StandardForm>`）・⚡ 推奨案で一括承認・完了後の回答履歴は
 * すべて `sheet.json` を材料にするので、注釈モード以外は必ず取る。
 *
 * 以前は `openItem` が `ak.mode !== 'standard'` で早期リターンしていたため、
 * `mode=sheet` で起票されたタスク（実体は `.json` を持つ）で `data === null` のまま
 * 生の `<IframeForm>` に落ちていた（SPEC-PILOT-V8 §3.1 / D38）。
 *
 * @param {object|null} review `item.review`（`{mode, sheet, ...}`）
 * @returns {boolean} 取得するか（`mode === 'annotation'` のときだけ false）
 */
export function shouldFetchSheetData(review) {
  return review?.mode !== 'annotation'
}

/**
 * 一覧行に生の `mode` バッジを出すか。
 *
 * `standard`（構造化 JSON）と `sheet`（HTML シート）は既定の表示形式なので、
 * 行に `sheet` と出しても人は何も判断できない。注釈など特殊モードだけ出す。
 *
 * @param {string|null|undefined} mode `review.mode`
 * @returns {boolean} 出すか
 */
export function shouldShowModeChip(mode) {
  return Boolean(mode) && mode !== 'standard' && mode !== 'sheet'
}

/**
 * 推奨の印。`recommended: true` のほか、**ラベルに推奨の語を含む選択肢**も推奨として扱う。
 *
 * シートを作る側（シート生成スキル）は `recommended: true` を付けるが、既存の資産には
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

