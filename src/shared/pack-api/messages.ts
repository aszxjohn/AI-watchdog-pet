import { stateCodeSchema } from '../states';
import { z } from '../zod-setup';
import { idSchema, repeatedIndexes, ruleIssue } from './common';
import { paramValuesSchema } from './params';

/**
 * Messages the stage sends a pack (API 1.0). Stage and pack address actors
 * only by `actorId`; `characterId` only picks a character's look and
 * parameters, and one character may have several actors at once. A pack
 * never sees session keys, sources, confidence or another pack's identity.
 * `stage.fire`, `hold`, `face` and `log` are not messages here (3.5, Epic 4).
 */

/** Longest actor id, in UTF-16 units. */
export const ACTOR_ID_MAX_LENGTH = 64;

/**
 * An actor: one session paired with one character, for as long as that
 * pairing lasts. Opaque to the pack; main/pool makes it (3.4) and never
 * reuses one within a run.
 */
export const actorIdSchema = z.string().min(1).max(ACTOR_ID_MAX_LENGTH);

export type ActorId = z.infer<typeof actorIdSchema>;

/** The session's display name, or null when it has none. */
export const displayNameSchema = z.string().nullable();

/**
 * One of this pack's actors: its character, that character's full
 * parameter values, its state (already mapped through `fallback`) and its
 * display name.
 */
export const ownActorSchema = z.strictObject({
  own: z.literal(true),
  actorId: actorIdSchema,
  characterId: idSchema,
  params: paramValuesSchema,
  state: stateCodeSchema,
  displayName: displayNameSchema,
});

/**
 * Another pack's actor: only its id and its state. That state holds only as
 * of the `init`; API 1.0 sends no later changes of it (Epic 4's
 * `state-broadcast` adds them in 1.1).
 */
export const otherActorSchema = z.strictObject({
  own: z.literal(false),
  actorId: actorIdSchema,
  state: stateCodeSchema,
});

/** Whether no two of `actors` share an actor id. */
function hasUniqueActorIds(actors: readonly { actorId: string }[]): boolean {
  return repeatedIndexes(actors.map((actor) => actor.actorId)).length === 0;
}

const uniqueActorIds = ruleIssue(
  'duplicate-actor-id',
  'each actor is listed once',
);

/**
 * The first message after the sandbox is built or rebuilt: every actor on
 * stage now, each once. No history is replayed.
 */
export const initMessageSchema = z.strictObject({
  type: z.literal('init'),
  actors: z
    .array(z.discriminatedUnion('own', [ownActorSchema, otherActorSchema]))
    .refine(hasUniqueActorIds, uniqueActorIds),
});

/** One of this pack's actors arrived. */
export const spawnMessageSchema = z.strictObject({
  type: z.literal('spawn'),
  actorId: actorIdSchema,
  characterId: idSchema,
  params: paramValuesSchema,
  state: stateCodeSchema,
  displayName: displayNameSchema,
});

/** One of this pack's actors left. */
export const despawnMessageSchema = z.strictObject({
  type: z.literal('despawn'),
  actorId: actorIdSchema,
});

/**
 * A character's full parameter values changed; at most one per character
 * per tick.
 */
export const paramsMessageSchema = z.strictObject({
  type: z.literal('params'),
  characterId: idSchema,
  params: paramValuesSchema,
});

/** The display name of one of this pack's actors changed. */
export const metaMessageSchema = z.strictObject({
  type: z.literal('meta'),
  actorId: actorIdSchema,
  displayName: displayNameSchema,
});

/** An actor came on stage this tick (any pack's). */
export const enterEventSchema = z.strictObject({
  type: z.literal('enter'),
  actorId: actorIdSchema,
});

/** An actor left the stage this tick (any pack's). */
export const leaveEventSchema = z.strictObject({
  type: z.literal('leave'),
  actorId: actorIdSchema,
});

/** A `frame` event. API 1.0 has only these two (see PACK_API_VERSION). */
export const frameEventSchema = z.discriminatedUnion('type', [
  enterEventSchema,
  leaveEventSchema,
]);

export type FrameEvent = z.infer<typeof frameEventSchema>;

/** One of this pack's actors in a `frame`: its state, after `fallback`. */
export const frameActorSchema = z.strictObject({
  actorId: actorIdSchema,
  state: stateCodeSchema,
});

/**
 * One tick. The pack's `frame` handler answers it with the `draw` for the
 * same `seq`. `t` is the pack's only clock.
 */
export const frameMessageSchema = z.strictObject({
  type: z.literal('frame'),
  seq: z.int().nonnegative(),
  /** Stage time, milliseconds. */
  t: z.number().nonnegative(),
  /** Milliseconds since the previous frame. */
  dt: z.number().nonnegative(),
  /** Each of this pack's actors once. */
  actors: z.array(frameActorSchema).refine(hasUniqueActorIds, uniqueActorIds),
  events: z.array(frameEventSchema),
});

export const STAGE_MESSAGE_TYPES = [
  'init',
  'spawn',
  'despawn',
  'params',
  'meta',
  'frame',
] as const;

/** Any message the stage sends a pack, told apart by `type`. */
export const stageMessageSchema = z.discriminatedUnion('type', [
  initMessageSchema,
  spawnMessageSchema,
  despawnMessageSchema,
  paramsMessageSchema,
  metaMessageSchema,
  frameMessageSchema,
]);

export type StageMessage = z.infer<typeof stageMessageSchema>;

export type StageMessageType = StageMessage['type'];

/** The message of one type. */
export type StageMessageOf<T extends StageMessageType> = Extract<
  StageMessage,
  { type: T }
>;
