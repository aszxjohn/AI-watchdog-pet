// 要你決定 — 支援防禦 (10/30: from the Dynames module's Guard.swift, values unchanged).
// Stands, dashes forward leaning into a burst of GN particles, braces behind the full shield; a volley of tracers
// sparks off it all over its face and each round shoves it back; then it boosts forward again, opens the shield and
// settles back to standing where it began; looping. Frames are the shared "shield" set.

var G = {
  period: 5.4,
  dash: [0.35, 0.72],      // stand → dash forward, leaning in (frames 0 → 3)
  brace: [0.72, 1.1],      // the shield closes (frames 3 → 7) and it holds
  boost: [3.05, 3.5],      // pushed back by the volley, it boosts forward again
  open: [3.5, 3.9],        // the shield opens (frames 11 → 14)
  home: [3.9, 4.5],        // slides back to where it stood, upright
  front: -0.26,            // × height: how far forward (left) it braces
  lunge: -0.36,            // × height: how far the boost carries it before it settles
  shove: 0.045,            // × height: how far each round pushes it back
  lean: 0.3,               // radians, tipped forward while dashing / boosting
  flight: 0.18,
  retreat: 0.5,            // while the volley lasts it keeps backing away (× height in all)
  // each round: when it lands (seconds into the cycle) and the angle it comes in at (degrees, + = from above)
  volley: [[1.15, 6], [1.32, -8], [1.48, 12], [1.66, -4], [1.82, 9], [1.98, -10],
           [2.16, 4], [2.3, -6], [2.46, 10], [2.62, -2], [2.78, 8], [2.92, -9]],
  // parts a round can hit (× height from its middle, measured on the shield frame): head, left shoulder, upper
  // shield, top of the shield, middle, left shield edge, legs, lower left, lower right shield
  spots: [[-0.2, 0.28], [-0.3, 0.13], [0.14, 0.26], [0.02, 0.38], [-0.05, -0.05], [-0.38, -0.05], [-0.16, -0.36],
          [-0.3, -0.25], [0.32, -0.16]]
};

function within(c, r) { return ease(c, r[0], r[1]); }

function frame(x) {
  var c = x.t % G.period, f = 0;
  if (c < G.dash[0]) f = 0;
  else if (c < G.dash[1]) f = Math.min(3, Math.floor(within(c, G.dash) * 4));
  else if (c < G.brace[1]) f = Math.min(7, 3 + Math.floor(within(c, G.brace) * 5));
  else if (c < G.open[0]) {
    // braced: rocks slowly between frames 5 and 9
    var k = Math.floor((c - G.brace[1]) * 5) % 8;
    f = 5 + (k < 4 ? k : 8 - k);
  }
  else if (c < G.open[1]) f = Math.min(14, 11 + Math.floor(within(c, G.open) * 4));
  return [x.anim, f];
}

function loopEnds(t) { return t >= G.period && t % G.period < 1 / 15; }

// How far the volley has pushed it back (× height) at a time in the cycle: a steady retreat from the first round to
// just after the last, each round adding a quick shove that eases out again.
function knock(c) {
  var first = G.volley[0][0], last = G.volley[G.volley.length - 1][0];
  if (!(c > first)) return 0;
  var k = G.retreat * Math.min(1, (c - first) / (last - first + 0.2));
  for (var i = 0; i < G.volley.length; i++) {
    if (!(c > G.volley[i][0])) continue;
    var e = c - G.volley[i][0];
    k += G.shove * Math.min(1, e / 0.05) * Math.max(0, 1 - e / 0.3);
  }
  return k;
}

// Where round i of loop `loop` lands (× height from its middle): a random part, never the same part twice in a row,
// nudged a little.
function spot(loop, i) {
  var n = G.spots.length;
  function pick(j) { return Math.floor(pet.rand(loop, j, 1) * n) % n; }
  var k = pick(i);
  if (i > 0 && k == pick(i - 1)) k = (k + 1 + Math.floor(pet.rand(loop, i, 2) * (n - 1))) % n;
  var s = G.spots[k];
  return [s[0] + (pet.rand(loop, i, 3) - 0.5) * 0.08, s[1] + (pet.rand(loop, i, 4) - 0.5) * 0.08];
}

function update(x) {
  var t = x.t, c = t % G.period, h = x.h;
  // where it is (× height from its spot) and how hard it is driving forward (0…1)
  var pushed = G.front + knock(Math.min(c, G.boost[0]));
  var px = 0, drive = 0;
  if (c < G.dash[0]) {
    px = 0;
  } else if (c < G.dash[1]) {
    px = G.front * within(c, G.dash);
    drive = 1;
  } else if (c < G.boost[0]) {
    px = G.front + knock(c);
  } else if (c < G.boost[1]) {
    // boost: shoots forward past where it braced, then settles back onto it
    var u = within(c, G.boost);
    var mid = G.boost[0] + (G.boost[1] - G.boost[0]) * 0.6;
    px = c < mid ? pushed + (G.lunge - pushed) * ease(c, G.boost[0], mid)
                 : G.lunge + (G.front - G.lunge) * ease(c, mid, G.boost[1]);
    drive = 1.4 * (1 - 0.5 * u);
  } else if (c < G.home[0]) {
    px = G.front;
  } else {
    px = G.front * (1 - within(c, G.home));
  }
  var lean = G.lean * Math.min(1, drive);

  // each round lands with a jolt
  var jolt = 0;
  var L = {shellGlow: [], shell: [], hitGlow: [], sparkBig: [], spark: []};
  var loop = Math.floor(t / G.period);
  var core = pet.point("shieldCore") || [0, 0];
  for (var i = 0; i < G.volley.length; i++) {
    var r = G.volley[i];
    var age = c - r[0];                       // < 0: in flight, ≥ 0: landed
    if (!(age >= -G.flight && age < 0.4)) continue;
    // a random part of it, wherever it has been pushed to when the round lands
    var sp = spot(loop, i);
    var bx = G.front + knock(r[0] - 0.001);
    var hit = [x.bodyX + x.ox + bx * h + core[0] + sp[0] * h, x.bodyY + x.oy + core[1] + sp[1] * h];
    var a = (r[1] + (pet.rand(loop, i, 5) - 0.5) * 10) * Math.PI / 180;
    var dir = [Math.cos(a), -Math.sin(a)];    // travelling right, from above when the angle > 0
    if (age < 0) {
      var dist = h * 2.6 * (-age / G.flight);
      var q = [hit[0] - dir[0] * dist, hit[1] - dir[1] * dist];
      var turn = Math.atan2(dir[1], dir[0]) - Math.PI / 2;
      L.shell[i] = {x: q[0], y: q[1], rotation: turn, sx: 0.8, sy: 1.7};
      L.shellGlow[i] = {x: q[0] - dir[0] * h * 0.07, y: q[1] - dir[1] * h * 0.07, rotation: turn, sx: 0.6, sy: 2.4,
                        opacity: 0.6};
      continue;
    }
    var e = age;
    // the glow where it struck, and sparks thrown back towards where it came from (left), fanning out
    L.hitGlow[i] = {x: hit[0], y: hit[1], scale: 0.7 + 0.8 * Math.min(1, e / 0.06), opacity: Math.max(0, 1 - e / 0.22)};
    var back = Math.atan2(-dir[1], -dir[0]) - Math.PI / 2;     // the spark fan's tips point up in its picture
    L[i % 3 == 1 ? "sparkBig" : "spark"][i] = {
      x: hit[0] - dir[0] * h * 0.04, y: hit[1] - dir[1] * h * 0.04, rotation: back,
      scale: 0.5 + 0.8 * Math.min(1, e / 0.12), opacity: Math.max(0, 1 - e / 0.32)};
    jolt = Math.max(jolt, 2.2 * Math.max(0, 1 - e / 0.12));
  }

  // GN particles: the jet off the drive on its back while it drives forward…
  var drv = [core[0] + h * 0.24, core[1] + h * 0.04];
  var jet = {
    x: x.bodyX + x.ox + px * h + drv[0] * Math.cos(lean) - drv[1] * Math.sin(lean),
    y: x.bodyY + x.oy + drv[0] * Math.sin(lean) + drv[1] * Math.cos(lean),
    birthRate: 1,
    keyPaths: {"emitterCells.jet.emissionLongitude": lean, "emitterCells.jet.birthRate": 140 * drive,
               "emitterCells.jet.velocity": 120 + 110 * drive}};
  // …and whenever it is not driving forward, the slow fan trailing back and to the right (等你回覆's 面向左邊)
  var aura = {
    velocity: 1, birthRate: drive == 0 ? 2.4 : 0,
    keyPaths: {"emitterCells.drift.emissionRange": 2.6, "emitterCells.drift.emissionLongitude": 0.1,
               "emitterCells.drift.velocity": 40, "emitterCells.drift.yAcceleration": 2,
               "emitterCells.drift.xAcceleration": 14}};
  return {
    layers: L,
    emitters: {jet: jet, aura: aura},
    body: {x: x.ox + px * h + jolt, y: x.oy, rotation: lean}
  };
}
