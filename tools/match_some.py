"""Focused version of match.py: given piece ids, fine scales and rotations, report each piece's best fit.

usage: python3 tools/match_some.py <reference.png> <ids,comma> <scales,comma> <rotations,comma> [region x0,y0,x1,y1]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from match import match_piece, SHEET, PARTS

ref_img = Image.open(sys.argv[1]).convert("RGB")
ids = [int(v) for v in sys.argv[2].split(",")]
scales = [float(v) for v in sys.argv[3].split(",")]
rots = [float(v) for v in sys.argv[4].split(",")]
region = [int(v) for v in sys.argv[5].split(",")] if len(sys.argv) > 5 else None
ref = np.asarray(ref_img).astype(np.float64) / 255
sheet = Image.open(SHEET).convert("RGBA")
parts = {p["id"]: p for p in json.loads(PARTS.read_text())}
for pid in ids:
    base = sheet.crop(tuple(parts[pid]["bbox"]))
    best = None
    for flip in (False, True):
        src = base.transpose(Image.FLIP_LEFT_RIGHT) if flip else base
        for s in scales:
            sc = src.resize((max(1, round(src.width * s)), max(1, round(src.height * s))), Image.LANCZOS)
            for r in rots:
                piece = sc.rotate(r, resample=Image.BICUBIC, expand=True) if r else sc
                score, n = match_piece(ref, piece)
                if score is None:
                    continue
                if region:
                    x0, y0, x1, y1 = region
                    sub = np.full_like(score, -1)
                    sub[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = score[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
                    score = sub
                y, x = np.unravel_index(np.argmax(score), score.shape)
                cand = {"part": pid, "flip": flip, "scale": s, "rot": r, "x": int(x), "y": int(y), "w": piece.width,
                        "h": piece.height, "ncc": round(float(score[y, x]), 3)}
                if best is None or cand["ncc"] > best["ncc"]:
                    best = cand
    print(json.dumps(best))
