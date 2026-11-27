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
 * - which sessions the user locked, and whether 鎖定展示 is on (session
 *   bulk-lock): while it is on, only a locked session gets a character
 *   (released or not), and every other one, new ones too, gets none. It is
 *   on only while some key is locked;
 * - which character each shown session has (Story 3.4): one assignment is
 *   one session paired with one character under one `actorId`. A change of
 *   character ends that assignment and makes a new one.
 * main/pool owns them, saves them in `userData/assignments.json`, and
 * publishes them as StageView's `pool` and `actors` sections; renderers
 * change only the released and locked sessions and 鎖定展示, through
 * `pool:set-released`, `pool:set-released-many`, `pool:set-locked` and
 * `pool:set-lock-on`.
 */

/** The `schemaVersion` main/pool reads and writes. */
export const POOL_SCHEMA_VERSION = 3;

/**
 * Most session keys one `pool:set-released-many` may carry: far more than
 * a panel ever lists at once.
 */
export const POOL_SET_RELEASED_MANY_MAX_KEYS = 1000;

/** Session keys (released or locked), in code-unit order, each once. */
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
 * `{ "schemaVersion": 3, "released": [<session key>…], "locked": [<session key>…], "lockOn": <boolean>, "assignments": [<assignment>…] }`.
 * The released and locked keys may come in any order or repeat a key
 * (main/pool sorts them and drops repeats when it reads the file); a
 * `lockOn` of true with no locked key reads as off. The assignments may
 * come in any order, but name a session key once and an actor id once. No
 * other field is allowed. Version 1 had `released` only (POOL_MIGRATIONS[1]);
 * version 2 had no `locked` and `lockOn` (POOL_MIGRATIONS[2]).
 */
export const poolFileSchema = z.strictObject({
  schemaVersion: z.literal(POOL_SCHEMA_VERSION),
  released: z.array(sessionKeySchema),
  locked: z.array(sessionKeySchema),
  lockOn: z.boolean(),
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
 * StageView's `pool` section: the released keys and the locked keys, each
 * list sorted and unique, and `lockOn`, whether 鎖定展示 is on (only ever
 * with a locked key). Either list may name a session that is not in
 * `sessions` (one saved from an earlier run that has not come back, until
 * the start-up sweep; one that ended this run).
 */
export const stagePoolSchema = z
  .strictObject({
    released: z.array(sessionKeySchema).refine(isSortedAndUnique, {
      message: 'released keys are sorted and unique',
    }),
    locked: z.array(sessionKeySchema).refine(isSortedAndUnique, {
      message: 'locked keys are sorted and unique',
    }),
    lockOn: z.boolean(),
  })
  .refine((pool) => !pool.lockOn || pool.locked.length > 0, {
    message: 'lockOn needs a locked key',
  });

export type StagePool = z.infer<typeof stagePoolSchema>;

/**
 * The one rule of who gets no character, as `pool` says (main/pool's
 * assigner follows it; the 管理 session page marks rows by it): while
 * 鎖定展示 is on, every session that is not locked, released or not;
 * otherwise every released one. Answers a test for one session key.
 */
export function heldBackBy(
  pool: Pick<StagePool, 'released' | 'locked' | 'lockOn'>,
): (sessionKey: SessionKey) => boolean {
  if (pool.lockOn) {
    const locked = new Set<SessionKey>(pool.locked);
    return (sessionKey) => !locked.has(sessionKey);
  }
  const released = new Set<SessionKey>(pool.released);
  return (sessionKey) => released.has(sessionKey);
}

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
 * once. A session held back (heldBackBy) has none, unless it is one of
 * demo mode's while demo mode is on; nor does any session while the pool
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

/**
 * `pool:set-released-many`'s arguments: the session keys (1 to
 * POOL_SET_RELEASED_MANY_MAX_KEYS of them; a repeat counts once), and true
 * to release them all or false to show them all again.
 */
export const poolSetReleasedManyInputSchema = z.tuple([
  z.array(sessionKeySchema).min(1).max(POOL_SET_RELEASED_MANY_MAX_KEYS),
  z.boolean(),
]);

/**
 * `pool:set-locked`'s arguments: a session key, and true to lock it or
 * false to unlock it.
 */
export const poolSetLockedInputSchema = z.tuple([
  sessionKeySchema,
  z.boolean(),
]);

/** `pool:set-lock-on`'s argument: true to turn 鎖定展示 on, false off. */
export const poolSetLockOnInputSchema = z.tuple([z.boolean()]);
