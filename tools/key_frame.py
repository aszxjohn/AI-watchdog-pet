"""Cut the unit out of a sky-background video frame (blue-sky chroma key).

Sky = blue-dominant pixels connected to the frame border; small blue specks inside the unit's outline
(GN particles) are removed too; the largest blob is kept; edges get a 1-px feather and the blue spill on
the edge pixels is pulled out. Areas listed in <frame>.ignore.json (banner, letterbox) are dropped.

usage: python3 tools/key_frame.py <frame.png> <out.png>
"""
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

src = Path(sys.argv[1])
a = np.asarray(Image.open(src).convert("RGB")).astype(np.float64)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
h, w = r.shape
sky = (b > 95) & (b > r + 35) & (b > g + 5)
ign = np.zeros((h, w), bool)
side = Path(str(src) + ".ignore.json")
for x0, y0, x1, y1 in (json.loads(side.read_text()) if side.exists() else []):
    ign[y0:y1, x0:x1] = True
keep = ~sky & ~ign
# largest connected blob = the unit
lab = np.zeros((h, w), np.int32)
best, best_n, cur = 0, 0, 0
for y0, x0 in zip(*np.nonzero(keep)):
    if lab[y0, x0]:
        continue
    cur += 1
    q = deque([(y0, x0)])
    lab[y0, x0] = cur
    n = 0
    while q:
        y, x = q.popleft()
        n += 1
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and keep[ny, nx] and not lab[ny, nx]:
                lab[ny, nx] = cur
                q.append((ny, nx))
    if n > best_n:
        best, best_n = cur, n
mask = lab == best
# fill small holes (particles in front of the body read as holes)
inv = ~mask
hl = np.zeros((h, w), np.int32)
cur = 0
for y0, x0 in zip(*np.nonzero(inv)):
    if hl[y0, x0]:
        continue
    cur += 1
    q = deque([(y0, x0)])
    hl[y0, x0] = cur
    pts = []
    border = False
    while q:
        y, x = q.popleft()
        pts.append((y, x))
        if y in (0, h - 1) or x in (0, w - 1):
            border = True
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and inv[ny, nx] and not hl[ny, nx]:
                hl[ny, nx] = cur
                q.append((ny, nx))
    if not border and len(pts) < 60:
        for y, x in pts:
            mask[y, x] = True
alpha = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
                   .filter(ImageFilter.GaussianBlur(0.7))).astype(np.float64)
# despill: on soft edge pixels clamp blue down to max(r, g)
edge = (alpha > 0) & (alpha < 250)
b2 = b.copy()
b2[edge] = np.minimum(b[edge], np.maximum(r[edge], g[edge]) + 10)
out = np.dstack([r, g, b2, alpha]).astype(np.uint8)
img = Image.fromarray(out)
img = img.crop(img.getbbox())
img.save(sys.argv[2])
print(sys.argv[2], img.size)
