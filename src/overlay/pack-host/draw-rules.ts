/**
 * pack-host's check of a pack's `draw` (Story 3.6), as pure functions: no
 * DOM types, so they are unit-tested under Node. In this order, the first
 * that fails dropping the whole `draw`:
 *
 * 1. before it is parsed: plain JSON data (`invalid`) of at most
 *    DRAW_MAX_BYTES (`too-large`), with at most DRAW_MAX_COMMANDS commands
 *    over all its actors (`too-many-commands`);
 * 2. the pack API's drawMessageSchema (`invalid`: a `particles` preset
 *    outside PARTICLE_PRESETS too);
 * 3. at most PARTICLE_EMITTERS_MAX `particles` commands over all its actors
 *    (`too-many-emitters`);
 * 4. every actor in it is one of the pack's actors the `frame` it answers
 *    named (`not-own-actor`);
 * 5. command by command, in the pack's order: every sprite's `asset` is a
 *    key of the pack's manifest `assets` (`unknown-asset`), with a `frame`
 *    exactly when that asset is a spritesheet, naming one of its frames
 *    (`unknown-frame`); every bitmap (Story 3.6's last part) is for an
 *    actor whose character has `advancedBitmap` (`bitmap-not-allowed`),
 *    its `image` an ImageBitmap (`bitmap-not-image`) no wider or higher
 *    than BITMAP_MAX_SIDE (`bitmap-too-large`), the only one of its actor
 *    in this `draw`, an image no other command names, and within its
 *    actor's BITMAP_MAX_PER_SECOND (pack-host's window says how many more
 *    it may send now) (`too-many-bitmaps`).
 *
 * What passes is kept as each actor's sprite, `particles` and `bitmap`
 * commands, in the pack's order. An actor of the `frame` that the `draw`
 * leaves out is not drawn for it.
 *
 * Also here: closeBitmaps, which pack-host and dom.ts call on every
 * message they do not keep, and the per-actor window of
 * BITMAP_MAX_PER_SECOND (createBitmapWindow).
 */
import {
  BITMAP_MAX_PER_SECOND,
  BITMAP_MAX_SIDE,
  DRAW_MAX_BYTES,
  DRAW_MAX_COMMANDS,
  PARTICLE_EMITTERS_MAX,
} from '../../shared/constants';
import {
  type DrawCommand,
  drawMessageSchema,
  type PackCharacter,
  type PackManifest,
} from '../../shared/pack-api';
import type { PackMessageDropReason } from '../../shared/sandbox';
import {
  countDrawCommands,
  countEmitters,
  type ImageBitmapLike,
  imageBitmapsIn,
  isImageBitmap,
  jsonBytes,
} from '../../shared/draw-size';

export { countDrawCommands, countEmitters } from '../../shared/draw-size';

/** A sprite command. */
export type SpriteCommand = Extract<DrawCommand, { type: 'sprite' }>;

/** A particles command: one emitter (Story 3.6). */
export type ParticlesCommand = Extract<DrawCommand, { type: 'particles' }>;

/**
 * A bitmap command whose `image` checkDraw found to be an ImageBitmap
 * (Story 3.6's last part).
 */
export type BitmapCommand = Omit<
  Extract<DrawCommand, { type: 'bitmap' }>,
  'image'
> & { readonly image: ImageBitmapLike };

/** A command the stage draws. */
export type DrawnCommand = SpriteCommand | ParticlesCommand | BitmapCommand;

/**
 * What a checked `draw` keeps: each actor's sprites, emitters and bitmap,
 * in the pack's order.
 */
export type DrawnActors = ReadonlyMap<string, readonly DrawnCommand[]>;

/** A `draw` that passed checkDraw, or why it is dropped. */
export type DrawCheck =
  | { readonly ok: true; readonly actors: DrawnActors }
  | { readonly ok: false; readonly reason: PackMessageDropReason };

/**
 * What checkDraw knows of the pack: its assets, its sheets' frames and its
 * characters (their `advancedBitmap`).
 */
export interface DrawCheckLook {
  readonly manifest: Pick<PackManifest, 'assets'>;
  /** The frame names of spritesheet asset `key`; undefined for any other. */
  frames(key: string): ReadonlySet<string> | undefined;
  /** The manifest's character `characterId`, if it has one. */
  character(
    characterId: string,
  ): Pick<PackCharacter, 'advancedBitmap'> | undefined;
}

/**
 * The limits checkDraw applies: bytes and commands before parsing,
 * emitters once the `draw` is valid, a bitmap's side command by command.
 */
export interface DrawLimits {
  readonly bytes: number;
  readonly commands: number;
  readonly emitters: number;
  readonly bitmapSide: number;
}

export const DRAW_LIMITS: DrawLimits = Object.freeze({
  bytes: DRAW_MAX_BYTES,
  commands: DRAW_MAX_COMMANDS,
  emitters: PARTICLE_EMITTERS_MAX,
  bitmapSide: BITMAP_MAX_SIDE,
});

/** What checkDraw takes besides the `draw`, its `frame`'s actors and the look. */
export interface DrawCheckOptions {
  readonly limits?: DrawLimits;
  /**
   * The character of the `frame`'s actor `actorId` (pack-host: what the
   * stage had told the pack when it sent that `frame`). A bitmap of an
   * actor without one is not allowed; none without this.
   */
  readonly characterOf?: (actorId: string) => string | undefined;
  /**
   * How many more bitmaps `actorId` may send now (pack-host's window of
   * BITMAP_MAX_PER_SECOND); no limit without this.
   */
  readonly bitmapAllowance?: (actorId: string) => number;
}

/**
 * Checks a `draw` from a pack (see the module comment) against the actors
 * of the `frame` it answers and the pack's look.
 */
export function checkDraw(
  data: unknown,
  frameActors: ReadonlySet<string>,
  look: DrawCheckLook,
  {
    limits = DRAW_LIMITS,
    characterOf = () => undefined,
    bitmapAllowance = () => Infinity,
  }: DrawCheckOptions = {},
): DrawCheck {
  const bytes = jsonBytes(data, limits.bytes);
  if (bytes === null) {
    return { ok: false, reason: 'invalid' };
  }
  if (bytes > limits.bytes) {
    return { ok: false, reason: 'too-large' };
  }
  if (countDrawCommands(data, limits.commands) > limits.commands) {
    return { ok: false, reason: 'too-many-commands' };
  }
  const parsed = drawMessageSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' };
  }
  if (countEmitters(parsed.data, limits.emitters) > limits.emitters) {
    return { ok: false, reason: 'too-many-emitters' };
  }
  const entries = Object.entries(parsed.data.actors);
  if (entries.some(([actorId]) => !frameActors.has(actorId))) {
    return { ok: false, reason: 'not-own-actor' };
  }
  const actors = new Map<string, DrawnCommand[]>();
  /** The images the bitmaps checked so far name. */
  const images = new Set<object>();
  for (const [actorId, commands] of entries) {
    const drawn: DrawnCommand[] = [];
    let bitmaps = 0;
    for (const command of commands) {
      if (command.type === 'bitmap') {
        const characterId = characterOf(actorId);
        if (
          characterId === undefined ||
          look.character(characterId)?.advancedBitmap !== true
        ) {
          return { ok: false, reason: 'bitmap-not-allowed' };
        }
        const { image } = command;
        if (!isImageBitmap(image)) {
          return { ok: false, reason: 'bitmap-not-image' };
        }
        if (
          image.width > limits.bitmapSide ||
          image.height > limits.bitmapSide
        ) {
          return { ok: false, reason: 'bitmap-too-large' };
        }
        bitmaps += 1;
        if (bitmaps > 1 || images.has(image) || bitmapAllowance(actorId) < 1) {
          return { ok: false, reason: 'too-many-bitmaps' };
        }
        images.add(image);
        drawn.push({ ...command, image });
        continue;
      }
      if (command.type === 'particles') {
        drawn.push(command);
        continue;
      }
      if (!Object.hasOwn(look.manifest.assets, command.asset)) {
        return { ok: false, reason: 'unknown-asset' };
      }
      const frames = look.frames(command.asset);
      if (
        frames === undefined
          ? command.frame !== undefined
          : command.frame === undefined || !frames.has(command.frame)
      ) {
        return { ok: false, reason: 'unknown-frame' };
      }
      drawn.push(command);
    }
    actors.set(actorId, drawn);
  }
  return { ok: true, actors };
}

/**
 * Closes every ImageBitmap in `data` (imageBitmapsIn: each once), a
 * message the stage does not keep: what it does not draw must not wait
 * for the garbage collector. Never throws.
 */
export function closeBitmaps(data: unknown): void {
  for (const image of imageBitmapsIn(data)) {
    try {
      image.close();
    } catch {
      // Closed already, or not closable: nothing to free.
    }
  }
}

/**
 * How long the window of BITMAP_MAX_PER_SECOND is: one second, by when
 * pack-host received each `draw`. Answers TICK_HZ ticks apart can come a
 * little closer than a second (how long each took to come back differs,
 * and a stall bunches them up); BITMAP_MAX_PER_SECOND leaves room for
 * that, not the window.
 */
export const BITMAP_WINDOW_MS = 1000;

/**
 * Each actor's bitmaps of one pack over a sliding window (pack-host's,
 * Story 3.6's last part).
 */
export interface BitmapWindow {
  /** How many more bitmaps `actorId` may send now. */
  allowance(actorId: string): number;
  /** Counts one bitmap now for each of `actorIds`. */
  take(actorIds: Iterable<string>): void;
}

/**
 * A sliding window of `windowMs` by `now`: `allowance` is `limit` less the
 * bitmaps an actor sent less than `windowMs` ago. Actors with none left in
 * it are forgotten.
 */
export function createBitmapWindow(
  now: () => number,
  limit: number = BITMAP_MAX_PER_SECOND,
  windowMs: number = BITMAP_WINDOW_MS,
): BitmapWindow {
  const times = new Map<string, number[]>();
  /** Forgets what is out of the window at `at`. */
  function prune(at: number): void {
    for (const [actorId, list] of times) {
      while (list.length > 0 && at - (list[0] as number) >= windowMs) {
        list.shift();
      }
      if (list.length === 0) {
        times.delete(actorId);
      }
    }
  }
  return {
    allowance(actorId) {
      prune(now());
      return limit - (times.get(actorId)?.length ?? 0);
    },
    take(actorIds) {
      const at = now();
      prune(at);
      for (const actorId of actorIds) {
        const list = times.get(actorId) ?? [];
        list.push(at);
        times.set(actorId, list);
      }
    },
  };
}
