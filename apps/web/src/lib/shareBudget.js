/**
 * シェア文の「X（twitter-text）加重 280」予算（SPEC-SHARE280 §2.1 / D45）。
 *
 * React にも DOM にも依存しない純関数だけを置く（`apps/web/test/shareBudget.test.js` の対象）。
 * 数え方（weightedLength）は X の現行仕様をそのまま写したもの:
 * 既定は **2**、次の符号位置だけ **1**。
 *  - `U+0000–U+10FF`（ASCII・ラテン拡張・ギリシャ・キリル等）
 *  - `U+2000–U+200D`（全角スペース・ゼロ幅）
 *  - `U+2010–U+201F`（ハイフン・ダッシュ・引用符）
 *  - `U+2032–U+2037`（プライム・キャレット）
 *
 * したがって `🏆`（U+1F3C6）= 2、`·`（U+00B7）= 1、`—`（U+2014）= 1、`（`（U+FF08）= 2、改行 = 1。
 */

/** X（twitter-text）の加重上限。X が上限を変えたらここ 1 箇所だけを直す。 */
export const X_WEIGHT_LIMIT = 280

/**
 * 1 符号位置ぶんの加重。
 * @param {number} cp 符号位置（codePointAt の値）
 * @returns {1|2} 加重
 */
function cpWeight(cp) {
  if (cp <= 0x10ff) return 1
  if (cp >= 0x2000 && cp <= 0x200d) return 1
  if (cp >= 0x2010 && cp <= 0x201f) return 1
  if (cp >= 0x2032 && cp <= 0x2037) return 1
  return 2
}

/**
 * 文字列の X 加重長。サロゲートペアは 1 符号位置として数える（`🏆` = 2）。
 * @param {string} text 対象
 * @returns {number} 加重長
 */
export function xWeight(text) {
  if (!text) return 0
  let sum = 0
  for (const ch of String(text)) sum += cpWeight(ch.codePointAt(0))
  return sum
}

/**
 * 末尾を符号位置単位で削り、`…` の加重を含めて budget 以下にする（返り値は必ず `<= budget`）。
 *
 * `budget` に `…` すら入らないときは空文字を返す（空行は呼び出し側で落とす）。
 * 収まっているときは原文をそのまま返す（切り詰めた痕跡を残さない）。
 *
 * @param {string} text 対象
 * @param {number} budget 使える加重
 * @param {string} [ellipsis] 省略記号（既定 `…`）
 * @returns {string} 収めた文字列
 */
export function truncateToWeight(text, budget, ellipsis = '…') {
  const s = String(text ?? '')
  const limit = Number(budget)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  if (xWeight(s) <= limit) return s
  const tail = String(ellipsis ?? '')
  const tailWeight = xWeight(tail)
  if (tailWeight > limit) return ''
  const room = limit - tailWeight
  let used = 0
  let out = ''
  for (const ch of s) {
    const w = cpWeight(ch.codePointAt(0))
    if (used + w > room) break
    used += w
    out += ch
  }
  return `${out}${tail}`
}

/**
 * blocks を joiner で連結した加重が limit 以下になるまで steps を順に適用する。
 *
 * 各 step は「まだ超過しているときだけ」適用し、収まったら残りは適用しない。
 * 落とした block（空文字になったもの）は空行を残さず消す。
 *
 * step の形は 4 種:
 *  - `{ drop: i }`          … blocks[i] を落とす
 *  - `{ set: [i, text] }`   … blocks[i] を差し替える（空文字なら実質「親を外す」）
 *  - `{ truncate: i }`      … blocks[i] の末尾を `…` 付きで詰める（他の block の加重を引いた残予算で）
 *  - `{ cutAt: [i, sep] }`  … blocks[i] を sep の最後の出現より前で切り落とす
 *
 * @param {string[]} blocks 行（または段落）
 * @param {{limit?: number, joiner?: string, steps?: Array<object>}} [opts] 予算・連結子・段
 * @returns {{text: string, applied: number[]}} `applied` は実際に適用した step の index
 */
export function fitBlocks(blocks, { limit = X_WEIGHT_LIMIT, joiner = '\n', steps = [] } = {}) {
  const cur = (Array.isArray(blocks) ? blocks : []).map((b) => String(b ?? ''))
  const sep = String(joiner ?? '')
  const budget = Number(limit)
  const same = (list) => list.filter(Boolean).join(sep)
  const applied = []

  for (let idx = 0; idx < steps.length; idx += 1) {
    if (xWeight(same(cur)) <= budget) break
    const step = steps[idx]
    if (!step || typeof step !== 'object') continue

    if (Number.isInteger(step.drop)) {
      if (step.drop >= 0 && step.drop < cur.length) cur[step.drop] = ''
      applied.push(idx)
      continue
    }
    if (Array.isArray(step.set) && step.set.length === 2) {
      const i = Number(step.set[0])
      if (Number.isInteger(i) && i >= 0 && i < cur.length) cur[i] = String(step.set[1] ?? '')
      applied.push(idx)
      continue
    }
    if (Number.isInteger(step.truncate)) {
      const i = step.truncate
      if (i >= 0 && i < cur.length && cur[i]) {
        // 他の block が占める加重（内部の joiner 込み）＋ この block の直前の joiner を引く
        const others = cur.filter((b, j) => j !== i && b)
        const othersText = others.join(sep)
        const room = budget - xWeight(othersText) - (others.length ? xWeight(sep) : 0)
        cur[i] = truncateToWeight(cur[i], room)
      }
      applied.push(idx)
      continue
    }
    if (Array.isArray(step.cutAt) && step.cutAt.length === 2) {
      const i = Number(step.cutAt[0])
      const at = String(step.cutAt[1] ?? '')
      if (Number.isInteger(i) && i >= 0 && i < cur.length && at && cur[i].includes(at)) {
        cur[i] = cur[i].slice(0, cur[i].lastIndexOf(at)).trimEnd()
      }
      applied.push(idx)
    }
  }

  return { text: same(cur), applied }
}
