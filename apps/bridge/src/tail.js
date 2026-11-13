import fs from 'node:fs'

/**
 * ファイル末尾から最大 `maxBytes` バイトだけを読み込む。
 * 肥大化したログや JSONL を全文 readFileSync しないための共通ヘルパー。
 * 境界で切れた先頭の不完全な 1 行は切り捨てる。
 *
 * @param {string} filePath ファイルパス
 * @param {number} [maxBytes] 読み込む最大バイト数
 * @returns {string} テキスト
 */
export function readTailText(filePath, maxBytes = 256 * 1024) {
  const limit = Math.max(1024, Number(maxBytes) || 256 * 1024)
  const stat = fs.statSync(filePath)
  if (stat.size <= limit) {
    return fs.readFileSync(filePath, 'utf8')
  }
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(limit)
    const bytesRead = fs.readSync(fd, buf, 0, limit, stat.size - limit)
    const raw = buf.subarray(0, bytesRead).toString('utf8')
    const nl = raw.indexOf('\n')
    return nl >= 0 ? raw.slice(nl + 1) : raw
  } finally {
    fs.closeSync(fd)
  }
}
