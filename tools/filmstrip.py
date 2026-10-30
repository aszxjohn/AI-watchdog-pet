"""Frames of one animation on a fixed canvas, with a crosshair at the manifest anchor."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parent.parent
uid, anim = sys.argv[1], sys.argv[2]
m = json.loads((root / "units" / uid / "unit.json").read_text())["animations"][anim]
frames = [Image.open(root / "units" / uid / f).convert("RGBA") for f in m["frames"]]
w, h = m["size"]; ax, ay = m["anchor"]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 8
rows = (len(frames) + cols - 1) // cols
sheet = Image.new("RGBA", (cols * w, rows * h), (40, 42, 56, 255))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(frames):
    x, y = (i % cols) * w, (i // cols) * h
    sheet.alpha_composite(f, (x, y))
    d.rectangle([x, y, x + w - 1, y + h - 1], outline=(90, 90, 110, 255))
    d.line([x + ax, y, x + ax, y + h], fill=(255, 80, 80, 140))
    d.line([x, y + ay, x + w, y + ay], fill=(255, 80, 80, 140))
    d.text((x + 3, y + 2), str(i), fill=(255, 220, 0, 255))
out = root / "preview" / f"strip_{uid}_{anim}.png"
sheet.save(out); print(out, sheet.size)
