#!/usr/bin/env python3
"""PWA インストール要件チェッカー（WebAPK / ホーム画面追加の再発防止）

背景（実例）:
  アイコン画像の**周囲 24px が透明**だったため、Android のランチャーが白いカードを
  透かして描き「白枠付きアイコン」になっていた。manifest も icons 宣言も正しく、
  Chrome の installability も 0 error だったので、目視するまで原因が分からなかった。
  さらに WebAPK のインストール基盤が壊れていると `This site cannot be installed` に
  なるが、これもページ側の検査では検出できない。

このスクリプトは「ページ側で検出できる条件」を全部機械的に見る。
  - manifest の必須項目 / start_url ⊂ scope / id 同一オリジン / display
  - アイコンの**実ピクセル**と宣言サイズの一致（宣言だけ直しても効かない）
  - any 192 / any 512 / maskable の存在（purpose は単独トークンで判定）
  - **アイコン外周 1px に透明画素が無いこと**（白枠の直接原因）
  - 背景が単色（グラデーションは前景/背景合成で境目が出る）
  - maskable の図柄が中心半径 0.40 以内（安全域）
  - シェル（manifest / アイコン / sw.js / index）が**未認証で 200**
  - manifest が immutable でキャッシュされないこと
  - Service Worker が fetch ハンドラを持つこと

使い方:
  python3 scripts/check-pwa.py --url https://host:8444/
  python3 scripts/check-pwa.py --dir apps/web/public          # ローカルのみ（ネットワーク無し）
  python3 scripts/check-pwa.py --url ... --json               # CI 用

終了コード: 0=合格 / 1=不合格 / 2=実行不能
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import urllib.error
import urllib.request
import zlib
from pathlib import Path

OK = "\033[32m✓\033[0m"
NG = "\033[31m✗\033[0m"
WARN = "\033[33m!\033[0m"


# ---------------------------------------------------------------- PNG デコード
def png_info(data: bytes):
    """(width, height, channels, rgba_bytes) を返す。PNG 以外は例外。"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG ではない")
    pos, idat, ihdr = 8, b"", None
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos : pos + 4])
        typ = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
    if not ihdr:
        raise ValueError("IHDR が無い")
    w, h, bd, ct, _comp, _filt, inter = ihdr
    if bd != 8 or inter != 0:
        raise ValueError(f"8bit 非インタレースのみ対応 (bitdepth={bd} interlace={inter})")
    chn = {0: 1, 2: 3, 4: 2, 6: 4}.get(ct)
    if not chn:
        raise ValueError(f"未対応の color type {ct}")
    bpp = chn
    stride = w * bpp
    raw = zlib.decompress(idat)
    out = bytearray(h * stride)
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return w, h, chn, bytes(out)


def analyze_icon(data: bytes):
    """アイコンの画素を検査して辞書で返す。"""
    w, h, chn, px = png_info(data)

    def at(x, y):
        o = (y * w + x) * chn
        if chn == 4:
            return px[o], px[o + 1], px[o + 2], px[o + 3]
        if chn == 3:
            return px[o], px[o + 1], px[o + 2], 255
        if chn == 2:
            return px[o], px[o], px[o], px[o + 1]
        return px[o], px[o], px[o], 255

    corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)]

    # 外周 1px に透明画素があるか（＝白枠の直接原因）
    border = []
    for x in range(w):
        border.append(at(x, 0))
        border.append(at(x, h - 1))
    for y in range(h):
        border.append(at(0, y))
        border.append(at(w - 1, y))
    border_transparent = sum(1 for c in border if c[3] < 250)

    # 背景が単色か（四隅＋四辺中央が同色）
    flat = len({corners[0], corners[1], corners[2], corners[3], at(w // 2, 0), at(w // 2, h - 1)}) == 1

    # 図柄の最大半径（中心からの距離 / 幅）。背景色と違う画素を図柄とみなす
    bg = corners[0][:3]
    max_r = 0.0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b, a = at(x, y)
            if a < 120:
                continue
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 24:
                max_r = max(max_r, math.hypot(x - w / 2, y - h / 2) / w)

    return {
        "w": w,
        "h": h,
        "corner": corners[0],
        "border_transparent": border_transparent,
        "flat": flat,
        "ink_radius": round(max_r, 3),
    }



# ---------------------------------------------------------------- SVG 検査
def analyze_svg(text: str):
    """SVG に「全面を覆う図形」があるかを見る。

    実例: `<rect x="24" y="24" width="464" height="464">` のように内側に図形を描くと
    周囲が透明になり、Android のランチャーが白いカードを透かして **白枠** になる。
    """
    import re

    vb = re.search(r'viewBox\s*=\s*"([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)"', text)
    W = float(vb.group(3)) if vb else 0.0
    H = float(vb.group(4)) if vb else 0.0
    rects = re.findall(r"<rect\b[^>]*>", text)
    covers = False
    for r in rects:
        def num(attr, default):
            m = re.search(rf'{attr}\s*=\s*"([-\d.]+)(%?)"', r)
            if not m:
                return default
            v = float(m.group(1))
            return v if m.group(2) != "%" else v / 100.0 * (W if attr in ("x", "width") else H)

        x = num("x", 0.0)
        y = num("y", 0.0)
        w = num("width", W)
        h = num("height", H)
        if W and H and x <= 0.01 and y <= 0.01 and w >= W - 0.01 and h >= H - 0.01:
            covers = True
            break
    return {"viewBox": (W, H), "rects": len(rects), "full_bleed_rect": covers}

# ---------------------------------------------------------------- 取得
class Fetcher:
    def __init__(self, base: str | None, root: Path | None, insecure: bool = False):
        self.base = base.rstrip("/") if base else None
        self.root = root
        self.insecure = insecure
        self.results = []

    def get(self, path: str):
        """(status, headers, body) を返す。ローカルモードは status=200 固定。"""
        if self.root is not None:
            p = self.root / path.lstrip("/")
            if p.is_dir():
                p = p / "index.html"
            if not p.exists() and path in ("/", ""):
                # Vite の index.html は public/ の外にあることが多い
                for cand in (self.root / "index.html", self.root.parent / "index.html", self.root.parent / "dist" / "index.html"):
                    if cand.exists():
                        p = cand
                        break
            if not p.exists():
                return 404, {}, b""
            return 200, {"content-type": _guess_type(p)}, p.read_bytes()
        assert self.base is not None
        url = self.base + path
        req = urllib.request.Request(url, headers={"user-agent": "hermes-pwa-check/1.0"})
        try:
            ctx = None
            if self.insecure:
                import ssl

                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
        except urllib.error.HTTPError as e:
            return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
        except Exception as e:  # noqa: BLE001
            return 0, {}, str(e).encode()


def _guess_type(p: Path) -> str:
    return {
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
        ".html": "text/html",
        ".js": "text/javascript",
    }.get(p.suffix, "application/octet-stream")


# ---------------------------------------------------------------- 本体
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="公開 URL（未認証で取得できることの確認もする）")
    ap.add_argument("--dir", help="ローカルの public ディレクトリ（ネットワーク無し）")
    ap.add_argument("--manifest", default="/manifest.webmanifest")
    ap.add_argument("--insecure", action="store_true", help="証明書検証をスキップ（自己署名のみ）")
    ap.add_argument("--json", action="store_true", help="結果を JSON で出力")
    ap.add_argument("--self-test", action="store_true", help="検出できること自体を確認する（ネットワーク不要）")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.url and not args.dir:
        ap.error("--url か --dir のどちらかが必要")

    f = Fetcher(args.url, Path(args.dir) if args.dir else None, args.insecure)
    rows: list[tuple[bool, str, str]] = []

    def chk(ok: bool, label: str, detail: str = "") -> bool:
        rows.append((bool(ok), label, str(detail)))
        return bool(ok)

    # 1) manifest
    st, hd, body = f.get(args.manifest)
    if not chk(st == 200, "manifest 取得", f"HTTP {st} {hd.get('content-type','')}"):
        return finish(rows, args.json)
    try:
        m = json.loads(body)
    except Exception as e:  # noqa: BLE001
        chk(False, "manifest の JSON", str(e))
        return finish(rows, args.json)
    chk(True, "manifest の JSON", f"{len(m)} 項目")

    if args.url:
        cc = hd.get("cache-control", "")
        chk("immutable" not in cc, "manifest の cache-control", cc or "(なし)")

    chk(bool(m.get("name")), "name", m.get("name", ""))
    chk(bool(m.get("short_name")), "short_name", m.get("short_name", ""))

    base = args.url.rstrip("/") if args.url else "https://example.invalid"
    murl = base + args.manifest

    def resolve(v, default="."):
        from urllib.parse import urljoin

        return urljoin(murl, v if v is not None else default)

    start = resolve(m.get("start_url"))
    scope = resolve(m.get("scope"))
    mid = resolve(m["id"]) if m.get("id") is not None else None
    chk(True, "start_url", start)
    chk(True, "scope", scope)
    chk(True, "id", mid or "(未指定=start_url)")
    chk(start.startswith(scope), "start_url ⊂ scope", f"{start} ⊂ {scope}")
    if args.url:
        o = args.url.split("/manifest")[0]
        chk(mid is None or mid.startswith(o), "id が同一オリジン", mid or "-")

    disp = m.get("display", "browser")
    chk(disp in ("standalone", "fullscreen", "minimal-ui"), "display", disp)
    chk(not m.get("prefer_related_applications"), "prefer_related_applications", str(m.get("prefer_related_applications", False)))

    # 2) icons
    icons = m.get("icons") or []
    chk(len(icons) > 0, "icons 件数", f"{len(icons)} 件")
    has_any192 = has_any512 = has_maskable = False
    for ic in icons:
        src = ic.get("src", "")
        purpose = (ic.get("purpose") or "any").split()
        path = src
        if src.startswith("http"):
            path = "/" + src.split("/", 3)[3] if args.url else src
        st2, hd2, data = f.get(path)
        if not chk(st2 == 200, f"icon {src.split('/')[-1]}", f"HTTP {st2}" + ("（未認証で取得できない）" if args.url and st2 in (401, 403) else "")):
            continue
        declared = ic.get("sizes", "")
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            try:
                info = analyze_icon(data)
            except Exception as e:  # noqa: BLE001
                chk(False, f"icon {src.split('/')[-1]} の画素", str(e))
                continue
            decl_ok = declared in ("", "any") or f"{info['w']}x{info['h']}" in declared
            chk(decl_ok, f"icon {src.split('/')[-1]} のサイズ", f"実体 {info['w']}x{info['h']} / 宣言 {declared}")
            chk(
                info["border_transparent"] == 0,
                f"icon {src.split('/')[-1]} の外周が不透明",
                f"透明画素 {info['border_transparent']} → 白枠の原因" if info["border_transparent"] else "透明画素 0",
            )
            if "maskable" in purpose:
                chk(info["flat"], f"icon {src.split('/')[-1]} の背景が単色", "四隅が同色" if info["flat"] else "グラデーション/グロー → 前景背景合成で境目が出る")
            if "maskable" in purpose and info["w"] >= 512:
                chk(info["ink_radius"] <= 0.40, f"icon {src.split('/')[-1]} の安全域", f"図柄半径 {info['ink_radius']} (≤0.40)")
            if "any" in purpose and info["w"] >= 192:
                has_any192 = True
            if "any" in purpose and info["w"] >= 512:
                has_any512 = True
        elif b"<svg" in data[:400]:
            try:
                sv = analyze_svg(data.decode("utf-8", "replace"))
            except Exception as e:  # noqa: BLE001
                chk(False, f"icon {src.split('/')[-1]} の SVG 解析", str(e))
                sv = None
            if sv:
                chk(
                    sv["full_bleed_rect"],
                    f"icon {src.split('/')[-1]} が全面ベタ",
                    f"viewBox={sv['viewBox']} rect={sv['rects']}件"
                    + ("" if sv["full_bleed_rect"] else " → 内側に図形＝透明マージンで白枠になる"),
                )
        else:
            chk(True, f"icon {src.split('/')[-1]}（その他形式）", f"{len(data)}B {hd2.get('content-type','')}")
        if "maskable" in purpose:
            has_maskable = True

    chk(has_any192, "any 192px 以上", "あり" if has_any192 else "なし → インストール不可")
    chk(has_any512, "any 512px 以上", "あり" if has_any512 else "なし → インストール不可")
    chk(has_maskable, "maskable あり", "あり" if has_maskable else "なし → 白枠/非アダプティブの原因")

    # 3) シェルが未認証で取れるか / SW
    st3, hd3, sw = f.get("/sw.js")
    chk(st3 == 200, "sw.js 取得", f"HTTP {st3}")
    if st3 == 200:
        chk(b"addEventListener('fetch'" in sw or b'addEventListener("fetch"' in sw, "SW に fetch ハンドラ", "あり")
    st4, _h, _b = f.get("/")
    chk(st4 == 200, "index 取得", f"HTTP {st4}")

    return finish(rows, args.json)


def self_test() -> int:
    """過去に実際に起きた不具合を、このチェッカーが検出できるか確認する。"""
    bad_svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
        '<rect x="24" y="24" width="464" height="464" rx="96" fill="#0a262c"/></svg>'
    )
    good_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#06161a"/></svg>'
    cases = [
        ("内側に図形（余白24px）= 過去の白枠", analyze_svg(bad_svg)["full_bleed_rect"], False),
        ("全面ベタ", analyze_svg(good_svg)["full_bleed_rect"], True),
    ]
    ok_all = True
    for label, got, want in cases:
        ok = got == want
        ok_all &= ok
        print(f"{OK if ok else NG} {label}: 検出={got} 期待={want}")
    # 透明マージン付き PNG の検出（1px の透明枠を作る）
    import struct as _s
    import zlib as _z

    W = H = 8
    raw = b""
    for y in range(H):
        row = bytearray()
        for x in range(W):
            edge = x in (0, W - 1) or y in (0, H - 1)
            row += bytes((0, 0, 0, 0 if edge else 255))
        raw += b"\x00" + bytes(row)

    def chunk(t, d):
        return _s.pack(">I", len(d)) + t + d + _s.pack(">I", _z.crc32(t + d) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", _s.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", _z.compress(raw))
        + chunk(b"IEND", b"")
    )
    info = analyze_icon(png)
    ok = info["border_transparent"] > 0
    ok_all &= ok
    print(f"{OK if ok else NG} 透明マージン付きPNG: 透明画素={info['border_transparent']}（>0 を期待）")
    print()
    print(f"{OK} セルフテスト合格" if ok_all else f"{NG} セルフテスト失敗: 検出漏れがある")
    return 0 if ok_all else 1


def finish(rows, as_json: bool) -> int:
    bad = [r for r in rows if not r[0]]
    if as_json:
        print(json.dumps({"ok": not bad, "checks": [{"ok": o, "label": l, "detail": d} for o, l, d in rows]}, ensure_ascii=False, indent=2))
    else:
        width = max((len(l) for _o, l, _d in rows), default=10)
        for ok, label, detail in rows:
            print(f"{OK if ok else NG} {label.ljust(width)}  {detail}")
        print()
        if bad:
            print(f"{NG} {len(bad)} 件の不合格。上の ✗ を直すこと。")
        else:
            print(f"{OK} すべて合格（{len(rows)} 項目）")
            print(f"{WARN} 端末側でインストールできない場合は WebAPK 基盤側の問題。")
            print("    chrome://webapks で Last Update Completion Time を確認 → 端末再起動 → 再インストール")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
