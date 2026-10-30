"""Place a piece where it best explains the part of the reference silhouette that the current assembly
does not cover yet (inside a band), penalising piece pixels that fall on sky. FFT over all positions.

usage: python3 tools/fit_sil.py <reference.png> <placements.json> <ids> <scales> <rots> <bx0,by0,bx1,by1> [penalty]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_matches import compose, placed_piece
from match import SHEET, PARTS, fft_corr
from refmask import load

ref_path = sys.argv[1]
placements = json.loads(Path(sys.argv[2]).read_text()) if sys.argv[2] != "-" else []
ids = [int(v) for v in sys.argv[3].split(",")]
scales = [float(v) for v in sys.argv[4].split(",")]
rots = [float(v) for v in sys.argv[5].split(",")]
bx0, by0, bx1, by1 = [int(v) for v in sys.argv[6].split(",")]
penalty = float(sys.argv[7]) if len(sys.argv) > 7 else 1.5
S, IGN = load(ref_path)
H, W = S.shape
cover = np.asarray(compose(placements, (W, H)))[..., 3] > 60 if placements else np.zeros((H, W), bool)
band = np.zeros((H, W), bool)
band[by0:by1, bx0:bx1] = True
target = (S & ~cover & band).astype(float)
sky = (~S & ~IGN).astype(float)
T = target.sum()
sheet = Image.open(SHEET).convert("RGBA")
parts = {p["id"]: p for p in json.loads(PARTS.read_text())}
res = []
for pid in ids:
    for flip in (False, True):
        for s in scales:
            for r in rots:
                pc = placed_piece(sheet, parts, {"part": pid, "flip": flip, "scale": s, "rot": r})
                a = (np.asarray(pc)[..., 3] > 60).astype(float)
                h, w = a.shape
                if h >= H or w >= W:
                    continue
                shp = (H + h, W + w)
                hit = fft_corr(target, a, shp)[h - 1:H, w - 1:W]
                off = fft_corr(sky, a, shp)[h - 1:H, w - 1:W]
                sc = hit / (T + penalty * off + 1)
                y, x = np.unravel_index(np.argmax(sc), sc.shape)
                res.append({"part": pid, "flip": flip, "scale": s, "rot": r, "x": int(x), "y": int(y),
                            "fit": round(float(sc[y, x]), 3), "hit": int(round(hit[y, x])), "off": int(round(off[y, x]))})
res.sort(key=lambda r: -r["fit"])
print("target px", int(T))
seen = set()
for r in res:
    if r["part"] in seen:
        continue
    seen.add(r["part"])
    print(json.dumps(r))
    if len(seen) >= 8:
        break
