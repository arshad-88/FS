#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FamilyShield - launcher icons rendered from the brand artwork.

The single source of truth for every launcher bitmap is
``art/ic_launcher_source.png`` (the neon shield emblem). This script renders all
of the derived icons from it, stdlib only - no PIL, no network, deterministic
output:

    app/res/mipmap-mdpi/ic_launcher.png            48 x 48
    app/res/mipmap-mdpi/ic_launcher_round.png      48 x 48
    app/res/mipmap-hdpi/...                        72 x 72
    app/res/mipmap-xhdpi/...                       96 x 96
    app/res/mipmap-xxhdpi/...                     144 x 144
    app/res/mipmap-xxxhdpi/...                    192 x 192
    app/res/drawable-nodpi/ic_launcher_art.png    432 x 432, transparent

Why the two shapes:

  legacy tiles   Full-bleed art over the icon base colour, masked to the tile
                 shape a pre-API-26 launcher draws: a rounded square with a
                 24/108 corner radius (ic_launcher.png) or a circle
                 (ic_launcher_round.png). The emblem is fitted so its glow
                 reaches ~96% of the tile and the bright core never shrinks
                 below 80%.
  adaptive art   The adaptive icon (mipmap-anydpi-v26/*.xml) gets a transparent
                 foreground carrying only the emblem. Android crops that layer
                 to whatever mask the launcher uses, so the bright core is held
                 to ~58% of the 108dp viewport and the glow to <=96%: the
                 shield stays intact under every mask, including circular ones.

Background/unpremultiply note: the artwork sits on a pure black field, so
alpha = max(r, g, b) reconstructs it exactly over the dark base colour
(#0B0714) used by app/res/drawable/ic_launcher_background.xml.

Usage:
    python tools/gen_icons_from_art.py             # write every icon
    python tools/gen_icons_from_art.py --check     # verify only (exit 1 on miss)
    python tools/gen_icons_from_art.py --preview   # ASCII proof, writes nothing
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "res")
SOURCE = os.path.join(ROOT, "art", "ic_launcher_source.png")
ADAPTIVE_OUT = os.path.join(RES, "drawable-nodpi", "ic_launcher_art.png")

DENSITIES = (
    ("mdpi", 48),
    ("hdpi", 72),
    ("xhdpi", 96),
    ("xxhdpi", 144),
    ("xxxhdpi", 192),
)
VARIANTS = (
    ("ic_launcher.png", "rounded"),
    ("ic_launcher_round.png", "circle"),
)

BASE = (0x0B, 0x07, 0x14)      # ic_launcher_background solid
TILE_CORNER = 24.0 / 108.0     # rounded-square radius, fraction of the tile
ADAPTIVE_SIZE = 432            # 108dp at xxxhdpi

# Fitting rules (see module docstring).
LEGACY_GLOW_FILL = 0.96        # glow bbox / tile edge (upper bound)
LEGACY_CORE_FILL = 0.80        # bright core / tile edge (drives the scale)
ADAPTIVE_CORE_FILL = 0.58      # bright core / 432
ADAPTIVE_GLOW_FILL = 0.96      # glow bbox / 432

T_GLOW = 12                    # channel value that still counts as glow
T_CORE = 128                   # channel value that counts as solid emblem
SS = 4                         # mask supersampling


# --------------------------------------------------------------------- png io --
def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(path: str):
    """Decode an 8-bit non-interlaced RGB/RGBA PNG into (w, h, bytearray RGBA)."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a PNG: %s" % path)

    pos = 8
    w = h = bit = color = interlace = 0
    idat = bytearray()
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            w, h, bit, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
    if bit != 8 or color not in (2, 6) or interlace != 0:
        raise SystemExit(
            "unsupported PNG (bit depth %d, colour type %d, interlace %d)" % (bit, color, interlace)
        )

    chans = 3 if color == 2 else 4
    stride = w * chans
    raw = zlib.decompress(bytes(idat))
    prev = bytearray(stride)
    out = bytearray(w * h * 4)
    step = chans
    for y in range(h):
        base = y * (stride + 1)
        ftype = raw[base]
        line = bytearray(raw[base + 1:base + 1 + stride])
        if ftype == 1:
            for i in range(step, stride):
                line[i] = (line[i] + line[i - step]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                upleft = prev[i - step] if i >= step else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        elif ftype != 0:
            raise SystemExit("bad PNG filter %d on row %d" % (ftype, y))

        o = y * w * 4
        if chans == 3:
            for x in range(w):
                s = x * 3
                d = o + x * 4
                out[d] = line[s]
                out[d + 1] = line[s + 1]
                out[d + 2] = line[s + 2]
                out[d + 3] = 255
        else:
            out[o:o + w * 4] = line
        prev = line
    return w, h, out


def encode_png(path: str, w: int, h: int, rgba: bytes) -> None:
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)


# -------------------------------------------------------------------- fitting --
def bounds(w: int, h: int, rgba: bytearray, threshold: int):
    """Bounding box of pixels whose max channel reaches ``threshold``."""
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            o = row + x * 4
            if max(rgba[o], rgba[o + 1], rgba[o + 2]) >= threshold:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        raise SystemExit("nothing bright enough at threshold %d" % threshold)
    return x0, y0, x1 + 1, y1 + 1


def fit(src_w: int, src_h: int, rgba: bytearray, size: int, core_fill: float,
        glow_fill: float, core_min_fill: float | None = None):
    """Pick (centre_x, centre_y, scale) so the emblem sits inside ``size``."""
    gx0, gy0, gx1, gy1 = bounds(src_w, src_h, rgba, T_GLOW)
    cx0, cy0, cx1, cy1 = bounds(src_w, src_h, rgba, T_CORE)
    cx = (cx0 + cx1) / 2.0
    cy = (cy0 + cy1) / 2.0
    core = max(cx1 - cx0, cy1 - cy0)
    glow = max(gx1 - gx0, gy1 - gy0)
    if core_fill <= 0.0:
        # legacy tiles: fill the plate with the artwork, then protect the core
        scale = size * glow_fill / glow
    else:
        scale = size * core_fill / core
        if glow * scale > size * glow_fill:
            scale = size * glow_fill / glow
    if core_min_fill is not None and core * scale < size * core_min_fill:
        scale = size * core_min_fill / core
    return cx, cy, scale, (gx0, gy0, gx1, gy1), (cx0, cy0, cx1, cy1)


# ----------------------------------------------------------------- resampling --
def _axis_weights(n_dst: int, n_src: int, center_src: float, scale: float):
    """Exact box-filter weights for dst pixel -> src interval, per axis."""
    c_dst = n_dst / 2.0
    out = []
    for d in range(n_dst):
        u0 = (d - c_dst) / scale + center_src
        u1 = (d + 1 - c_dst) / scale + center_src
        taps = []
        first = int(u0 // 1)
        last = int(u1 // 1)
        for i in range(first, last + 1):
            lo = max(u0, float(i))
            hi = min(u1, float(i + 1))
            if hi <= lo:
                continue
            taps.append((min(max(i, 0), n_src - 1), hi - lo))
        total = sum(wt for _, wt in taps)
        if total <= 0.0:
            taps = [(min(max(int(u0), 0), n_src - 1), 1.0)]
            total = 1.0
        out.append([(i, wt / total) for i, wt in taps])
    return out


def resample(src_w: int, src_h: int, rgba: bytearray, size: int,
             cx: float, cy: float, scale: float):
    """Area-average the source into a size x size RGBA buffer around (cx, cy)."""
    wx = _axis_weights(size, src_w, cx, scale)
    wy = _axis_weights(size, src_h, cy, scale)

    mid = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * src_h)]
    for y in range(src_h):
        row = y * src_w * 4
        mrow = y * size
        for d in range(size):
            r = g = b = a = 0.0
            for i, wt in wx[d]:
                o = row + i * 4
                r += rgba[o] * wt
                g += rgba[o + 1] * wt
                b += rgba[o + 2] * wt
                a += rgba[o + 3] * wt
            p = mid[mrow + d]
            p[0] = r
            p[1] = g
            p[2] = b
            p[3] = a

    out = bytearray(size * size * 4)
    for y in range(size):
        orow = y * size * 4
        for d in range(size):
            r = g = b = a = 0.0
            for j, wt in wy[y]:
                p = mid[j * size + d]
                r += p[0] * wt
                g += p[1] * wt
                b += p[2] * wt
                a += p[3] * wt
            o = orow + d * 4
            out[o] = 0 if r < 0 else (255 if r > 255 else int(r + 0.5))
            out[o + 1] = 0 if g < 0 else (255 if g > 255 else int(g + 0.5))
            out[o + 2] = 0 if b < 0 else (255 if b > 255 else int(b + 0.5))
            out[o + 3] = 0 if a < 0 else (255 if a > 255 else int(a + 0.5))
    return out


def keyed(rgba: bytearray) -> bytearray:
    """Black-field art -> straight-alpha art (alpha = max channel)."""
    out = bytearray(len(rgba))
    for o in range(0, len(rgba), 4):
        m = max(rgba[o], rgba[o + 1], rgba[o + 2])
        if m == 0:
            continue
        out[o] = min(255, rgba[o] * 255 // m)
        out[o + 1] = min(255, rgba[o + 1] * 255 // m)
        out[o + 2] = min(255, rgba[o + 2] * 255 // m)
        out[o + 3] = m
    return out


# ----------------------------------------------------------------------- mask --
def coverage(size: int, shape: str) -> bytearray:
    """Antialiased tile coverage (0-255) for the legacy icon shapes."""
    cov = bytearray(size * size)
    half = size / 2.0
    if shape == "circle":
        radius = half
        for y in range(size):
            for x in range(size):
                hit = 0
                for sy in range(SS):
                    py = y + (sy + 0.5) / SS - half
                    for sx in range(SS):
                        px = x + (sx + 0.5) / SS - half
                        if px * px + py * py <= radius * radius:
                            hit += 1
                cov[y * size + x] = hit * 255 // (SS * SS)
        return cov

    r = max(1.0, size * TILE_CORNER)
    inner = half - r
    for y in range(size):
        for x in range(size):
            hit = 0
            for sy in range(SS):
                py = y + (sy + 0.5) / SS - half
                ay = abs(py) - inner
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS - half
                    ax = abs(px) - inner
                    # rounded-rect SDF, inside when <= 0
                    ox = ax if ax > 0 else 0.0
                    oy = ay if ay > 0 else 0.0
                    dist = (ox * ox + oy * oy) ** 0.5 + min(max(ax, ay), 0.0) - r
                    if dist <= 0:
                        hit += 1
            cov[y * size + x] = hit * 255 // (SS * SS)
    return cov


# -------------------------------------------------------------------- renders --
def render_legacy(src_w, src_h, art, size: int, shape: str) -> bytes:
    cx, cy, scale, _, _ = fit(src_w, src_h, art, size, LEGACY_CORE_FILL,
                              LEGACY_GLOW_FILL)
    img = resample(src_w, src_h, keyed(art), size, cx, cy, scale)
    cov = coverage(size, shape)
    br, bg, bb = BASE
    out = bytearray(size * size * 4)
    for i in range(size * size):
        c = cov[i]
        if c == 0:
            continue
        o = i * 4
        a = img[o + 3] / 255.0
        out[o] = int(br * (1 - a) + img[o] * a + 0.5)
        out[o + 1] = int(bg * (1 - a) + img[o + 1] * a + 0.5)
        out[o + 2] = int(bb * (1 - a) + img[o + 2] * a + 0.5)
        out[o + 3] = c
    return bytes(out)


def render_adaptive(src_w, src_h, art) -> bytes:
    cx, cy, scale, _, _ = fit(src_w, src_h, art, ADAPTIVE_SIZE,
                              ADAPTIVE_CORE_FILL, ADAPTIVE_GLOW_FILL)
    return bytes(resample(src_w, src_h, keyed(art), ADAPTIVE_SIZE, cx, cy, scale))


# -------------------------------------------------------------------- preview --
RAMP = " .:-=+*#%@"


def preview(path: str, cols: int = 44) -> None:
    w, h, rgba = decode_png(path)
    step = max(1, w // cols)
    rows = max(1, h // step // 2)
    print("%s  %dx%d" % (os.path.basename(path), w, h))
    for ry in range(rows):
        line = []
        for rx in range(cols):
            x = min(w - 1, rx * step)
            y = min(h - 1, ry * step * 2)
            o = (y * w + x) * 4
            lum = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) // 1000
            lum = lum * rgba[o + 3] // 255
            line.append(RAMP[min(len(RAMP) - 1, lum * len(RAMP) // 256)])
        print("".join(line))


# ----------------------------------------------------------------------- main --
def targets():
    out = []
    for density, size in DENSITIES:
        for name, shape in VARIANTS:
            out.append((os.path.join(RES, "mipmap-" + density, name),
                        size, shape))
    out.append((ADAPTIVE_OUT, ADAPTIVE_SIZE, "adaptive"))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="render FamilyShield launcher icons from art")
    ap.add_argument("--source", default=SOURCE)
    ap.add_argument("--check", action="store_true", help="verify outputs exist and are current")
    ap.add_argument("--preview", action="store_true", help="ASCII proof, writes nothing")
    args = ap.parse_args(argv)

    if not os.path.exists(args.source):
        raise SystemExit("missing source art: %s" % args.source)

    if args.preview:
        preview(args.source)
        for path, _, _ in targets():
            if os.path.exists(path):
                preview(path)
        return 0

    src_w, src_h, art = decode_png(args.source)
    gx0, gy0, gx1, gy1 = bounds(src_w, src_h, art, T_GLOW)
    cx0, cy0, cx1, cy1 = bounds(src_w, src_h, art, T_CORE)
    print("source      %dx%d" % (src_w, src_h))
    print("glow bbox   %d,%d - %d,%d" % (gx0, gy0, gx1, gy1))
    print("core bbox   %d,%d - %d,%d" % (cx0, cy0, cx1, cy1))

    rc = 0
    for path, size, shape in targets():
        if shape == "adaptive":
            img = render_adaptive(src_w, src_h, art)
            cx, cy, scale, _, _ = fit(src_w, src_h, art, size, ADAPTIVE_CORE_FILL,
                                       ADAPTIVE_GLOW_FILL)
        else:
            img = render_legacy(src_w, src_h, art, size, shape)
            cx, cy, scale, _, _ = fit(src_w, src_h, art, size, LEGACY_CORE_FILL,
                                       LEGACY_GLOW_FILL)
        rel = os.path.relpath(path, ROOT)
        if args.check:
            ok = os.path.exists(path)
            print("%-46s %s" % (rel, "ok" if ok else "MISSING"))
            rc |= 0 if ok else 1
            continue
        encode_png(path, size, size, img)
        print("%-46s %3dx%-3d  scale %.3f  centre %.1f,%.1f  %d bytes"
              % (rel, size, size, scale, cx, cy, len(img)))
    if args.check and rc:
        print("run: python tools/gen_icons_from_art.py")
    return rc


if __name__ == "__main__":
    sys.exit(main())
