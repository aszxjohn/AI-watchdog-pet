/**
 * pack-host's rules for what a pack's sandbox sends (Story 3.5), as pure
 * functions: which actors are whose, a fixed-window rate limiter, and the
 * check of one message, with the bounded JSON size count (jsonBytes, in
 * src/shared since the Worker bootstrap counts with it too, Story 3.6). No
 * DOM types, so they are unit-tested under Node.
 */

export { jsonBytes } from '../../shared/draw-size';
import { PACK_MESSAGE_MAX_BYTES } from '../../shared/constants';
import { jsonBytes } from '../../shared/draw-size';
import { type StageCall, stageCallSchema } from '../../shared/pack-api';
import type { StageActor } from '../../shared/pool';
import type { PackMessageDropReason } from '../../shared/sandbox';

/** The pack id of a character key `<packId>/<characterId>`. */
export function packIdOf(characterKey: string): string {
  const slash = characterKey.indexOf('/');
  return slash < 0 ? characterKey : characterKey.slice(0, slash);
}

/**
 * StageView's actors grouped by pack: pack id → its actors' ids. A pack
 * with no actor is not in the map.
 */
export function actorsByPack(
  actors: readonly Pick<StageActor, 'actorId' | 'characterKey'>[],
): Map<string, Set<string>> {
  const byPack = new Map<string, Set<string>>();
  for (const { actorId, characterKey } of actors) {
    const packId = packIdOf(characterKey);
    const ids = byPack.get(packId) ?? new Set<string>();
    ids.add(actorId);
    byPack.set(packId, ids);
  }
  return byPack;
}

/** Lets through at most `limit` takes per window. */
export interface RateLimiter {
  /** True when one more fits in the current window (and counts it). */
  take(): boolean;
}

/**
 * A fixed-window limiter: a window starts at the first take after the
 * previous one ended and lasts `windowMs` by `now`.
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number,
): RateLimiter {
  let windowStart = -Infinity;
  let used = 0;
  return {
    take() {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        used = 0;
      }
      if (used >= limit) {
        return false;
      }
      used += 1;
      return true;
    },
  };
}

/** A message that passed checkPackMessage, or why it is dropped. */
export type PackMessageCheck =
  | { readonly ok: true; readonly call: StageCall }
  | { readonly ok: false; readonly reason: PackMessageDropReason };

/**
 * Checks one message from a pack's sandbox (not one of the bootstrap's
 * reports), in this order: plain JSON data no larger than `maxBytes`
 * (`invalid`, `too-large`), a `stage.*` call by the shared schema
 * (`invalid`), and an `actorId` that is one of `ownActors`, the pack's
 * actors in StageView (`not-own-actor`; `fire`'s `target` may be any
 * actor). Rate limits are the caller's.
 */
export function checkPackMessage(
  data: unknown,
  ownActors: ReadonlySet<string>,
  maxBytes: number = PACK_MESSAGE_MAX_BYTES,
): PackMessageCheck {
  const bytes = jsonBytes(data, maxBytes);
  if (bytes === null) {
    return { ok: false, reason: 'invalid' };
  }
  if (bytes > maxBytes) {
    return { ok: false, reason: 'too-large' };
  }
  const parsed = stageCallSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' };
  }
  const call = parsed.data;
  if (call.type !== 'stage.log' && !ownActors.has(call.actorId)) {
    return { ok: false, reason: 'not-own-actor' };
  }
  return { ok: true, call };
}
