"""Silhouette difference: red = in the reference but not assembled, green = assembled but not in reference.
usage: python3 tools/diffmap.py <reference.png> <placements.json> <out.png>"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_matches import compose

ref = Image.open(sys.argv[1]).convert("RGBA")
art = compose(json.loads(Path(sys.argv[2]).read_text()), ref.size)
from refmask import load
sil, ignore = load(sys.argv[1])
A = (np.asarray(art)[..., 3] > 60) & ~ignore
out = (np.asarray(ref.convert("RGB")).astype(float) * 0.35).astype(np.uint8)
out[sil & ~A] = (255, 40, 40)
out[A & ~sil] = (40, 255, 80)
box = [int(v) for v in sys.argv[4].split(",")] if len(sys.argv) > 4 else [150, 30, 480, 310]
c = Image.fromarray(out).crop(box)
c.resize((c.width * 2, c.height * 2), Image.NEAREST).save(sys.argv[3])
