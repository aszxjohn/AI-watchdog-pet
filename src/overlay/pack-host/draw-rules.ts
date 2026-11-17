/**
 * pack-host's check of a pack's `draw` (Story 3.6), as pure functions: no
 * DOM types, so they are unit-tested under Node. In this order, the first
 * that fails dropping the whole `draw`:
 *
 * 1. before it is parsed: plain JSON data (`invalid`) of at most
 *    DRAW_MAX_BYTES (`too-large`), with at most DRAW_MAX_COMMANDS commands
 *    over all its actors (`too-many-commands`);
 * 2. the pack API's drawMessageSchema (`invalid`);
 * 3. every actor in it is one of the pack's actors the `frame` it answers
 *    named (`not-own-actor`);
 * 4. every sprite's `asset` is a key of the pack's manifest `assets`
 *    (`unknown-asset`), with a `frame` exactly when that asset is a
 *    spritesheet, naming one of its frames (`unknown-frame`).
 *
 * What passes is kept as each actor's sprite commands: `particles` and
 * `bitmap` commands are not drawn yet (Story 3.6's last part), so they are
 * left out and reported, and the rest of the `draw` is drawn. An actor of
 * the `frame` that the `draw` leaves out is not drawn for it.
 */
import { DRAW_MAX_BYTES, DRAW_MAX_COMMANDS } from '../../shared/constants';
import {
  type DrawCommand,
  drawMessageSchema,
  type PackManifest,
} from '../../shared/pack-api';
import type {
  PackMessageDropReason,
  SkippedDrawCommand,
} from '../../shared/sandbox';
import { countDrawCommands, jsonBytes } from '../../shared/draw-size';

export { countDrawCommands } from '../../shared/draw-size';

/** A sprite command. */
export type SpriteCommand = Extract<DrawCommand, { type: 'sprite' }>;

/** What a checked `draw` keeps: each actor's sprites, in the pack's order. */
export type DrawnActors = ReadonlyMap<string, readonly SpriteCommand[]>;

/** A `draw` that passed checkDraw, or why it is dropped. */
export type DrawCheck =
  | {
      readonly ok: true;
      readonly actors: DrawnActors;
      /** The command types left out of it. */
      readonly skipped: ReadonlySet<SkippedDrawCommand>;
    }
  | { readonly ok: false; readonly reason: PackMessageDropReason };

/** What checkDraw knows of the pack: its assets and its sheets' frames. */
export interface DrawCheckLook {
  readonly manifest: Pick<PackManifest, 'assets'>;
  /** The frame names of spritesheet asset `key`; undefined for any other. */
  frames(key: string): ReadonlySet<string> | undefined;
}

/** The limits checkDraw applies before parsing. */
export interface DrawLimits {
  readonly bytes: number;
  readonly commands: number;
}

export const DRAW_LIMITS: DrawLimits = Object.freeze({
  bytes: DRAW_MAX_BYTES,
  commands: DRAW_MAX_COMMANDS,
});

/**
 * Checks a `draw` from a pack (see the module comment) against the actors
 * of the `frame` it answers and the pack's look.
 */
export function checkDraw(
  data: unknown,
  frameActors: ReadonlySet<string>,
  look: DrawCheckLook,
  limits: DrawLimits = DRAW_LIMITS,
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
  const entries = Object.entries(parsed.data.actors);
  if (entries.some(([actorId]) => !frameActors.has(actorId))) {
    return { ok: false, reason: 'not-own-actor' };
  }
  const actors = new Map<string, SpriteCommand[]>();
  const skipped = new Set<SkippedDrawCommand>();
  for (const [actorId, commands] of entries) {
    const sprites: SpriteCommand[] = [];
    for (const command of commands) {
      if (command.type !== 'sprite') {
        skipped.add(command.type);
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
      sprites.push(command);
    }
    actors.set(actorId, sprites);
  }
  return { ok: true, actors, skipped };
}
