/**
 * レビュービューの小さいチップ（`ReviewPane.jsx` から切り出し）。
 *
 * 一覧の行・設問フォームの「推奨」・読取専用の詳細が同じ見た目（`.ak-chip`）を使うので、
 * 定義はここ 1 箇所だけに置く。
 */

export function Chip({ tone, children }) {
  return <span className={`ak-chip ${tone || ''}`}>{children}</span>
}
