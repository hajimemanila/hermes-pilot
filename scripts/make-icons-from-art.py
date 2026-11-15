#!/usr/bin/env python3
"""正となるアート画像から PWA アイコン一式を作る（外部依存なし）。

入力は `docs/icon-proposal-2-maskable.png`（1024x1024・不透明フルブリード・図柄半径 0.216）。
`scripts/make-icons.py` は旧 H グリフをコードで描く版なので、**アート画像を差し替えたときは
こちらを使う**（同じアートから 5 種を作るので、favicon と PNG の見た目がずれない）。

白枠の再発防止（docs/PITFALLS.md P1 / P2）:
- 元画像は外周 1px まで不透明・背景は theme_color と同値の単色ベタ。**クロップも縮小も
  余白を足さない**ので alpha=255 のまま
- `any` は図柄をやや大きく見せるため中心をクロップしてから縮小する（半径 0.284 < 安全域 0.40）
- `maskable` はクロップしない（半径 0.216。マスクで切られない）

使い方: python3 scripts/make-icons-from-art.py
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "docs" / "icon-proposal-2-maskable.png"
OUT = ROOT / "apps" / "web" / "public"

# (出力名, 出力サイズ, 中心クロップ率) クロップ率 1.0 = 元画像をそのまま縮小
JOBS = [
    ("icon-192-v6.png", 192, 0.76),
    ("icon-512-v6.png", 512, 0.76),
    ("icon-maskable-192-v6.png", 192, 1.0),
    ("icon-maskable-512-v6.png", 512, 1.0),
    ("icon-180-v6.png", 180, 0.86),
]


def read_png(path: Path) -> tuple[int, int, bytes]:
    """8bit / 非インターレースの PNG を RGBA で返す。"""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"PNG ではない: {path}")
    pos = 8
    idat = bytearray()
    w = h = depth = ctype = interlace = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
    if depth != 8 or interlace != 0:
        raise SystemExit(f"8bit 非インターレースのみ対応: depth={depth} interlace={interlace}")
    chn = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(bytes(idat))
    stride = w * chn
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - chn] if x >= chn else 0
            b = prev[x]
            c = prev[x - chn] if x >= chn else 0
            if f == 1:
                line[x] = (line[x] + a) & 0xFF
            elif f == 2:
                line[x] = (line[x] + b) & 0xFF
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 0xFF
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        prev = line
        for x in range(w):
            o = (y * w + x) * 4
            s = x * chn
            if chn == 4:
                out[o:o + 4] = line[s:s + 4]
            elif chn == 3:
                out[o:o + 3] = line[s:s + 3]
                out[o + 3] = 255
            elif chn == 2:
                out[o] = out[o + 1] = out[o + 2] = line[s]
                out[o + 3] = line[s + 1]
            else:
                out[o] = out[o + 1] = out[o + 2] = line[s]
                out[o + 3] = 255
    return w, h, bytes(out)


def resample(src_w: int, src_h: int, src: bytes,
             crop_x: float, crop_y: float, crop_w: float, crop_h: float,
             dst: int) -> bytes:
    """矩形を面積平均で dst x dst に縮小する（アルファも同じ重みで平均）。"""
    x0, y0 = crop_x, crop_y
    x1, y1 = crop_x + crop_w, crop_y + crop_h
    scale_x = crop_w / dst
    scale_y = crop_h / dst
    out = bytearray(dst * dst * 4)
    for dy in range(dst):
        sy0 = y0 + dy * scale_y
        sy1 = sy0 + scale_y
        iy0, iy1 = int(sy0), min(int(sy1 - 1e-9) + 1, src_h)
        for dx in range(dst):
            sx0 = x0 + dx * scale_x
            sx1 = sx0 + scale_x
            ix0, ix1 = int(sx0), min(int(sx1 - 1e-9) + 1, src_w)
            r = g = b = a = 0.0
            wsum = 0.0
            for y in range(iy0, iy1):
                wy = min(sy1, y + 1) - max(sy0, y)
                if wy <= 0:
                    continue
                row = y * src_w
                for x in range(ix0, ix1):
                    wx = min(sx1, x + 1) - max(sx0, x)
                    if wx <= 0:
                        continue
                    wgt = wx * wy
                    o = (row + x) * 4
                    r += src[o] * wgt
                    g += src[o + 1] * wgt
                    b += src[o + 2] * wgt
                    a += src[o + 3] * wgt
                    wsum += wgt
            o = (dy * dst + dx) * 4
            out[o] = int(round(r / wsum))
            out[o + 1] = int(round(g / wsum))
            out[o + 2] = int(round(b / wsum))
            out[o + 3] = int(round(a / wsum))
    return bytes(out)


def write_png(path: Path, size: int, rgba: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    stride = size * 4
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(size))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def write_ico(path: Path, image: bytes, size: int) -> None:
    """PNG をそのまま 1 枚入れた ICO を書く（Vista 以降の PNG 埋め込み形式）。"""
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(image), 22)
    path.write_bytes(header + entry + image)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"正となるアートが見つからない: {SRC}")
    sw, sh, src = read_png(SRC)
    for name, size, crop in JOBS:
        cw = sw * crop
        ch = sh * crop
        rgba = resample(sw, sh, src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, size)
        write_png(OUT / name, size, rgba)
        print(f"{name}: {size}x{size} crop={crop} {len(rgba) // 1024}KiB")

    # 404 を残さないための favicon.ico（中身は同じアートの 32px）
    fav = OUT / "_favicon32.png"
    cw = sw * 0.86
    rgba = resample(sw, sh, src, (sw - cw) / 2, (sh - cw) / 2, cw, cw, 32)
    write_png(fav, 32, rgba)
    write_ico(OUT / "favicon.ico", fav.read_bytes(), 32)
    fav.unlink()
    print("favicon.ico: 32x32 (PNG-in-ICO)")


if __name__ == "__main__":
    main()
