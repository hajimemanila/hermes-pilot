/**
 * 監査ログの折りたたみ（SPEC-PILOT-V3 §3.4 / D19-A）。
 *
 * 設定タブの監査カードは最新 8 件だけを既定表示し、9 件目以降は
 * アコーディオンで開閉する。表示の判断（何件出すか・ボタンを出すか）は
 * 純関数に閉じ込めてユニットテストで固定する（JSX に条件式を散らさない）。
 */

/** 既定表示件数（SPEC §3.4 の `AUDIT_PREVIEW_LIMIT`）。 */
export const AUDIT_PREVIEW_LIMIT = 8

/**
 * 監査ログ（新しい順に並べた配列）を、表示分と折りたたみ分に分ける。
 *
 * - `expanded` が真なら全件を返す（`hiddenCount` は変わらない＝ボタンの文言用）
 * - 件数が上限以下なら `canExpand` が偽になり、呼び出し側はボタンを描かない
 * - 入力が配列でなくても落ちない（API 失敗時は `null` が入り得る）
 *
 * @param {unknown} list 監査ログ（新しい順）
 * @param {{limit?: number, expanded?: boolean}} [opts] 上限と展開状態
 * @returns {{visible: object[], hiddenCount: number, canExpand: boolean, expanded: boolean}} 表示用
 */
export function foldAudit(list, { limit = AUDIT_PREVIEW_LIMIT, expanded = false } = {}) {
  const all = Array.isArray(list) ? list : []
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : AUDIT_PREVIEW_LIMIT
  const hiddenCount = Math.max(0, all.length - cap)
  const canExpand = hiddenCount > 0
  return {
    visible: canExpand && expanded ? all : all.slice(0, cap),
    hiddenCount,
    canExpand,
    expanded: canExpand && Boolean(expanded),
  }
}
