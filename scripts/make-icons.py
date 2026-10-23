#!/usr/bin/env python3
"""PWA アイコンの生成（外部依存なし）。

HyperOS / Android のスキール（角丸）マスクで白い枠が出ないように、
**キャンバスの四隅まで背景色で塗り切る**フルブリードで描く。

- `any`      : 図柄を大きめ（0.68）に置いた通常アイコン
- `maskable` : セーフゾーン（中心 80%）に収まる 0.56 の図柄。`any maskable` としても使える

使い方: python3 scripts/make-icons.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "apps" / "web" / "public"

BG_TOP = (11, 47, 54)      # #0b2f36
BG_BOTTOM = (6, 22, 26)    # #06161a
GLYPH = (70, 224, 200)     # #46e0c8
GLYPH_SHADOW = (18, 96, 92)

SS = 4  # スーパーサンプリング倍率


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def blend(dst, src, a: float):
    return tuple(int(round(lerp(dst[i], src[i], a))) for i in range(3))


def rounded_bar(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """角丸長方形（x0..x1, y0..y1, 角半径 r）の内側か。"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def glyph_cov(x: float, y: float, s: float, scale: float) -> tuple[float, float]:
    """H の字形。戻り値 = (本体カバレッジ, 影カバレッジ)。座標は 0..1 正規化。"""
    cx, cy = 0.5, 0.5
    half_w = 0.17 * scale       # 縦棒の中心間の半分
    bar_w = 0.105 * scale       # 縦棒の太さ
    arm = 0.215 * scale         # 縦棒の半長
    cross = 0.095 * scale       # 横棒の太さ

    lx0, lx1 = cx - half_w - bar_w / 2, cx - half_w + bar_w / 2
    rx0, rx1 = cx + half_w - bar_w / 2, cx + half_w + bar_w / 2
    y0, y1 = cy - arm, cy + arm

    hit = (
        rounded_bar(x, y, lx0, y0, lx1, y1, bar_w / 2)
        or rounded_bar(x, y, rx0, y0, rx1, y1, bar_w / 2)
        or rounded_bar(x, y, lx0, cy - cross / 2, rx1, cy + cross / 2, cross / 2)
    )
    # 影（右下に 0.012 ずらした同じ形）
    off = 0.014 * scale
    shadow = (
        rounded_bar(x - off, y - off, lx0, y0, lx1, y1, bar_w / 2)
        or rounded_bar(x - off, y - off, rx0, y0, rx1, y1, bar_w / 2)
        or rounded_bar(x - off, y - off, lx0, cy - cross / 2, rx1, cy + cross / 2, cross / 2)
    )
    return (1.0 if hit else 0.0), (1.0 if shadow and not hit else 0.0)


def render(size: int, scale: float) -> bytes:
    """size x size の RGBA を返す（全面を背景で塗る）。"""
    big = size * SS
    buf = bytearray(size * size * 4)
    acc = [[[0.0, 0.0, 0.0] for _ in range(size)] for _ in range(size)]

    for by in range(big):
        ny = (by + 0.5) / big
        for bx in range(big):
            nx = (bx + 0.5) / big
            # 背景: 縦グラデーション + 中央の淡いグロー
            g = lerp(1.0, 0.0, ny)
            col = tuple(int(round(lerp(BG_TOP[i], BG_BOTTOM[i], 1.0 - g))) for i in range(3))
            d = math.hypot(nx - 0.5, ny - 0.46)
            glow = max(0.0, 1.0 - d / 0.55) ** 2 * 0.30
            col = blend(col, (26, 120, 118), glow)

            hit, shadow = glyph_cov(nx, ny, 1.0, scale)
            if shadow:
                col = blend(col, GLYPH_SHADOW, 0.55)
            if hit:
                col = GLYPH

            px, py = bx // SS, by // SS
            cell = acc[py][px]
            cell[0] += col[0]
            cell[1] += col[1]
            cell[2] += col[2]

    n = float(SS * SS)
    for y in range(size):
        for x in range(size):
            r, g, b = acc[y][x]
            o = (y * size + x) * 4
            buf[o] = int(round(r / n))
            buf[o + 1] = int(round(g / n))
            buf[o + 2] = int(round(b / n))
            buf[o + 3] = 255  # 四隅まで不透明（透明だと白枠に見える）
    return bytes(buf)


def write_png(path: Path, size: int, rgba: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    stride = size * 4
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(size))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    jobs = [
        ("icon-192.png", 192, 1.24),
        ("icon-512.png", 512, 1.24),
        ("icon-maskable-192.png", 192, 1.02),
        ("icon-maskable-512.png", 512, 1.02),
        ("icon-180.png", 180, 1.26),
    ]
    for name, size, scale in jobs:
        data = render(size, scale)
        write_png(OUT / name, size, data)
        print(f"{name}: {size}x{size} scale={scale} {len(data)} bytes")


if __name__ == "__main__":
    main()
