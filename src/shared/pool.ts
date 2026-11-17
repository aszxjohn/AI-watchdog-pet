import {
  confidenceSchema,
  type SessionKey,
  sessionDisplayNameSchema,
  sessionKeySchema,
} from './detection-events';
import { actorIdSchema } from './pack-api';
import { characterKeySchema } from './packs';
import { stateCodeSchema } from './states';
import { z } from './zod-setup';

/**
 * main/pool's data:
 * - which sessions the user released (Story 2.8). A released session is
 *   still detected and shown with its state, but gets no character;
 * - which character each shown session has (Story 3.4): one assignment is
 *   one session paired with one character under one `actorId`. A change of
 *   character ends that assignment and makes a new one.
 * main/pool owns both, saves them in `userData/assignments.json`, and
 * publishes them as StageView's `pool` and `actors` sections; renderers
 * change only the released sessions, through `pool:set-released`.
 */

/** The `schemaVersion` main/pool reads and writes. */
export const POOL_SCHEMA_VERSION = 2;

/** The released keys, in code-unit order, each once. */
export function sortedSessionKeys(keys: Iterable<SessionKey>): SessionKey[] {
  return [...new Set(keys)].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
}

/** Strictly increasing in code-unit order: sorted, each key once. */
function isSortedAndUnique(keys: readonly string[]): boolean {
  return keys.every((key, i) => i === 0 || (keys[i - 1] as string) < key);
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * One assignment as assignments.json keeps it: the session, its actor and
 * the character (`<packId>/<characterId>`) it plays.
 */
export const poolAssignmentSchema = z.strictObject({
  sessionKey: sessionKeySchema,
  actorId: actorIdSchema,
  characterKey: characterKeySchema,
});

export type PoolAssignment = z.infer<typeof poolAssignmentSchema>;

/**
 * `assignments.json`:
 * `{ "schemaVersion": 2, "released": [<session key>…], "assignments": [<assignment>…] }`.
 * The released keys may come in any order or repeat a key (main/pool sorts
 * them and drops repeats when it reads the file); the assignments may come
 * in any order, but name a session key once and an actor id once. No other
 * field is allowed. Version 1 had `released` only (POOL_MIGRATIONS[1]).
 */
export const poolFileSchema = z.strictObject({
  schemaVersion: z.literal(POOL_SCHEMA_VERSION),
  released: z.array(sessionKeySchema),
  assignments: z
    .array(poolAssignmentSchema)
    .refine((items) => isUnique(items.map((item) => item.sessionKey)), {
      message: 'a session has one assignment at most',
    })
    .refine((items) => isUnique(items.map((item) => item.actorId)), {
      message: 'actor ids are unique',
    }),
});

export type PoolFile = z.infer<typeof poolFileSchema>;

/**
 * StageView's `pool` section: the released keys, sorted and unique. It may
 * name a session that is not in `sessions` (one saved from an earlier run
 * that has not come back, until the start-up sweep; one that ended this
 * run).
 */
export const stagePoolSchema = z.strictObject({
  released: z.array(sessionKeySchema).refine(isSortedAndUnique, {
    message: 'released keys are sorted and unique',
  }),
});

export type StagePool = z.infer<typeof stagePoolSchema>;

/**
 * One actor as StageView carries it: its id, the session it stands for,
 * the character it plays, and that session's state, confidence and
 * display name (the same fields as the session's, at the same rev).
 */
export const stageActorSchema = z.strictObject({
  actorId: actorIdSchema,
  sessionKey: sessionKeySchema,
  characterKey: characterKeySchema,
  state: stateCodeSchema,
  confidence: confidenceSchema,
  displayName: sessionDisplayNameSchema,
});

export type StageActor = z.infer<typeof stageActorSchema>;

/**
 * StageView's `actors` section: one per shown session that has a
 * character, in the order of `sessions`; actor ids and session keys each
 * once. A released session has none, nor does any session while the pool
 * is empty or before the start-up sync.
 */
export const stageActorsSchema = z
  .array(stageActorSchema)
  .refine((actors) => isUnique(actors.map((actor) => actor.actorId)), {
    message: 'actor ids are unique',
  })
  .refine((actors) => isUnique(actors.map((actor) => actor.sessionKey)), {
    message: 'a session has one actor at most',
  });

/**
 * `pool:set-released`'s arguments: a session key, and true to release it or
 * false to show it again.
 */
export const poolSetReleasedInputSchema = z.tuple([
  sessionKeySchema,
  z.boolean(),
]);
