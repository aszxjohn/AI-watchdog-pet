/**
 * overlay/renderer (Story 3.6's second last part): the particles, as plain
 * data: no PixiJS and no DOM, with the random numbers passed in, so it is
 * unit-tested under Node. pixi-stage.ts draws what it gives.
 *
 * - PARTICLE_PRESET_DEFS is the one place each of the pack API's
 *   PARTICLE_PRESETS is defined: how fast it emits, how long a particle
 *   lives, how it starts, moves, turns, grows, fades and what colour it is,
 *   and the shape pixi-stage.ts paints its texture with. A Record over the
 *   preset type, so every preset has exactly one definition.
 * - An emitter is one pack × actor × `emitterId`. sync() follows the
 *   actors drawn this display frame (scene.ts), each with the `particles`
 *   commands of its pack's latest valid draw: an emitter whose command is
 *   there emits, from that command's latest `x`, `y` (the actor's local
 *   coordinates); one whose command is gone stops emitting, its particles
 *   live out their lives, and then it is removed. Another preset under the
 *   same `emitterId` is the old emitter stopping and a new one starting.
 *   An actor that is not drawn any more (it left, its draw left it out,
 *   its pack's sandbox went and took its draw, or it is drawn as the
 *   placeholder, which main.ts leaves out: Story 3.7) has its emitters and
 *   particles removed at once.
 * - An actor has at most PARTICLE_EMITTERS_MAX emitters, the stopped ones
 *   still fading out counted too (one ParticleContainer each): past that,
 *   its oldest stopped emitters go at once, with their particles, so a
 *   pack changing its emitter ids every tick cannot pile them up. Its
 *   emitting ones always stay (a valid draw has at most that many).
 * - Of a command's `params` only `rate` (a number, times the preset's
 *   rate, kept to 0 to 2; 1 by default) and `tint` (`#rrggbb`: every
 *   particle that colour; the preset's colours by default) are read;
 *   anything else, or a value of another type, is left alone.
 * - step() moves everything on by the render loop's time, at most
 *   PARTICLE_STEP_MAX_MS at once (after a pause or a stall nothing bursts
 *   out); while the render loop stands still nothing moves. An emitter
 *   with PARTICLES_PER_EMITTER_MAX particles alive emits nothing until
 *   some have run out, and what it would have emitted meanwhile is not
 *   owed afterwards.
 */
import {
  PARTICLE_EMITTERS_MAX,
  PARTICLE_STEP_MAX_MS,
  PARTICLES_PER_EMITTER_MAX,
} from '../../shared/constants';
import type { ParticlePreset } from '../../shared/pack-api';
import type { ParticlesCommand } from '../pack-host/draw-rules';

/** A range a value is picked from, evenly: [lowest, highest]. */
export type Range = readonly [number, number];

/** The shape of a preset's texture; pixi-stage.ts paints it in white. */
export type ParticleShape = 'spark' | 'puff' | 'square' | 'bubble';

/** How one preset looks and moves. Lengths are in base pixels, times in ms. */
export interface PresetDef {
  /** Particles a second at `rate` 1. */
  readonly rate: number;
  /** How long a particle lives. */
  readonly life: Range;
  /** How far from the emitter a particle is born, at most. */
  readonly spread: number;
  /** Its first speed, base pixels a second. */
  readonly speed: Range;
  /** Which way it first moves, radians: 0 right, -π/2 up (y is down). */
  readonly direction: Range;
  /** How fast it speeds up downwards, base pixels a second²; < 0 is up. */
  readonly gravity: number;
  /** How fast it slows down: its speed times e^(-drag) each second. */
  readonly drag: number;
  /** Its width when born and when its life runs out. */
  readonly size: readonly [start: number, end: number];
  /** How fast it turns, radians a second. */
  readonly spin: Range;
  /** Its colour (0xrrggbb), one picked per particle; `tint` replaces it. */
  readonly colors: readonly number[];
  /** Its opacity at its fullest, 0 to 1. */
  readonly alpha: number;
  /** The share of its life it fades in over, at the start. */
  readonly fadeIn: number;
  /** The share of its life it fades out over, at the end. */
  readonly fadeOut: number;
  /** How many times a second it twinkles (its opacity dips); 0: never. */
  readonly twinkle: number;
  /** Side to side: how far (base pixels) and how many times a second. */
  readonly sway: { readonly amplitude: number; readonly frequency: number };
  /** Its texture. */
  readonly shape: ParticleShape;
}

/** Straight up. */
const UP = -Math.PI / 2;

/** Every preset's look, the only place it is defined. */
export const PARTICLE_PRESET_DEFS: Readonly<Record<ParticlePreset, PresetDef>> =
  Object.freeze({
    // Small bright points scattered close round the emitter, twinkling out.
    // They stay within about 15 base pixels of it: the contract pack emits
    // 10 below the top of its bounds, so drifting up would be cut at once.
    sparkle: {
      rate: 14,
      life: [500, 900],
      spread: 10,
      speed: [2, 6],
      direction: [-Math.PI, Math.PI],
      gravity: 0,
      drag: 0,
      size: [6, 2],
      spin: [-1, 1],
      colors: [0xfff4b0, 0xffffff, 0xffe066],
      alpha: 1,
      fadeIn: 0.15,
      fadeOut: 0.5,
      twinkle: 6,
      sway: { amplitude: 0, frequency: 0 },
      shape: 'spark',
    },
    // Soft grey puffs rising, growing and thinning out.
    smoke: {
      rate: 6,
      life: [1400, 2200],
      spread: 4,
      speed: [12, 22],
      direction: [UP - 0.35, UP + 0.35],
      gravity: -6,
      drag: 0.4,
      size: [8, 22],
      spin: [-0.6, 0.6],
      colors: [0x8c8c8c, 0xa6a6a6, 0x777777],
      alpha: 0.55,
      fadeIn: 0.15,
      fadeOut: 0.6,
      twinkle: 0,
      sway: { amplitude: 2, frequency: 0.5 },
      shape: 'puff',
    },
    // Small squares of many colours thrown out and up, falling and turning.
    confetti: {
      rate: 16,
      life: [1100, 1700],
      spread: 3,
      speed: [55, 95],
      direction: [UP - 1, UP + 1],
      gravity: 160,
      drag: 0.8,
      size: [5, 5],
      spin: [-7, 7],
      colors: [0xff5c5c, 0xffc23c, 0x4cd98a, 0x4aa3ff, 0xc77dff],
      alpha: 1,
      fadeIn: 0,
      fadeOut: 0.25,
      twinkle: 0,
      sway: { amplitude: 0, frequency: 0 },
      shape: 'square',
    },
    // Pale blue rings rising slowly, swaying side to side.
    bubbles: {
      rate: 4,
      life: [1800, 2600],
      spread: 6,
      speed: [14, 22],
      direction: [UP - 0.15, UP + 0.15],
      gravity: 0,
      drag: 0,
      size: [4, 7],
      spin: [0, 0],
      colors: [0xaee0ff, 0xc8ecff],
      alpha: 0.85,
      fadeIn: 0.1,
      fadeOut: 0.25,
      twinkle: 0,
      sway: { amplitude: 3, frequency: 1.2 },
      shape: 'bubble',
    },
  });

/** The `rate` an emitter takes, and the default. */
export const EMITTER_RATE_MIN = 0;
export const EMITTER_RATE_MAX = 2;
export const EMITTER_RATE_DEFAULT = 1;

/** A `tint` the stage reads: `#` and six hex digits. */
export const TINT_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** What an emitter takes from its command's `params`. */
export interface EmitterParams {
  /** Times the preset's rate, 0 to 2. */
  readonly rate: number;
  /** Every particle's colour (0xrrggbb); null: the preset's colours. */
  readonly tint: number | null;
}

/** `rate` and `tint` from `params` (see the module comment). */
export function emitterParams(
  params: ParticlesCommand['params'],
): EmitterParams {
  const rate = params === undefined ? undefined : params.rate;
  const tint = params === undefined ? undefined : params.tint;
  return {
    rate:
      typeof rate === 'number' && Number.isFinite(rate)
        ? Math.min(EMITTER_RATE_MAX, Math.max(EMITTER_RATE_MIN, rate))
        : EMITTER_RATE_DEFAULT,
    tint:
      typeof tint === 'string' && TINT_PATTERN.test(tint)
        ? Number.parseInt(tint.slice(1), 16)
        : null,
  };
}

/** One particle as it is drawn, in its actor's local coordinates. */
export interface ParticleView {
  /** Its centre. */
  readonly x: number;
  readonly y: number;
  /** Its width (and height), base pixels. */
  readonly size: number;
  /** Radians. */
  readonly rotation: number;
  /** 0xrrggbb. */
  readonly color: number;
  /** 0 to 1. */
  readonly alpha: number;
}

/** One emitter as it is drawn. */
export interface EmitterView {
  /** Never reused while the overlay runs; pixi-stage.ts keys by it. */
  readonly id: number;
  readonly emitterId: string;
  readonly preset: ParticlePreset;
  /** Still emitting (its command is in the latest draw). */
  readonly active: boolean;
  /** Its particles alive, oldest first. */
  readonly particles: readonly ParticleView[];
}

/** An actor drawn this display frame, with its `particles` commands. */
export interface ParticleActor {
  readonly actorId: string;
  readonly emitters: readonly ParticlesCommand[];
}

/** How many emitters there are and how many particles are alive. */
export interface ParticleCounts {
  readonly emitters: number;
  readonly particles: number;
}

export interface ParticleSystem {
  /** Follows the actors drawn this display frame (see the module comment). */
  sync(actors: readonly ParticleActor[]): void;
  /**
   * Moves every particle on by `dtMs` (at most PARTICLE_STEP_MAX_MS; none
   * when it is not a positive number), lets the ones that ran out go,
   * removes the stopped emitters left with none, and emits.
   */
  step(dtMs: number): void;
  /** `actorId`'s emitters, oldest first. */
  emittersOf(actorId: string): readonly EmitterView[];
  counts(): ParticleCounts;
}

export interface ParticleSystemOptions {
  /** A random number in [0, 1); Math.random by default. */
  readonly random?: () => number;
  /** The presets' looks; PARTICLE_PRESET_DEFS by default (tests give theirs). */
  readonly presets?: Readonly<Record<ParticlePreset, PresetDef>>;
  /** Most particles alive per emitter; PARTICLES_PER_EMITTER_MAX by default. */
  readonly maxParticles?: number;
  /** The longest step; PARTICLE_STEP_MAX_MS by default. */
  readonly maxStepMs?: number;
}

/** One particle: what is drawn, and how it moves on. */
interface Particle {
  x: number;
  y: number;
  size: number;
  rotation: number;
  readonly color: number;
  alpha: number;
  /** Where it is without its sway. */
  baseX: number;
  vx: number;
  vy: number;
  /** ms lived, and to live. */
  age: number;
  readonly life: number;
  readonly spin: number;
  /** Where in its twinkle and sway it started, 0 to 1. */
  readonly phase: number;
}

interface Emitter {
  readonly id: number;
  readonly emitterId: string;
  readonly preset: ParticlePreset;
  readonly def: PresetDef;
  active: boolean;
  x: number;
  y: number;
  params: EmitterParams;
  /** The particles owed but not emitted yet, less than 1 after a step. */
  carry: number;
  readonly particles: Particle[];
}

/** The value `share` (0 to 1) of the way through `range`. */
function within(range: Range, share: number): number {
  return range[0] + (range[1] - range[0]) * share;
}

/** A particle's opacity at `share` (0 to 1) of its life, before twinkling. */
function fade(def: PresetDef, share: number): number {
  if (def.fadeIn > 0 && share < def.fadeIn) {
    return share / def.fadeIn;
  }
  if (def.fadeOut > 0 && share > 1 - def.fadeOut) {
    return Math.max(0, (1 - share) / def.fadeOut);
  }
  return 1;
}

/** Moves `particle` on by `ms` and works out how it is drawn. */
function advance(particle: Particle, def: PresetDef, ms: number): void {
  const seconds = ms / 1000;
  particle.vy += def.gravity * seconds;
  if (def.drag > 0) {
    const keep = Math.exp(-def.drag * seconds);
    particle.vx *= keep;
    particle.vy *= keep;
  }
  particle.baseX += particle.vx * seconds;
  particle.y += particle.vy * seconds;
  particle.rotation += particle.spin * seconds;
  particle.age += ms;
  const share = Math.min(1, particle.age / particle.life);
  const turns = particle.age / 1000;
  particle.x =
    particle.baseX +
    def.sway.amplitude *
      Math.sin(2 * Math.PI * (def.sway.frequency * turns + particle.phase));
  particle.size = def.size[0] + (def.size[1] - def.size[0]) * share;
  const twinkle =
    def.twinkle > 0
      ? 0.55 +
        0.45 * Math.cos(2 * Math.PI * (def.twinkle * turns + particle.phase))
      : 1;
  particle.alpha = def.alpha * fade(def, share) * twinkle;
}

export function createParticleSystem({
  random = Math.random,
  presets = PARTICLE_PRESET_DEFS,
  maxParticles = PARTICLES_PER_EMITTER_MAX,
  maxStepMs = PARTICLE_STEP_MAX_MS,
}: ParticleSystemOptions = {}): ParticleSystem {
  /** Each drawn actor's emitters, oldest first. */
  const actors = new Map<string, Emitter[]>();
  let nextId = 1;

  function start(command: ParticlesCommand): Emitter {
    const id = nextId;
    nextId += 1;
    return {
      id,
      emitterId: command.emitterId,
      preset: command.preset,
      def: presets[command.preset],
      active: true,
      x: command.x,
      y: command.y,
      params: emitterParams(command.params),
      carry: 0,
      particles: [],
    };
  }

  /** A new particle of `emitter`, born `ageMs` ago. */
  function emit(emitter: Emitter, ageMs: number): void {
    const { def } = emitter;
    const around = random() * 2 * Math.PI;
    const distance = def.spread * Math.sqrt(random());
    const direction = within(def.direction, random());
    const speed = within(def.speed, random());
    const life = within(def.life, random());
    const spin = within(def.spin, random());
    const rotation = random() * 2 * Math.PI;
    const pick = Math.floor(random() * def.colors.length);
    const color =
      emitter.params.tint ??
      def.colors[Math.min(pick, def.colors.length - 1)] ??
      0xffffff;
    const phase = random();
    const x = emitter.x + Math.cos(around) * distance;
    const particle: Particle = {
      x,
      y: emitter.y + Math.sin(around) * distance,
      size: def.size[0],
      rotation,
      color,
      alpha: 0,
      baseX: x,
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      age: 0,
      life,
      spin,
      phase,
    };
    advance(particle, def, ageMs);
    emitter.particles.push(particle);
  }

  function stepEmitter(emitter: Emitter, ms: number): void {
    const { def, particles } = emitter;
    let kept = 0;
    for (const particle of particles) {
      advance(particle, def, ms);
      if (particle.age < particle.life) {
        particles[kept] = particle;
        kept += 1;
      }
    }
    particles.length = kept;
    if (!emitter.active) {
      return;
    }
    emitter.carry += (def.rate * emitter.params.rate * ms) / 1000;
    const owed = Math.floor(emitter.carry);
    emitter.carry -= owed;
    // A full emitter pauses: what it could not emit is not owed later.
    const count = Math.min(owed, Math.max(0, maxParticles - particles.length));
    for (let i = 0; i < count; i += 1) {
      // Born somewhen in this step, so a step's particles do not bunch.
      emit(emitter, random() * ms);
    }
  }

  return {
    sync(drawn) {
      const seen = new Set<string>();
      for (const { actorId, emitters: commands } of drawn) {
        seen.add(actorId);
        const emitters = actors.get(actorId) ?? [];
        const wanted = new Map(
          commands.map((command) => [command.emitterId, command]),
        );
        for (const emitter of emitters) {
          if (!emitter.active) {
            continue;
          }
          const command = wanted.get(emitter.emitterId);
          if (command === undefined || command.preset !== emitter.preset) {
            emitter.active = false;
            continue;
          }
          emitter.x = command.x;
          emitter.y = command.y;
          emitter.params = emitterParams(command.params);
          wanted.delete(emitter.emitterId);
        }
        for (const command of wanted.values()) {
          emitters.push(start(command));
        }
        // Over the limit: the oldest stopped emitters go first.
        let over = emitters.length - PARTICLE_EMITTERS_MAX;
        const kept =
          over <= 0
            ? emitters
            : emitters.filter((emitter) => {
                if (over > 0 && !emitter.active) {
                  over -= 1;
                  return false;
                }
                return true;
              });
        if (kept.length === 0) {
          actors.delete(actorId);
        } else {
          actors.set(actorId, kept);
        }
      }
      for (const actorId of actors.keys()) {
        if (!seen.has(actorId)) {
          actors.delete(actorId);
        }
      }
    },

    step(dtMs) {
      if (!(dtMs > 0)) {
        return;
      }
      const ms = Math.min(dtMs, maxStepMs);
      for (const [actorId, emitters] of actors) {
        for (const emitter of emitters) {
          stepEmitter(emitter, ms);
        }
        const left = emitters.filter(
          (emitter) => emitter.active || emitter.particles.length > 0,
        );
        if (left.length === 0) {
          actors.delete(actorId);
        } else if (left.length !== emitters.length) {
          actors.set(actorId, left);
        }
      }
    },

    emittersOf(actorId) {
      return actors.get(actorId) ?? [];
    },

    counts() {
      let emitters = 0;
      let particles = 0;
      for (const list of actors.values()) {
        emitters += list.length;
        for (const emitter of list) {
          particles += emitter.particles.length;
        }
      }
      return { emitters, particles };
    },
  };
}
