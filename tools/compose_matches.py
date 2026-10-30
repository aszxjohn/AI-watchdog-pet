"""Draw a list of matched placements (as printed by match_some.py) onto a blank canvas the size of the
reference, and put it next to the reference and an overlay, for checking the assembly by eye.

usage: python3 tools/compose_matches.py <reference.png> <placements.json> <out.png>
placements.json: [{"part", "flip", "scale", "rot", "x", "y"}, ...] back to front
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from match import SHEET, PARTS


def placed_piece(sheet, parts, r):
    pc = sheet.crop(tuple(parts[r["part"]]["bbox"]))
    if r.get("flip"):
        pc = pc.transpose(Image.FLIP_LEFT_RIGHT)
    s = r.get("scale", 1)
    pc = pc.resize((max(1, round(pc.width * s)), max(1, round(pc.height * s))), Image.LANCZOS)
    if r.get("rot"):
        pc = pc.rotate(r["rot"], resample=Image.BICUBIC, expand=True)
    return pc


def compose(placements, size):
    sheet = Image.open(SHEET).convert("RGBA")
    parts = {p["id"]: p for p in json.loads(PARTS.read_text())}
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    for r in placements:
        canvas.alpha_composite(placed_piece(sheet, parts, r), (r["x"], r["y"]))
    return canvas


if __name__ == "__main__":
    ref = Image.open(sys.argv[1]).convert("RGBA")
    placements = json.loads(Path(sys.argv[2]).read_text())
    art = compose(placements, ref.size)
    blank = Image.new("RGBA", ref.size, (60, 110, 190, 255))
    blank.alpha_composite(art)
    over = ref.copy()
    ghost = art.copy()
    ghost.putalpha(ghost.getchannel("A").point(lambda v: v * 0.6))
    over.alpha_composite(ghost)
    w, h = ref.size
    out = Image.new("RGBA", (w * 3 + 20, h + 24), (20, 20, 28, 255))
    for i, (im, label) in enumerate(((ref, "reference"), (blank, "assembled"), (over, "overlay"))):
        out.alpha_composite(im, (i * (w + 10), 24))
        ImageDraw.Draw(out).text((i * (w + 10) + 4, 4), label, fill=(255, 220, 0, 255))
    out = out.resize((out.width * 2 // 1, out.height * 2 // 1), Image.LANCZOS) if w < 400 else out
    out.save(sys.argv[3])
    print(sys.argv[3], out.size)
