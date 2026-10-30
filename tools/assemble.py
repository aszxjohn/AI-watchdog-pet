"""Assemble a pose from parts-sheet pieces (no pixel editing: each piece is only placed, rotated, scaled,
flipped and layered), the way the G Generation battle animations build their frames.

A pose file (JSON) lists layers from back to front:
    {"sheet": "assets/raw/world_dynames.png",
     "parts": "assets/parts/world_dynames/parts.json",
     "layers": [{"part": 225, "x": 0, "y": 0, "rot": 0, "scale": 1, "flip": false, "pivot": [cx, cy]}, ...]}
x / y place the piece's pivot (default: its centre, in the piece's own pixels) on the pose canvas;
rot is degrees counter-clockwise around the pivot.

usage: python3 tools/assemble.py poses/snipe_aim.json preview/snipe_aim.png [zoom]
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def load_pose(path):
    pose = json.loads(Path(path).read_text())
    sheet = Image.open(ROOT / pose["sheet"]).convert("RGBA")
    parts = {p["id"]: p for p in json.loads((ROOT / pose["parts"]).read_text())}
    return pose, sheet, parts


def _piece(layer, sheet, parts):
    piece = sheet.crop(tuple(parts[layer["part"]]["bbox"]))
    if layer.get("flip"):
        piece = piece.transpose(Image.FLIP_LEFT_RIGHT)
    s = layer.get("scale", 1.0)
    if s != 1.0:
        piece = piece.resize((max(1, round(piece.width * s)), max(1, round(piece.height * s))), Image.LANCZOS)
    return piece


def split(pose, sheet, parts, loose):
    """Body = every layer except `loose` (index), drawn on one image; the loose layer is returned unrotated
    with its pivot, plus where that pivot sits on the body image. Used for a separately animated arm."""
    full = render(pose, sheet, parts, pad=0, keep_frame=True)
    frame_x0, frame_y0, canvas = full
    body_pose = dict(pose, layers=[l for i, l in enumerate(pose["layers"]) if i != loose])
    _, _, body = render(body_pose, sheet, parts, pad=0, keep_frame=True, frame=(frame_x0, frame_y0, canvas.size))
    layer = pose["layers"][loose]
    piece = _piece(layer, sheet, parts)
    s = layer.get("scale", 1.0)
    pivot = [v * s for v in layer.get("pivot", [piece.width / s / 2, piece.height / s / 2])]
    hand = [layer["x"] - frame_x0, layer["y"] - frame_y0]
    box = body.getbbox()
    body = body.crop(box)
    hand = [hand[0] - box[0], hand[1] - box[1]]
    return body, piece, pivot, hand


def render(pose, sheet, parts, pad=40, keep_frame=False, frame=None):
    placed = []
    for layer in pose["layers"]:
        piece = _piece(layer, sheet, parts)
        s = layer.get("scale", 1.0)
        px, py = layer.get("pivot", [piece.width / s / 2, piece.height / s / 2])
        px, py = px * s, py * s
        rot = layer.get("rot", 0)
        if rot:
            cx, cy = piece.width / 2, piece.height / 2
            t = math.radians(rot)
            dx, dy = px - cx, py - cy
            rx, ry = dx * math.cos(t) + dy * math.sin(t), -dx * math.sin(t) + dy * math.cos(t)
            piece = piece.rotate(rot, resample=Image.BICUBIC, expand=True)
            px, py = piece.width / 2 + rx, piece.height / 2 + ry
        placed.append((piece, layer["x"] - px, layer["y"] - py))
    if frame:
        x0, y0, size = frame
        canvas = Image.new("RGBA", size)
    else:
        x0 = min(x for _, x, _ in placed) - pad
        y0 = min(y for _, _, y in placed) - pad
        x1 = max(x + p.width for p, x, _ in placed)
        y1 = max(y + p.height for p, _, y in placed)
        canvas = Image.new("RGBA", (math.ceil(x1 - x0) + pad, math.ceil(y1 - y0) + pad))
    for p, x, y in placed:
        canvas.alpha_composite(p, (round(x - x0), round(y - y0)))
    if keep_frame:
        return x0, y0, canvas
    return canvas.crop(canvas.getbbox())


if __name__ == "__main__":
    pose, sheet, parts = load_pose(sys.argv[1])
    img = render(pose, sheet, parts)
    zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 2
    bg = Image.new("RGBA", img.size, (40, 42, 56, 255))
    bg.alpha_composite(img)
    bg = bg.resize((round(img.width * zoom), round(img.height * zoom)), Image.LANCZOS)
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    bg.save(out)
    print(out, img.size)
