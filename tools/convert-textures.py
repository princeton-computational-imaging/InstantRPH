#!/usr/bin/env python3
"""Convert the 3D method figure's PNG textures to downscaled WebP.

These are drawn as small planes in an orbiting stack (see scripts/method-3d.js,
CONFIG.planeWidth/planeHeight = 3.4 x 2.125 world units) -- the shipped
1280x800 originals are far more resolution than the on-screen size ever uses,
and at ~1 MB each they were the reason the method figure's layers frequently
never finished loading before the user scrolled past.

layer_NN.png keeps full alpha quality: the shader reads texel.a as each
layer's per-pixel coverage mask (see COMPLEX_FRAGMENT in method-3d.js), so a
lossy alpha channel would fray the visible edge of every layer. focal_NN.png
has no alpha channel to worry about.

Writes alongside the source as .webp; does not touch or remove the .png.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [
    ("assets/instantrph", "layer_*.png"),
    ("assets/instantrph", "focal_*.png"),
]
SIZE = (640, 400)
QUALITY = 82


def convert(src: Path) -> Path:
    dst = src.with_suffix(".webp")
    im = Image.open(src)
    im = im.resize(SIZE, Image.LANCZOS)
    im.save(dst, "WEBP", quality=QUALITY, alpha_quality=100, method=6)
    return dst


def main():
    total_in = total_out = count = 0
    for subdir, pattern in TARGETS:
        for src in sorted((ROOT / subdir).glob(pattern)):
            dst = convert(src)
            a, b = src.stat().st_size, dst.stat().st_size
            total_in += a
            total_out += b
            count += 1
            print(f"{src.relative_to(ROOT)}  {a/1e6:.2f}MB -> {b/1e6:.2f}MB")
    if count:
        print(f"\n{count} files: {total_in/1e6:.1f}MB -> {total_out/1e6:.1f}MB "
              f"({total_in/total_out:.1f}x smaller)")
    else:
        print("No matching files found.")


if __name__ == "__main__":
    sys.exit(main())
