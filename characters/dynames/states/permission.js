// 要你批准 — 防禦待命 (10/30: from the Dynames module's Field.swift, values unchanged).
// The full shield closes, a GN field rises around it, "!" blinks. Then, drawn small so it has room, it dashes about
// with its field while shells come in from the lower left: the first ones streak through where it just was, then it
// cannot get clear: shells burst on the field right in front of it, it is knocked back, the last one bursts big, the
// smoke clears and it drifts back to its place; repeating. Frames: the shared "shield" set, played as a hold.

var F = {
  riseFrom: 0.3,       // the field starts growing as the shield finishes closing…
  riseTime: 0.5,       // …and is full size after this long
  float: 0.55,         // × height: how far it floats up inside it (keeps the field's bright bottom clear of the tag)
  below: 0.06,         // × the field's size: its centre sits this far below the Gundam's
  breathe: 1.8,        // seconds per slow swell
  shimmer: 2.4,        // the two sparkle spheres trade places this often
  size: 0.72,          // the Gundam's (and its field's) size in this state
  attackFrom: 1.0,     // seconds after the state starts
  volley: 5.6,         // seconds per volley
  flight: 0.3,         // a shell's flight time to where it was aimed
  boom: 1.4,           // how long a burst (flash, fire, smoke) lasts
  // where it dashes to (× height from its place, + = right / up) and when (seconds into a volley)
  moves: [[0.38, 0.6, -0.5, 0.42], [1.0, 1.22, 0.1, 0.12], [1.62, 1.84, -0.32, 0.26], [2.34, 2.5, -0.2, 0.36],
          [4.3, 5.0, 0, 0]],
  // each shell: when it is fired, whether it hits (bursting dx, dy × height from its middle) or streaks past, the angle
  // it comes in at (degrees above level, travelling right), how big its burst is
  shots: [[0.22, false, 0, 0, 24, 1], [0.3, false, 0, 0, 19, 1], [0.38, false, 0, 0, 15, 1],
          [0.85, false, 0, 0, 16, 1], [0.93, false, 0, 0, 11, 1], [1.01, false, 0, 0, 21, 1],
          [1.55, false, 0, 0, 24, 1],
          [2.3, true, -0.3, 0.13, 16, 0.6], [2.45, true, 0.14, 0.26, 20, 0.6], [2.6, true, -0.16, -0.36, 6, 0.6],
          [2.75, true, 0.32, -0.16, 10, 0.6], [2.9, true, -0.24, 0.2, 13, 0.55], [3.1, true, -0.05, -0.05, 5, 2.0]],
  // opacity of each piece (faint: clear in the middle, lit at the edge and the bottom)
  look: {glow: 0.04, sphereA: 0.15, sphereB: 0.12, ring: 0.45, arc: 1, arc2: 0.8}
};

function frame(x) { return [x.anim, pet.holdFrame(x.anim, x.t, x.fps)]; }

function loopEnds(t) {
  var c = t - F.attackFrom;
  return c >= F.volley && c % F.volley < 1 / 15;
}

// Where the dashes have taken it at a time in the volley (× height from its place).
function dashOffset(c) {
  if (c < 0) return [0, 0];
  var at = [0, 0];
  for (var i = 0; i < F.moves.length; i++) {
    var m = F.moves[i];
    if (c <= m[0]) break;
    var u = Math.min(1, (c - m[0]) / (m[1] - m[0]));
    var e = u * u * (3 - 2 * u);
    at = [at[0] + (m[2] - at[0]) * e, at[1] + (m[3] - at[1]) * e];
    if (c < m[1]) break;
  }
  return at;
}

// How far the hits have shoved it back (right and a little down); each shove eases back as the smoke clears.
function knockBack(c, h) {
  var k = [0, 0];
  for (var i = 0; i < F.shots.length; i++) {
    var s = F.shots[i];
    if (!s[1]) continue;
    var e = c - s[0] - F.flight;
    if (!(e >= 0 && e < F.boom + 0.3)) continue;
    var u = Math.min(1, e / 0.2);
    var back = (1 - (1 - u) * (1 - u)) * Math.max(0, 1 - Math.max(0, e - 0.6) / 1.0);
    k = [k[0] + 0.12 * h * Math.min(1, s[5]) * back, k[1] - 0.035 * h * Math.min(1, s[5]) * back];
  }
  return k;
}

function update(x) {
  var t = x.t, h = x.h, k = F.size;
  var p = Math.min(1, Math.max(0, (t - F.riseFrom) / F.riseTime));
  var grow = 1 - Math.pow(1 - p, 3);
  var c = t >= F.attackFrom ? (t - F.attackFrom) % F.volley : -1;
  var core = pet.point("shieldCore") || [0, 0];
  // where it is: its place (floated up as the field forms), the dash it is in, a gentle hover, the knock-back
  var lift = F.float * h * grow;
  var hover = [Math.sin(t * 2 * Math.PI / 5.3) * 0.03 * h * grow, Math.sin(t * 2 * Math.PI / 3.2) * 0.025 * h * grow];
  var dash = dashOffset(c), prev = dashOffset(c - 1 / 60);
  // its middle on screen for a dash offset (without hover or knock-back)
  function middle(move) {
    return [x.bodyX + x.ox + move[0] * h + core[0] * k, x.bodyY + x.oy + lift + move[1] * h + core[1] * k];
  }
  var L = {smokeA: [], smokeB: [], fireA: [], fireB: [], fireC: [], embers: [], flash: [], shellGlow: [], shell: []};
  var hits = attack(c, h, k, L, function (cc) { return middle(dashOffset(cc)); });
  var move = [dash[0] * h + hover[0] + hits.knock[0] + hits.shake[0],
              dash[1] * h + lift + hover[1] + hits.knock[1] + hits.shake[1]];
  // leaning into each dash, GN particles streaming off behind it
  var vx = (dash[0] - prev[0]) * h * 60;
  var speed = Math.hypot(vx, (dash[1] - prev[1]) * h * 60);
  var lean = Math.max(-0.2, Math.min(0.2, -vx * 0.0006));
  var anchor = [x.bodyX + x.ox + move[0], x.bodyY + x.oy + move[1]];
  var mid = [anchor[0] + core[0] * k, anchor[1] + core[1] * k];
  // the "!" marker and the alert corners go along with it, drawn around the smaller Gundam
  var pin = [x.bodyX, x.bodyY];
  var centre = [mid[0], mid[1] - F.below * h * 2 * k];
  var swell = 1 + 0.012 * Math.sin(t * 2 * Math.PI / F.breathe);
  var s = (0.3 + 0.7 * grow) * swell * k;
  // the two sparkle spheres turn slowly against each other and trade brightness: the particles glitter
  var w = Math.sin(t * 2 * Math.PI / F.shimmer);
  L.fieldBack = {x: centre[0], y: centre[1], scale: s, opacity: p};
  L.fieldFront = {x: centre[0], y: centre[1], scale: s, opacity: p};
  L.sphereA = {rotation: -t * 2 * Math.PI / 30, opacity: F.look.sphereA * (1 + 0.35 * w) + 0.2 * hits.flash};
  L.sphereB = {rotation: t * 2 * Math.PI / 22, opacity: F.look.sphereB * (1 - 0.35 * w)};
  L.arc = {opacity: F.look.arc * (0.8 + 0.2 * Math.sin(t * 2 * Math.PI / F.breathe))};
  // a hit lights the whole surface up for a moment
  L.ring = {opacity: F.look.ring + 0.55 * hits.flash};
  return {
    layers: L,
    emitters: {dashTrail: {x: mid[0], y: mid[1], birthRate: speed > h * 0.6 ? 1 : 0}},
    body: {x: anchor[0] - x.bodyX, y: anchor[1] - x.bodyY, scale: k, rotation: lean},
    // "!" blinks while it waits for the go-ahead
    marker: {x: (k - 1) * (x.markerX - pin[0]) + move[0], y: (k - 1) * (x.markerY - pin[1]) + move[1],
             opacity: Math.floor(x.now * 3) % 2 == 0 ? 1 : 0.3},
    brackets: {x: (1 - k) * pin[0] + move[0], y: (1 - k) * pin[1] + move[1], scale: k}
  };
}

// Shells fly in from the lower left, aimed where it is when they are fired: the early ones streak through the spot
// it has just left, the last ones burst on the field right in front of it. at(c) = its middle at volley time c.
function attack(c, h, k, L, at) {
  var none = {knock: [0, 0], shake: [0, 0], flash: 0};
  if (c < 0) return none;
  var flash = 0, shake = [0, 0];
  function ease(v) { var q = Math.min(1, Math.max(0, v)); return 1 - (1 - q) * (1 - q); }
  for (var i = 0; i < F.shots.length; i++) {
    var shot = F.shots[i];
    var climb = shot[4] * Math.PI / 180;
    var dir = [Math.cos(climb), Math.sin(climb)];
    var aim = at(shot[0]);                       // where it was when this shell was fired
    var land = shot[0] + F.flight;
    var span = h * 2.6;                          // distance flown to the aim point
    var fly = c - shot[0];
    // a miss keeps going past the spot (and off), a hit stops where it bursts
    var flyEnd = shot[1] ? F.flight : F.flight * 2.2;
    if (fly >= 0 && fly < flyEnd) {
      var d = span * (fly / F.flight) - span;
      var q = [aim[0] + dir[0] * d, aim[1] + dir[1] * d];
      var turn = Math.atan2(dir[1], dir[0]) - Math.PI / 2;
      var fade = shot[1] ? 1 : Math.min(1, (flyEnd - fly) / 0.12);
      L.shell[i] = {x: q[0], y: q[1], rotation: turn, sx: 0.9, sy: 1.6, scale: 1.3 * k, opacity: fade};
      L.shellGlow[i] = {x: q[0] - dir[0] * h * 0.09, y: q[1] - dir[1] * h * 0.09, rotation: turn, sx: 0.6, sy: 2.2,
                        scale: 1.3 * k, opacity: 0.55 * fade};
    }
    if (!shot[1]) continue;
    var age = c - land;
    if (!(age >= 0 && age < F.boom)) continue;
    var e = age, z = shot[5];
    // on it where it is when the shell lands, knock-back from the earlier hits included
    var m = at(land), kb = knockBack(land - 0.001, h);
    var hit = [m[0] + kb[0] + shot[2] * h * k, m[1] + kb[1] + shot[3] * h * k];
    function show(name, p, scale, alpha, spin) {
      L[name][i] = {x: p[0], y: p[1], rotation: spin || 0, scale: scale * z * k, opacity: alpha};
    }
    var r = h * k * z;
    // white flash first…
    show("flash", hit, 0.7 + 1.6 * ease(e / 0.12), 1 - e / 0.18);
    // …the fireballs swell and burn out…
    var spin = i * 1.7;
    show("fireA", hit, 0.45 + 0.9 * ease(e / 0.5), e < 0.28 ? 1 : 1 - (e - 0.28) / 0.3, spin);
    show("fireB", [hit[0] - r * 0.12, hit[1] + r * 0.08], 0.4 + 0.8 * ease((e - 0.05) / 0.45),
         e < 0.05 ? 0 : (e < 0.32 ? 1 : 1 - (e - 0.32) / 0.3), -spin);
    show("fireC", [hit[0] + r * 0.06, hit[1] - r * 0.08], 0.5 + 0.9 * ease(e / 0.35),
         e < 0.2 ? 1 : 1 - (e - 0.2) / 0.25, spin * 0.5);
    show("embers", hit, 0.7 + 1.1 * ease(e / 0.5), 1 - e / 0.55);
    // …and the smoke billows up and thins out
    var rise = r * 0.4 * ease(e / F.boom);
    show("smokeA", [hit[0] - r * 0.1, hit[1] + rise], 0.6 + 0.9 * ease(e / 1.1),
         e < 0.15 ? e / 0.15 * 0.7 : 0.7 * (1 - (e - 0.15) / (F.boom - 0.15)), spin);
    show("smokeB", [hit[0] + r * 0.05, hit[1] + rise * 0.7], 0.5 + 0.8 * ease((e - 0.1) / 1.1),
         e < 0.25 ? Math.max(0, (e - 0.1) / 0.15) * 0.6 : 0.6 * (1 - (e - 0.25) / (F.boom - 0.25)), -spin);
    flash = Math.max(flash, Math.max(0, 1 - e / 0.3));
    var sk = 2.5 * z * Math.max(0, 1 - e / 0.16);
    shake = [shake[0] + sk * Math.sin(e * 95), shake[1] + sk * Math.cos(e * 80)];
  }
  return {knock: knockBack(c, h), shake: shake, flash: flash};
}
