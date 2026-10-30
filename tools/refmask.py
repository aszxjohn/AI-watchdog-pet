"""Silhouette of the unit in a reference video frame: everything that is not sky blue, minus the areas
listed in <reference>.ignore.json (letterbox bars, the on-screen banner) which count for neither side."""
import json
from pathlib import Path

import numpy as np
from PIL import Image


def load(ref_path):
    """Returns (silhouette bool H×W, ignore bool H×W)."""
    r = np.asarray(Image.open(ref_path).convert("RGB")).astype(int)
    sky = (r[..., 2] > 110) & (r[..., 2] > r[..., 0] + 45) & (r[..., 2] > r[..., 1] + 10)
    ignore = np.zeros(sky.shape, bool)
    side = Path(str(ref_path) + ".ignore.json")
    for x0, y0, x1, y1 in (json.loads(side.read_text()) if side.exists() else []):
        ignore[y0:y1, x0:x1] = True
    return ~sky & ~ignore, ignore
