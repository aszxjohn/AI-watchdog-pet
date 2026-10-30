"""Assemble a pose from parts-sheet pieces as a joint hierarchy, not as loose stickers.

Every node is one piece hung on its parent: `pivot` is the joint on the piece itself, `at` is where that
joint sits on the parent piece, `rot` is the joint angle (degrees, positive = counter-clockwise on screen).
A child's placement is computed from its parent's, so turning a joint carries everything below it along,
and no limb can drift off its socket. Coordinates are the piece's own pixels as displayed (after `flip`,
before any scaling); `scale` is relative to the parent (a root's is absolute).

rig json: {"canvas": [w, h], "sheet"?: "world" | "wars_ta", "nodes": [{"name", "part", "sheet"?, "flip"?,
           "erase"?: [polygon...], "parent"?, "at": [x, y], "pivot": [x, y], "rot"?, "scale"?, "z"?}, ...]}
           a root's `at` is a canvas position; `sheet` (the rig's, or a node's own) picks the parts sheet: the World
           sheet unless it says "wars_ta" (G Gen Wars' Trans-Am sheet).

usage: python3 tools/rig.py <rig.json> <out.png> [--joints] [--pose name=deg,...]
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "assets" / "raw" / "world_dynames.png"
PARTS = ROOT / "assets" / "parts" / "world_dynames" / "parts.json"
SHEETS = {"world": (SHEET, PARTS),
          "wars_ta": (ROOT / "assets" / "raw" / "wars_dynames_transam.png",
                      ROOT / "assets" / "parts" / "wars_dynames_transam" / "parts.json")}

_loaded = {}


def piece(node):
    name = node.get("sheet", "world")
    if name not in _loaded:
        sheet, parts = SHEETS[name]
        _loaded[name] = (Image.open(sheet).convert("RGBA"), {p["id"]: p["bbox"] for p in json.loads(parts.read_text())})
    sheet, boxes = _loaded[name]
    im = sheet.crop(tuple(boxes[node["part"]]))
    if node.get("flip"):
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    if node.get("erase"):
        keep = Image.new("L", im.size, 255)
        draw = ImageDraw.Draw(keep)
        for poly in node["erase"]:
            draw.polygon([tuple(v) for v in poly], fill=0)
        im.putalpha(Image.fromarray(np.minimum(np.asarray(im.getchannel("A")), np.asarray(keep))))
    return im


def mat(a, b, c, d, e, f):
    return np.array([[a, b, c], [d, e, f], [0, 0, 1]], dtype=float)


def rotm(deg):
    th = math.radians(deg)
    # y points down, so a counter-clockwise turn on screen is (x, y) -> (x cos + y sin, -x sin + y cos)
    return mat(math.cos(th), math.sin(th), 0, -math.sin(th), math.cos(th), 0)


def world(nodes):
    """Each node's draw matrix (piece pixels -> canvas). Angles and scales add up down the chain; `sx` squashes
    one piece along its own x (a limb pointing towards the camera) without squashing its children."""
    by = {n["name"]: n for n in nodes}
    draw, ang, scl = {}, {}, {}

    def get(name):
        if name not in draw:
            n = by[name]
            if n.get("parent"):
                get(n["parent"])
                a = draw[n["parent"]] @ np.array([n["at"][0], n["at"][1], 1])
                ang[name] = ang[n["parent"]] + n.get("rot", 0)
                scl[name] = scl[n["parent"]] * n.get("scale", 1.0)
            else:
                a = np.array([n["at"][0], n["at"][1], 1])
                ang[name] = n.get("rot", 0)
                scl[name] = n.get("scale", 1.0)
            s, sx = scl[name], n.get("sx", 1.0)
            px, py = n["pivot"]
            draw[name] = (mat(1, 0, a[0], 0, 1, a[1]) @ rotm(ang[name]) @ mat(s * sx, 0, 0, 0, s, 0)
                          @ mat(1, 0, -px, 0, 1, -py))
        return draw[name]

    for n in nodes:
        get(n["name"])
    return draw


def resolve(nodes):
    """`atCanvas` (a canvas point) -> `at` on the parent piece, measured in the rest pose, so the child is still
    hung on its parent afterwards and moves with it."""
    for n in nodes:
        if "atCanvas" in n and n.get("parent"):
            W = world([m for m in nodes if "at" in m or not m.get("parent")])
            inv = np.linalg.inv(W[n["parent"]])
            p = inv @ np.array([n["atCanvas"][0], n["atCanvas"][1], 1])
            n["at"] = [round(float(p[0]), 2), round(float(p[1]), 2)]
    return nodes


def render(rig, pose=None):
    nodes = resolve([dict(n) for n in rig["nodes"]])
    for n in nodes:
        if rig.get("sheet"):
            n.setdefault("sheet", rig["sheet"])
        if pose and n["name"] in pose:
            n["rot"] = pose[n["name"]]
    W = world(nodes)
    w, h = rig["canvas"]
    can = Image.new("RGBA", (w, h))
    for n in sorted(nodes, key=lambda n: n.get("z", 0)):
        inv = np.linalg.inv(W[n["name"]])
        im = piece(n)
        layer = im.transform((w, h), Image.AFFINE, data=tuple(inv[:2].ravel()), resample=Image.BICUBIC)
        can.alpha_composite(layer)
    return can, nodes, W


def joints_overlay(can, nodes, W, k=1):
    out = can.copy()
    d = ImageDraw.Draw(out)
    for n in nodes:
        m = W[n["name"]]
        p = m @ np.array([n["pivot"][0], n["pivot"][1], 1])
        x, y = p[0] * k, p[1] * k
        d.ellipse([x - 3, y - 3, x + 3, y + 3], outline=(255, 40, 40, 255), width=2)
        d.text((x + 4, y - 6), n["name"], fill=(255, 255, 0, 255))
    return out


if __name__ == "__main__":
    rig = json.loads(Path(sys.argv[1]).read_text())
    pose = {}
    if "--pose" in sys.argv:
        for kv in sys.argv[sys.argv.index("--pose") + 1].split(","):
            k, v = kv.split("=")
            pose[k] = float(v)
    can, nodes, W = render(rig, pose)
    if "--joints" in sys.argv:
        can = joints_overlay(can, nodes, W)
    can.save(sys.argv[2])
    print(sys.argv[2], can.size)
