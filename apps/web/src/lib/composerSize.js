/**
 * 入力欄（textarea）を内容に合わせて伸ばすときの高さを返す。
 *
 * `box-sizing: border-box` の textarea は `scrollHeight`（padding を含む）を
 * そのまま height に入れると **枠（border）の分だけ足りない**。実測（390x844 の Chrome）:
 *   style.height = 57px → clientHeight 55 / scrollHeight 57 … 2px 溢れる
 * 溢れた textarea は Chrome が全高のスクロールバー（グレーの縦棒）を描くので、
 * 枠の分を足して「収まっているときは溢れない」ようにする。
 */
export function composerHeight({ scrollHeight = 0, clientHeight = 0, offsetHeight = 0, cap = 120 } = {}) {
  const border = Math.max(0, (offsetHeight || 0) - (clientHeight || 0))
  return Math.min(cap, scrollHeight + border)
}
