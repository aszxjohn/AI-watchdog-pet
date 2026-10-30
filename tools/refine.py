"""Nudge an assembly towards a reference frame: coordinate descent over every layer's position and scale
(rotation and layer order stay as given), scoring silhouette IoU against the reference's non-sky pixels
minus the colour error where both overlap.

usage: python3 tools/refine.py <reference.png> <in.json> <out.json> [passes] [locked ids,comma]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_matches import placed_piece
from match import SHEET, PARTS

ref_img = Image.open(sys.argv[1]).convert("RGB")
layers = json.loads(Path(sys.argv[2]).read_text())
passes = int(sys.argv[4]) if len(sys.argv) > 4 else 3
locked = {int(v) for v in sys.argv[5].split(",")} if len(sys.argv) > 5 and sys.argv[5] else set()

R = np.asarray(ref_img).astype(np.float64) / 255
from refmask import load
S, IGNORE = load(sys.argv[1])
H, W = S.shape
Rl = R ** 0.5          # lifted tones so dark armour counts in the colour term

sheet = Image.open(SHEET).convert("RGBA")
parts = {p["id"]: p for p in json.loads(PARTS.read_text())}
cache = {}


def piece(r):
    key = (r["part"], bool(r.get("flip")), round(r.get("scale", 1), 3), r.get("rot", 0))
    if key not in cache:
        a = np.asarray(placed_piece(sheet, parts, r)).astype(np.float64) / 255
        cache[key] = a
    return cache[key]


def render(ls):
    rgb = np.zeros((H, W, 3))
    alpha = np.zeros((H, W))
    for r in ls:
        a = piece(r)
        h, w = a.shape[:2]
        x0, y0 = r["x"], r["y"]
        xs, ys = max(0, x0), max(0, y0)
        xe, ye = min(W, x0 + w), min(H, y0 + h)
        if xe <= xs or ye <= ys:
            continue
        sub = a[ys - y0:ye - y0, xs - x0:xe - x0]
        sa = sub[..., 3:4]
        rgb[ys:ye, xs:xe] = sub[..., :3] * sa + rgb[ys:ye, xs:xe] * (1 - sa)
        alpha[ys:ye, xs:xe] = sa[..., 0] + alpha[ys:ye, xs:xe] * (1 - sa[..., 0])
    return rgb, alpha


def score(ls):
    rgb, alpha = render(ls)
    A = (alpha > 0.25) & ~IGNORE
    iou = (A & S).sum() / max(1, (A | S).sum())
    both = A & S
    if both.sum() == 0:
        return iou
    err = np.abs(rgb[both] ** 0.5 - Rl[both]).mean()
    return iou - 0.6 * err


best = score(layers)
print(f"start {best:.4f}")
for p in range(passes):
    for i, r in enumerate(layers):
        if r["part"] in locked:
            continue
        cur = dict(r)
        for ds in (-0.05, 0, 0.05):
            for dy in range(-6, 7, 2):
                for dx in range(-6, 7, 2):
                    cand = dict(cur, x=cur["x"] + dx, y=cur["y"] + dy, scale=round(cur["scale"] + ds, 3))
                    trial = layers[:i] + [cand] + layers[i + 1:]
                    s = score(trial)
                    if s > best + 1e-5:
                        best = s
                        layers[i] = cand
        print(f"pass {p + 1} layer #{r['part']}: {best:.4f}  ->", {k: layers[i][k] for k in ('x', 'y', 'scale')})
Path(sys.argv[3]).write_text(json.dumps(layers, indent=1))
print(f"final {best:.4f}")
