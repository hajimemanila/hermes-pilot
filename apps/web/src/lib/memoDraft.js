/**
 * メモ編集シートの未保存判定（SPEC-ver-0-2-1 §2.2 / Q3=A）。
 *
 * シートを閉じる経路は `Sheet` の `onClose` 1 箇所（背景タップ・✕・端末の戻る）に
 * 集約されているので、判定は純関数にしてここへ置く。React にも storage にも触れない。
 *
 * 比較対象は 6 フィールドだけ（`id` や `kind` は編集 UI から変わらないため入れない）。
 * チェックリストは配列の順序も比較する — 並べ替えも未保存の変更として扱う。
 */

/** 比較対象のフィールド。順序は JSON 文字列の安定性のため固定。 */
export const DRAFT_FIELDS = ['title', 'body', 'tagsText', 'color', 'pinned', 'checklist']

const asText = (v) => (v == null ? '' : String(v))

function asChecklist(list) {
  if (!Array.isArray(list)) return []
  return list.map((c) => ({
    id: asText(c?.id),
    text: asText(c?.text),
    done: Boolean(c?.done),
  }))
}

/**
 * 下書きの比較用スナップショット（JSON 文字列）。
 * 開いた時点の値を保存しておき、閉じるときに現在値と比べる。
 * @param {{title?: string, body?: string, tagsText?: string, color?: string,
 *          pinned?: boolean, checklist?: Array<object>}|null|undefined} draft
 * @returns {string}
 */
export function draftSnapshot(draft) {
  const src = draft ?? {}
  const out = {}
  for (const key of DRAFT_FIELDS) {
    if (key === 'checklist') out[key] = asChecklist(src.checklist)
    else if (key === 'pinned') out[key] = Boolean(src.pinned)
    else out[key] = asText(src[key])
  }
  return JSON.stringify(out)
}

/**
 * 新規メモに保存する中身が 1 つでも入っているか。
 * `tagsText` の既定値（`idea`）や `color` の既定値は数えない — 開いただけで
 * 「未保存の変更あり」になるのを避けるため。
 * @param {object|null|undefined} draft
 * @returns {boolean}
 */
export function hasDraftContent(draft) {
  if (!draft) return false
  if (asText(draft.title).trim()) return true
  if (asText(draft.body).trim()) return true
  return asChecklist(draft.checklist).length > 0
}

/**
 * 閉じる前に確認が要るか（＝未保存の変更があるか）。
 *
 * - 既存メモ（`baseline` あり）: 開いた時点のスナップショットとの差分。
 * - 新規メモ（`baseline` が `null`）: 本文かタイトルが 1 文字以上、または
 *   チェックリストが 1 件以上あれば dirty。空のまま閉じるのは確認しない。
 *
 * @param {object|null|undefined} current 現在の下書き
 * @param {string|object|null|undefined} baseline `draftSnapshot()` の戻り値（新規は `null`）
 * @returns {boolean}
 */
export function isDraftDirty(current, baseline) {
  if (!current) return false
  if (baseline == null || baseline === '') return hasDraftContent(current)
  const base = typeof baseline === 'string' ? baseline : draftSnapshot(baseline)
  return draftSnapshot(current) !== base
}
