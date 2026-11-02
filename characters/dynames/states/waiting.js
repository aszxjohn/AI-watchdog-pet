// 等你回覆 (locked 10/27) — its GN particles (10/30: from the Dynames module's Waiting.swift, values unchanged).
// A drift from the drive at the body's centre and, during the forward move, a converging jet; the drift's look follows
// the pose (面向左邊 → 低頭 → 前衝). The frames are the system's flourish playback.

var LOOK = {
  // 面向左邊: a slow fan trailing back and to the right; nothing goes left (only 低頭 may)
  facingLeft: {range: 2.6, longitude: 0.1, velocity: 40, yAccel: 2, xAccel: 14, rate: 2.4, speed: 1, halo: 0},
  // 低頭: an even circle around the body, the only phase whose particles reach the left
  aura: {range: Math.PI * 2, longitude: 0, velocity: 60, yAccel: 0, xAccel: 0, rate: 2.6, speed: 1, halo: 0},
  // 前衝: a fast stream backwards and a little upwards, kept to the right; still much wider than the converging jet
  dash: {range: 0.65, longitude: 0.28, velocity: 24, yAccel: 6, xAccel: 0, rate: 2.5, speed: 6, halo: 0}
};

// 0…1: how far into the forward move the flourish is (drives the backward stream and the jet), and how far the pose
// has switched to a fidget pose (低頭 etc.)
var level = {dash: 0, fidget: 0};

function mix(a, b, t) {
  var o = {};
  for (var k in a) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
}

// every tick, acting or not ("runWhileIdle"): it runs calm only while settled on screen. The two switches are this
// state file's own settings (gnIdle, jet).
function update(x) {
  var calm = params.gnIdle === true && x.settled;
  var target = calm && params.jet === true ? x.dash : 0;
  level.dash += (target - level.dash) * 0.3;
  // opens slowly into the full circle, closes quickly once the pose ends, so leftward particles stay in 低頭
  level.fidget += ((x.fidgeting ? 1 : 0) - level.fidget) * (x.fidgeting ? 0.15 : 0.35);
  var look = mix(mix(LOOK.facingLeft, LOOK.aura, level.fidget), LOOK.dash, level.dash);
  return {emitters: {
    gnIdle: {velocity: look.speed, birthRate: calm ? look.rate : 0, keyPaths: {
      "emitterCells.drift.emissionRange": look.range, "emitterCells.drift.emissionLongitude": look.longitude,
      "emitterCells.drift.velocity": look.velocity, "emitterCells.drift.yAcceleration": look.yAccel,
      "emitterCells.drift.xAcceleration": look.xAccel, "emitterCells.halo.xAcceleration": look.xAccel * 0.8,
      "emitterCells.halo.birthRate": 10 * look.halo}},
    jet: {birthRate: calm ? level.dash : 0}
  }};
}
