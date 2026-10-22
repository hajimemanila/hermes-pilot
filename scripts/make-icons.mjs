#!/usr/bin/env node
/**
 * PWA アイコンを生成する（依存なし・zlib で PNG を組み立てる）。
 * 別オリジンなので Hermes ダッシュボード / DSH とは別アイコンになる。
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname, '../apps/web/public')

/** CRC32 */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** PNG チャンク */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA バッファを PNG にする */
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 角丸矩形を描く */
function roundRect(rgba, W, H, x0, y0, x1, y1, r, color) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const dx = Math.min(x - x0, x1 - 1 - x)
      const dy = Math.min(y - y0, y1 - 1 - y)
      if (dx < r && dy < r) {
        const d = Math.hypot(r - dx, r - dy)
        if (d > r) continue
      }
      const i = (y * W + x) * 4
      rgba[i] = color[0]
      rgba[i + 1] = color[1]
      rgba[i + 2] = color[2]
      rgba[i + 3] = color[3]
    }
  }
}

/** 512 の原版を作る（背景 + H のグリフ） */
function master() {
  const S = 512
  const buf = Buffer.alloc(S * S * 4)
  // 背景: 深いティールの角丸四角
  roundRect(buf, S, S, 24, 24, S - 24, S - 24, 96, [10, 38, 44, 255])
  // アクセントの帯
  roundRect(buf, S, S, 24, 300, S - 24, S - 24, 96, [13, 90, 87, 255])
  // H のグリフ（2本の縦棒 + 横棒）
  roundRect(buf, S, S, 140, 132, 196, 380, 24, [94, 234, 212, 255])
  roundRect(buf, S, S, 316, 132, 372, 380, 24, [94, 234, 212, 255])
  roundRect(buf, S, S, 140, 232, 372, 288, 24, [94, 234, 212, 255])
  return { S, buf }
}

/** 高品質ダウンサンプル（box filter） */
function resize({ S, buf }, size) {
  if (size === S) return buf
  const out = Buffer.alloc(size * size * 4)
  const scale = S / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      const sx0 = Math.floor(x * scale)
      const sy0 = Math.floor(y * scale)
      const sx1 = Math.min(S, Math.floor((x + 1) * scale))
      const sy1 = Math.min(S, Math.floor((y + 1) * scale))
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * S + sx) * 4
          r += buf[i]
          g += buf[i + 1]
          b += buf[i + 2]
          a += buf[i + 3]
          n++
        }
      }
      const o = (y * size + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return out
}

mkdirSync(OUT, { recursive: true })
const m = master()
for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`)
  writeFileSync(file, png(size, size, resize(m, size)))
  console.log('wrote', file)
}
// maskable は余白を広めに取った別デザイン（中央 80%）
const mask = Buffer.alloc(512 * 512 * 4)
roundRect(mask, 512, 512, 0, 0, 512, 512, 0, [10, 38, 44, 255])
const inner = resize(m, 410)
for (let y = 0; y < 410; y++) {
  inner.copy(mask, ((y + 51) * 512 + 51) * 4, y * 410 * 4, (y + 1) * 410 * 4)
}
writeFileSync(path.join(OUT, 'icon-maskable-512.png'), png(512, 512, mask))
console.log('wrote icon-maskable-512.png')

writeFileSync(
  path.join(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="24" y="24" width="464" height="464" rx="96" fill="#0a262c"/>
  <rect x="24" y="300" width="464" height="188" rx="96" fill="#0d5a57"/>
  <g fill="#5eead4">
    <rect x="140" y="132" width="56" height="248" rx="24"/>
    <rect x="316" y="132" width="56" height="248" rx="24"/>
    <rect x="140" y="232" width="232" height="56" rx="24"/>
  </g>
</svg>`,
)
console.log('wrote icon.svg')
