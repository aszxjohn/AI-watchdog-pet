"""A test character that is not Dynames: 測試球 (TEST-01), drawn here from circles (no game sprites), to check that a
character package stands on its own — it runs in an app without any character module, next to Dynames, and goes out
and back in as a character file.

Its 8 states use every kind of acting a package can have:
  waiting     system flourish (plays "stand" now and then) + JSON emitter
  thinking    JSON timeline ("frames" with an expression) + JSON particles with looks
  working     JSON layers + a JavaScript program (frames, an orbiting spark, body bob, its own loop)
  permission  plain: the system's hold playback only (no state file script)
  question    JSON body motion (sway)
  done        JSON "play" + a glowing layer
  sleeping    JSON "frames" + drift + "12pt" emitter
  error       plain: the system's hold with the opening hit

usage: python3 tools/make_fixture.py [out_dir]      (default: build/fixtures/blob — build/ is not in git)
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build" / "fixtures" / "blob"
S = 120                      # frame size (pixels); the body stands on (60, 104)


def blob(squash=1.0, eyes=1.0, tint=(90, 170, 255), lean=0.0, antenna=0.0, closed=False):
    """A round body with two eyes and an antenna; squash < 1 flattens it, eyes 0…1 opens them."""
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    w, h = 76, 76 * squash
    cx, by = 60 + lean * 10, 104
    box = [cx - w / 2, by - h, cx + w / 2, by]
    d.ellipse(box, fill=tint + (255,), outline=(20, 40, 70, 255), width=3)
    d.ellipse([cx - 24, by - h + 10, cx + 4, by - h + 26], fill=(255, 255, 255, 90))          # shine
    ey = by - h * 0.55
    for ex in (cx - 14, cx + 14):
        if closed or eyes < 0.15:
            d.line([ex - 6, ey, ex + 6, ey], fill=(20, 30, 50, 255), width=3)
        else:
            d.ellipse([ex - 5, ey - 7 * eyes, ex + 5, ey + 7 * eyes], fill=(20, 30, 50, 255))
    ax, ay = cx + math.sin(antenna) * 10, by - h - 14
    d.line([cx, by - h, ax, ay], fill=(20, 40, 70, 255), width=3)
    d.ellipse([ax - 5, ay - 5, ax + 5, ay + 5], fill=(255, 210, 80, 255))
    return im


def dot(color, size=32, blur=4):
    im = Image.new("RGBA", (size, size))
    ImageDraw.Draw(im).ellipse([8, 8, size - 8, size - 8], fill=color + (255,))
    return im.filter(ImageFilter.GaussianBlur(blur))


def star(size=40):
    im = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(im)
    c = size / 2
    pts = []
    for k in range(10):
        r = c - 2 if k % 2 == 0 else c * 0.35
        a = k * math.pi / 5 - math.pi / 2
        pts.append((c + r * math.cos(a), c + r * math.sin(a)))
    d.polygon(pts, fill=(255, 230, 120, 255))
    return im


def save(im, rel):
    p = OUT / "assets" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    im.save(p)
    return rel


def anim(name, frames, segments=None):
    paths = [save(f, f"{name}/{i:02d}.png") for i, f in enumerate(frames)]
    a = {"frames": paths, "size": [S, S], "anchor": [60, 104]}
    if segments:
        a["segments"] = segments
    return a


def main():
    anims = {
        "stand": anim("stand", [blob(squash=1 - 0.05 * math.sin(k * math.pi / 3), eyes=0.1 if k == 3 else 1)
                                for k in range(6)]),
        "spin": anim("spin", [blob(antenna=k * math.pi / 4, tint=(255, 140, 90)) for k in range(8)]),
        "shield": anim("shield", [blob(squash=s, tint=(150, 150, 255)) for s in (1, .9, .8, .8, .9, 1)],
                       {"in": [0, 1], "hold": [2, 3], "out": [4, 5]}),
        "back": anim("back", [blob(closed=True), blob(closed=True, squash=.95)]),
        "dash": anim("dash", [blob(lean=.6, squash=.9), blob(lean=.3)]),
        "sleep": anim("sleep", [blob(closed=True, squash=s, tint=(120, 140, 200)) for s in (.85, .82, .8, .82)]),
    }
    fx = {"dot": save(dot((140, 220, 255)), "fx/dot.png"), "spark": save(star(), "fx/spark.png"),
          "glow": save(dot((255, 240, 160), 64, 10), "fx/glow.png")}
    unit = {
        "id": "blob", "name": "測試球", "code": "TEST-01",
        "animations": anims,
        "fx": fx,
        "rig": {
            "states": {
                "waiting": {"anim": "stand", "mode": "flourish", "fps": 8},
                "thinking": {"anim": "stand", "mode": "still"},
                "working": {"anim": "spin", "mode": "still"},
                "permission": {"anim": "shield", "mode": "hold", "fps": 8},
                "question": {"anim": "stand", "mode": "still", "hud": "alert"},
                "done": {"anim": "back", "mode": "still"},
                "sleeping": {"anim": "sleep", "mode": "still", "dim": 0.85},
                "error": {"anim": "shield", "mode": "hold", "fps": 8, "hit": True},
            },
            "enter": "dash", "leave": "back",
            "core": [60, 66],
        },
    }
    (OUT / "assets").mkdir(parents=True, exist_ok=True)
    (OUT / "assets" / "unit.json").write_text(json.dumps(unit, ensure_ascii=False, indent=1))

    calm = {"wander": False, "cells": [], "strength": 0.5, "step": "small", "stay": [4, 8], "speed": 200}
    character = {"id": "blob", "name": "測試球", "code": "TEST-01",
                 "tags": {"work": "測試", "series": "角色包測試", "generation": "fixture"},
                 "height": 80, "trail": {"image": "fx/dot", "color": [0.55, 0.85, 1]},
                 "states": {s: dict(calm) for s in unit["rig"]["states"]}}
    (OUT / "character.json").write_text(json.dumps(character, ensure_ascii=False, indent=1))

    dots = {"name": "dots", "back": True, "at": "core", "size": "16pt", "render": "additive",
            "cells": [{"image": "fx/dot", "rate": 6, "life": 1.5, "velocity": "0.3*h", "velocityRange": 8,
                       "range": "2*pi", "yAccel": 10, "scale": 0.4, "alphaSpeed": -0.6, "color": [0.6, 0.9, 1]}]}
    states = {
        "waiting": {"params": [], "script": {"moveWhileActing": True,
                                             "emitters": [dict(dots, birthRate="0.5 + 0.5*sin(t*2*pi/3)")]}},
        "thinking": {"params": [{"name": "speed", "type": "number", "default": 8, "min": 2, "max": 20, "step": 1,
                                 "user": True, "label": "眨眼速度"}],
                     "script": {"timeline": [{"do": "particles", "look": "think"},
                                             {"do": "frames", "anim": "stand", "index": "floor(t*$speed) % count",
                                              "for": "12/4"}],
                                "particles": {"image": "fx/dot", "core": "core", "size": 20, "color": [1, 0.9, 0.5],
                                              "cell": {"lifetime": 1.2, "scale": 0.3},
                                              "looks": {"think": {"range": "pi/3", "longitude": "pi/2",
                                                                  "velocity": 30, "rate": 2}}}}},
        "working": {"params": [], "script": {"program": "working.js",
                                             "layers": [{"name": "spark", "image": "fx/spark", "size": "24pt"}]}},
        "question": {"params": [], "script": {"moveWhileActing": True,
                                              "body": {"dx": "6*sin(t*2*pi/1.5)", "lean": "-6*sin(t*2*pi/1.5)"}}},
        "done": {"params": [], "script": {"loop": False, "moveWhileActing": True,
                                          "timeline": [{"do": "play", "anim": "back", "frames": [0, 1], "fps": 4}],
                                          "layers": [{"image": "fx/glow", "at": "core", "size": 0.9,
                                                      "opacity": "0.5 + 0.3*sin(st*2*pi/1.2)",
                                                      "scale": "1 + 0.1*sin(st*2*pi/1.2)", "back": True}]}},
        "sleeping": {"params": [], "script": {"moveWhileActing": True,
                                              "timeline": [{"do": "frames", "anim": "sleep",
                                                            "index": "round((0.5 - 0.5*cos(t*2*pi/4))*(count - 1))",
                                                            "for": 4}],
                                              "body": {"dy": "3*sin(t*2*pi/5)"},
                                              "emitters": [dict(dots, name=None, size="12pt", birthRate=0.4)]}},
    }
    (OUT / "states").mkdir(exist_ok=True)
    for name, o in states.items():
        if "emitters" in o["script"]:
            for e in o["script"]["emitters"]:
                if e.get("name") is None:
                    e.pop("name", None)
        (OUT / "states" / f"{name}.json").write_text(json.dumps(o, ensure_ascii=False, indent=1))
    (OUT / "states" / "working.js").write_text("""// 測試球 — working: spins, an orbiting spark, a little bob; loops every 2 seconds.
function frame(x) { return ["spin", Math.floor(x.t * 10) % pet.frames("spin")]; }
function loopEnds(t) { return t >= 2 && t % 2 < 1 / 15; }
function react(x) { return {dy: 2 * Math.sin(x.t * 2 * Math.PI)}; }
function update(x) {
  var core = pet.point("core") || [0, 0];
  var a = x.t * 2 * Math.PI / 1.2;
  return {layers: {spark: {x: core[0] + Math.cos(a) * x.h * 0.45, y: core[1] + Math.sin(a) * x.h * 0.3,
                           rotation: a, opacity: 0.9}}};
}
""")
    print(OUT)


if __name__ == "__main__":
    main()
