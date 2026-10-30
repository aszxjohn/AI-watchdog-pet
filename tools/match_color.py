"""Fit pieces by one colour class only (e.g. the yellow V-fin), which survives dark lighting better
than full-colour NCC. Score = IoU of the colour masks inside a search box.

usage: python3 tools/match_color.py <reference.png> <yellow|white|cyan|red> <ids> <scales> <rots> <x0,y0,x1,y1>
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_matches import placed_piece
from match import SHEET, PARTS, fft_corr


def mask(rgb, kind, lift):
    a = (rgb / 255.0) ** lift
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    if kind == "yellow":
        return (r > 0.55) & (g > 0.42) & (b < 0.45) & (r > b + 0.25)
    if kind == "white":
        return (np.minimum(np.minimum(r, g), b) > 0.62) & (np.abs(r - b) < 0.2)
    if kind == "cyan":
        return (b > 0.6) & (g > 0.6) & (r < 0.6)
    if kind == "red":
        return (r > 0.5) & (g < 0.35) & (b < 0.4)
    raise SystemExit(kind)


ref = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(float)
kinds = sys.argv[2].split("+")
ids = [int(v) for v in sys.argv[3].split(",")]
scales = [float(v) for v in sys.argv[4].split(",")]
rots = [float(v) for v in sys.argv[5].split(",")]
x0, y0, x1, y1 = [int(v) for v in sys.argv[6].split(",")]
Ms = []
for kind in kinds:
    M = np.zeros(ref.shape[:2])
    M[y0:y1, x0:x1] = mask(ref, kind, 0.6)[y0:y1, x0:x1]
    Ms.append(M)
sheet = Image.open(SHEET).convert("RGBA")
parts = {p["id"]: p for p in json.loads(PARTS.read_text())}
res = []
H, W = Ms[0].shape
total = sum(M.sum() for M in Ms)
for pid in ids:
    for flip in (False, True):
        for s in scales:
            for r in rots:
                pc = np.asarray(placed_piece(sheet, parts, {"part": pid, "flip": flip, "scale": s, "rot": r})).astype(float)
                h, w = pc.shape[:2]
                if h > H or w > W:
                    continue
                score = 0
                for kind, M in zip(kinds, Ms):
                    pm = (mask(pc[..., :3], kind, 1.0) & (pc[..., 3] > 150)).astype(float)
                    n = pm.sum()
                    ov = fft_corr(M, pm, (H + h, W + w))[h - 1:H, w - 1:W]
                    score = score + ov / (M.sum() + n - ov + 1e-9) / len(kinds)
                yy, xx = np.unravel_index(np.argmax(score), score.shape)
                res.append({"part": pid, "flip": flip, "scale": s, "rot": r, "x": int(xx), "y": int(yy),
                            "w": w, "h": h, "iou": round(float(score[yy, xx]), 3)})
res.sort(key=lambda r: -r["iou"])
print("ref mask px", int(total))
for r in res[:8]:
    print(json.dumps(r))
