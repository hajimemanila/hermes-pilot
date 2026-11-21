/**
 * ペアリング用 QR コードと接続先候補の検出（SPEC §8.1 / §8.2、Batch T6）。
 *
 * 依存ゼロの QR エンコーダ（byte モード・UTF-8・誤り訂正レベル M・型番 1〜10）。
 * - 型番 10-M で 213 バイトまで入る。ペアリング URL（`https://<host>/?token=<64hex>`）は
 *   80 バイト前後なので余裕がある。それ以上は明示的に失敗させる（黙って切らない）。
 * - SVG は `shape-rendering="crispEdges"` の 1 パス。ターミナルは ANSI 背景色つきの
 *   半角ブロック（`▀▄█`）2 モジュール分を 1 行に圧縮して出す。
 *
 * 検証方針（重要）: 生成したモジュール行列は **qrencode(1) の PBM 出力と完全一致**することを
 * 単体テスト（`apps/bridge/test/qr.test.js`）で確かめている。目視に頼らない。
 */

import os from 'node:os'
import zlib from 'node:zlib'

/** 誤り訂正レベル M のブロック構造（型番: [EC コードワード/ブロック, 群1ブロック数, 群1データ長, 群2ブロック数, 群2データ長]）。 */
const ECC_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
}

/** 誤り訂正レベル M の識別ビット（仕様では 00）。 */
const ECL_M_BITS = 0b00

/** 対応する最大型番。 */
export const MAX_VERSION = 10

/** 隅の余白（モジュール数）。仕様の 4 モジュールを既定にする。 */
export const DEFAULT_MARGIN = 4

// --- Reed-Solomon (GF(256)) -------------------------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

/**
 * GF(256) の掛け算。
 * @param {number} a 左辺
 * @param {number} b 右辺
 * @returns {number} 積
 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/**
 * 生成多項式（最高次が 1）の係数列。
 * @param {number} degree 次数
 * @returns {Uint8Array} 係数（次数の降順、先頭は常に 1）
 */
function rsDivisor(degree) {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/**
 * データコードワードから誤り訂正コードワードを作る。
 * @param {Uint8Array|number[]} data データコードワード
 * @param {number} ecLen 生成する EC コードワード数
 * @returns {Uint8Array} EC コードワード
 */
export function reedSolomon(data, ecLen) {
  const divisor = rsDivisor(ecLen)
  const result = new Uint8Array(ecLen)
  for (const b of data) {
    const factor = b ^ result[0]
    result.copyWithin(0, 1)
    result[ecLen - 1] = 0
    for (let i = 0; i < ecLen; i++) result[i] ^= gfMul(divisor[i], factor)
  }
  return result
}

// --- ビット列・コードワード -------------------------------------------------

/** ビット列ビルダー。 */
class BitStream {
  constructor() {
    this.bits = []
  }

  /**
   * @param {number} value 値
   * @param {number} len ビット長
   */
  push(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }

  /** @returns {number[]} バイト配列 */
  toBytes() {
    const out = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0)
      out.push(b)
    }
    return out
  }
}

/**
 * 型番ごとのデータ容量（コードワード数）。
 * @param {number} version 型番
 * @returns {number} データコードワード数
 */
function dataCodewords(version) {
  const [, b1, d1, b2, d2] = ECC_M[version]
  return b1 * d1 + b2 * d2
}

/**
 * 文字数指示子のビット長（byte モード）。
 * @param {number} version 型番
 * @returns {number} ビット長
 */
function countBits(version) {
  return version <= 9 ? 8 : 16
}

/**
 * 生のデータモジュール数（余りビット込み）。
 * @param {number} version 型番
 * @returns {number} モジュール数
 */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/**
 * 入力バイト列を型番に合わせてコードワード化し、ブロック間でインターリーブする。
 * @param {Uint8Array} bytes 入力（UTF-8）
 * @param {number} version 型番
 * @returns {number[]} 最終コードワード列（データ→EC の順にインターリーブ済み）
 */
export function buildCodewords(bytes, version) {
  const [ecLen, b1, d1, b2, d2] = ECC_M[version]
  const capacityBits = dataCodewords(version) * 8
  const stream = new BitStream()
  stream.push(0b0100, 4)
  stream.push(bytes.length, countBits(version))
  for (const b of bytes) stream.push(b, 8)
  // 終端（最大 4 ビット）→ バイト境界まで 0
  const terminator = Math.min(4, capacityBits - stream.bits.length)
  stream.push(0, terminator)
  while (stream.bits.length % 8 !== 0) stream.push(0, 1)
  const data = stream.toBytes()
  // 埋め草（0xEC / 0x11 の交互）
  const total = dataCodewords(version)
  for (let i = 0; data.length < total; i++) data.push(i % 2 === 0 ? 0xec : 0x11)

  const blocks = []
  let offset = 0
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2
    const chunk = data.slice(offset, offset + len)
    offset += len
    blocks.push({ data: chunk, ecc: Array.from(reedSolomon(chunk, ecLen)) })
  }

  const out = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) out.push(b.ecc[i])
  }
  return out
}

// --- 行列 -------------------------------------------------------------------

/** BCH(15,5) で形式情報を作る。 */
function formatBits(mask) {
  const data = (ECL_M_BITS << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** BCH(18,6) で型番情報を作る。 */
function versionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

/** 位置検出パターンの中心座標。 */
function alignmentPositions(version) {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

/**
 * キャンバス（モジュール行列＋機能モジュール印）を作る。
 * @param {number} version 型番
 * @returns {{size: number, modules: Uint8Array, func: Uint8Array}} キャンバス
 */
function createCanvas(version) {
  const size = version * 4 + 17
  const modules = new Uint8Array(size * size)
  const func = new Uint8Array(size * size)
  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0
    func[y * size + x] = 1
  }

  // 位置検出パターン＋分離パターン
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, dist !== 2 && dist !== 4)
      }
    }
  }

  // タイミングパターン
  for (let i = 0; i < size; i++) {
    if (!func[6 * size + i]) set(i, 6, i % 2 === 0)
    if (!func[i * size + 6]) set(6, i, i % 2 === 0)
  }

  // 位置合わせパターン
  const pos = alignmentPositions(version)
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // 位置検出パターンと重なる 3 箇所は置かない
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // 形式情報・型番情報の領域を予約する（値は後で書く）
  const reserve = (x, y) => {
    func[y * size + x] = 1
  }
  for (let i = 0; i <= 5; i++) reserve(8, i)
  reserve(8, 7)
  reserve(8, 8)
  reserve(7, 8)
  for (let i = 9; i < 15; i++) reserve(14 - i, 8)
  for (let i = 0; i < 8; i++) reserve(size - 1 - i, 8)
  for (let i = 8; i < 15; i++) reserve(8, size - 15 + i)
  reserve(8, size - 8)

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      reserve(a, b)
      reserve(b, a)
    }
  }

  return { size, modules, func, set }
}

/** マスク条件。 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      throw new Error(`mask out of range: ${mask}`)
  }
}

/** 形式情報・型番情報を書き込む（対象は渡された modules 配列。func は既に予約済み）。 */
function drawFormatAndVersion(modules, size, version, mask) {
  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0
  }
  const bits = formatBits(mask)
  const bit = (i) => ((bits >>> i) & 1) !== 0
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
  set(8, size - 8, true) // 常時ダーク

  if (version >= 7) {
    const vbits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, dark)
      set(b, a, dark)
    }
  }
}

/** データコードワードをジグザグに配置する。 */
function drawCodewords(canvas, codewords) {
  const { size, modules, func } = canvas
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (func[y * size + x]) continue
        if (i < codewords.length * 8) {
          modules[y * size + x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1
          i++
        }
        // 余りビットは 0 のまま（既に 0）
      }
    }
  }
}

/** マスクを適用する（機能モジュールは変えない）。 */
function applyMask(canvas, mask) {
  const { size, modules, func } = canvas
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (func[y * size + x]) continue
      if (maskBit(mask, x, y)) modules[y * size + x] ^= 1
    }
  }
}

/** ペナルティ（仕様の 4 規則）。 */
function penalty(modules, size) {
  const N1 = 3
  const N2 = 3
  const N3 = 40
  const N4 = 10
  let result = 0

  const finderPenaltyAddHistory = (runLength, history) => {
    let len = runLength
    if (history[0] === 0) len += size
    history.copyWithin(1, 0, history.length - 1)
    history[0] = len
  }
  const finderPenaltyCount = (history) => {
    const n = history[1]
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  }

  const scan = (get) => {
    for (let a = 0; a < size; a++) {
      let runColor = false
      let runLen = 0
      const history = new Int32Array(7)
      for (let b = 0; b < size; b++) {
        if (get(a, b) === runColor) {
          runLen++
          if (runLen === 5) result += N1
          else if (runLen > 5) result++
        } else {
          finderPenaltyAddHistory(runLen, history)
          if (!runColor) result += finderPenaltyCount(history) * N3
          runColor = get(a, b)
          runLen = 1
        }
      }
      if (runColor) {
        finderPenaltyAddHistory(runLen, history)
        runLen = 0
      }
      runLen += size
      finderPenaltyAddHistory(runLen, history)
      result += finderPenaltyCount(history) * N3
    }
  }

  scan((y, x) => modules[y * size + x] !== 0) // 行
  scan((x, y) => modules[y * size + x] !== 0) // 列

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y * size + x]
      if (c === modules[y * size + x + 1] && c === modules[(y + 1) * size + x] && c === modules[(y + 1) * size + x + 1]) {
        result += N2
      }
    }
  }

  let dark = 0
  for (const v of modules) dark += v ? 1 : 0
  const total = size * size
  const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1
  result += k * N4
  return result
}

/**
 * 型番を選ぶ（誤り訂正レベル M・byte モード）。
 * @param {number} byteLength 入力バイト長
 * @returns {number} 型番
 */
export function chooseVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacityBits = dataCodewords(v) * 8
    const needed = 4 + countBits(v) + byteLength * 8
    if (needed <= capacityBits) return v
  }
  throw new Error(`PAIRING_TOO_LONG: ${byteLength} bytes exceeds version ${MAX_VERSION}-M capacity`)
}

/**
 * QR コードのモジュール行列を作る（余白なし）。
 * @param {string} text 内容
 * @param {object} [opts] オプション
 * @param {number} [opts.mask] マスク番号を固定する（未指定ならペナルティ最小を選ぶ）
 * @returns {{size: number, version: number, modules: boolean[][], mask: number}} 行列
 */
export function qrMatrix(text, { mask } = {}) {
  const bytes = new Uint8Array(Buffer.from(String(text), 'utf8'))
  const version = chooseVersion(bytes.length)
  const codewords = buildCodewords(bytes, version)
  const canvas = createCanvas(version)
  drawCodewords(canvas, codewords)

  let best = null
  const masks = typeof mask === 'number' ? [mask] : [0, 1, 2, 3, 4, 5, 6, 7]
  for (const m of masks) {
    const trial = {
      size: canvas.size,
      modules: canvas.modules.slice(),
      func: canvas.func,
      set: canvas.set,
    }
    applyMask(trial, m)
    drawFormatAndVersion(trial.modules, trial.size, version, m)
    const score = penalty(trial.modules, trial.size)
    if (!best || score < best.score) best = { score, modules: trial.modules, mask: m }
  }

  const { size } = canvas
  const grid = []
  for (let y = 0; y < size; y++) {
    const row = []
    for (let x = 0; x < size; x++) row.push(best.modules[y * size + x] !== 0)
    grid.push(row)
  }
  return { size, version, modules: grid, mask: best.mask }
}

/**
 * QR コードを SVG にする（外部依存なし・1 パス）。
 * @param {string} text 内容
 * @param {object} [opts] オプション
 * @param {number} [opts.margin] 余白モジュール数（既定 4）
 * @param {number} [opts.scale] 1 モジュールのピクセル数（既定: viewBox は 1 単位）
 * @param {string} [opts.dark] 暗色
 * @param {string} [opts.light] 明色
 * @param {string} [opts.title] アクセシブル名
 * @returns {string} SVG 文字列
 */
export function qrSvg(text, { margin = DEFAULT_MARGIN, dark = '#0a0f14', light = '#ffffff', title = 'Pairing QR' } = {}) {
  const { size, modules } = qrMatrix(text)
  const total = size + margin * 2
  let path = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue
      path += `M${x + margin} ${y + margin}h1v1h-1z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${total * 8}" height="${total * 8}" role="img" aria-label="${escapeXml(title)}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  )
}

/**
 * 端末表示用の文字列をやめ、**画像**として書き出せる PNG を組み立てる。
 *
 * 端末の半角ブロックは行間（セルの隙間）が背景色で塗られず、カメラから見ると
 * 暗い横縞が QR を横切るため読み取れない（実測: 80x24 の端末で別端末のスキャナも無反応）。
 * モジュールを整数ピクセルで描いた PNG なら、画面でも印刷でも読める。
 *
 * 形式は 8bit グレースケール（colorType 0）。依存ゼロ（`node:zlib` のみ）。
 * @param {string} text 内容
 * @param {object} [opts] オプション
 * @param {number} [opts.margin] 余白モジュール数（既定 4）
 * @param {number} [opts.scale] 1 モジュールのピクセル数（既定 10）
 * @returns {Buffer} PNG バイト列
 */
export function qrPng(text, { margin = 4, scale = 10 } = {}) {
  const { size, modules } = qrMatrix(text)
  const total = size + margin * 2
  const w = total * scale
  // 1 行 = フィルタ種別 1 バイト + グレースケール w バイト
  const raw = Buffer.alloc((w + 1) * w, 0xff)
  // フィルタ種別は 0（None）でなければならない（0xff のままだと不正な PNG になる）
  for (let y = 0; y < w; y += 1) raw[y * (w + 1)] = 0x00
  for (let my = 0; my < size; my += 1) {
    for (let mx = 0; mx < size; mx += 1) {
      if (!modules[my][mx]) continue
      const x0 = (mx + margin) * scale
      const y0 = (my + margin) * scale
      for (let y = y0; y < y0 + scale; y += 1) {
        const rowStart = y * (w + 1) + 1
        raw.fill(0x00, rowStart + x0, rowStart + x0 + scale)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filter
  ihdr[12] = 0 // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC32（PNG のチャンク用）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * PNG のチャンク（長さ・種別・データ・CRC）。
 * @param {string} type 種別（4 文字）
 * @param {Buffer} data データ
 * @returns {Buffer} チャンク
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([len, body, crcBuf])
}

/**
 * QR のモジュール行列を 0/1 の文字列配列にする（フロントエンドが canvas に
 * 整数ピクセルで描くための形。SVG を CSS で縮小すると、モジュールが半端な
 * ピクセルになりスキャナが反応しない）。
 * @param {string} text 内容
 * @returns {string[]} 1 行 1 文字列（'1' = 暗）
 */
export function qrRows(text) {
  const { modules } = qrMatrix(text)
  return modules.map((row) => row.map((v) => (v ? '1' : '0')).join(''))
}

/**
 * ターミナル表示用の文字列（ANSI 背景色つき半角ブロック）。
 *
 * 端末の前景/背景色に左右されないよう、各行を「白背景・黒前景」に固定して描く。
 * これでダークテーマでもライトテーマでも、暗モジュールが暗く出る（QR の極性が崩れない）。
 * @param {string} text 内容
 * @param {object} [opts] オプション
 * @param {number} [opts.margin] 余白モジュール数（既定 2。端末では 4 は広すぎる）
 * @param {boolean} [opts.color] ANSI 色を使う（既定 true）
 * @returns {string} 表示用文字列
 */
export function qrTerminal(text, { margin = 2, color = true } = {}) {
  const { size, modules } = qrMatrix(text)
  const total = size + margin * 2
  const at = (x, y) => {
    const mx = x - margin
    const my = y - margin
    if (mx < 0 || my < 0 || mx >= size || my >= size) return false
    return modules[my][mx]
  }
  const reset = color ? '\x1b[0m' : ''
  const paint = color ? '\x1b[30;47m' : ''
  const lines = []
  for (let y = 0; y < total; y += 2) {
    let line = ''
    for (let x = 0; x < total; x++) {
      const top = at(x, y)
      const bottom = y + 1 < total ? at(x, y + 1) : false
      // 前景=黒・背景=白なので、ブロック（█）が暗モジュールになる
      const ch = top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
      line += color ? ch : ch === ' ' ? '  ' : ch === '█' ? '██' : ch === '▀' ? '▀▀' : '▄▄'
    }
    lines.push(`${paint}${line}${reset}`)
  }
  return lines.join('\n')
}

/**
 * XML 用のエスケープ。
 * @param {string} s 文字列
 * @returns {string} エスケープ済み
 */
function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
}

// --- 接続先候補の検出 -------------------------------------------------------

/**
 * LAN の IPv4 を 1 つ選ぶ。
 *
 * 優先順は ①家用の `192.168.*` ②その他のプライベート/グローバル IPv4 ③Tailscale の CGNAT
 * (`100.64.0.0/10`)。loopback・link-local (`169.254.*`) は常に除外する。
 * @param {Record<string, Array<{address: string, family: string|number, internal: boolean}>>} [ifaces] `os.networkInterfaces()` の戻り
 * @returns {string|null} IP または null
 */
export function detectLanIp(ifaces = os.networkInterfaces()) {
  const ranked = []
  for (const list of Object.values(ifaces ?? {})) {
    for (const addr of list ?? []) {
      const family = typeof addr.family === 'string' ? addr.family : addr.family === 4 ? 'IPv4' : 'IPv6'
      if (family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      const [a, b] = addr.address.split('.').map(Number)
      const cgnat = a === 100 && b >= 64 && b <= 127
      const rank = cgnat ? 2 : addr.address.startsWith('192.168.') ? 0 : 1
      ranked.push({ rank, ip: addr.address })
    }
  }
  ranked.sort((x, y) => x.rank - y.rank)
  return ranked[0]?.ip ?? null
}

/**
 * Tailscale CLI の候補（PATH に無い macOS アプリ版のバイナリも見る）。
 *
 * 常駐プロセス（launchd / systemd）からアプリ版バイナリを叩くと
 * 「The Tailscale GUI failed to start」を返す環境があるため、候補を広げつつ
 * `HP_TAILSCALE_BIN` で明示指定できるようにする（読み取れなければ LAN 候補に落ちる）。
 * @param {string} [platform] `process.platform`
 * @param {object} [opts] 差し替え
 * @param {Record<string, string|undefined>} [opts.env] 環境変数
 * @returns {string[]} 候補コマンド
 */
export function tailscaleCommandCandidates(platform = process.platform, { env = process.env } = {}) {
  const out = []
  const override = String(env?.HP_TAILSCALE_BIN ?? '').trim()
  if (override) out.push(override)
  out.push('tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale')
  if (platform === 'darwin') out.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  return [...new Set(out)]
}

/**
 * `tailscale status --json` の出力から MagicDNS 名を取り出す。
 * @param {string|object} status JSON 文字列またはオブジェクト
 * @returns {string|null} `mac-mini.tail1234.ts.net` 形式（末尾ドット無し）または null
 */
export function parseTailscaleDnsName(status) {
  let json = status
  if (typeof status === 'string') {
    try {
      json = JSON.parse(status)
    } catch {
      return null
    }
  }
  const name = json?.Self?.DNSName
  if (typeof name !== 'string' || !name.trim()) return null
  return name.trim().replace(/\.$/, '')
}

/**
 * ペアリング URL の候補を組み立てる（Tailscale → LAN → localhost の順）。
 * @param {object} opts 入力
 * @param {string} opts.token トークン
 * @param {number} [opts.port] ブリッジのポート
 * @param {string|null} [opts.dnsName] Tailscale MagicDNS 名
 * @param {string|null} [opts.lanIp] LAN IP
 * @param {number} [opts.tlsPort] Tailscale serve の HTTPS ポート（未指定なら 443 相当）
 * @returns {Array<{kind: string, url: string, label: string}>} 候補
 */
export function pairingTargets({ token, port = 4097, dnsName = null, lanIp = null, tlsPort = null } = {}) {
  const q = `?token=${encodeURIComponent(String(token ?? ''))}`
  const out = []
  if (dnsName) {
    const suffix = tlsPort && Number(tlsPort) !== 443 ? `:${tlsPort}` : ''
    out.push({ kind: 'tailscale', url: `https://${dnsName}${suffix}/${q}`, label: 'Tailscale (HTTPS)' })
  }
  if (lanIp) out.push({ kind: 'lan', url: `http://${lanIp}:${port}/${q}`, label: 'LAN' })
  out.push({ kind: 'local', url: `http://127.0.0.1:${port}/${q}`, label: 'This machine' })
  return out
}

/**
 * 既定で QR に焼く 1 本を選ぶ（Tailscale があればそれ、無ければ LAN）。
 * @param {Array<{kind: string, url: string}>} targets 候補
 * @returns {{kind: string, url: string}|null} 先頭候補
 */
export function bestTarget(targets) {
  return Array.isArray(targets) && targets.length ? targets[0] : null
}

/**
 * 候補検出の材料をまとめて 1 つの応答にする（サーバと CLI の共通経路）。
 * @param {object} opts 入力
 * @param {string} opts.token トークン
 * @param {number} [opts.port] ブリッジのポート
 * @param {string|null} [opts.tailscaleJson] `tailscale status --json` の生出力
 * @param {string|null} [opts.dnsName] MagicDNS 名の明示指定（CLI を叩けない環境の控え）
 * @param {string|null} [opts.lanIp] LAN IP（未指定なら自動検出）
 * @param {number|null} [opts.tlsPort] Tailscale serve の HTTPS ポート
 * @param {Record<string, any>} [opts.ifaces] `os.networkInterfaces()` の差し替え
 * @returns {{targets: Array<{kind: string, url: string, label: string}>, best: {kind: string, url: string, label: string}|null, dnsName: string|null, lanIp: string|null}} 結果
 */
export function collectPairing({ token, port = 4097, tailscaleJson = null, dnsName: explicitDns = null, lanIp, tlsPort = null, ifaces } = {}) {
  // CLI の応答が取れない常駐環境（launchd からアプリ版 Tailscale を叩けない等）では
  // 設定ファイルの `tailscaleDns` を控えとして使う。どちらも無ければ LAN 候補だけ。
  const fromJson = tailscaleJson ? parseTailscaleDnsName(tailscaleJson) : null
  const fallback = typeof explicitDns === 'string' ? explicitDns.trim().replace(/\.$/, '') : ''
  const dnsName = fromJson || fallback || null
  const resolvedLan = lanIp ?? detectLanIp(ifaces ?? os.networkInterfaces())
  const targets = pairingTargets({ token, port, dnsName, lanIp: resolvedLan, tlsPort })
  return { targets, best: bestTarget(targets), dnsName, lanIp: resolvedLan }
}
