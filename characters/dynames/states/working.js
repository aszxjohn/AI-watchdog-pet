// 工作中 — TRANS-AM (Cross Rays' "Trans-Am" attack, told with G Gen Wars' own Trans-Am pieces). 10/30: from the
// Dynames module's TransAm.swift (with the Lockon cut-in of Cutin.swift and the lock-on reticle of LockHud.swift),
// values unchanged.
// ①② the game's own opening, frame by frame from the Cross Rays video: the camera coming down onto the head, the eyes
// flashing, the TRANS-AM screen, the standing body turning red → ③ out of the panel the red standing body bursts out
// in a white flash and red GN particles → ⑤ first shot → ⑥ high-speed: darts to three places leaving afterimages,
// firing at each → ⑨ Lockon's cut-in (the sniping cycle's) → ⑩ full-power beam, the target blows up → ⑪ the red
// drains back to normal. Every shot is fired from the Trans-Am sniping pose ("ta_snipe": frame 1 has the muzzle lit),
// with Wars' own pink beam-rifle effects; ⑪ swaps back to 等你回覆's standing pose under a white flash. GN particles
// follow the sniping fan (back and to the right), green throughout.

var TA = {
  intro: [0.0, 3.75],          // the video's 112 frames at 30 fps, in the panel
  reveal: [3.75, 4.55],
  first: [4.55, 5.35],
  dash: [5.35, 8.35],
  lockon: [8.35, 10.35],
  burst: [10.35, 12.15],
  release: [12.15, 13.15],
  period: 13.15,
  shutter: 0.15,               // panel opening / closing
  lit: 0.4,                    // the lit-muzzle frame after each shot
  drain: 0.25,                 // ⑪ the white flash up to the swap to normal colours
  firstShot: 0.25,             // into ⑤
  // ⑥: where it darts (× height from its place, + = right / up), then back over its place at ⑩'s height (`rise`)
  stops: [[-1.6, -0.08], [0.3, 0.08], [-2.0, 0.2], [-0.6, -0.45]],
  dashTime: 0.2,
  hold: 0.5,                   // at each stop; it fires 0.1 s in
  ghosts: 5,
  charge: [0.25, 0.75],        // ⑩, after Lockon's panel has shut (closed range)
  bigShot: 0.75,
  bigHold: 0.7,
  bigFade: 0.35,
  rise: 0.45,                  // ⑩ how high it rises to fire (× height)
  red: [1, 0.3, 0.5],
  pink: [1, 0.32, 0.75],
  // GN particles: the sniping fan, and a stronger push of it (still never to the left) at bursts and shots
  fan: {range: 3.0, longitude: 0.1, velocity: 58, yAccel: 2, xAccel: 16, rate: 4.2, speed: 1},
  gush: {range: 3.0, longitude: 0.1, velocity: 130, yAccel: 2, xAccel: 24, rate: 10, speed: 1}
};

// Lockon's cut-in (Cutin.swift): the panel opens while the Gundam fades, cockpit → helmet → eye through the scope
var CUT = {open: 0.2, cockpit: [0.0, 0.8], face: [0.65, 1.3], eye: [1.15, 2.3], lock: 1.6, close: 0.15};
var HUD = {line: [0.36, 1, 0.69, 0.85], green: [0.36, 1, 0.69], orange: [1, 0.62, 0.2]};

var trail = [];        // ⑥'s afterimages: the pictures it showed and where
var taHit = null;      // ⑩ where the full-power beam ends, fixed when it fires

function has(r, c) { return c >= r[0] && c < r[1]; }        // a half-open range
function within(r, c) { return c >= r[0] && c <= r[1]; }    // a closed one
function rotate(p, a) { return [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]; }
function mix(a, b, t) { var o = {}; for (var k in a) o[k] = a[k] + (b[k] - a[k]) * t; return o; }

// Opacity of a cut-in shot that fades in over its first `fade` seconds and out over its last.
function shotAlpha(c, r, fade) {
  fade = fade || 0.15;
  if (!within(r, c)) return 0;
  var a = Math.min(1, (c - r[0]) / fade), b = Math.min(1, (r[1] - c) / fade);
  return Math.max(0, Math.min(r[0] == 0 ? 1 : a, b));
}

function loopEnds(t) { return t >= TA.period && t % TA.period < 1 / 15; }

// waits in its normal colours; powers up again on arrival
function travel(x) { return ["stand", 0]; }

// ⑥ at d seconds in: where it is (× height), whether it is mid-dash, seconds since its shot here, which stop
function taDash(d) {
  var step = TA.dashTime + TA.hold, from = [0, 0];
  var list = TA.stops.concat([[0, TA.rise]]);
  for (var i = 0; i < list.length; i++) {
    var to = list[i], s = i * step;
    if (d < s + TA.dashTime) {
      var u = Math.max(0, (d - s) / TA.dashTime), e = u * u * (3 - 2 * u);
      return {at: [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e], dashing: true, since: null, stop: -1};
    }
    if (i < TA.stops.length && d < s + step) {
      var since = d - s - TA.dashTime - 0.1;
      return {at: to, dashing: false, since: since >= 0 ? since : null, stop: i};
    }
    from = to;
  }
  return {at: [0, 0], dashing: false, since: null, stop: -1};
}

function taFrame(t) {
  var c = t % TA.period;
  // 等你回覆's standing pose in normal colours until the opening's panel starts shutting, and again once ⑪'s white
  // flash has swallowed the red
  if (c < TA.intro[1] - TA.shutter || c >= TA.release[0] + TA.drain) return ["stand", 0];
  if (c < TA.first[0]) return ["ta_stand", 0];
  function lit(since) { return since !== null && since >= 0 && since < TA.lit ? 1 : 0; }
  if (has(TA.first, c)) return ["ta_snipe", lit(c - TA.first[0] - TA.firstShot)];
  if (has(TA.dash, c)) {
    var d = c - TA.dash[0], s = taDash(d);
    // the last dash, back home just before Lockon's cut-in, glides in the sniping pose
    var homing = d >= TA.stops.length * (TA.dashTime + TA.hold);
    return s.dashing && !homing ? ["ta_stand", 0] : ["ta_snipe", lit(s.since)];
  }
  if (c >= TA.burst[0] && c < TA.release[0]) {
    var e = c - TA.burst[0];
    return ["ta_snipe", e >= TA.charge[0] && e < TA.bigShot + TA.bigHold ? 1 : 0];
  }
  return ["ta_snipe", 0];
}

function frame(x) { return taFrame(x.t); }

// The lock-on reticle (LockHud.layout): ring, turning diamond, centre square, four closing arcs around p.
// closeIn 0 = searching … 1 = locked; flash > 1 pops the ring. r: the ring's size in points.
function lockLayout(out, names, p, r, closeIn, spin, flash, alpha) {
  out[names.ring] = {x: p[0], y: p[1], opacity: alpha, scale: (1.35 - 0.35 * closeIn) * flash};
  out[names.diamond] = {x: p[0], y: p[1], opacity: alpha * 0.6,
                        rotation: spin * 1.2 * (1 - closeIn) + Math.PI / 4 * closeIn};
  out[names.square] = {x: p[0], y: p[1], opacity: alpha, scale: 2.2 - 1.2 * closeIn};
  var radius = r * (0.95 - 0.35 * closeIn);
  for (var k = 0; k < 4; k++) {
    var ang = k * Math.PI / 2 + Math.PI / 4 + (1 - closeIn) * 0.9;
    names.arc(out, k, {x: p[0] + Math.cos(ang) * radius, y: p[1] + Math.sin(ang) * radius, opacity: alpha,
                       rotation: ang - Math.PI / 4});
  }
}

// Called when it stops acting (it waits to move, comes in, goes out): the afterimages start afresh.
function hide() { trail = []; }

function update(x) {
  var h = x.h, t = x.t, now = x.now, c = t % TA.period;
  var L = {lockArc: []};
  var out = {layers: L, emitters: {charge: {birthRate: 0}}, bodyOpacity: 1};
  var panel = [1.6 * h, 0.95 * h], centre = [0, h * 0.55];
  var boltRange = h * 1.75;

  // ①② the opening in its panel: it opens and shuts like Lockon's while the unit behind fades out; its edge goes pink
  // with the TRANS-AM screen and red with the standing shot
  if (has(TA.intro, c)) {
    var open = Math.min(progress(c - TA.intro[0], 0, TA.shutter), progress(TA.intro[1] - c, 0, TA.shutter));
    var sy = Math.max(0.02, open);
    var rig = pet.rig("taScreen") || [112, 30];
    var i = Math.floor((c - TA.intro[0]) * rig[1]);
    var cuts = pet.rig("taIntroCuts") || [];
    var border = cuts.length == 2 ? (i < cuts[0] ? HUD.line : i < cuts[1] ? TA.pink : TA.red) : TA.pink;
    var n = Math.min(i, rig[0] - 1);
    L.taPanel = {x: centre[0], y: centre[1], sx: 1, sy: sy, opacity: 1};
    L.taBorder = {x: centre[0], y: centre[1], sx: 1, sy: sy, opacity: 1, stroke: border, shadowColor: border};
    L.taScreen = {image: "transam/scr_" + ("00" + n).slice(-3), opacity: 1};
    out.bodyOpacity = 1 - open;
  }
  // ⑨ Lockon's cut-in, and its panel snapping shut at the start of ⑩
  if (has(TA.lockon, c)) {
    cutin(L, out, c - TA.lockon[0], panel, centre);
  } else if (c >= TA.burst[0] && c < TA.burst[0] + 0.25) {
    var cc = c - TA.burst[0];
    if (cc < CUT.close) {
      var p = Math.min(1, cc / CUT.close);
      L.cutinPanel = {x: centre[0], y: centre[1], sx: 1, sy: Math.max(0.02, 1 - p), opacity: 1 - p};
      L.cutinBorder = {x: centre[0], y: centre[1], sx: 1, sy: Math.max(0.02, 1 - p), opacity: 1 - p};
      out.bodyOpacity = Math.min(1, cc / 0.2);
    }
  }

  // ⑩ fires from higher up so the beam has room: the dashes end at that height, it holds it through the cut-in and
  // ⑩, and comes back down as the red drains
  var rise = 0;
  if (c >= TA.lockon[0]) {
    rise = TA.rise * h * (has(TA.release, c) ? 1 - progress(c - TA.release[0], 0, TA.release[1] - TA.release[0]) : 1);
  }
  // muzzle (root space) and barrel direction of the Trans-Am sniping shot, moved by `off`, turned `lean`
  var muzzlePx = pet.point("taSnipeMuzzle", "ta_snipe") || [0, 0];
  var dv = pet.rig("taSnipeDir") || [-1, 0];
  function firePoint(off, lean) {
    var r = rotate(muzzlePx, lean);
    var len = Math.max(0.001, Math.hypot(dv[0], dv[1]));
    return {muzzle: [x.bodyX + off[0] + r[0], x.bodyY + off[1] + r[1]], dir: rotate([dv[0] / len, -dv[1] / len], lean)};
  }
  // the target: along the barrel, high enough that the locked reticle stays in the window; the tag slides right
  var rest = firePoint([x.ox, x.oy + rise], 0);
  var lockedSize = 26 * (0.95 - 0.35 + 0.3);
  var floor = -x.rootY + 2 + lockedSize;
  var reach = Math.min(boltRange * 0.75, Math.max(20, (rest.muzzle[1] - floor) / Math.max(0.2, -rest.dir[1])));
  var aimPoint = [rest.muzzle[0] + rest.dir[0] * reach, rest.muzzle[1] + rest.dir[1] * reach];
  out.tagX = Math.max(0, aimPoint[0] + lockedSize + 4 + x.tagWidth / 2) * progress(t, 0, 0.4);

  var red = c >= TA.reveal[0] && c < TA.release[1];
  var off = [x.ox, x.oy + rise], turn = 0, gush = 0;
  var shadow = {};
  // a red glow round the body the whole time it is in Trans-Am
  if (red && !has(TA.release, c)) shadow = {color: TA.red, radius: 6, opacity: 0.55};
  else shadow = {opacity: 0};

  function put(name, p, rot, k, alpha) { L[name] = {x: p[0], y: p[1], rotation: rot, scale: k, opacity: alpha}; }

  // A shot `since` seconds ago from the Trans-Am sniping pose, as Wars draws it: a white flash over the unit, the kick
  // back along the barrel, the pink beam, and at the muzzle a cloud of light, a lens flare that stays while the beam
  // holds, a cross flare and a spiky flash; `ring` adds a shock ring.
  var beamH = (pet.imageSize("transam/fx_beam") || [1, 1])[1];
  function fire(since, beam, thick, hold, fade, kick, ring, target) {
    var kk = Math.exp(-since * 7), back = kick * kk;
    off = [off[0] - rest.dir[0] * back, off[1] - rest.dir[1] * back];
    turn = -0.06 * kk * (rest.dir[0] < 0 ? 1 : -1);
    var m = firePoint(off, turn);
    if (since < 0.08) out.tint = {color: [1, 1, 1], opacity: 0.6 * (1 - since / 0.08)};
    if (!(since < hold + fade)) return;
    var f = since < hold ? 1 : 1 - (since - hold) / fade;
    // `target`: the beam stops there (the blast sits on its end), else it runs on out of the window
    var full = target ? Math.max(10, (target[0] - m.muzzle[0]) * m.dir[0] + (target[1] - m.muzzle[1]) * m.dir[1])
                      : boltRange * 1.4;
    var len = full * Math.min(1, since / 0.06);
    var w = thick * (0.4 + 0.6 * f) * (1 + 0.06 * Math.sin(now * 70));
    // the bar's rounded end fades in over 0.28 of its height: start it that far back inside the bore
    var tail = 0.3 * w;
    beam.set({x: m.muzzle[0] - m.dir[0] * tail, y: m.muzzle[1] - m.dir[1] * tail, w: len + tail, h: w,
              contentsScale: beamH / Math.max(1, w), rotation: Math.atan2(m.dir[1], m.dir[0]), opacity: f});
    var ang = Math.atan2(m.dir[1], m.dir[0]);
    var size = Math.min(2, Math.sqrt(thick / 24)), s = since;
    function ahead(d) { return [m.muzzle[0] + m.dir[0] * d, m.muzzle[1] + m.dir[1] * d]; }
    put("fxBurst", ahead(0.12 * h * size), ang, size * (0.5 + 0.7 * Math.min(1, s / 0.1)), 1 - s / 0.35);
    put("fxLens", m.muzzle, 0, size * (1.3 - 0.4 * Math.min(1, s / 0.3)), f);
    put("fxCross", m.muzzle, ang, size * (0.6 + 0.6 * Math.min(1, s / 0.05)), 1 - s / 0.18);
    put("fxSpike", ahead(0.1 * h * size), ang, size * (0.7 + 0.5 * Math.min(1, s / 0.08)), 1 - s / 0.2);
    if (ring) put("fxRing", m.muzzle, 0, size * (0.4 + 1.0 * Math.min(1, s / 0.3)), 0.7 * (1 - s / 0.4));
    gush = Math.max(gush, Math.max(0, 1 - since / 0.4));
  }
  function bolt(i) { return {set: function (o) { L.bolt = L.bolt || []; L.bolt[i] = o; }}; }
  var big = {set: function (o) { L.bigBeam = o; }};

  if (has(TA.reveal, c)) {
    // ③ out of the panel in a white flash, red GN particles gushing
    var e = c - TA.reveal[0];
    out.tint = {color: [1, 1, 1], opacity: Math.max(0, 0.9 - e * 2.5)};
    shadow.opacity = 0.55 + 0.45 * Math.max(0, 1 - e * 1.5);
    shadow.radius = 6 + 6 * Math.max(0, 1 - e * 1.5);
    gush = Math.max(0, 1 - e / 0.6);
    off = [off[0], off[1] + 6 * Math.sin(Math.min(1, e / 0.8) * Math.PI)];
  } else if (has(TA.first, c)) {
    var since = c - TA.first[0] - TA.firstShot;
    if (since >= 0) fire(since, bolt(0), 30, 0.2, 0.25, 7);
  } else if (has(TA.dash, c)) {
    // ⑥ darting about, afterimages left behind on the way
    var s = taDash(c - TA.dash[0]);
    off = [off[0] + s.at[0] * h, off[1] + s.at[1] * h];
    if (s.since !== null && s.stop >= 0) fire(s.since, bolt(s.stop % 3), 18, 0.12, 0.15, 4);
    if (s.dashing) gush = Math.max(gush, 0.5);
    trail.push({anim: x.shownAnim, frame: x.shownFrame, at: [x.bodyX + off[0], x.bodyY + off[1]]});
    if (trail.length > TA.ghosts * 3 + 1) trail.splice(0, trail.length - TA.ghosts * 3 - 1);
    L.ghost = [];
    for (var k = 0; k < TA.ghosts; k++) {
      var j = trail.length - 1 - (k + 1) * 3;
      if (j < 0) continue;
      var g = trail[j];
      var moved = Math.hypot(g.at[0] - x.bodyX - off[0], g.at[1] - x.bodyY - off[1]);
      L.ghost[k] = {frame: [g.anim, g.frame], x: g.at[0], y: g.at[1], opacity: moved > 3 ? 0.45 * (1 - k / TA.ghosts) : 0};
    }
  } else if (c >= TA.burst[0] && c < TA.release[1]) {
    // ⑩ charge at the muzzle, then the full-power beam; the target blows up; ⑪ the red drains away
    var e2 = c - TA.burst[0];
    if (within(TA.charge, e2)) {
      // a ball of light swelling at the muzzle, rings closing in on it, particles drawn in
      var m0 = firePoint(off, 0);
      var pc = (e2 - TA.charge[0]) / (TA.charge[1] - TA.charge[0]);
      put("fxOrb", m0.muzzle, 0, 0.5 + 1.5 * pc, 0.5 + 0.5 * pc);
      var q = (pc * 3) % 1;
      put("fxRing", m0.muzzle, 0, 1.6 - 1.3 * q, 0.9 * q);
      out.emitters.charge = {x: muzzlePx[0], y: muzzlePx[1], birthRate: 1};
    }
    var since2 = e2 - TA.bigShot;
    if (since2 < 0) taHit = null; else if (taHit === null) taHit = aimPoint;
    var hit = taHit || aimPoint;
    if (since2 >= 0) {
      if (since2 < TA.bigHold + TA.bigFade) {
        // the beam's weight shakes it (before the shot is laid out, so the beam shakes with the muzzle)
        off = [off[0] + 2.5 * Math.sin(now * 73), off[1] + 2 * Math.sin(now * 91 + 1)];
        gush = 1;
      }
      fire(since2, big, 90, TA.bigHold, TA.bigFade, 12, true, hit);
    }
    if (e2 >= TA.charge[0] && e2 < TA.bigShot + TA.bigHold + 0.3) {
      var pulse = since2 >= 0 && since2 < 0.2 ? 1 + (0.2 - since2) * 2.5 : 1;
      var alpha = since2 > TA.bigHold ? Math.max(0, 1 - (since2 - TA.bigHold) / 0.3) : 0.95;
      lockLayout(L, {ring: "lockRing", diamond: "lockDiamond", square: "lockSquare",
                     arc: function (o, k, v) { o.lockArc[k] = v; }}, hit, 26, 1, now, pulse, alpha);
    }
    var be = since2 - 0.12;
    if (be >= 0) {
      function blast(name, d, delay, lo, hi, growTime, life, spin) {
        var qq = be - delay;
        if (!(qq >= 0 && qq < life)) return;
        var gg = lo + (hi - lo) * Math.min(1, qq / growTime);
        L[name] = {x: hit[0] + d[0] * h, y: hit[1] + d[1] * h, rotation: (spin || 0) * qq, scale: gg,
                   opacity: Math.min(1, qq / 0.05) * Math.max(0, 1 - Math.max(0, qq - life * 0.45) / (life * 0.55))};
      }
      blast("flash", [0, 0], 0, 0.5, 2.4, 0.1, 0.35);
      blast("hitGlow", [0, 0], 0, 1, 2.2, 0.2, 0.5);
      blast("fireC", [0, 0], 0.03, 0.5, 1.6, 0.35, 1.3);
      blast("fireA", [-0.14, 0.08], 0.12, 0.5, 1.4, 0.3, 1.0);
      blast("fireB", [0.13, -0.06], 0.22, 0.5, 1.4, 0.3, 1.0);
      blast("sparkBig", [0, 0], 0.02, 0.6, 1.4, 0.2, 0.45, 1.5);
      blast("smokeA", [-0.05, 0.12], 0.35, 0.6, 2.0, 1.3, 1.6);
      blast("smokeB", [0.08, 0.05], 0.5, 0.6, 1.8, 1.2, 1.4);
    }
    if (has(TA.release, c)) {
      // ⑪ a white flash swallows the red pose and lets go of 等你回覆's standing pose
      var r = c - TA.release[0];
      out.tint = {color: [1, 1, 1],
                  opacity: r < TA.drain ? 0.9 * r / TA.drain : Math.max(0, 0.9 * (1 - (r - TA.drain) / 0.5))};
      // swap at once under the white (a cross-fade would let the red pose show through un-whitened)
      if (r >= TA.drain && r < TA.drain + x.fadeTime) out.skipFade = true;
      // and a flare of light over the body hides the change of outline
      var fl = r - TA.drain;
      if (Math.abs(fl) < 0.3) {
        var core = pet.point("taSnipeCore", "ta_snipe") || [0, 0];
        put("fxLens", [x.bodyX + off[0] + core[0], x.bodyY + off[1] + core[1]], 0, 1.6 + 0.6 * fl,
            1 - Math.abs(fl) / 0.3);
      }
      shadow = {color: TA.red, radius: 6, opacity: 0.55 * Math.max(0, 1 - r / TA.drain)};
    }
  }
  out.body = {x: off[0], y: off[1], rotation: turn};
  out.spriteShadow = shadow;

  // GN particles from the body's middle: the sniping fan, pushed harder at bursts and shots; green throughout
  var pose = taFrame(t)[0], at;
  if (pose == "stand") at = [h * 0.02, h * 0.06];        // where 等你回覆 releases them
  else at = pet.point(pose == "ta_stand" ? "taStandCore" : pose == "ta_snipe" ? "taSnipeCore" : "snipeCore", pose) || [0, 0];
  var look = mix(TA.fan, TA.gush, gush);
  out.emitters.gn = {x: at[0], y: at[1], velocity: look.speed, birthRate: look.rate, keyPaths: {
    "emitterCells.drift.emissionRange": look.range, "emitterCells.drift.emissionLongitude": look.longitude,
    "emitterCells.drift.velocity": look.velocity, "emitterCells.drift.yAcceleration": look.yAccel,
    "emitterCells.drift.xAcceleration": look.xAccel}};
  return out;
}

// ⑨ Lockon's cut-in at c seconds in (Cutin.updateCutin): the panel opens like a shutter while the Gundam fades away;
// shot A the cockpit pushing in, shot B his helmet, shot C his eye through the scope with the reticle closing in on
// his pupil; a scan line sweeps down while it searches, then LOCK ON blinks.
function cutin(L, out, c, panel, centre) {
  var mid = [panel[0] / 2, panel[1] / 2];
  var open = progress(c, 0, CUT.open);
  L.cutinPanel = {x: centre[0], y: centre[1], sx: 1, sy: Math.max(0.02, open), opacity: 1};
  out.bodyOpacity = 1 - open;
  L.cockpit = {opacity: shotAlpha(c, CUT.cockpit), scale: 1 + 0.1 * (c / CUT.cockpit[1])};
  L.face = {opacity: shotAlpha(c, CUT.face), scale: 1.05 + 0.07 * progress(c, CUT.face[0], CUT.face[1])};
  L.scope = {opacity: 0};
  var eyeAlpha = shotAlpha(c, CUT.eye, 0.12), pc = 1.1 + 0.05 * progress(c, CUT.eye[0], CUT.eye[1]);
  L.eye = {opacity: eyeAlpha, scale: pc};
  L.cutinTint = {opacity: eyeAlpha * 0.55};
  var hud = CUT.eye[0] + 0.1;
  var closeIn = progress(c, hud, CUT.lock);
  var hudAlpha = c >= hud ? Math.min(1, (c - hud) / 0.1) : 0;
  var locked = c >= CUT.lock;
  var flash = locked && c < CUT.lock + 0.15 ? 1 + (CUT.lock + 0.15 - c) * 2 : 1;
  // the reticle closes in on his pupil: where it sits in the eye picture, through the aspect fill and push-in
  var target = mid;
  var pupil = pet.rig("cutinPupil"), img = pet.imageSize("cutin/eye");
  if (pupil && img) {
    var fill = Math.max(panel[0] / img[0], panel[1] / img[1]) * pc;
    target = [mid[0] + (pupil[0] - img[0] / 2) * fill, mid[1] - (pupil[1] - img[1] / 2) * fill];
  }
  lockLayout(L, {ring: "cutRing", diamond: "cutDiamond", square: "cutSquare",
                 arc: function (o, k, v) { o["cutArc" + k] = v; }}, target, panel[1] * 0.62, closeIn, c, flash, hudAlpha);
  var sweep = progress(c, hud, CUT.lock);
  L.scanLine = {x: mid[0], y: panel[1] * (1 - sweep), opacity: c >= hud && c < CUT.lock ? hudAlpha * 0.9 : 0};
  L.lockLabel = {opacity: locked ? (Math.floor(c * 10) % 2 == 0 ? 1 : 0.35) : 0};
  var edge = locked ? HUD.orange : HUD.line;
  L.cutinBorder = {x: centre[0], y: centre[1], sx: 1, sy: Math.max(0.02, open), opacity: 1, stroke: edge,
                   shadowColor: locked ? HUD.orange : HUD.green};
}
