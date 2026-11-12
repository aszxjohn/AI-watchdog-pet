import { type SessionKey, sessionKeySchema } from './detection-events';
import { z } from './zod-setup';

/**
 * main/pool's data (Story 2.8): which sessions the user released. A
 * released session is still detected and shown with its state; Epic 2 only
 * marks it on the panel (Story 3.4 gives it no character). main/pool owns
 * it, saves it in `userData/assignments.json`, and publishes it as
 * StageView's `pool` section; renderers change it only through
 * `pool:set-released`.
 */

/** The `schemaVersion` main/pool reads and writes. */
export const POOL_SCHEMA_VERSION = 1;

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

/**
 * `assignments.json`: `{ "schemaVersion": 1, "released": [<session key>…] }`.
 * The list may come in any order or repeat a key (main/pool sorts it and
 * drops repeats when it reads the file); no other field is allowed. Story
 * 3.4 adds the assignment fields with a new version and a migration.
 */
export const poolFileSchema = z.strictObject({
  schemaVersion: z.literal(POOL_SCHEMA_VERSION),
  released: z.array(sessionKeySchema),
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
 * `pool:set-released`'s arguments: a session key, and true to release it or
 * false to show it again.
 */
export const poolSetReleasedInputSchema = z.tuple([
  sessionKeySchema,
  z.boolean(),
]);
