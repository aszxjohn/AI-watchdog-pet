"""Split a World/Wars parts sheet into its separate pieces and lay them out with ids.

Pieces are the 8-connected blobs of non-transparent pixels. Each one is scored on how much it
looks like an effect (bright, saturated, soft-edged) rather than armour, and the contact sheet
lists the most effect-like first, so beams / flashes / sparks are easy to pick out.

usage: python3 tools/parts.py <sheet.png> <out_dir>
writes <out_dir>/parts.json (id → bbox, score) and <out_dir>/contact.png
"""
import colorsys
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sheet = Image.open(sys.argv[1]).convert("RGBA")
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
rgba = np.asarray(sheet)
mask = rgba[..., 3] > 8

# Connected components by repeated min-propagation of pixel ids (no scipy here).
h, w = mask.shape
big = np.iinfo(np.int32).max
labels = np.where(mask, np.arange(h * w, dtype=np.int32).reshape(h, w), big)
while True:
    prev = labels
    m = labels.copy()
    m[1:, :] = np.minimum(m[1:, :], labels[:-1, :])
    m[:-1, :] = np.minimum(m[:-1, :], labels[1:, :])
    m[:, 1:] = np.minimum(m[:, 1:], labels[:, :-1])
    m[:, :-1] = np.minimum(m[:, :-1], labels[:, 1:])
    m[1:, 1:] = np.minimum(m[1:, 1:], labels[:-1, :-1])
    m[:-1, :-1] = np.minimum(m[:-1, :-1], labels[1:, 1:])
    m[1:, :-1] = np.minimum(m[1:, :-1], labels[:-1, 1:])
    m[:-1, 1:] = np.minimum(m[:-1, 1:], labels[1:, :-1])
    labels = np.where(mask, m, big)
    if np.array_equal(labels, prev):
        break

parts = []
for lab in np.unique(labels[mask]):
    ys, xs = np.nonzero(labels == lab)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    if (x1 - x0 + 1) * (y1 - y0 + 1) < 64 or len(xs) < 30:
        continue
    px = rgba[ys, xs].astype(np.float32) / 255
    a = px[:, 3]
    hsv = np.array([colorsys.rgb_to_hsv(*p[:3]) for p in px[:: max(1, len(px) // 400)]])
    sat, val = hsv[:, 1].mean(), hsv[:, 2].mean()
    soft = float((a < 0.9).mean())
    score = soft * 1.5 + val * sat + (val - 0.5) * 0.5
    hue = float(np.median(hsv[:, 0]))
    parts.append({"bbox": [int(x0), int(y0), int(x1) + 1, int(y1) + 1], "pixels": int(len(xs)),
                  "soft": round(soft, 2), "sat": round(float(sat), 2), "val": round(float(val), 2),
                  "hue": round(hue * 360), "score": round(float(score), 3)})

parts.sort(key=lambda p: -p["score"])
for i, p in enumerate(parts):
    p["id"] = i
(out / "parts.json").write_text(json.dumps(parts, indent=1))

cell = 120
cols = 12
show = parts[:96]
rows = (len(show) + cols - 1) // cols
contact = Image.new("RGBA", (cols * cell, rows * cell), (34, 36, 46, 255))
d = ImageDraw.Draw(contact)
for i, p in enumerate(show):
    piece = sheet.crop(tuple(p["bbox"]))
    piece.thumbnail((cell - 8, cell - 22))
    x, y = (i % cols) * cell, (i // cols) * cell
    contact.alpha_composite(piece, (x + (cell - piece.width) // 2, y + 18 + (cell - 18 - piece.height) // 2))
    bw, bh = p["bbox"][2] - p["bbox"][0], p["bbox"][3] - p["bbox"][1]
    d.text((x + 3, y + 2), f'#{p["id"]} {bw}x{bh}', fill=(255, 220, 0, 255))
contact.save(out / "contact.png")
print(len(parts), "parts; contact shows", len(show))
