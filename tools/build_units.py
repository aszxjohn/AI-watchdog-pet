"""Turn extracted Cross Rays rips into the unit folders the app reads.

Each source frame in the rips is trimmed and pinned to the top-left corner, so
consecutive frames are not registered. We re-register every sequence by
cross-correlating each frame against the previous one, put all frames on one
shared canvas, scale the unit to a common height, and write:

    units/<id>/unit.json
    units/<id>/<anim>/NN.png

usage: python3 tools/build_units.py [unit_id ...]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "extracted"
OUT = ROOT / "units"
PREVIEW = ROOT / "preview"

# Height (px) of the idle pose after scaling. The app draws at @2x, so this is 2x
# the on-screen height in points.
TARGET_H = 240
SHEET_WORLD = ROOT / "assets" / "raw" / "world_dynames.png"
PARTS_WORLD = ROOT / "assets" / "parts" / "world_dynames" / "parts.json"

# Per-unit source mapping. Globs are relative to SRC/<id>.
# The 15-frame sequences all go rest pose → action pose → rest pose, so each one is split into
# in / hold / out segments; the app plays "in", loops "hold" for as long as the state lasts,
# and plays "out" before switching. Single-frame entries are stills.
UNITS = {
    "dynames": {
        "name": "力天使", "fullName": "Gundam Dynames", "code": "GN-002",
        "base": "stand",
        "anims": {
            "stand": "g1140u01000 Gundam Dynames/01_*.PNG",    # rifle at the side → shifts stance
            "aim": "g1140u01000 Gundam Dynames/08_*.PNG",      # raises the GN sniper rifle
            "shield": "g1140u01000 Gundam Dynames/11_*.PNG",   # GN full shield closes
            "cocoon": "g1140u01000 Gundam Dynames/18_*.PNG",   # full shield, curled up
            "pose_a": "g1140u01000 Gundam Dynames/p03_*.PNG",
            "pose_b": "g1140u01000 Gundam Dynames/p05_*.PNG",
            "dash": "g1140u01000 Gundam Dynames/p09_*.PNG",    # charging at the viewer
            "back": "g1140u01000 Gundam Dynames/p19_*.PNG",    # turned away, GN drive showing
        },
        # How the app acts out each session state with these animations (passed through to unit.json).
        #   mode: flourish = rest on frame 0, now and then play the whole move (and sometimes a fidget pose)
        #         hold     = play "in", loop "hold" until the state ends, play "out" on the way out
        #         still    = frame 0 only
        #         attack   = sniping loop on attackPose: GN charge at the muzzle, flash, beam, recoil
        #         pistols  = 工作中: raise the twin pistols, then burst after burst, the two guns in turn
        #   hud: scan = lock-on reticle sweeping ahead, alert = blinking orange corner brackets
        #   gnIdle: GN particles keep drifting off the back; jet: during the move they stream backwards
        #         and a converging jet is added
        "rig": {
            "states": {
                # Three parts: 面向左邊 (rest), 前衝 (the stand move), 低頭 (pose_a, now and then).
                "waiting": {"anim": "stand", "mode": "flourish", "fidget": ["pose_a"],
                            "gnIdle": True, "jet": True},
                # 思考中 and 工作中 swapped animations at the user's word (10/29): the sniping cycle (locked) now plays
                # for 工作中, the twin pistols for 思考中.
                # 舉槍 (arms come up) → 雙槍連射 (pistols fire in turn, bursts with a pause), looping.
                # Its own frames, layers and timings; nothing shared with the other states.
                "thinking": {"anim": "pistol", "mode": "pistols"},
                # 預備射擊 (aim stance, reticle sweeping) → 瞄準 (reticle locks on) → 射擊 (fireAnim, beam
                # bolt, recoil), looping. Separate from the waiting state's settings.
                # 10/29: the user kept Lockon's cut-in and asked for the rest to become Dynames' TRANS-AM, the whole
                # set of moves (Stage.swift "working — TRANS-AM"); the sniping cycle itself stays in the code, locked.
                "working": {"anim": "snipe_ta", "mode": "transam"},
                # 防禦待命：full shield closes, a GN field sphere rises around it, "!" blinks. Its own layers.
                # (10/30: the blinking orange corner brackets, "hud": "alert", were taken off both shield states)
                "permission": {"anim": "shield", "mode": "field", "fps": 8},
                # 支援防禦：flies forward, braces behind the full shield, a volley of bullets sparks off it, opens up
                # and drops back, looping. Its own layers.
                "question": {"anim": "shield", "mode": "defend", "fps": 12},
                # 做完了: turned away, GN particles pouring out of the GN drive on its back (its own layers).
                "done": {"anim": "back", "mode": "drive"},
                # 休息中: curled up in the closed shields, adrift as if in zero gravity: slowly turning left 3/4 →
                # front and back ("turn" frames), wandering and tilting a little, letting out GN particles.
                # No "dim" — fading the whole unit read as see-through on the desktop (user removed it 10/29).
                "sleeping": {"anim": "turn", "mode": "float"},
                "error": {"anim": "shield", "mode": "hold", "fps": 8, "hit": True},
            },
            "enter": "dash",
            "leave": "back",
            # GN sniper rifle in pose_b (p05): muzzle tip and barrel direction, in that image's pixels.
            "muzzle": [24, 120],
            "aimDir": [-66, 68],
            # Degrees the body tilts while sniping (negative = clockwise), lifting the barrel.
            "lean": -12,
            # Thinking cycle (狙擊準備 → 瞄準 cut-in → 射擊) all in the World-parts sniping pose "snipe"
            # (poses/snipe_aim_v2.json); its muzzle and barrel direction are measured at build time.
            "fireAnim": "snipe",
            "fireLean": 0,
        },
        # Effect pieces cut from the G Generation World parts sheet (assets/raw/world_dynames.png,
        # boxes found with tools/parts.py): beam, muzzle glow, energy orb, smoke halo, shards, glints.
        "fx": {
            "sheet": "assets/raw/world_dynames.png",
            "pieces": {
                "beam": [434, 1984, 626, 2004],
                "flash": [1186, 731, 1220, 754],
                "orb": [1114, 1038, 1151, 1073],
                "halo": [709, 1969, 752, 2012],
                "spark_a": [497, 1957, 526, 1970],
                "spark_b": [536, 1954, 556, 1973],
                "glow_a": [458, 1954, 489, 1971],
                "glow_b": [427, 1954, 451, 1977],
            },
            # GN particles: the World blobs above are replaced by G Gen Wars' Celestial Being GN particle sheet
            # (round dot → glow_a, cross glint → glow_b), each resized to the old blob's width (31 / 24 px) so every
            # emitter keeps its settings (direction, rate, scale, tint) and only the picture changes. The user picked
            # this over a 1.5× version (46 / 36 px): the game dots read finer than the old fog.
            "gn": {"dir": "assets/extracted/wars_combat_effects/_0 Effects", "file": "GNparticle_CB.png",
                   "pieces": {"glow_a": [[70, 18, 84, 33], 31], "glow_b": [[82, 3, 99, 22], 24]}},
        },
        # Thinking pose built from World parts: #286 (complete body holding the rifle in both hands) + #260
        # (rifle behind it, restoring the barrel the rip cuts off) + #119 head, two head frames (look / turn).
        "snipe": {"pose": "poses/snipe_aim_v2.json", "scale": 1.2, "lift": 105},
        # 工作中's TRANS-AM (10/29), after Cross Rays' "Trans-Am" attack (YouTube BBQPyxrJAN8, 3:02) told with
        # G Gen Wars' own Trans-Am pieces (assets/raw/wars_dynames_transam.png, spriters-resource asset 130260). That
        # sheet holds the same big drawings as the World sheet, 1.33× larger and in Trans-Am red: `swap` maps the
        # World parts of the sniping pose to them (silhouettes match, IoU ≥ 0.97), so "snipe_ta" lines up with
        # "snipe" pixel for pixel. `stand` is a Trans-Am full body with no World twin (the reveal / dashes);
        # (The head and muzzle close-ups built from the sheet were taken out on 10/30.) `intro` is the game's own opening, frame by frame from the Cross Rays video (182.0 s
        # on, 30 fps, packed 8 to a row in cells of `cell` pixels, cropped to the panel's shape clear of the HUD and
        # subtitles; the standing shot again from 185.0 s with a bigger crop so the whole body is in): `runs` are
        # the sheet frames played, back to back (the camera coming down onto the head, the eyes flashing, the black
        # cut, the TRANS-AM screen, then the standing body turning red); `cuts` are where the TRANS-AM screen and the
        # standing shot start (the panel's edge changes colour there). All sheet pieces face right and are flipped,
        # like the sniping pose.
        "transam": {"sheet": "assets/raw/wars_dynames_transam.png", "parts": "assets/parts/wars_dynames_transam/parts.json",
                    "swap": {"286": 136, "260": 52, "119": 13},
                    # 10/30: 0.9 → 0.72 with "aim", then 0.72 → 0.6 so its head is 等你回覆's size (it was 1.2×)
                    "stand": {"part": 139, "flip": False, "scale": 0.6},
                    # The Trans-Am sniping shot (10/30): the full-armament firing pose of Wars' Trans-Am "GN Sniper
                    # Rifle" (74.4 s), a rig of Wars Trans-Am parts (#76 body, #23 right shoulder shield, #6 left
                    # shoulder + arm + shield, #164 rifle; frame 1 swaps the rifle for #9, its muzzle lit). `muzzle` is
                    # the bore's middle on the rifle piece and `barrel` a point on the barrel's centre line behind it
                    # (the shot leaves along barrel → muzzle); `core` is the body's middle on #76 (GN particles); `lift`
                    # puts the body as high above the pinned point as the sniping pose's. `fx` are Wars' own pink
                    # beam-rifle effects (DV_efe = Dynames'): `key` ones are drawn on black for adding light, so their
                    # brightness becomes their opacity.
                    # 10/30: scale 1.4 → 1.12 (the user: a little smaller, so its darting about shows more)
                    "aim": {"pose": "poses/ta_snipe_v3.json", "fire": {"rifle": 9}, "scale": 1.12, "pad": 6,
                            "muzzle": [44, 139], "barrel": [150, 81], "core": [70, 95], "lift": 105},
                    "fx": {"dir": "assets/extracted/wars_combat_effects/_0 Effects",
                           "pieces": {"burst": ["DV_efe.png", [286, 6, 470, 138]],
                                      "lens": ["DV_efe.png", [272, 270, 505, 504], "key"],
                                      "cross": ["DV_efe.png", [2, 172, 34, 404]],
                                      "ring": ["DV_efe.png", [164, 32, 276, 144]],
                                      "orb": ["DV_efe.png", [99, 40, 162, 102]],
                                      "beam": ["DV_efe.png", [10, 6, 87, 66]],
                                      "spike": ["GN_beamrifule_P.png", [0, 107, 59, 175]],
                                      "spark": ["DV_efe.png", [40, 322, 181, 397]]}},
                    "intro": {"sheet": "assets/reference_video/transam/screen/cr_transam_intro_182.0-186.0_30fps_8x440.png",
                              "cols": 8, "cell": [440, 261], "runs": [[3, 91], [96, 118]], "cuts": [48, 96], "fps": 30}},
        # Working pose: twin GN beam pistols, assembled as a joint hierarchy (tools/rig.py) from World parts and
        # matched to G Gen Wars' GN Beam Pistol frame. Frames: arms coming up (0-2), aim (3), right / left recoil
        # (4, 5); `raise` and `recoil` are joint angles added to the aim pose (degrees, + = down).
        # The two guns keep their own angles (the bolts fly on two staggered lines). Recoil only flips a gun up a
        # few degrees: a bigger flip points the gun away from where its bolt is flying and the shot looks curved.
        # 休息中's turn: cocoon frames 9–14, the game's own turn from its most-left view to the front. Only this half:
        # a mirrored right half was tried, but the front frame is not symmetric, so passing the front had to swap the
        # shields from one side to the other in a single step and the turn visibly broke there (user, 10/29).
        "turn": {"from": "cocoon", "frames": [9, 10, 11, 12, 13, 14]},
        # 10/30 scale 1.1 → 0.8: its head was 1.38× 等你回覆's (helmet top to eye, 73 vs 52 px); every state is
        # drawn at 等你回覆's size (the user: 大小差異 請同步大小, 我喜歡右邊)
        "pistol": {"rig": "poses/pistol_rig_v14.json", "scale": 0.8, "lift": 40, "pad": [80, 90],
                   "raise": {"rUpper": 50, "nearFore": 45},
                   "recoil": [{"farGun": -4}, {"nearGun": -4}],
                   "guns": ["farGun", "nearGun"],
                   # each pistol's barrel in its own picture (they are drawn tipped down-left, not along x)
                   "barrel": {"farGun": [-1, 0.02], "nearGun": [-1, 0.22]}},
        # 要你批准 (GN field around the closed shield) and 要你決定 (support defend: bullets hitting the shield) both
        # use the "shield" frames; measure where the shield's front is (bullets land there) and the body's centre and
        # reach (the field sphere) on the braced frame.
        "shieldMarks": {"anim": "shield", "frame": 7, "hits": 6},
        # 要你批准's GN field: G Generation Wars' own GN フィールド atlas (assets/raw/wars_combat_effects.zip,
        # "_0 Effects/GNF.png", the field in the battle video) — two sparkle spheres, the rim ring, the bright arc and the
        # soft glow, each cut out as drawn. Every piece is laid on the same square (`canvas`) around one centre, the
        # sphere `sphere` across, so the app stacks them as they are; [x0, y0, x1, y1] boxes in the atlas,
        # "size" = width as a fraction of the sphere, "dy" = offset of its centre (fraction of the sphere), "flip" = upside
        # down (the arc is drawn as the top of a circle; the game puts it at the bottom, where the field glows).
        "field": {"atlas": "assets/extracted/wars_combat_effects/_0 Effects/GNF.png", "canvas": 640, "sphere": 440,
                  "pieces": {"sphereA": {"box": [2, 2, 118, 118], "size": 1.0},
                             "sphereB": {"box": [1, 122, 118, 239], "size": 1.0},
                             "ring": {"box": [120, 0, 208, 88], "size": 1.0},
                             "arc": {"box": [121, 89, 195, 127], "size": 0.84, "dy": 0.30, "flip": True},
                             "glow": {"box": [123, 132, 205, 212], "size": 1.4}}},
        # 要你批准's attack on the GN field, as in the battle video: G Generation Wars' own effect pieces
        # (assets/raw/wars_combat_effects.zip, "_0 Effects"), cut out as drawn: an orange shell (2PMG), the white hit flash,
        # fireballs and smoke (w04_exp_128pixl, w05_flow_exp_128) and embers. [file, [x0, y0, x1, y1]].
        "attack": {"dir": "assets/extracted/wars_combat_effects/_0 Effects",
                   "pieces": {"shell": ["2PMG.png", [80, 0, 112, 39]], "shellGlow": ["2PMG.png", [177, 0, 207, 40]],
                              "flash": ["w04_exp_128pixl.png", [0, 76, 32, 109]],
                              "fireA": ["w04_exp_128pixl.png", [41, 1, 85, 43]],
                              "fireB": ["w05_flow_exp_128.png", [3, 0, 41, 44]],
                              "fireC": ["w04_exp_128pixl.png", [3, 0, 37, 36]],
                              "smokeA": ["w04_exp_128pixl.png", [86, 15, 126, 54]],
                              "smokeB": ["w04_exp_128pixl.png", [84, 75, 124, 128]],
                              "embers": ["w04_exp_128pixl.png", [0, 107, 36, 128]],
                              # 要你決定 (support defend): sparks thrown off the shield and the glow where a round lands
                              "spark": ["hibana_Y.png", [0, 0, 65, 45]], "sparkBig": ["hibana_Y.png", [112, 100, 182, 189]],
                              "hitGlow": ["hibana_Y.png", [131, 200, 184, 252]]}},
        # 做完了's GN drive, from G Generation Wars' own GN effects (assets/raw/wars_combat_effects.zip, "_0 Effects"):
        # the flare and green core at the drive, and the dots, sparkles and soft puffs it lets out. `at` is the drive's
        # glowing end on the "back" frame (pixels).
        # `at` = the middle of the drive's rounded end, `radius` = its radius (pixels on the "back" frame).
        "drive": {"dir": "assets/extracted/wars_combat_effects/_0 Effects", "anim": "back", "at": [119, 60], "radius": 15,
                  "pieces": {"flare": ["oo_ring_flash.png", [0, 0, 178, 178]], "core": ["oo_ring_flash.png", [180, 4, 251, 62]],
                             "dot": ["oo_ring_flash.png", [112, 183, 126, 198]], "star": ["oo_gn_pati.png", [127, 0, 152, 24]],
                             "puff": ["oo_gn_pati.png", [77, 62, 114, 99]]},
                  # drawn for additive blending (dark = see-through): converted so the dark parts become transparent
                  "additive": ["flare"],
                  # how see-through the middle of each piece is made (alpha × this at the centre, back to full at
                  # `edge` × the piece's radius), so the drive under the glow still shows
                  "clearMiddle": {"flare": [0.12, 0.55]}},
        # 出錯了's seal tape, drawn here (none of the effect packs has hazard tape): ERROR words between stripe blocks,
        # thin stripe rims, after the user's caution-tape references but without the yellow ground — only stripes and
        # letters, each with a thin dark rim so they read on light and dark desktops, and faint scanlines baked in, as
        # if seen on a screen. Size in pixels, 2× the points the app shows it at (the user asked for it taller; the
        # ERROR plate that sat above it was taken out).
        "alarm": {"stripe": [255, 196, 26], "text": [255, 64, 56],
                  "font": "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf",
                  "tape": [520, 48]},
        # 瞄準 cut-in (thinking): Lockon's sniping cockpit sequence from G Generation Wars' "Lockon Stratos -
        # Event Cutins" sheet (assets/raw/wars_lockon_event.png, boxes found with tools/parts.py).
        "cutin": {
            "sheet": "assets/raw/wars_lockon_event.png",
            "pieces": {
                "cockpit": [0, 724, 687, 1236],     # Lockon in the Dynames cockpit
                "face": [10, 0, 500, 290],          # helmet close-up, looking ahead
                "eye": [858, 544, 1540, 774],       # eye-level strip, looking through the scope
                "scope": [529, 12, 888, 708],       # the precision scope that drops from the ceiling
                "reticle": [1173, 313, 1363, 502],
                "arc_a": [1036, 338, 1127, 420],
                "arc_b": [1036, 255, 1127, 331],
                "arc_c": [1036, 193, 1120, 249],
                "arc_d": [1037, 424, 1126, 505],
                "square": [1206, 81, 1255, 131],
                "diamond": [1042, 12, 1178, 147],
                "line": [13, 466, 497, 503],        # cyan scan line
                "tint": [733, 926, 1120, 1097],     # teal gradient laid over the scope view
            },
            "pupil": [348, 101],                    # his pupil in eye.png; the lock-on square sits on it
        },
    },
}

SEGMENTS_15 = {"in": [0, 3], "hold": [4, 10], "out": [11, 14]}


def render_pose(pose, part_image):
    """Draw a layered pose (poses/*.json, the sniping pose's format) with `part_image(id)` giving each part's
    picture: the same steps as the "snipe" block, frame 0 only (erase / clip, flip, scale, the head, flipAll)."""
    def piece(pid, flip, sc, erase=(), clip=None):
        im = part_image(pid).copy()
        keep = Image.new("L", im.size, 0 if clip else 255)
        draw = ImageDraw.Draw(keep)
        if clip:
            draw.polygon([tuple(v) for v in clip], fill=255)
        for poly in erase:
            draw.polygon([tuple(v) for v in poly], fill=0)
        if erase or clip:
            im.putalpha(Image.fromarray(np.minimum(np.asarray(im.getchannel("A")), np.asarray(keep))))
        if flip:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        return im.resize((round(im.width * sc), round(im.height * sc)), Image.LANCZOS)

    can = Image.new("RGBA", tuple(pose["canvas"]))
    for l in pose["layers"]:
        can.alpha_composite(piece(l["part"], l.get("flip"), l["scale"], l.get("erase", ()), l.get("clip")),
                            (l["x"], l["y"]))
    flip, sc, cx, cy = pose["headFrames"]["0"]
    hd = piece(pose["head"], flip, sc)
    can.alpha_composite(hd, (round(cx - hd.width / 2), round(cy - hd.height / 2)))
    return can.transpose(Image.FLIP_LEFT_RIGHT) if pose.get("flipAll") else can


def alarm_pieces(al):
    """出錯了's seal tape on a transparent ground (see the "alarm" spec)."""
    from PIL import ImageFilter, ImageFont
    stripe, text = tuple(al["stripe"]) + (255,), tuple(al["text"]) + (255,)

    def stripes(d, x0, y0, x1, y1, pitch):
        h = y1 - y0
        x = x0 - h
        while x < x1:
            d.polygon([(x, y1), (x + pitch / 2, y1), (x + pitch / 2 + h, y0), (x + h, y0)], fill=stripe)
            x += pitch

    def clipped(im, box):
        m = Image.new("L", im.size, 0)
        ImageDraw.Draw(m).rectangle(box, fill=255)
        out = Image.new("RGBA", im.size)
        out.paste(im, (0, 0), m)
        return out

    def finish(im):
        # thin dark rim, then every third row fainter (scanlines)
        rim = Image.new("RGBA", im.size, (10, 10, 14, 0))
        rim.putalpha(im.getchannel("A").filter(ImageFilter.MaxFilter(3)).point(lambda v: v * 150 // 255))
        rim.alpha_composite(im)
        a = np.array(rim).astype(float)
        a[::3, :, 3] *= 0.55
        return Image.fromarray(a.clip(0, 255).astype(np.uint8))

    length, h = al["tape"]
    tape = Image.new("RGBA", (length, h))
    d = ImageDraw.Draw(tape)
    rim = max(2, round(h * 0.12))
    d.rectangle([0, 0, length, rim], fill=stripe)
    d.rectangle([0, h - rim, length, h], fill=stripe)
    font = ImageFont.truetype(al["font"], round(h * 0.7))
    # the letters' own ink box (font metrics leave room for descenders, so anchoring by them sits capitals too high)
    ink = Image.new("L", (h * 4, h * 2))
    ImageDraw.Draw(ink).text((h, h // 2), "ERROR", font=font, fill=255)
    ib = ink.getbbox()
    letters = ink.crop(ib)
    word, block = round(h * 2.6), round(h * 2.2)
    # stripe block, ERROR, stripe block, … ending in a block; centred, the end blocks cut off by the tape's ends
    n = max(1, round((length - block) / (block + word)))
    x = (length - n * word - (n + 1) * block) // 2
    for k in range(n + 1):
        blk = Image.new("RGBA", tape.size)
        stripes(ImageDraw.Draw(blk), x, rim + 2, x + block, h - rim - 2, h * 0.7)
        tape.alpha_composite(clipped(blk, (max(0, x), rim + 2, min(length, x + block), h - rim - 2)))
        x += block
        if k < n:
            # centred on the tape's height (the rims are the same top and bottom), not touching the top rim
            colour = Image.new("RGBA", letters.size, text)
            colour.putalpha(letters)
            tape.alpha_composite(colour, (round(x + (word - letters.width) / 2), round((h - letters.height) / 2)))
            x += word
    return {"tape": finish(tape)}


def load(path):
    im = Image.open(path).convert("RGBA")
    return im.crop(im.getbbox())


def shift_between(ref, cur):
    """Offset (dx, dy) to add to cur's top-left so it best overlays ref (both top-left at 0)."""
    a = np.asarray(ref, dtype=np.float32)[..., 3] / 255.0
    b = np.asarray(cur, dtype=np.float32)[..., 3] / 255.0
    h = a.shape[0] + b.shape[0]
    w = a.shape[1] + b.shape[1]
    fa = np.fft.rfft2(a, s=(h, w))
    fb = np.fft.rfft2(b, s=(h, w))
    corr = np.fft.irfft2(fa * np.conj(fb), s=(h, w))
    dy, dx = np.unravel_index(np.argmax(corr), corr.shape)
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w
    return int(dx), int(dy)


def register(frames):
    offsets = [(0, 0)]
    for prev, cur in zip(frames, frames[1:]):
        dx, dy = shift_between(prev, cur)
        px, py = offsets[-1]
        offsets.append((px + dx, py + dy))
    return offsets


def compose(frames, offsets, scale):
    """Put registered frames on one shared canvas and scale it. Also returns where frame 0's
    top-left corner landed on the (unscaled) canvas, so points in frame 0 can be mapped onto it."""
    x0 = min(ox for ox, _ in offsets)
    y0 = min(oy for _, oy in offsets)
    x1 = max(ox + f.width for f, (ox, _) in zip(frames, offsets))
    y1 = max(oy + f.height for f, (_, oy) in zip(frames, offsets))
    pad = 4
    cw, ch = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    out_w, out_h = round(cw * scale), round(ch * scale)
    result = []
    for f, (ox, oy) in zip(frames, offsets):
        canvas = Image.new("RGBA", (cw, ch))
        canvas.alpha_composite(f, (ox - x0 + pad, oy - y0 + pad))
        result.append(canvas.resize((out_w, out_h), Image.LANCZOS))
    origin = (offsets[0][0] - x0 + pad, offsets[0][1] - y0 + pad)
    return result, origin


def centroid(im):
    """Alpha-weighted centroid (x, y) in the image's own pixels."""
    a = np.asarray(im, dtype=np.float32)[..., 3]
    ys, xs = np.nonzero(a > 16)
    wts = a[ys, xs]
    return float(np.average(xs, weights=wts)), float(np.average(ys, weights=wts))


def build(unit_id):
    spec = UNITS[unit_id]
    src = SRC / unit_id
    anims = {name: sorted(src.glob(glob)) for name, glob in spec["anims"].items()}
    for name, paths in anims.items():
        if not paths:
            raise SystemExit(f"{unit_id}/{name}: no frames for {spec['anims'][name]}")

    base_f0 = load(anims[spec["base"]][0])
    scale = TARGET_H / base_f0.height
    # The pinned point: the base pose's centroid. Every other animation gets the same body point,
    # found by overlaying its first frame on the base pose, so switching animations does not jump.
    base_pin = centroid(base_f0)

    out_dir = OUT / unit_id
    if out_dir.exists():
        for old in out_dir.rglob("*.png"):
            old.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"id": unit_id, "name": spec["name"], "fullName": spec["fullName"], "code": spec["code"],
                "rig": spec.get("rig", {}), "animations": {}}
    previews = {}
    for name, paths in anims.items():
        frames = [load(p) for p in paths]
        offsets = register(frames)
        scaled, origin = compose(frames, offsets, scale)
        dx, dy = shift_between(base_f0, frames[0])
        pin = ((base_pin[0] - dx + origin[0]) * scale, (base_pin[1] - dy + origin[1]) * scale)
        (out_dir / name).mkdir(exist_ok=True)
        names = []
        for i, im in enumerate(scaled):
            rel = f"{name}/{i:02d}.png"
            im.save(out_dir / rel, optimize=True)
            names.append(rel)
        entry = {"frames": names, "size": list(scaled[0].size), "anchor": [round(pin[0], 1), round(pin[1], 1)]}
        if len(frames) == 15:
            entry["segments"] = SEGMENTS_15
        manifest["animations"][name] = entry
        previews[name] = scaled
        print(f"{unit_id}/{name}: {len(frames)} frames, canvas {scaled[0].size}, pin {entry['anchor']}")
    if "turn" in spec:
        tn = spec["turn"]
        base = manifest["animations"][tn["from"]]
        frames = [Image.open(out_dir / base["frames"][i]).convert("RGBA") for i in tn["frames"]]
        (out_dir / "turn").mkdir(exist_ok=True)
        names = []
        for i, im in enumerate(frames):
            rel = f"turn/{i:02d}.png"
            im.save(out_dir / rel, optimize=True)
            names.append(rel)
        manifest["animations"]["turn"] = {"frames": names, "size": base["size"], "anchor": base["anchor"]}
        previews["turn"] = frames
        print(f"{unit_id}/turn: {len(frames)} frames (left 3/4 → front)")
    if "fx" in spec:
        sheet = Image.open(ROOT / spec["fx"]["sheet"]).convert("RGBA")
        (out_dir / "fx").mkdir(exist_ok=True)
        manifest["fx"] = {}
        for name, box in spec["fx"]["pieces"].items():
            sheet.crop(tuple(box)).save(out_dir / "fx" / f"{name}.png")
            manifest["fx"][name] = f"fx/{name}.png"
        if "gn" in spec["fx"]:
            gn = spec["fx"]["gn"]
            gsheet = Image.open(ROOT / gn["dir"] / gn["file"]).convert("RGBA")
            for name, (box, w) in gn["pieces"].items():
                im = gsheet.crop(tuple(box))
                im.resize((w, round(w * im.height / im.width)), Image.LANCZOS).save(out_dir / "fx" / f"{name}.png")
        print(f"{unit_id}/fx: {', '.join(manifest['fx'])}")
    if "puppet" in spec:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import assemble
        pp = spec["puppet"]
        pose, psheet, pparts = assemble.load_pose(ROOT / pp["pose"])
        body, arm, pivot, hand = assemble.split(pose, psheet, pparts, pp["loose"])
        k = pp["scale"]
        body = body.resize((round(body.width * k), round(body.height * k)), Image.LANCZOS)
        arm = arm.resize((round(arm.width * k), round(arm.height * k)), Image.LANCZOS)
        layer = pose["layers"][pp["loose"]]
        ls = layer.get("scale", 1.0)
        (out_dir / "snipe").mkdir(exist_ok=True)
        body.save(out_dir / "snipe" / "body.png")
        arm.save(out_dir / "snipe" / "rifle.png")
        manifest["animations"]["snipe_body"] = {"frames": ["snipe/body.png"], "size": list(body.size),
                                                "anchor": [round(v, 1) for v in centroid(body)]}
        manifest["snipe"] = {
            "rifle": "snipe/rifle.png",
            "hand": [round(hand[0] * k, 1), round(hand[1] * k, 1)],
            "grip": [round(pivot[0] * k, 1), round(pivot[1] * k, 1)],
            "muzzle": [round(pp["muzzle"][0] * ls * k, 1), round(pp["muzzle"][1] * ls * k, 1)],
            "barrel": pp["barrel"],
        }
        print(f"{unit_id}/snipe: puppet body {body.size} + rifle arm {arm.size}")
    if "snipe" in spec:
        sp = spec["snipe"]
        pose = json.loads((ROOT / sp["pose"]).read_text())
        psheet = Image.open(SHEET_WORLD).convert("RGBA")
        boxes = {p["id"]: p["bbox"] for p in json.loads(PARTS_WORLD.read_text())}

        def piece(pid, flip, sc, erase=(), clip=None):
            im = psheet.crop(tuple(boxes[pid]))
            # erase: cut away these polygons; clip: keep only inside this one (the part's own pixels, before
            # flipping or scaling)
            keep = Image.new("L", im.size, 0 if clip else 255)
            draw = ImageDraw.Draw(keep)
            if clip:
                draw.polygon([tuple(v) for v in clip], fill=255)
            for poly in erase:
                draw.polygon([tuple(v) for v in poly], fill=0)
            if erase or clip:
                im.putalpha(Image.fromarray(np.minimum(np.asarray(im.getchannel("A")), np.asarray(keep))))
            if flip:
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
            return im.resize((round(im.width * sc), round(im.height * sc)), Image.LANCZOS)

        frames = []
        for key in sorted(pose["headFrames"]):
            if not key.isdigit():
                continue
            can = Image.new("RGBA", tuple(pose["canvas"]))
            for l in pose["layers"]:
                can.alpha_composite(piece(l["part"], l.get("flip"), l["scale"], l.get("erase", ()), l.get("clip")),
                                    (l["x"], l["y"]))
            flip, sc, cx, cy = pose["headFrames"][key]
            hd = piece(pose["head"], flip, sc)
            can.alpha_composite(hd, (round(cx - hd.width / 2), round(cy - hd.height / 2)))
            frames.append(can.transpose(Image.FLIP_LEFT_RIGHT) if pose.get("flipAll") else can)
        box = frames[0].getbbox()
        for f in frames[1:]:
            b2 = f.getbbox()
            box = (min(box[0], b2[0]), min(box[1], b2[1]), max(box[2], b2[2]), max(box[3], b2[3]))
        k = sp["scale"]
        frames = [f.crop(box) for f in frames]
        frames = [f.resize((round(f.width * k), round(f.height * k)), Image.LANCZOS) for f in frames]
        (out_dir / "snipe").mkdir(exist_ok=True)
        names = []
        for i, f in enumerate(frames):
            f.save(out_dir / "snipe" / f"{i:02d}.png")
            names.append(f"snipe/{i:02d}.png")
        # Barrel direction: #286's barrel runs dx/dy = 0.937 (down-right); mirrored by flipAll.
        d = np.array([0.684, 0.730])
        if pose.get("flipAll"):
            d[0] = -d[0]
        al = np.asarray(frames[0])[..., 3] > 100
        ys, xs = np.nonzero(al)
        proj = xs * d[0] + ys * d[1]
        tip = np.argmax(proj)
        # The farthest pixel is a corner of the muzzle brake, not its centre: walk back along the barrel,
        # take the middle of the opaque run across it at each step, fit a line through those middles, and
        # use it for both the muzzle face centre and the beam direction. Stops before the rod under the barrel.
        n = np.array([d[1], -d[0]])
        t0 = np.array([xs[tip], ys[tip]], dtype=float)
        backs, mids = [], []
        for b in range(3, 46):
            c = t0 - d * b
            ss = np.arange(-30, 30.5, 0.5)
            pts = np.rint(c[None, :] + ss[:, None] * n[None, :]).astype(int)
            ok = (pts[:, 0] >= 0) & (pts[:, 0] < al.shape[1]) & (pts[:, 1] >= 0) & (pts[:, 1] < al.shape[0])
            hit = np.zeros(len(ss), bool)
            hit[ok] = al[pts[ok, 1], pts[ok, 0]]
            runs, start = [], None
            for i, v in enumerate(np.append(hit, False)):
                if v and start is None:
                    start = i
                elif not v and start is not None:
                    runs.append((ss[start], ss[i - 1]))
                    start = None
            if runs:
                ref = mids[-1] if mids else 0.0
                lo, hi = min(runs, key=lambda r: abs((r[0] + r[1]) / 2 - ref))
                backs.append(b)
                mids.append((lo + hi) / 2)
        k, s0 = np.polyfit(backs, mids, 1)
        axis = d - k * n
        axis /= np.linalg.norm(axis)
        inset = 6
        mx, my = t0 - d * inset + n * (s0 + k * inset)
        d = axis
        w, h = frames[0].size
        # Pinned point: the body centre, raised by `lift` pixels so the barrel and beam have room below.
        cxb, cyb = centroid(frames[0])
        manifest["animations"]["snipe"] = {"frames": names, "size": [w, h],
                                           "anchor": [round(cxb, 1), round(cyb + sp["lift"], 1)]}
        manifest["rig"]["snipeMuzzle"] = [round(float(mx), 1), round(float(my), 1)]
        manifest["rig"]["snipeDir"] = [round(float(d[0]), 3), round(float(d[1]), 3)]
        manifest["rig"]["snipeCore"] = [round(cxb, 1), round(cyb, 1)]     # body centre, for the GN particles
        print(f"{unit_id}/snipe: {len(frames)} frames {w}x{h}, muzzle {manifest['rig']['snipeMuzzle']}")
    if "transam" in spec and "snipe" in spec:
        ta = spec["transam"]
        tsheet = Image.open(ROOT / ta["sheet"]).convert("RGBA")
        tboxes = {p["id"]: p["bbox"] for p in json.loads((ROOT / ta["parts"]).read_text())}
        wsheet = Image.open(SHEET_WORLD).convert("RGBA")
        wboxes = {p["id"]: p["bbox"] for p in json.loads(PARTS_WORLD.read_text())}
        swap = {int(k): v for k, v in ta["swap"].items()}

        def world_part(pid):
            return wsheet.crop(tuple(wboxes[pid]))

        def ta_part(pid):
            # the same drawing in Trans-Am red, brought to the World part's size so every offset in the pose fits
            return tsheet.crop(tuple(tboxes[swap[pid]])).resize(world_part(pid).size, Image.LANCZOS)

        sp = spec["snipe"]
        pose = json.loads((ROOT / sp["pose"]).read_text())
        box = render_pose(pose, world_part).getbbox()       # the "snipe" frames' crop, so the two line up
        k = sp["scale"]
        red = render_pose(pose, ta_part).crop(box)
        red = red.resize((round(red.width * k), round(red.height * k)), Image.LANCZOS)
        (out_dir / "snipe_ta").mkdir(exist_ok=True)
        red.save(out_dir / "snipe_ta" / "00.png")
        manifest["animations"]["snipe_ta"] = dict(manifest["animations"]["snipe"], frames=["snipe_ta/00.png"])
        # The standing Trans-Am body: Wars pixels → World pixels (÷1.33) → the sniping pose's scale.
        st = ta["stand"]
        im = tsheet.crop(tuple(tboxes[st["part"]]))
        if st["flip"]:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        im = im.resize((round(im.width * st["scale"]), round(im.height * st["scale"])), Image.LANCZOS)
        pad = 8
        can = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad))
        can.alpha_composite(im, (pad, pad))
        (out_dir / "ta_stand").mkdir(exist_ok=True)
        can.save(out_dir / "ta_stand" / "00.png")
        cx, cy = centroid(can)
        manifest["animations"]["ta_stand"] = {"frames": ["ta_stand/00.png"], "size": list(can.size),
                                              "anchor": [round(cx, 1), round(cy + sp["lift"], 1)]}
        manifest["rig"]["taStandCore"] = [round(cx, 1), round(cy, 1)]
        # Cut-in shots and the TRANS-AM screen.
        (out_dir / "transam").mkdir(exist_ok=True)
        manifest["transam"] = {}
        sc = ta["intro"]
        sheet = Image.open(ROOT / sc["sheet"]).convert("RGB")
        cw, ch = sc["cell"]
        played = [i for a, b in sc["runs"] for i in range(a, b + 1)]
        for n, i in enumerate(played):
            x, y = i % sc["cols"] * cw, i // sc["cols"] * ch
            sheet.crop((x, y, x + cw, y + ch)).save(out_dir / "transam" / f"scr_{n:03d}.png")
            manifest["transam"][f"scr_{n:03d}"] = f"transam/scr_{n:03d}.png"
        manifest["rig"]["taScreen"] = [len(played), sc["fps"]]
        manifest["rig"]["taIntroCuts"] = [played.index(i) for i in sc["cuts"]]
        # The Trans-Am sniping shot: frame 0 aiming, frame 1 firing (the lit-muzzle rifle), same geometry.
        import rig as rigtool
        am = ta["aim"]
        pose = json.loads((ROOT / am["pose"]).read_text())
        k = am["scale"]
        renders = []
        for swap in ({}, am["fire"]):
            rp = dict(pose, nodes=[dict(n, **({"part": swap[n["name"]]} if n["name"] in swap else {}))
                                   for n in pose["nodes"]])
            renders.append(rigtool.render(rp))
        can0, nodes0, W0 = renders[0]
        x0, y0, x1, y1 = can0.getbbox()
        pad = am["pad"]
        box = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)

        def to_frame(pt):
            return [(pt[0] - box[0]) * k, (pt[1] - box[1]) * k]
        (out_dir / "ta_snipe").mkdir(exist_ok=True)
        frames = []
        for n, (can, _, _) in enumerate(renders):
            im = can.crop(box)
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
            im.save(out_dir / "ta_snipe" / f"{n:02d}.png")
            frames.append(f"ta_snipe/{n:02d}.png")
        mz = W0["rifle"] @ np.array([*am["muzzle"], 1])
        bz = W0["rifle"] @ np.array([*am["barrel"], 1])
        core = W0["body"] @ np.array([*am["core"], 1])
        d = mz[:2] - bz[:2]
        d = d / np.linalg.norm(d)
        mzf, cf = to_frame(mz), to_frame(core)
        manifest["animations"]["ta_snipe"] = {"frames": frames, "size": list(im.size),
                                              "anchor": [round(cf[0], 1), round(cf[1] + am["lift"], 1)]}
        manifest["rig"]["taSnipeMuzzle"] = [round(mzf[0], 1), round(mzf[1], 1)]
        manifest["rig"]["taSnipeDir"] = [round(float(d[0]), 3), round(float(d[1]), 3)]
        manifest["rig"]["taSnipeCore"] = [round(cf[0], 1), round(cf[1], 1)]
        # Its shot effects.
        fx = ta["fx"]
        for name, (fname, fbox, *how) in fx["pieces"].items():
            im = Image.open(ROOT / fx["dir"] / fname).convert("RGBA").crop(tuple(fbox))
            if "key" in how:
                a = np.asarray(im).astype(float)
                lum = a[..., :3].max(2) * a[..., 3] / 255
                rgb = np.where(lum[..., None] > 0, a[..., :3] * 255 / np.maximum(lum[..., None], 1), 0)
                im = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), lum]).astype(np.uint8), "RGBA")
            im.save(out_dir / "transam" / f"fx_{name}.png")
            manifest["transam"][f"fx_{name}"] = f"transam/fx_{name}.png"
        print(f"{unit_id}/ta_snipe: {im.size if False else manifest['animations']['ta_snipe']['size']}, muzzle "
              f"{manifest['rig']['taSnipeMuzzle']} dir {manifest['rig']['taSnipeDir']}")
        print(f"{unit_id}/transam: snipe_ta {red.size}, ta_stand {can.size}, {', '.join(manifest['transam'])}")
    if "pistol" in spec:
        import rig as rigtool
        pp = spec["pistol"]
        base = json.loads((ROOT / pp["rig"]).read_text())
        # Room around the pose for the lowered arms: move every canvas-placed point by the pad.
        padx, pady = pp["pad"]
        base["canvas"] = [base["canvas"][0] + 2 * padx, base["canvas"][1] + 2 * pady]
        for n in base["nodes"]:
            if not n.get("parent"):
                n["at"] = [n["at"][0] + padx, n["at"][1] + pady]
            if "atCanvas" in n:
                n["atCanvas"] = [n["atCanvas"][0] + padx, n["atCanvas"][1] + pady]
        rot0 = {n["name"]: n.get("rot", 0) for n in base["nodes"]}
        poses = []
        for lowered in (1.0, 0.66, 0.33):
            poses.append({k: rot0[k] + d * lowered for k, d in pp["raise"].items()})
        poses.append({})
        for rc in pp["recoil"]:
            poses.append({k: rot0[k] + d for k, d in rc.items()})

        def muzzle_of(node):
            """Tip of a pistol piece (its leftmost opaque column), in the piece's own pixels."""
            a = np.asarray(rigtool.piece(node))[..., 3] > 100
            xs = np.nonzero(a.any(0))[0]
            x0 = int(xs.min())
            ys = np.nonzero(a[:, x0:x0 + 3].any(1))[0]
            return np.array([x0, ys.mean(), 1.0])

        frames, muzzles, dirs = [], [], []
        for pose in poses:
            can, nodes, W = rigtool.render(base, pose)
            by = {n["name"]: n for n in nodes}
            frames.append(can)
            ms, ds = [], []
            for g in pp["guns"]:
                ms.append((W[g] @ muzzle_of(by[g]))[:2])
                d = W[g][:2, :2] @ np.array(pp["barrel"][g], dtype=float)
                ds.append(d / np.linalg.norm(d))
            muzzles.append(ms)
            dirs.append(ds)
        box = frames[0].getbbox()
        for f in frames[1:]:
            b2 = f.getbbox()
            box = (min(box[0], b2[0]), min(box[1], b2[1]), max(box[2], b2[2]), max(box[3], b2[3]))
        k = pp["scale"]
        frames = [f.crop(box) for f in frames]
        frames = [f.resize((round(f.width * k), round(f.height * k)), Image.LANCZOS) for f in frames]
        (out_dir / "pistol").mkdir(exist_ok=True)
        names = []
        for i, f in enumerate(frames):
            f.save(out_dir / "pistol" / f"{i:02d}.png")
            names.append(f"pistol/{i:02d}.png")
        w, h = frames[0].size
        aim = 3                     # the aim pose (after the three raise frames)
        cxb, cyb = centroid(frames[aim])
        manifest["animations"]["pistol"] = {"frames": names, "size": [w, h],
                                            "anchor": [round(cxb, 1), round(cyb + pp["lift"], 1)]}
        manifest["rig"]["pistolMuzzles"] = [[[round(float((m[0] - box[0]) * k), 1), round(float((m[1] - box[1]) * k), 1)]
                                             for m in ms] for ms in muzzles]
        manifest["rig"]["pistolDirs"] = [[[round(float(d[0]), 3), round(float(d[1]), 3)] for d in ds] for ds in dirs]
        manifest["rig"]["pistolCore"] = [round(cxb, 1), round(cyb, 1)]
        print(f"{unit_id}/pistol: {len(frames)} frames {w}x{h}, aim muzzles {manifest['rig']['pistolMuzzles'][aim]}")
    if "shieldMarks" in spec:
        sm = spec["shieldMarks"]
        fr = Image.open(out_dir / manifest["animations"][sm["anim"]]["frames"][sm["frame"]]).convert("RGBA")
        al = np.asarray(fr)[..., 3] > 100
        ys, xs = np.nonzero(al)
        cx, cy = centroid(fr)
        reach = float(np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max())
        # the front (leftmost opaque pixel) of the rows between 30% and 75% of the height: the shield's face
        top, bot = ys.min(), ys.max()
        hits = []
        for f in np.linspace(0.3, 0.75, sm["hits"]):
            y = int(top + (bot - top) * f)
            row = np.nonzero(al[y])[0]
            if len(row):
                hits.append([int(row.min()) + 3, y])
        manifest["rig"]["shieldHits"] = hits
        manifest["rig"]["shieldCore"] = [round(cx, 1), round(cy, 1)]
        manifest["rig"]["shieldReach"] = round(reach, 1)
        print(f"{unit_id}/shield marks: core {manifest['rig']['shieldCore']} reach {reach:.0f} hits {hits}")
    if "field" in spec:
        fs = spec["field"]
        atlas = Image.open(ROOT / fs["atlas"]).convert("RGBA")
        n, d = fs["canvas"], fs["sphere"]
        (out_dir / "field").mkdir(exist_ok=True)
        manifest["field"] = {}
        for name, pc in fs["pieces"].items():
            im = atlas.crop(tuple(pc["box"]))
            if pc.get("flip"):
                im = im.transpose(Image.FLIP_TOP_BOTTOM)
            w = round(d * pc["size"])
            im = im.resize((w, round(w * im.height / im.width)), Image.LANCZOS)
            can = Image.new("RGBA", (n, n))
            can.alpha_composite(im, (n // 2 - im.width // 2, round(n / 2 + pc.get("dy", 0) * d - im.height / 2)))
            can.save(out_dir / "field" / f"{name}.png")
            manifest["field"][name] = f"field/{name}.png"
        manifest["rig"]["fieldRim"] = round(d / 2 / n, 4)     # sphere radius as a fraction of each picture's width
        print(f"{unit_id}/field: {', '.join(manifest['field'])}")
    if "attack" in spec:
        at = spec["attack"]
        (out_dir / "attack").mkdir(exist_ok=True)
        manifest["attack"] = {}
        for name, (fname, box) in at["pieces"].items():
            Image.open(ROOT / at["dir"] / fname).convert("RGBA").crop(tuple(box)).save(out_dir / "attack" / f"{name}.png")
            manifest["attack"][name] = f"attack/{name}.png"
        print(f"{unit_id}/attack: {', '.join(manifest['attack'])}")
    if "drive" in spec:
        dv = spec["drive"]
        (out_dir / "drive").mkdir(exist_ok=True)
        manifest["drive"] = {}
        for name, (fname, box) in dv["pieces"].items():
            im = Image.open(ROOT / dv["dir"] / fname).convert("RGBA").crop(tuple(box))
            if name in dv.get("additive", ()):
                # what it adds over black = colour × alpha; keep that light, make the rest transparent
                a = np.asarray(im).astype(float)
                light = a[..., :3] * a[..., 3:4] / 255
                m = light.max(-1, keepdims=True)
                rgb = np.where(m > 0, light / np.maximum(m, 1e-6) * 255, 0)
                im = Image.fromarray(np.dstack([rgb, m]).clip(0, 255).astype(np.uint8))
            if name in dv.get("clearMiddle", {}):
                lo, edge = dv["clearMiddle"][name]
                a = np.asarray(im).astype(float)
                hh, ww = a.shape[:2]
                yy, xx = np.mgrid[0:hh, 0:ww]
                r = np.hypot(xx - (ww - 1) / 2, yy - (hh - 1) / 2) / (min(ww, hh) / 2)
                u = np.clip(r / edge, 0, 1)
                a[..., 3] *= lo + (1 - lo) * u * u * (3 - 2 * u)
                im = Image.fromarray(a.clip(0, 255).astype(np.uint8))
            im.save(out_dir / "drive" / f"{name}.png")
            manifest["drive"][name] = f"drive/{name}.png"
        manifest["rig"]["driveAt"] = dv["at"]
        manifest["rig"]["driveRadius"] = dv["radius"]
        print(f"{unit_id}/drive: {', '.join(manifest['drive'])} at {dv['at']}")
    if "alarm" in spec:
        (out_dir / "alarm").mkdir(exist_ok=True)
        manifest["alarm"] = {}
        for name, im in alarm_pieces(spec["alarm"]).items():
            im.save(out_dir / "alarm" / f"{name}.png")
            manifest["alarm"][name] = f"alarm/{name}.png"
        print(f"{unit_id}/alarm: {', '.join(manifest['alarm'])}")
    if "cutin" in spec:
        sheet = Image.open(ROOT / spec["cutin"]["sheet"]).convert("RGBA")
        (out_dir / "cutin").mkdir(exist_ok=True)
        manifest["cutin"] = {}
        for name, box in spec["cutin"]["pieces"].items():
            sheet.crop(tuple(box)).save(out_dir / "cutin" / f"{name}.png")
            manifest["cutin"][name] = f"cutin/{name}.png"
        if "pupil" in spec["cutin"]:
            manifest["rig"]["cutinPupil"] = spec["cutin"]["pupil"]
        print(f"{unit_id}/cutin: {', '.join(manifest['cutin'])}")
    (out_dir / "unit.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    write_preview(unit_id, previews, manifest)


def write_preview(unit_id, previews, manifest):
    """Frame 0 of every animation with its pin marked, plus an onion skin of the sequence."""
    PREVIEW.mkdir(exist_ok=True)
    tiles = []
    for anim, frames in previews.items():
        ax, ay = manifest["animations"][anim]["anchor"]
        onion = Image.new("RGBA", frames[0].size, (40, 42, 56, 255))
        for f in frames:
            ghost = f.copy()
            ghost.putalpha(ghost.getchannel("A").point(lambda v: v * 0.18))
            onion.alpha_composite(ghost)
        base = Image.new("RGBA", frames[0].size, (40, 42, 56, 255))
        base.alpha_composite(frames[0])
        mark = ImageDraw.Draw(base)
        mark.line([ax - 8, ay, ax + 8, ay], fill=(255, 60, 60, 255), width=2)
        mark.line([ax, ay - 8, ax, ay + 8], fill=(255, 60, 60, 255), width=2)
        tiles += [base] if len(frames) == 1 else [base, onion]
    w = sum(t.width for t in tiles) + 8 * len(tiles)
    h = max(t.height for t in tiles)
    sheet = Image.new("RGBA", (w, h), (20, 20, 28, 255))
    x = 0
    for t in tiles:
        sheet.alpha_composite(t, (x, 0))
        x += t.width + 8
    sheet.save(PREVIEW / f"onion_{unit_id}.png")


if __name__ == "__main__":
    for uid in sys.argv[1:] or UNITS:
        build(uid)
