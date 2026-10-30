"""Build a labelled contact sheet of every PNG under one unit folder.

usage: python3 -I contact.py <unit_dir> <out.png> [cell_px]
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

unit_dir = Path(sys.argv[1])
out = Path(sys.argv[2])
cell = int(sys.argv[3]) if len(sys.argv) > 3 else 160

files = sorted(p for p in unit_dir.rglob("*") if p.suffix.lower() == ".png")
groups = {}
for p in files:
    rel = p.relative_to(unit_dir)
    stem = p.stem.rsplit("_", 1)[0]
    key = f"{'/'.join(rel.parts[1:-1]) or '.'}:{stem}"
    groups.setdefault(key, []).append(p)

cols = max(len(v) for v in groups.values())
label_w = 150
sheet = Image.new("RGBA", (label_w + cols * cell, len(groups) * cell), (70, 72, 90, 255))
draw = ImageDraw.Draw(sheet)
for row, (key, paths) in enumerate(groups.items()):
    draw.text((6, row * cell + 6), key, fill=(255, 220, 0, 255))
    for col, p in enumerate(paths):
        im = Image.open(p).convert("RGBA")
        bbox = im.getbbox()
        if bbox:
            im = im.crop(bbox)
        im.thumbnail((cell - 6, cell - 6))
        x = label_w + col * cell + (cell - im.width) // 2
        y = row * cell + (cell - im.height) // 2
        sheet.alpha_composite(im, (x, y))
        draw.text((label_w + col * cell + 3, row * cell + 2), p.stem.rsplit("_", 1)[-1], fill=(200, 200, 200, 255))
sheet.save(out)
print(out, sheet.size, {k: len(v) for k, v in groups.items()})
