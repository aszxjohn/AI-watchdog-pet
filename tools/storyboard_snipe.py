"""Static storyboard of the thinking-state sniping motion built from the aim assembly (poses/match/aim_v6.json):
the rifle (#281) is its own layer turning around the right hand (#100); everything else stays as matched.

usage: python3 tools/storyboard_snipe.py <out.png> [angle:back[:label] ...]
angle in degrees (negative = clockwise on screen = muzzle up), back = pixels pushed back along the barrel
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compose_matches import compose, placed_piece
from match import SHEET, PARTS

ROOT = Path(__file__).resolve().parent.parent
AIM = json.loads((ROOT / "poses/match/aim_v6.json").read_text())
RIFLE = 281
W, H = 620, 460
OFF = (60, 40)          # move the assembly so a raised rifle stays on the canvas


def layers():
    return [dict(r, x=r["x"] + OFF[0], y=r["y"] + OFF[1]) for r in AIM]


def pivot():
    hand = next(r for r in layers() if r["part"] == 100)
    sheet = Image.open(SHEET).convert("RGBA")
    parts = {p["id"]: p for p in json.loads(PARTS.read_text())}
    pc = placed_piece(sheet, parts, hand)
    return hand["x"] + pc.width / 2, hand["y"] + pc.height / 2


# The low-ready rifle: #224 (thin, muzzle down) in the same right hand, placed by eye on the matched body.
LOW = {"part": 224, "flip": False, "scale": 1.05, "rot": 0, "x": 262 + OFF[0], "y": -10 + OFF[1]}


def frame(angle, back, piece=RIFLE):
    ls = layers()
    i = [r["part"] for r in ls].index(RIFLE)
    rifle = ls[i] if piece == RIFLE else LOW
    below = compose(ls[:i], (W, H))
    above = compose(ls[i + 1:], (W, H))
    rl = compose([rifle], (W, H))
    px, py = pivot()
    # barrel direction in the matched pose: from the pivot towards the muzzle end (lower left)
    t = math.radians(-angle)
    bx, by = -0.83, 0.56
    rl = rl.rotate(angle, resample=Image.BICUBIC, center=(px, py))
    dx = -(bx * math.cos(t) - by * math.sin(t)) * back
    dy = -(bx * math.sin(t) + by * math.cos(t)) * back
    out = Image.new("RGBA", (W, H))
    out.alpha_composite(below)
    shifted = Image.new("RGBA", (W, H))
    shifted.alpha_composite(rl, (round(dx), round(dy)))
    out.alpha_composite(shifted)
    out.alpha_composite(above)
    return out


if __name__ == "__main__":
    specs = sys.argv[2:] or ["224:0:0:待命", "224:-20:0:抬槍", "224:-38:0:抬槍", "281:5:0:到位過頭", "281:0:0:瞄準",
                             "281:-7:10:後座", "281:-2:3:回穩"]
    font = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 18)
    tiles = []
    for spec in specs:
        pc, a, b, *lbl = spec.split(":")
        im = frame(float(a), float(b), int(pc))
        bg = Image.new("RGBA", (W, H), (60, 110, 190, 255))
        bg.alpha_composite(im)
        ImageDraw.Draw(bg).text((8, 6), (lbl[0] if lbl else "") + f"  {a}°/{b}px", fill=(255, 230, 0, 255), font=font)
        tiles.append(bg)
    cols = 4
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * W, rows * H))
    for k, t in enumerate(tiles):
        sheet.alpha_composite(t, ((k % cols) * W, (k // cols) * H))
    sheet.save(sys.argv[1])
    print(sys.argv[1], sheet.size, "pivot", pivot())
