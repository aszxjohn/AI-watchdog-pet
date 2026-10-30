"""Find which parts-sheet pieces appear in a reference video frame, and where.

For every piece (and its mirror) at a range of scales, computes the masked normalised cross-correlation
(only over the piece's opaque pixels) against every position in the reference, via FFT. Lists the best
matches and draws them over the reference.

usage: python3 tools/match.py <reference.png> <out_prefix> [min_px] [scales...]
writes <out_prefix>.json (matches) and <out_prefix>.png (top matches outlined on the reference)
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "assets" / "raw" / "world_dynames.png"
PARTS = ROOT / "assets" / "parts" / "world_dynames" / "parts.json"


def fft_corr(a, b, shape):
    """Valid-mode cross-correlation of image a (H×W) with kernel b (h×w) using FFT."""
    fa = np.fft.rfft2(a, s=shape)
    fb = np.fft.rfft2(b[::-1, ::-1], s=shape)
    return np.fft.irfft2(fa * fb, s=shape)


def match_piece(ref, piece, blur=0.8, gamma=1.0):
    """Masked NCC map of piece (RGBA) over ref (H×W×3 float). Returns (score map, n).
    gamma < 1 lifts dark tones on the piece (apply the same to ref) so dark armour still has contrast."""
    p = piece.filter(ImageFilter.GaussianBlur(blur)) if blur else piece
    t = (np.asarray(p).astype(np.float64) / 255) ** gamma
    m = (np.asarray(piece)[..., 3] > 200).astype(np.float64)
    n = m.sum()
    if n < 50:
        return None, n
    H, W, _ = ref.shape
    h, w = m.shape
    if h > H or w > W:
        return None, n
    shape = (H + h, W + w)
    s_ii = np.zeros(shape)
    s_i = np.zeros(shape)
    s_ti = np.zeros(shape)
    s_t = 0.0
    s_tt = 0.0
    for c in range(3):
        I = ref[..., c]
        T = t[..., c] * m
        s_i += fft_corr(I, m, shape)
        s_ii += fft_corr(I * I, m, shape)
        s_ti += fft_corr(I, T, shape)
        s_t += T.sum()
        s_tt += (T * T).sum()
    N = 3 * n
    # valid region: kernel fully inside the image; the correlation peak for top-left offset (y, x)
    # sits at index (y + h - 1, x + w - 1)
    sl = (slice(h - 1, H), slice(w - 1, W))
    num = s_ti[sl] - s_t * s_i[sl] / N
    den = np.sqrt(np.maximum(1e-9, (s_tt - s_t * s_t / N) * (s_ii[sl] - s_i[sl] ** 2 / N)))
    return num / den, n


def main():
    ref_path, out = sys.argv[1], sys.argv[2]
    min_px = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
    scales = [float(v) for v in sys.argv[4:]] or [0.8, 0.9, 1.0, 1.1, 1.2]
    ref_img = Image.open(ref_path).convert("RGB")
    ref = np.asarray(ref_img).astype(np.float64) / 255
    sheet = Image.open(SHEET).convert("RGBA")
    parts = json.loads(PARTS.read_text())
    results = []
    for p in parts:
        if p["pixels"] < min_px or p["score"] > 0.9:      # skip tiny pieces and glow effects
            continue
        base = sheet.crop(tuple(p["bbox"]))
        for flip in (False, True):
            src = base.transpose(Image.FLIP_LEFT_RIGHT) if flip else base
            for s in scales:
                piece = src.resize((max(1, round(src.width * s)), max(1, round(src.height * s))), Image.LANCZOS)
                score, n = match_piece(ref, piece)
                if score is None:
                    continue
                y, x = np.unravel_index(np.argmax(score), score.shape)
                results.append({"part": p["id"], "flip": flip, "scale": s, "x": int(x), "y": int(y),
                                "w": piece.width, "h": piece.height, "ncc": round(float(score[y, x]), 3),
                                "px": int(n)})
    # best per part
    best = {}
    for r in results:
        if r["part"] not in best or r["ncc"] > best[r["part"]]["ncc"]:
            best[r["part"]] = r
    ranked = sorted(best.values(), key=lambda r: -r["ncc"] * np.log(r["px"]))
    Path(out + ".json").write_text(json.dumps(ranked, indent=1))
    vis = ref_img.resize((ref_img.width * 3, ref_img.height * 3), Image.LANCZOS).convert("RGBA")
    d = ImageDraw.Draw(vis)
    colors = [(255, 60, 60), (60, 255, 60), (255, 220, 0), (0, 200, 255), (255, 0, 255), (255, 140, 0),
              (180, 120, 255), (255, 255, 255)]
    for i, r in enumerate(ranked[:8]):
        c = colors[i % len(colors)] + (255,)
        d.rectangle([r["x"] * 3, r["y"] * 3, (r["x"] + r["w"]) * 3, (r["y"] + r["h"]) * 3], outline=c, width=3)
        d.text((r["x"] * 3 + 4, r["y"] * 3 + 4), f"#{r['part']}{' F' if r['flip'] else ''} {r['ncc']:.2f}", fill=c)
    vis.save(out + ".png")
    for r in ranked[:20]:
        print(r)


if __name__ == "__main__":
    main()
