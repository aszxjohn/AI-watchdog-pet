import { z } from '../zod-setup';
import {
  idSchema,
  repeatedIndexes,
  ruleIssue,
  withoutProtoKey,
} from './common';
import { actorIdSchema } from './messages';
import { paramValueSchema } from './params';

/**
 * `draw`, the one message a pack sends back (API 1.0): for one `frame`, the
 * commands to draw each of its actors with, in that actor's local
 * coordinates. An actor with an empty list draws nothing this tick (no
 * placeholder). Limits on commands, bytes, emitters and bitmaps are applied
 * by the stage (3.6), not by this schema.
 */

/** Longest particle emitter id, in UTF-16 units. */
export const EMITTER_ID_MAX_LENGTH = 64;

/** What a sprite command's optional fields are when it leaves them out. */
export const SPRITE_COMMAND_DEFAULTS = Object.freeze({
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  alpha: 1,
  z: 0,
});

/** One image, or one frame of a spritesheet, by its key in `assets`. */
export const spriteCommandSchema = z.strictObject({
  type: z.literal('sprite'),
  asset: idSchema,
  /** The spritesheet frame's name; only for a spritesheet asset. */
  frame: z.string().min(1).exactOptional(),
  x: z.number(),
  y: z.number(),
  /** Radians. */
  rotation: z.number().exactOptional(),
  scaleX: z.number().exactOptional(),
  scaleY: z.number().exactOptional(),
  alpha: z.number().min(0).max(1).exactOptional(),
  /** Order among this actor's commands; higher is drawn on top. */
  z: z.int().exactOptional(),
});

/**
 * A particle emitter, kept alive by naming the same `emitterId` each tick.
 * An emitter belongs to one actor: its id is unique within that actor's
 * commands, and another actor may use the same id for its own emitter.
 * `preset` takes any id-style name for now; 3.6 narrows it to the stage's
 * preset list.
 */
export const particlesCommandSchema = z.strictObject({
  type: z.literal('particles'),
  emitterId: z.string().min(1).max(EMITTER_ID_MAX_LENGTH),
  preset: idSchema,
  x: z.number(),
  y: z.number(),
  params: withoutProtoKey(
    z.record(z.string().min(1).max(EMITTER_ID_MAX_LENGTH), paramValueSchema),
  ).exactOptional(),
});

/** Any object that is not null and not a list. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A bitmap the pack painted itself. Only characters with `advancedBitmap`
 * may send it, which the stage checks at run time (3.6). `image` is an
 * ImageBitmap; the renderer checks that, so the schema runs in Node too.
 */
export const bitmapCommandSchema = z.strictObject({
  type: z.literal('bitmap'),
  image: z.custom<object>(
    isObject,
    ruleIssue('bitmap-image-not-object', 'image is an object'),
  ),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const DRAW_COMMAND_TYPES = ['sprite', 'particles', 'bitmap'] as const;

/** Any draw command, told apart by `type`. */
export const drawCommandSchema = z.discriminatedUnion('type', [
  spriteCommandSchema,
  particlesCommandSchema,
  bitmapCommandSchema,
]);

export type DrawCommand = z.infer<typeof drawCommandSchema>;

/** Whether no two particles commands in `commands` share an emitter id. */
function hasUniqueEmitterIds(commands: readonly DrawCommand[]): boolean {
  const emitterIds = commands.flatMap((command) =>
    command.type === 'particles' ? [command.emitterId] : [],
  );
  return repeatedIndexes(emitterIds).length === 0;
}

/** One actor's commands for this tick; each emitter id at most once. */
const actorCommandsSchema = z
  .array(drawCommandSchema)
  .refine(
    hasUniqueEmitterIds,
    ruleIssue('duplicate-emitter-id', "an actor's emitter ids are unique"),
  );

/** The pack's answer to the `frame` with the same `seq`. */
export const drawMessageSchema = z.strictObject({
  type: z.literal('draw'),
  seq: z.int().nonnegative(),
  actors: withoutProtoKey(z.record(actorIdSchema, actorCommandsSchema)),
});

export type DrawMessage = z.infer<typeof drawMessageSchema>;
