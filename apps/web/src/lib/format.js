/** 表示用の数値フォーマット（1MB単位の桁を落とさず、狭い画面でも読める長さにする）。 */

/** コスト: 0.01 未満は有効数字3桁、それ以上は2桁。 */
export function fmtCost(n) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v <= 0) return '$0'
  if (v < 0.01) return `$${v.toPrecision(2)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** トークン数: 1.97M / 257.9M / 12.3k / 842。 */
export function fmtTokens(n) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(Math.round(v))
}

/** 比率（0..1）を % に。null は '—'。 */
export function fmtPct(r) {
  if (r == null || !Number.isFinite(r)) return '—'
  const p = r * 100
  if (p >= 99.95) return '100%'
  return `${p.toFixed(1)}%`
}
