/**
 * 新しい会話でリポジトリ（＝作業ディレクトリ）とボードを選ぶための純関数。
 *
 * 決定: レビュー `sheets/repo-picker-01-1.html` の 4 問すべて A。
 *  - Q1=A 同じシートに節を足す（プロファイル 3 行 + リポジトリの節）
 *  - Q2=A リポジトリから入る（板が複数あるときだけ次の段）
 *  - Q3=A 板が無いリポジトリは**確認してから作る**
 *  - Q4=A 選んだリポジトリは**この会話だけ**。次回は前回の値を初期値にする
 *
 * React にも localStorage にも依存させない（テストは Map 相当を渡す）。
 */

import { t } from '../i18n/lang.js'

/** 直近に選んだリポジトリ（次回の初期値）。 */
export const REPO_KEY = 'hm.repo'

/** 直近に選んだリポジトリの履歴（シートに出す 4 件を新しい順に）。 */
export const RECENT_REPOS_KEY = 'hm.repoRecent'

/** タスクタブ / クイック起票が読む「既定のボード」。選んだ repo の板に合わせる。 */
export const BOARD_KEY = 'hm.board'

/** 送信前の「新しい会話で選んだリポジトリ」（1通目送信・既存会話resumeまでのリロード復元用）。 */
export const PENDING_REPO_KEY = 'hm.pendingRepo'

/**
 * 直近に注釈を付けた対象リポジトリ（SPEC-ver-0-2-1 §2.1）。
 * 注釈シートを開くたびに対象が空へ戻る不具合を、この 1 キーで止める。
 */
export const REVIEW_REPO_KEY = 'hm.reviewRepo'

/** 履歴に残す件数。 */
export const RECENT_MAX = 6

/** シートに直接並べるリポジトリの数（Q1=A の 3 + 4 行）。 */
export const PINNED_ROWS = 4

/**
 * ボードの要約（行の補足文）。
 * @param {Array<{slug: string, name?: string, current?: boolean}>} boards その repo のボード
 * @returns {string} 例: `ボード 1 つ: hermes-mobile-pwa` / `ボードなし`
 */
export function boardSummary(boards) {
  const list = Array.isArray(boards) ? boards.filter(Boolean) : []
  if (!list.length) return t('repo.noBoard')
  const names = list.map((b) => String(b.slug ?? b.name ?? '')).filter(Boolean)
  if (!names.length) return t('repo.noBoard')
  const shown = names.slice(0, 3)
  const rest = names.length - shown.length
  const tail = rest > 0 ? t('repo.boardMore', { rest }) : ''
  return t('repo.boardCount', { count: names.length, names: shown.join(' / '), tail })
}

/**
 * 選ぶべきボード（複数あれば current → 先頭）。
 * @param {Array<{slug: string, current?: boolean}>} boards ボード
 * @returns {{slug: string, name?: string}|null} 決定（板が無ければ null）
 */
export function defaultBoard(boards) {
  const list = Array.isArray(boards) ? boards.filter((b) => b && b.slug) : []
  if (!list.length) return null
  return list.find((b) => b.current) ?? list[0]
}

/**
 * 保存された履歴を読む（壊れていても落とさない）。
 * @param {{getItem: Function}} [storage] 端末ストレージ
 * @returns {string[]} リポジトリ id（新しい順）
 */
export function readRecent(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(RECENT_REPOS_KEY)
    const arr = JSON.parse(raw ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => typeof x === 'string' && x).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/**
 * 直前に選んだリポジトリ id。
 * @param {{getItem: Function}} [storage] 端末ストレージ
 * @returns {string|null} id
 */
export function readLastRepo(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(REPO_KEY) || null
  } catch {
    return null
  }
}

/**
 * シートに直接並べるリポジトリ（履歴が先頭・足りない分は一覧の順で埋める）。
 *
 * @param {Array<{id: string}>} repos 全リポジトリ
 * @param {string[]} recent 履歴（新しい順）
 * @param {number} [limit] 並べる数
 * @returns {{rows: Array<object>, total: number, hidden: number}} 行と件数
 */
export function pinnedRepos(repos = [], recent = [], limit = PINNED_ROWS) {
  const all = Array.isArray(repos) ? repos.filter((r) => r && r.id) : []
  const byId = new Map(all.map((r) => [r.id, r]))
  const rows = []
  const seen = new Set()
  for (const id of recent) {
    const hit = byId.get(id)
    if (!hit || seen.has(id)) continue
    rows.push(hit)
    seen.add(id)
    if (rows.length >= limit) break
  }
  for (const r of all) {
    if (rows.length >= limit) break
    if (seen.has(r.id)) continue
    rows.push(r)
    seen.add(r.id)
  }
  return { rows, total: all.length, hidden: Math.max(0, all.length - rows.length) }
}

/** リポジトリ名の表示（長すぎる id を切らない。CSS 側で省略する）。 */
export function repoLabel(repo) {
  return String(repo?.label ?? repo?.id ?? '')
}

/**
 * 注釈の対象リポジトリの初期値（`hm.reviewRepo` → `hm.repo` → `''`）。
 *
 * `hm.reviewRepo` は「最後に注釈を付けた対象」、`hm.repo` は「最後に会話で選んだリポジトリ」。
 * 注釈をまだ一度も作っていない端末では会話側の選択に落ちるので、初回から空にならない。
 *
 * @param {{getItem: Function}} [storage] 端末ストレージ
 * @returns {string} repo id（無ければ空文字）
 */
export function readReviewRepo(storage = globalThis.localStorage) {
  try {
    const own = storage?.getItem(REVIEW_REPO_KEY)
    if (own) return String(own)
    const fallback = storage?.getItem(REPO_KEY)
    return fallback ? String(fallback) : ''
  } catch {
    return ''
  }
}

/**
 * 注釈の対象リポジトリを覚える（次に注釈シートを開いたときの初期値）。
 *
 * `hm.repo`（会話側の選択）は書き換えない。会話の既定リポジトリを注釈が乗っ取らないため。
 *
 * @param {{setItem: Function}} [storage] 端末ストレージ
 * @param {string} id 確定した対象リポジトリの id
 * @returns {string} 保存した id（保存できなければ空文字）
 */
export function rememberReviewRepo(storage = globalThis.localStorage, id = '') {
  const value = String(id ?? '')
  if (!storage || !value) return ''
  try {
    storage.setItem(REVIEW_REPO_KEY, value)
    return value
  } catch {
    return ''
  }
}

/**
 * 選んだリポジトリを覚える（Q4=A: この会話だけ・次回の初期値）。
 *
 * `hm.board` も同時に更新する。タスクタブとクイック起票はこれを既定のボードとして
 * 読むので、「repo を選ぶ → 起票がその repo の板に載る」がここで繋がる。
 *
 * @param {{getItem: Function, setItem: Function}} [storage] 端末ストレージ
 * @param {{id: string, board?: {slug: string}|null}} pick 選んだもの
 * @returns {{repo: string|null, board: string|null}} 保存した値
 */
export function rememberRepo(storage = globalThis.localStorage, pick = {}) {
  const id = String(pick?.id ?? '')
  const board = String(pick?.board?.slug ?? '')
  if (!storage) return { repo: null, board: null }
  try {
    if (id) storage.setItem(REPO_KEY, id)
    if (board) storage.setItem(BOARD_KEY, board)
    if (id) {
      const next = [id, ...readRecent(storage).filter((x) => x !== id)].slice(0, RECENT_MAX)
      storage.setItem(RECENT_REPOS_KEY, JSON.stringify(next))
    }
    return { repo: id || null, board: board || null }
  } catch {
    // ストレージが無い / 拒否された。会話は始められるので止めない
    return { repo: id || null, board: board || null }
  }
}

/**
 * `cwd` パスに一致するリポジトリを返す（大小文字・末尾スラッシュを正規化して比較）。
 * @param {Array<{id: string, path?: string}>} repos 全リポジトリ
 * @param {string|null|undefined} cwd セッションの作業ディレクトリ
 * @returns {object|null} 一致したリポジトリ
 */
export function matchRepoByCwd(repos = [], cwd = '') {
  const norm = (p) => String(p ?? '').trim().replace(/\/+$/, '').toLowerCase()
  const target = norm(cwd)
  if (!target || !Array.isArray(repos)) return null
  return repos.find((r) => r?.path && norm(r.path) === target) ?? null
}

/**
 * 送信前の「新しい会話で選んだリポジトリ」を読む。
 * @param {{getItem: Function}} [storage] 端末ストレージ
 * @returns {{repoId: string, profile: string}|null} 保存された選択
 */
export function readPendingRepo(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PENDING_REPO_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.repoId !== 'string' || !parsed.repoId) return null
    return { repoId: parsed.repoId, profile: typeof parsed.profile === 'string' && parsed.profile ? parsed.profile : '' }
  } catch {
    return null
  }
}

/**
 * 送信前の「新しい会話で選んだリポジトリ」を保存・消去する。
 * @param {{setItem: Function, removeItem?: Function}} [storage] 端末ストレージ
 * @param {{repoId: string, profile?: string}|null} pending 保存する選択（null で消去）
 */
export function writePendingRepo(storage = globalThis.localStorage, pending = null) {
  if (!storage) return
  try {
    if (pending?.repoId) {
      storage.setItem(PENDING_REPO_KEY, JSON.stringify({ repoId: pending.repoId, profile: pending.profile || '' }))
    } else {
      storage.removeItem?.(PENDING_REPO_KEY)
    }
  } catch {
    /* noop */
  }
}
