"""Like match.py, but only accepts placements whose centre falls inside a given box (reference pixels),
so each missing area of an assembly can be searched separately.

usage: python3 tools/match_region.py <reference.png> <cx0,cy0,cx1,cy1> <scales,comma> [min_px] [exclude ids,comma]
       [only ids,comma] [rotations,comma]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from match import match_piece, SHEET, PARTS

ref_img = Image.open(sys.argv[1]).convert("RGB")
cx0, cy0, cx1, cy1 = [int(v) for v in sys.argv[2].split(",")]
scales = [float(v) for v in sys.argv[3].split(",")]
min_px = int(sys.argv[4]) if len(sys.argv) > 4 else 800
exclude = {int(v) for v in sys.argv[5].split(",")} if len(sys.argv) > 5 and sys.argv[5] else set()
only = {int(v) for v in sys.argv[6].split(",")} if len(sys.argv) > 6 and sys.argv[6] else None
rots = [float(v) for v in sys.argv[7].split(",")] if len(sys.argv) > 7 and sys.argv[7] else [0.0]
gamma = float(sys.argv[8]) if len(sys.argv) > 8 else 1.0
ref = (np.asarray(ref_img).astype(np.float64) / 255) ** gamma
sheet = Image.open(SHEET).convert("RGBA")
parts = json.loads(PARTS.read_text())
out = []
for p in parts:
    if p["pixels"] < min_px or p["score"] > 0.9 or p["id"] in exclude or (only and p["id"] not in only):
        continue
    if p["sat"] > 0.45 and (p["hue"] < 30 or p["hue"] > 300):      # Trans-Am red / pink copies
        continue
    base = sheet.crop(tuple(p["bbox"]))
    for flip in (False, True):
        src = base.transpose(Image.FLIP_LEFT_RIGHT) if flip else base
        for s in scales:
          sc = src.resize((max(1, round(src.width * s)), max(1, round(src.height * s))), Image.LANCZOS)
          for rot in rots:
            piece = sc.rotate(rot, resample=Image.BICUBIC, expand=True) if rot else sc
            score, n = match_piece(ref, piece, gamma=gamma)
            if score is None:
                continue
            h, w = score.shape
            ys, xs = np.mgrid[0:h, 0:w]
            cx, cy = xs + piece.width / 2, ys + piece.height / 2
            score = np.where((cx >= cx0) & (cx <= cx1) & (cy >= cy0) & (cy <= cy1), score, -1)
            y, x = np.unravel_index(np.argmax(score), score.shape)
            if score[y, x] > -1:
                out.append({"part": p["id"], "flip": flip, "scale": s, "rot": rot, "x": int(x), "y": int(y),
                            "w": piece.width, "h": piece.height, "ncc": round(float(score[y, x]), 3), "px": int(n)})
best = {}
for r in out:
    if r["part"] not in best or r["ncc"] > best[r["part"]]["ncc"]:
        best[r["part"]] = r
for r in sorted(best.values(), key=lambda r: -r["ncc"] * np.log(r["px"]))[:10]:
    print(json.dumps(r))
