"""The app icon (assets/icon/AppIcon.icns) from Cross Rays' own Dynames frames (assets/raw/dynames.zip).

A macOS-style rounded square (drawn here: dark navy, a GN-green glow) with GN particles (the game's own GN
texture, units/dynames/fx/glow_a.png) and the unit on it. Variants (10/30, the user picks one):
  A  whole body, front, shields spread (p05_05)
  B  whole body, front, shields closed (p14_04)
  C  bust close-up: the whole frame goes in and the plate frames its head, the rest cut off by the plate's edge
     (08_01) — the one that still reads at Dock sizes

usage: python3 tools/make_icon.py [A|B|C]      (default C; run tools/build_units.py first for the GN texture)
"""
import io
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "assets" / "raw" / "dynames.zip"
GLOW = ROOT / "characters" / "dynames" / "assets" / "fx" / "glow_a.png"
OUT = ROOT / "assets" / "icon"
SIZE = 1024
MARGIN, RADIUS = 100, 185            # Apple's icon grid: an 824 px plate on a 1024 px canvas


def frame(name):
    with zipfile.ZipFile(ZIP) as z:
        path = next(n for n in z.namelist() if n.endswith("/" + name))
        return Image.open(io.BytesIO(z.read(path))).convert("RGBA")


def plate():
    """Dark navy rounded square, lighter at the top, a soft GN-green glow below the middle, a faint green rim."""
    w = SIZE - 2 * MARGIN
    mask = Image.new("L", (SIZE, SIZE))
    ImageDraw.Draw(mask).rounded_rectangle([MARGIN, MARGIN, MARGIN + w, MARGIN + w], RADIUS, fill=255)
    y = np.linspace(0, 1, SIZE)[:, None, None]
    top, bot = np.array([34, 46, 66.]), np.array([10, 14, 22.])
    rgb = np.broadcast_to(top + (bot - top) * y, (SIZE, SIZE, 3)).copy()
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    d = np.hypot((xx - SIZE / 2) / (w * 0.42), (yy - SIZE * 0.56) / (w * 0.42))
    rgb += (np.clip(1 - d, 0, 1) ** 1.6)[..., None] * np.array([40, 150, 90.]) * 0.75
    bg = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).convert("RGBA")
    bg.putalpha(mask)
    rim = Image.new("RGBA", (SIZE, SIZE))
    ImageDraw.Draw(rim).rounded_rectangle([MARGIN + 3, MARGIN + 3, MARGIN + w - 3, MARGIN + w - 3], RADIUS - 3,
                                          outline=(120, 255, 170, 70), width=6)
    bg.alpha_composite(rim)
    # GN particles scattered over it
    g = Image.open(GLOW).convert("RGBA")
    rnd = np.random.default_rng(5)
    for _ in range(26):
        k = rnd.uniform(0.6, 1.8)
        p = g.resize((max(4, int(g.width * k)), max(4, int(g.height * k))), Image.LANCZOS)
        a = rnd.uniform(0.5, 0.95)
        p.putalpha(p.getchannel("A").point(lambda v: int(v * a)))
        bg.alpha_composite(p, (int(rnd.uniform(170, 860)), int(rnd.uniform(200, 860))))
    out = Image.new("RGBA", (SIZE, SIZE))
    out.paste(bg, (0, 0), mask)
    return out, mask


def place(bg, mask, unit, k, at):
    """`unit` scaled by `k` with its top left at `at`, a soft shadow under it, clipped to the plate."""
    u = unit.resize((int(unit.width * k), int(unit.height * k)), Image.LANCZOS)
    layer = Image.new("RGBA", bg.size)
    sh = Image.new("RGBA", u.size)
    sh.putalpha(u.getchannel("A").point(lambda v: int(v * 0.5)))
    layer.alpha_composite(sh.filter(ImageFilter.GaussianBlur(15)), (at[0] + 7, at[1] + 19))
    layer.alpha_composite(u, at)
    clipped = Image.new("RGBA", bg.size)
    clipped.paste(layer, (0, 0), mask)
    bg.alpha_composite(clipped)
    return bg


def fit(bg, mask, unit, box):
    unit = unit.crop(unit.getbbox())
    x0, y0, x1, y1 = box
    k = min((x1 - x0) / unit.width, (y1 - y0) / unit.height)
    at = (int(x0 + ((x1 - x0) - unit.width * k) / 2), int(y0 + ((y1 - y0) - unit.height * k) / 2))
    return place(bg, mask, unit, k, at)


def icon(variant):
    bg, mask = plate()
    if variant == "A":
        return fit(bg, mask, frame("p05_05.PNG"), (130, 210, 894, 860))
    if variant == "B":
        return fit(bg, mask, frame("p14_04.PNG"), (230, 150, 794, 900))
    # C: what the plate frames, in frame pixels: the head and V fin, down to the chest
    im = frame("08_01.PNG")
    x0, y0, x1, _ = 110, -10, 490, 330
    k = 740 / (x1 - x0)
    return place(bg, mask, im, k, (int(142 - x0 * k), int(150 - y0 * k)))


def main():
    variant = (sys.argv[1] if len(sys.argv) > 1 else "C").upper()
    master = icon(variant)
    OUT.mkdir(parents=True, exist_ok=True)
    master.save(OUT / "AppIcon_1024.png")
    iconset = OUT / "AppIcon.iconset"
    iconset.mkdir(exist_ok=True)
    for s in (16, 32, 128, 256, 512):
        master.resize((s, s), Image.LANCZOS).save(iconset / f"icon_{s}x{s}.png")
        master.resize((s * 2, s * 2), Image.LANCZOS).save(iconset / f"icon_{s}x{s}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "AppIcon.icns")], check=True)
    (OUT / "variant.txt").write_text(variant + "\n")
    print(f"{OUT / 'AppIcon.icns'} (variant {variant})")


if __name__ == "__main__":
    main()
