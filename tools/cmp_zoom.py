"""Reference vs assembled, body area, zoomed — for the assemble/compare loop.
usage: python3 tools/cmp_zoom.py <reference.png> <placements.json> <out.png> [x0,y0,x1,y1]"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_matches import compose

ref = Image.open(sys.argv[1]).convert("RGBA")
art = compose(json.loads(Path(sys.argv[2]).read_text()), ref.size)
box = [int(v) for v in sys.argv[4].split(",")] if len(sys.argv) > 4 else [150, 30, 480, 310]
bg = Image.new("RGBA", ref.size, (60, 110, 190, 255))
bg.alpha_composite(art)
ghost = ref.copy()
a = art.copy()
a.putalpha(a.getchannel("A").point(lambda v: v * 0.55))
ghost.alpha_composite(a)
tiles = [im.crop(box) for im in (ref, bg, ghost)]
z = 2
W, H = tiles[0].width * z, tiles[0].height * z
out = Image.new("RGBA", (W * 3 + 20, H + 22), (20, 20, 28, 255))
for i, (t, lbl) in enumerate(zip(tiles, ("reference", "assembled", "overlay"))):
    out.alpha_composite(t.resize((W, H), Image.LANCZOS), (i * (W + 10), 22))
    ImageDraw.Draw(out).text((i * (W + 10) + 4, 4), lbl, fill=(255, 220, 0, 255))
out.save(sys.argv[3])
# silhouette agreement: reference pixels that are not sky (blue) vs the assembled alpha, inside the box
import numpy as np
from refmask import load
sil, ignore = load(sys.argv[1])
art_a = (np.asarray(art)[..., 3] > 60) & ~ignore
x0, y0, x1, y1 = box
S, A = sil[y0:y1, x0:x1], art_a[y0:y1, x0:x1]
iou = (S & A).sum() / max(1, (S | A).sum())
miss = (S & ~A).sum() / max(1, S.sum())
extra = (A & ~S).sum() / max(1, A.sum())
print(sys.argv[3], out.size, f"IoU {iou:.3f}  missing {miss:.3f}  extra {extra:.3f}")
