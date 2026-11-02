// 出錯了 — sealed off behind an ERROR tape, shaking under hit after hit until it blows (10/30: from the Dynames
// module's Alarm.swift, values unchanged).
// The frames are the system's: the shield hold (hold mode, with its opening hit). On the "glass" in front of it — not
// on the unit, so it stays put while the unit shakes — one seal tape across its middle. Each round small hits land on
// random body parts, closer together and harder as the round goes on, with a growing tremble, glitchy jumps and a
// deepening red glow, until a big blast; then it settles and the next round starts. GN particles sputter out in
// 等你回覆's fan (back and to the right, never left).

var A = {
  cycle: 6.0,          // seconds per round
  blast: 5.2,          // when in the round the big blast goes off
  calm: 0.8,           // seconds after the blast for it to settle
  first: 0.5,          // first hit of a round
  life: 0.35,          // seconds one hit's glow, fireball and sparks last
  pool: 6,             // hit effect sets (hits overlapping at once)
  // where hits land, × height from the shield core (a copy of 要你決定's body-part spots)
  spots: [[-0.2, 0.28], [-0.3, 0.13], [0.14, 0.26], [0.02, 0.38], [-0.05, -0.05], [-0.38, -0.05], [-0.16, -0.36],
          [-0.3, -0.25], [0.32, -0.16]]
};

var cached = {round: -1, hits: []};

// Round n's hits: closer together as the round goes on, each on a body part picked at random (not the same one twice
// running) — the same within a round, different every round.
function roundHits(n) {
  if (n == cached.round) return cached.hits;
  var hits = [], t = A.first, last = -1, i = 0, m = A.spots.length;
  while (t < A.blast - 0.15) {
    var s = Math.floor(pet.rand(n, i, 11) * m) % m;
    if (s == last) s = (s + 1) % m;
    last = s;
    var p = A.spots[s];
    hits.push({at: t,
               spot: [p[0] + (pet.rand(n, i, 12) - 0.5) * 0.08, p[1] + (pet.rand(n, i, 13) - 0.5) * 0.08],
               fire: ["fireA", "fireB", "fireC"][i % 3],
               side: pet.rand(n, i, 14) < 0.5 ? -1 : 1,
               turn: pet.rand(n, i, 15) * 2 * Math.PI});
    t += (0.55 - 0.42 * t / A.blast) * (0.6 + 0.8 * pet.rand(n, i, 16));
    i += 1;
  }
  cached = {round: n, hits: hits};
  return hits;
}

// How worked up it is, 0…1: rising through the round to the blast, then dropping back.
function build(c) {
  if (c < A.blast) return Math.pow(c / A.blast, 1.6);
  return Math.max(0, 1 - (c - A.blast) / A.calm);
}

// The shaking: a tremble that grows through the round, a jolt from every hit, now and then a glitchy jump sideways,
// and a big shove at the blast.
function react(x) {
  var now = x.now, n = Math.floor(x.t / A.cycle), c = x.t - n * A.cycle, b = build(c);
  var dx = (1.2 + 3.5 * b) * (0.6 * Math.sin(now * 47) + 0.4 * Math.sin(now * 83 + 1.3));
  var dy = (0.8 + 2.0 * b) * (0.6 * Math.sin(now * 59 + 0.5) + 0.4 * Math.sin(now * 97));
  var lean = (0.5 + 1.5 * b) * Math.PI / 180 * Math.sin(now * 37);
  var hits = roundHits(n);
  for (var i = 0; i < hits.length; i++) {
    var hit = hits[i];
    if (!(c >= hit.at && c < hit.at + 0.15)) continue;
    var k = 1 - (c - hit.at) / 0.15, hard = hit.at / A.blast;
    dx += hit.side * (3 + 4 * hard) * k;
    dy += (1 + 1.5 * hard) * k;
    lean += hit.side * (1.5 + 2.5 * hard) * Math.PI / 180 * k;
  }
  var slot = Math.floor(now * 20);           // 0.05 s slots
  if (pet.rand(slot, 0, 21) < 0.04 + 0.16 * b) {
    dx += (pet.rand(slot, 0, 22) < 0.5 ? -1 : 1) * (5 + 4 * pet.rand(slot, 0, 23));
  }
  if (c >= A.blast && c < A.blast + 0.3) {
    var kb = 1 - (c - A.blast) / 0.3;
    dx += 9 * kb * Math.sin(now * 61);
    dy += 6 * kb;
  }
  return {dx: dx, dy: dy, lean: lean};
}

function update(x) {
  var h = x.h, now = x.now, n = Math.floor(x.t / A.cycle), c = x.t - n * A.cycle, b = build(c);
  var core = pet.point("shieldCore") || [0, 0];
  var out = {layers: {}, marker: {hidden: true}};     // the tape says it
  // the tape across its middle, flickering now and then like a bad screen and jumping a few points sideways
  var slot = Math.floor(now * 20);
  var jitter = pet.rand(slot, 1, 31) < 0.05 + 0.1 * b ? (pet.rand(slot, 1, 32) - 0.5) * 6 : 0;
  out.layers.tape = {x: x.bodyX + core[0] + jitter, y: x.bodyY + core[1],
                     opacity: pet.rand(slot, 1, 33) < 0.04 + 0.08 * b ? 0.35 : 0.95};
  // hits: a glow, a small fireball and sparks on the struck part
  var L = {hitGlow: [], fireA: [], fireB: [], fireC: [], spark: []};
  var flash = 0, hits = roundHits(n);
  for (var i = 0; i < hits.length; i++) {
    var hit = hits[i];
    if (!(c >= hit.at && c < hit.at + A.life)) continue;
    var e = c - hit.at, s = i % A.pool;
    var p = [core[0] + hit.spot[0] * h, core[1] + hit.spot[1] * h];
    L.hitGlow[s] = {x: p[0], y: p[1], scale: 0.6 + 0.8 * Math.min(1, e / 0.06), opacity: Math.max(0, 1 - e / 0.22)};
    L[hit.fire][s] = {x: p[0], y: p[1], scale: 0.4 + 0.6 * Math.min(1, e / 0.1),
                      opacity: Math.max(0, 1 - Math.max(0, e - 0.1) / 0.25)};
    L.spark[s] = {x: p[0], y: p[1], rotation: hit.turn, scale: 0.5 + 0.7 * Math.min(1, e / 0.12),
                  opacity: Math.max(0, 1 - e / 0.3)};
    flash = Math.max(flash, Math.max(0, 1 - e / 0.12));
  }
  for (var k in L) out.layers[k] = L[k];
  // the blast at the end of the round: a white flash, a big fireball and sparks in its middle
  var be = c - A.blast, blasting = be >= 0 && be < 0.7;
  if (blasting) {
    out.layers.blastFlash = {x: core[0], y: core[1], scale: 0.5 + 1.5 * Math.min(1, be / 0.08),
                             opacity: Math.max(0, 1 - be / 0.25)};
    var big = {scale: 0.5 + 0.7 * Math.min(1, be / 0.15), opacity: Math.max(0, 1 - be / 0.7)};
    out.layers.blastFire = {x: core[0], y: core[1], scale: big.scale, opacity: big.opacity};
    out.layers.blastSpark = {x: core[0], y: core[1], scale: big.scale, opacity: big.opacity};
  }
  // a red glow over the unit that deepens as it builds and pulses with each hit; white at the blast
  if (x.st > 0.5) {
    var white = blasting && be < 0.12;
    out.tint = {color: white ? [1, 1, 1] : [1, 0.15, 0.1], opacity: white ? 0.7 : 0.1 + 0.12 * b + 0.15 * flash};
  }
  // GN particles sputtering: on and off in 0.1 s bursts, more often as it builds, gushing at hits and the blast
  var on = pet.rand(Math.floor(slot / 2), 2, 41) < 0.55 + 0.3 * b;
  out.emitters = {gn: {birthRate: (on ? 0.6 + 0.6 * b : 0.12) + 1.5 * flash + (blasting && be < 0.3 ? 3 : 0)}};
  return out;
}
