/**
 * overlay/renderer/particles (Story 3.6's second last part): the presets'
 * definitions, `rate` and `tint`, and the emitters a particle system runs
 * for the drawn actors, with a repeatable random number source and steps
 * of the render loop's time. Nothing here draws (pixi-stage.test does).
 */
import { describe, expect, it } from 'vitest';
import type { ParticlesCommand } from '../../src/overlay/pack-host/draw-rules';
import {
  createParticleSystem,
  EMITTER_RATE_MAX,
  emitterParams,
  PARTICLE_PRESET_DEFS,
  type ParticleActor,
  type ParticleSystem,
  type ParticleView,
  type PresetDef,
} from '../../src/overlay/renderer/particles';
import {
  PARTICLE_EMITTERS_MAX,
  PARTICLE_STEP_MAX_MS,
  PARTICLES_PER_EMITTER_MAX,
} from '../../src/shared/constants';
import {
  PARTICLE_PRESETS,
  type ParticlePreset,
} from '../../src/shared/pack-api';

/** A repeatable random number source in [0, 1) (a small LCG). */
function seeded(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The contract pack's sparkle emitter, or another. */
function command(overrides: Partial<ParticlesCommand> = {}): ParticlesCommand {
  return {
    type: 'particles',
    emitterId: 'glow',
    preset: 'sparkle',
    x: 0,
    y: -120,
    ...overrides,
  };
}

function drawn(
  actorId: string,
  ...emitters: ParticlesCommand[]
): ParticleActor {
  return { actorId, emitters };
}

/** The render loop at TICK_HZ: steps of 33 ms, `ms` in all. */
function run(system: ParticleSystem, ms: number, step = 33): void {
  for (let done = 0; done < ms; done += step) {
    system.step(Math.min(step, ms - done));
  }
}

function particlesOf(
  system: ParticleSystem,
  actorId: string,
): readonly ParticleView[] {
  return system.emittersOf(actorId).flatMap((emitter) => emitter.particles);
}

/** How far `particle` is from (`x`, `y`). */
function distance(particle: ParticleView, x: number, y: number): number {
  return Math.hypot(particle.x - x, particle.y - y);
}

/** Every preset as `def`, for counting what is emitted. */
function allAs(def: PresetDef): Record<ParticlePreset, PresetDef> {
  return {
    sparkle: def,
    smoke: def,
    confetti: def,
    bubbles: def,
  };
}

/** A preset that lives long and does not move: easy to count. */
const STILL: PresetDef = {
  ...PARTICLE_PRESET_DEFS.sparkle,
  rate: 10,
  life: [60_000, 60_000],
  speed: [0, 0],
  spread: 0,
  twinkle: 0,
};

/** The longest a sparkle lives. */
const SPARKLE_LIFE_MAX = PARTICLE_PRESET_DEFS.sparkle.life[1];

describe('I/O matrix', () => {
  it('粒子出現: a drawn actor’s sparkle emitter keeps emitting, close round its point (about 15 base pixels)', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command())]);
    run(system, 1000);

    expect(system.counts().emitters).toBe(1);
    const [emitter] = system.emittersOf('a1');
    expect(emitter?.active).toBe(true);
    expect(emitter?.preset).toBe('sparkle');
    const first = particlesOf(system, 'a1');
    expect(first.length).toBeGreaterThan(0);
    for (const particle of first) {
      expect(distance(particle, 0, -120)).toBeLessThanOrEqual(16);
      expect(particle.alpha).toBeGreaterThanOrEqual(0);
      expect(particle.alpha).toBeLessThanOrEqual(1);
    }

    // Still emitting a second later: new particles, the first ones gone.
    run(system, 1000);
    const later = particlesOf(system, 'a1');
    expect(later.length).toBeGreaterThan(0);
    expect(later.some((particle) => first.includes(particle))).toBe(false);
  });

  it('粒子停止: an emitter whose command is gone emits no more; its particles live out their lives, then it is removed', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command())]);
    run(system, 1000);
    const before = new Set(particlesOf(system, 'a1'));
    expect(before.size).toBeGreaterThan(0);

    // The next draw has the actor without the emitter (its state changed).
    system.sync([drawn('a1')]);
    expect(system.emittersOf('a1')[0]?.active).toBe(false);
    run(system, 99);
    const after = particlesOf(system, 'a1');
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((particle) => before.has(particle))).toBe(true);
    expect(system.counts().emitters).toBe(1);

    run(system, SPARKLE_LIFE_MAX);
    expect(system.emittersOf('a1')).toStrictEqual([]);
    expect(system.counts()).toStrictEqual({ emitters: 0, particles: 0 });
  });

  it('粒子跟隨: the same emitter with a new x, y emits its new particles from there', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command())]);
    run(system, 330);
    const old = new Set(particlesOf(system, 'a1'));

    system.sync([drawn('a1', command({ x: 30, y: -60 }))]);
    run(system, 330);

    expect(system.counts().emitters).toBe(1);
    const fresh = particlesOf(system, 'a1').filter(
      (particle) => !old.has(particle),
    );
    expect(fresh.length).toBeGreaterThan(0);
    for (const particle of fresh) {
      expect(distance(particle, 30, -60)).toBeLessThanOrEqual(16);
    }
  });

  it('四種 preset: each preset has its own definition and texture shape, and each emits as it is defined', () => {
    expect(Object.keys(PARTICLE_PRESET_DEFS)).toStrictEqual([
      ...PARTICLE_PRESETS,
    ]);
    const shapes = PARTICLE_PRESETS.map(
      (preset) => PARTICLE_PRESET_DEFS[preset].shape,
    );
    expect(new Set(shapes).size).toBe(PARTICLE_PRESETS.length);

    const system = createParticleSystem({ random: seeded(7) });
    system.sync(
      PARTICLE_PRESETS.map((preset) =>
        drawn(preset, command({ emitterId: 'look', preset })),
      ),
    );
    run(system, 1500);
    const of = (preset: ParticlePreset) => {
      const particles = particlesOf(system, preset);
      expect(particles.length, preset).toBeGreaterThan(0);
      return particles;
    };

    // sparkle: stays close round its point.
    for (const particle of of('sparkle')) {
      expect(distance(particle, 0, -120)).toBeLessThanOrEqual(16);
    }
    // smoke: rises, grows and is grey and see-through.
    const smoke = of('smoke');
    expect(smoke.every((particle) => particle.y < -120 + 4)).toBe(true);
    expect(Math.max(...smoke.map((particle) => particle.size))).toBeGreaterThan(
      PARTICLE_PRESET_DEFS.smoke.size[0],
    );
    expect(smoke.every((particle) => particle.alpha < 0.6)).toBe(true);
    // confetti: many colours, thrown out and falling below its point.
    const confetti = of('confetti');
    expect(
      new Set(confetti.map((particle) => particle.color)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(confetti.some((particle) => particle.y > -120)).toBe(true);
    expect(confetti.some((particle) => Math.abs(particle.x) > 20)).toBe(true);
    // bubbles: pale blue, rising slowly.
    const bubbles = of('bubbles');
    expect(bubbles.every((particle) => particle.y < -120 + 6)).toBe(true);
    expect(
      bubbles.every((particle) =>
        PARTICLE_PRESET_DEFS.bubbles.colors.includes(particle.color),
      ),
    ).toBe(true);
  });

  it('rate 與 tint: rate 2 emits twice as fast and tint #ff0000 makes every particle red; 9 is kept to 2; x is left alone (1)', () => {
    const system = createParticleSystem({
      random: seeded(),
      presets: allAs(STILL),
    });
    system.sync([
      drawn('plain', command()),
      drawn('double', command({ params: { rate: 2, tint: '#ff0000' } })),
      drawn('nine', command({ params: { rate: 9 } })),
      drawn('text', command({ params: { rate: 'x' } })),
    ]);
    run(system, 990);

    const count = (actorId: string) => particlesOf(system, actorId).length;
    expect(count('plain')).toBe(9);
    expect(count('double')).toBe(19);
    expect(count('nine')).toBe(count('double'));
    expect(count('text')).toBe(count('plain'));
    expect(
      particlesOf(system, 'double').every(
        (particle) => particle.color === 0xff0000,
      ),
    ).toBe(true);
    expect(
      particlesOf(system, 'plain').every((particle) =>
        STILL.colors.includes(particle.color),
      ),
    ).toBe(true);
  });

  it('粒子數上限: a full emitter emits nothing; once some run out it emits again at its rate only, without making up for the wait', () => {
    // 10 a second, a second each, at most 3; a first step of 300 ms fills
    // it at once, all three the same age.
    const system = createParticleSystem({
      random: () => 0.5,
      presets: allAs({ ...STILL, rate: 10, life: [1000, 1000] }),
      maxParticles: 3,
      maxStepMs: 1000,
    });
    system.sync([drawn('a1', command())]);
    system.step(300);
    const counts = [particlesOf(system, 'a1').length];
    for (let i = 0; i < 12; i += 1) {
      system.step(100);
      counts.push(particlesOf(system, 'a1').length);
    }

    // Full for 800 ms (one a step owed, and let go); then all three run out
    // in one step, and it emits one a step again, not three at once.
    expect(counts).toStrictEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 2, 3, 3]);
  });

  it(`粒子數上限: by default an emitter has at most PARTICLES_PER_EMITTER_MAX (${PARTICLES_PER_EMITTER_MAX}) particles alive, however fast it emits`, () => {
    const system = createParticleSystem({
      random: seeded(),
      presets: allAs({ ...STILL, rate: 100_000 }),
    });
    system.sync([drawn('a1', command({ params: { rate: 2 } }))]);

    system.step(100);
    system.step(100);

    expect(particlesOf(system, 'a1')).toHaveLength(PARTICLES_PER_EMITTER_MAX);
    expect(PARTICLES_PER_EMITTER_MAX).toBe(64);
  });

  it(`發射器上限: a pack changing its emitter ids every tick does not pile emitters up: an actor keeps at most ${PARTICLE_EMITTERS_MAX}, the oldest stopped ones going first, the emitting ones all kept`, () => {
    // Each emitter has particles out after its one tick, living on long
    // after it stopped: none goes away by itself.
    const system = createParticleSystem({
      random: seeded(),
      presets: allAs({ ...STILL, rate: 100 }),
    });
    const ids = (frame: number, count: number) =>
      Array.from({ length: count }, (_unused, index) => `f${frame}-${index}`);
    const emitting = () =>
      system
        .emittersOf('a1')
        .filter((emitter) => emitter.active)
        .map((emitter) => emitter.emitterId);

    for (let frame = 0; frame < 100; frame += 1) {
      const wanted = ids(frame, PARTICLE_EMITTERS_MAX);
      system.sync([
        drawn('a1', ...wanted.map((emitterId) => command({ emitterId }))),
      ]);
      expect(system.counts().emitters).toBeLessThanOrEqual(
        PARTICLE_EMITTERS_MAX,
      );
      system.step(33);
      expect(emitting()).toStrictEqual(wanted);
      expect(
        system
          .emittersOf('a1')
          .every((emitter) => emitter.particles.length > 0),
      ).toBe(true);
    }

    // Half as many new ids a tick: the previous tick's stay, fading out,
    // and the ones before go.
    const half = PARTICLE_EMITTERS_MAX / 2;
    for (let frame = 100; frame < 103; frame += 1) {
      system.sync([
        drawn(
          'a1',
          ...ids(frame, half).map((emitterId) => command({ emitterId })),
        ),
      ]);
      system.step(33);
    }
    expect(system.emittersOf('a1').map((each) => each.emitterId)).toStrictEqual(
      [...ids(101, half), ...ids(102, half)],
    );
    expect(emitting()).toStrictEqual(ids(102, half));
  });

  it('actor 離場: an actor no longer drawn (it left, or its pack’s sandbox went with its last draw) loses its emitters and particles at once; the others keep theirs', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([
      drawn('a1', command(), command({ emitterId: 'puff', preset: 'smoke' })),
      drawn('a2', command()),
    ]);
    run(system, 500);
    const kept = system.emittersOf('a2');

    system.sync([drawn('a2', command())]);

    expect(system.emittersOf('a1')).toStrictEqual([]);
    expect(system.emittersOf('a2')).toStrictEqual(kept);
    expect(system.counts().emitters).toBe(1);

    system.sync([]);
    expect(system.counts()).toStrictEqual({ emitters: 0, particles: 0 });
  });

  it(`暫停: a step longer than ${PARTICLE_STEP_MAX_MS} ms counts as ${PARTICLE_STEP_MAX_MS} ms (no burst after a pause), and no step moves nothing`, () => {
    const paused = createParticleSystem({ random: seeded(3) });
    const capped = createParticleSystem({ random: seeded(3) });
    for (const system of [paused, capped]) {
      system.sync([drawn('a1', command())]);
      run(system, 500);
    }
    const snapshot = (system: ParticleSystem) =>
      structuredClone(particlesOf(system, 'a1'));
    const before = snapshot(paused);

    // The render loop stood still: nothing moves.
    for (const dt of [0, -5, Number.NaN]) {
      paused.step(dt);
    }
    expect(snapshot(paused)).toStrictEqual(before);

    // Back after a long pause: one step of at most the cap.
    paused.step(60_000);
    capped.step(PARTICLE_STEP_MAX_MS);
    expect(snapshot(paused)).toStrictEqual(snapshot(capped));
    expect(PARTICLE_STEP_MAX_MS).toBe(100);
  });
});

describe('emitters', () => {
  it('another preset under the same emitter id: the old emitter stops (its particles live on), a new one starts', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command())]);
    run(system, 330);
    const [sparkle] = system.emittersOf('a1');

    system.sync([drawn('a1', command({ preset: 'smoke' }))]);
    run(system, 99);

    const [old, fresh] = system.emittersOf('a1');
    expect(old).toBe(sparkle);
    expect([old?.preset, old?.active]).toStrictEqual(['sparkle', false]);
    expect(old?.particles.length).toBeGreaterThan(0);
    expect([fresh?.preset, fresh?.active, fresh?.emitterId]).toStrictEqual([
      'smoke',
      true,
      'glow',
    ]);
    expect(fresh?.id).not.toBe(old?.id);

    run(system, SPARKLE_LIFE_MAX);
    expect(system.emittersOf('a1').map((each) => each.preset)).toStrictEqual([
      'smoke',
    ]);
  });

  it('a stopped emitter’s id coming back with the same preset before its particles ran out starts a new emitter, which emits', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command())]);
    run(system, 330);
    system.sync([drawn('a1')]);
    run(system, 33);
    const [stopped] = system.emittersOf('a1');
    expect(stopped?.active).toBe(false);
    expect(stopped?.particles.length).toBeGreaterThan(0);

    system.sync([drawn('a1', command())]);
    run(system, 99);

    const [old, fresh] = system.emittersOf('a1');
    expect(old).toBe(stopped);
    expect(old?.active).toBe(false);
    expect([fresh?.emitterId, fresh?.preset, fresh?.active]).toStrictEqual([
      'glow',
      'sparkle',
      true,
    ]);
    expect(fresh?.particles.length).toBeGreaterThan(0);
  });

  it('rate 與 tint: the same emitter taking new params mid-way: new particles come at the new rate and in the new colour; the ones out already keep theirs; rate 0 emits no more', () => {
    const system = createParticleSystem({
      random: seeded(),
      presets: allAs(STILL),
    });
    system.sync([drawn('a1', command())]);
    run(system, 990);
    const first = particlesOf(system, 'a1');
    const colours = first.map((particle) => particle.color);
    expect(first.length).toBe(9);

    system.sync([
      drawn('a1', command({ params: { rate: 2, tint: '#ff0000' } })),
    ]);
    run(system, 990);
    const second = particlesOf(system, 'a1');
    const added = second.filter((particle) => !first.includes(particle));

    expect(system.counts().emitters).toBe(1);
    expect(added.length).toBeGreaterThanOrEqual(2 * first.length);
    expect(added.length).toBeLessThanOrEqual(2 * first.length + 2);
    expect(added.every((particle) => particle.color === 0xff0000)).toBe(true);
    expect(first.map((particle) => particle.color)).toStrictEqual(colours);
    expect(colours.includes(0xff0000)).toBe(false);

    system.sync([drawn('a1', command({ params: { rate: 0 } }))]);
    run(system, 990);
    expect(particlesOf(system, 'a1')).toStrictEqual(second);
    expect(system.emittersOf('a1')[0]?.active).toBe(true);
  });

  it('emitters are an actor’s own: two actors with the same emitter id each have theirs', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command()), drawn('a2', command({ x: 20 }))]);
    run(system, 330);

    expect(system.counts().emitters).toBe(2);
    expect(system.emittersOf('a1')[0]?.id).not.toBe(
      system.emittersOf('a2')[0]?.id,
    );
  });

  it('an emitter started and stopped before any step is removed at the next step', () => {
    const system = createParticleSystem({ random: seeded() });
    system.sync([drawn('a1', command())]);
    system.sync([drawn('a1')]);
    expect(system.counts().emitters).toBe(1);

    system.step(33);

    expect(system.counts()).toStrictEqual({ emitters: 0, particles: 0 });
  });

  it('a particle fades in, then out, and is gone when its life runs out', () => {
    const system = createParticleSystem({
      random: () => 0.5,
      presets: allAs({
        ...STILL,
        rate: 1000,
        life: [1000, 1000],
        fadeIn: 0.2,
        fadeOut: 0.5,
      }),
    });
    system.sync([drawn('a1', command())]);
    system.step(1);
    system.sync([drawn('a1')]);
    const [particle] = particlesOf(system, 'a1');
    const alphas: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      system.step(100);
      alphas.push(particle?.alpha ?? -1);
    }

    expect(alphas[0]).toBeLessThan(alphas[2] ?? 0);
    expect(alphas[2]).toBeCloseTo(1);
    expect(alphas[8]).toBeLessThan(alphas[5] ?? 0);
    system.step(100);
    expect(particlesOf(system, 'a1')).toStrictEqual([]);
  });
});

describe('emitterParams', () => {
  it.each<[string, ParticlesCommand['params'], number, number | null]>([
    ['no params', undefined, 1, null],
    ['rate 2 and a red tint', { rate: 2, tint: '#ff0000' }, 2, 0xff0000],
    ['rate 0.5', { rate: 0.5 }, 0.5, null],
    ['rate 9, kept to 2', { rate: 9 }, EMITTER_RATE_MAX, null],
    ['a negative rate, kept to 0', { rate: -1 }, 0, null],
    ['a rate that is a string', { rate: 'x' }, 1, null],
    ['a rate that is a boolean', { rate: true }, 1, null],
    ['an upper-case tint', { tint: '#00FF7f' }, 1, 0x00ff7f],
    ['a tint without #', { tint: 'ff0000' }, 1, null],
    ['a short tint', { tint: '#f00' }, 1, null],
    ['a named tint', { tint: 'red' }, 1, null],
    ['a tint that is a number', { tint: 0xff0000 }, 1, null],
    ['other names only', { count: 12, color: '#ff0000' }, 1, null],
  ])('%s', (_label, params, rate, tint) => {
    expect(emitterParams(params)).toStrictEqual({ rate, tint });
  });
});
