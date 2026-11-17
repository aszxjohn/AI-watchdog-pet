import { z } from '../zod-setup';
import { idSchema } from './common';
import { actorIdSchema } from './messages';

/**
 * The `stage.*` calls a pack makes that reach the stage as messages (API
 * 1.0, Story 3.5): the Worker bootstrap turns each call on `stage` into one
 * of these and the stage checks it here. Besides these, a pack sends only
 * `draw` (draw.ts). `stage.random` and `stage.canvas` stay inside the
 * sandbox and send nothing.
 *
 * The stage drops a whole call whose `actorId` is not one of the pack's
 * actors. `fire`, `hold` and `face` act on the world only from Epic 4.
 */

/** `stage.log(…)`: one line for the run log; the stage adds the pack id. */
export const stageLogCallSchema = z.strictObject({
  type: z.literal('stage.log'),
  text: z.string(),
});

/**
 * `stage.fire(fromActorId, { target, object })`: one of the pack's actors
 * fires `object` (a `projectiles` key) at the actor `target`.
 */
export const stageFireCallSchema = z.strictObject({
  type: z.literal('stage.fire'),
  actorId: actorIdSchema,
  target: actorIdSchema,
  object: idSchema,
});

/** `stage.hold(actorId, on)`: the actor stays put (true) or wanders again. */
export const stageHoldCallSchema = z.strictObject({
  type: z.literal('stage.hold'),
  actorId: actorIdSchema,
  on: z.boolean(),
});

/** Which way `stage.face` turns an actor. */
export const FACE_DIRECTIONS = ['left', 'right'] as const;

/** `stage.face(actorId, direction)`: the actor turns to face `direction`. */
export const stageFaceCallSchema = z.strictObject({
  type: z.literal('stage.face'),
  actorId: actorIdSchema,
  direction: z.enum(FACE_DIRECTIONS),
});

export const STAGE_CALL_TYPES = [
  'stage.log',
  'stage.fire',
  'stage.hold',
  'stage.face',
] as const;

/** Any `stage.*` call, told apart by `type`. */
export const stageCallSchema = z.discriminatedUnion('type', [
  stageLogCallSchema,
  stageFireCallSchema,
  stageHoldCallSchema,
  stageFaceCallSchema,
]);

export type StageCall = z.infer<typeof stageCallSchema>;

export type StageCallType = StageCall['type'];

/** The call of one type. */
export type StageCallOf<T extends StageCallType> = Extract<
  StageCall,
  { type: T }
>;
