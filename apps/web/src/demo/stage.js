/**
 * デモ筐体の寸法計算（React に依存しない純関数）。
 *
 * `DemoStage.jsx` から使う。JSX を含まないので `node --test` から直接 import できる
 * （筐体は 390x844 / 820x1180 の実寸で組み、`transform: scale()` で画面に収める）。
 */

/** 筐体の実寸（CSS px）。`full` は筐体を出さない。 */
export const VIEWS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  full: null,
}

/** 筐体を出す下限幅（これ未満はスマホ実機とみなして全画面）。 */
export const STAGE_MIN_WIDTH = 900

/**
 * 筐体の拡大率。使える領域に収まる最大倍率（1 を超えない・0.1 を下回らない）。
 *
 * @param {{width: number, height: number}|null} size 実寸
 * @param {number} availW 使える幅
 * @param {number} availH 使える高さ
 * @returns {number} 0.1..1
 */
export function fitScale(size, availW, availH) {
  if (!size) return 1
  const w = Math.max(0, Number(availW) || 0)
  const h = Math.max(0, Number(availH) || 0)
  if (!w || !h) return 1
  return Math.max(0.1, Math.min(1, Math.min(w / size.width, h / size.height)))
}
